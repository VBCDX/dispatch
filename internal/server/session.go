package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"github.com/VBCDX/dispatch/internal/auth"
	"github.com/VBCDX/dispatch/internal/store"
)

// Sign-in methods recorded on a session.
const (
	methodLocal   = "local"
	methodZitadel = "zitadel"
)

// csrfHeader carries the session's CSRF token on state-changing requests.
const csrfHeader = "X-CSRF-Token"

// cookieName uses the __Host- prefix when cookies are Secure: the browser
// then refuses the cookie unless it is Secure, host-only and Path=/.
func (s *Server) cookieName() string {
	if s.cfg.SecureCookies() {
		return "__Host-dispatch_session"
	}
	return "dispatch_session"
}

// Markers that stop the web app signing the browser in silently through
// Zitadel (prompt=none). silentMarker is set when a silent attempt starts
// and lasts silentMarkerTTL, so a failed attempt is not retried in a loop.
// signedOutMarker is set by an explicit sign-out and lasts until the
// browser closes, so whoever signed out is not signed straight back in.
// Any sign-in clears both.
const (
	silentMarker    = "dispatch_silent"
	signedOutMarker = "dispatch_signed_out"
	silentMarkerTTL = 5 * time.Minute
)

// markerName adds the __Host- prefix when cookies are Secure, as for the
// session cookie.
func (s *Server) markerName(base string) string {
	if s.cfg.SecureCookies() {
		return "__Host-" + base
	}
	return base
}

// setMarker sets a marker cookie; maxAge 0 makes it last until the browser
// closes, a negative maxAge deletes it.
func (s *Server) setMarker(w http.ResponseWriter, base string, maxAge time.Duration) {
	c := &http.Cookie{Name: s.markerName(base), Value: "1", Path: "/",
		HttpOnly: true, Secure: s.cfg.SecureCookies(), SameSite: http.SameSiteLaxMode}
	switch {
	case maxAge < 0:
		c.Value, c.MaxAge = "", -1
	case maxAge > 0:
		c.MaxAge = int(maxAge.Seconds())
	}
	http.SetCookie(w, c)
}

func (s *Server) hasMarker(r *http.Request, base string) bool {
	c, err := r.Cookie(s.markerName(base))
	return err == nil && c.Value != ""
}

// silentSignInAllowed reports whether the browser may try a silent Zitadel
// sign-in now.
func (s *Server) silentSignInAllowed(r *http.Request) bool {
	return s.oidc != nil && !s.hasMarker(r, silentMarker) && !s.hasMarker(r, signedOutMarker)
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// startSession creates a server-side session and sets its cookie. Any
// session the browser already had is deleted first, so a session ID planted
// before sign-in never becomes a signed-in one. id is the Zitadel identity
// for a Zitadel sign-in, nil otherwise.
func (s *Server) startSession(ctx context.Context, w http.ResponseWriter, r *http.Request, userID, method string, id *auth.Identity) (store.Session, error) {
	if c, err := r.Cookie(s.cookieName()); err == nil && c.Value != "" {
		_ = s.store.DeleteSession(ctx, hashToken(c.Value))
	}
	token := rand.Text()
	now := s.now()
	sess := store.Session{
		IDHash:    hashToken(token),
		UserID:    userID,
		Method:    method,
		CSRFToken: rand.Text(),
		CreatedAt: now,
		ExpiresAt: now.Add(s.cfg.SessionTTL),
	}
	if id != nil {
		sess.IDTokenHint, sess.OIDCIssuer, sess.OIDCSubject, sess.OIDCSID = id.IDToken, id.Issuer, id.Subject, id.SessionID
	}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return store.Session{}, err
	}
	s.setMarker(w, silentMarker, -1)
	s.setMarker(w, signedOutMarker, -1)
	http.SetCookie(w, &http.Cookie{
		Name: s.cookieName(), Value: token, Path: "/",
		MaxAge:   int(s.cfg.SessionTTL.Seconds()),
		HttpOnly: true, Secure: s.cfg.SecureCookies(), SameSite: http.SameSiteLaxMode,
	})
	return sess, nil
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: s.cookieName(), Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, Secure: s.cfg.SecureCookies(), SameSite: http.SameSiteLaxMode,
	})
}

var errNoSession = errors.New("no session")

// currentSession resolves the request's session cookie.
func (s *Server) currentSession(r *http.Request) (store.Session, store.User, error) {
	c, err := r.Cookie(s.cookieName())
	if err != nil || c.Value == "" {
		return store.Session{}, store.User{}, errNoSession
	}
	sess, u, err := s.store.GetSession(r.Context(), hashToken(c.Value), s.now())
	if errors.Is(err, store.ErrNotFound) {
		return store.Session{}, store.User{}, errNoSession
	}
	return sess, u, err
}

type sessionKey struct{}

type authed struct {
	session store.Session
	user    store.User
}

// requireSession rejects requests without a valid session, and checks the
// CSRF token on any method that is not GET, HEAD or OPTIONS.
func (s *Server) requireSession(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, u, err := s.currentSession(r)
		if errors.Is(err, errNoSession) {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign in first")
			return
		}
		if err != nil {
			s.log.Error("session lookup failed", "err", err)
			writeError(w, http.StatusInternalServerError, "internal", "session lookup failed")
			return
		}
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if !validCSRF(r, sess) {
				writeError(w, http.StatusForbidden, "csrf", "missing or wrong "+csrfHeader+" header")
				return
			}
		}
		next(w, r.WithContext(context.WithValue(r.Context(), sessionKey{}, authed{sess, u})))
	}
}

func validCSRF(r *http.Request, sess store.Session) bool {
	got := r.Header.Get(csrfHeader)
	return got != "" && subtle.ConstantTimeCompare([]byte(got), []byte(sess.CSRFToken)) == 1
}

func fromContext(ctx context.Context) authed {
	a, _ := ctx.Value(sessionKey{}).(authed)
	return a
}
