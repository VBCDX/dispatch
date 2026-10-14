package server

import (
	"context"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/VBCDX/dispatch/internal/auth"
	"github.com/VBCDX/dispatch/internal/bus"
	"github.com/VBCDX/dispatch/internal/seed"
	"github.com/VBCDX/dispatch/internal/store"
)

type suiteApp struct {
	Name    string `json:"name"`
	URL     string `json:"url"`
	Current bool   `json:"current"`
}

type authConfigResponse struct {
	Local   bool `json:"local"`
	Zitadel bool `json:"zitadel"`
	// SilentSignIn tells the web app to try /auth/oidc/login?prompt=none
	// before showing the sign-in page.
	SilentSignIn bool       `json:"silent_sign_in"`
	SuiteApps    []suiteApp `json:"suite_apps"`
	// GAMeasurementID is the GA4 measurement id; empty disables
	// analytics in the web app. Public config, like the OIDC client id.
	GAMeasurementID string `json:"ga_measurement_id"`
}

func (s *Server) handleAuthConfig(w http.ResponseWriter, r *http.Request) {
	out := authConfigResponse{
		Local:           s.cfg.AuthMode.Local(),
		Zitadel:         s.cfg.AuthMode.Zitadel(),
		SilentSignIn:    s.silentSignInAllowed(r),
		SuiteApps:       []suiteApp{},
		GAMeasurementID: s.cfg.GAMeasurementID,
	}
	for _, a := range s.cfg.SuiteApps {
		cur := false
		if u, err := url.Parse(a.URL); err == nil {
			cur = u.Scheme+"://"+u.Host == s.cfg.Origin()
		}
		out.SuiteApps = append(out.SuiteApps, suiteApp{Name: a.Name, URL: a.URL, Current: cur})
	}
	// The answer depends on this browser's marker cookies.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}

type meResponse struct {
	User struct {
		ID    string `json:"id"`
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"user"`
	Method           string    `json:"method"`
	SessionStartedAt time.Time `json:"session_started_at"`
	SessionExpiresAt time.Time `json:"session_expires_at"`
	CSRFToken        string    `json:"csrf_token"`
}

func newMe(sess store.Session, u store.User) meResponse {
	var m meResponse
	m.User.ID, m.User.Email, m.User.Name = u.ID, u.Email, u.Name
	m.Method = sess.Method
	m.SessionStartedAt, m.SessionExpiresAt = sess.CreatedAt.UTC(), sess.ExpiresAt.UTC()
	m.CSRFToken = sess.CSRFToken
	return m
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	a := fromContext(r.Context())
	writeJSON(w, http.StatusOK, newMe(a.session, a.user))
}

// NormalizeEmail is how local account emails are compared and stored.
func NormalizeEmail(email string) string { return strings.ToLower(strings.TrimSpace(email)) }

// maxEmailLen is RFC 5321's limit on a forward-path (254 octets). The email
// is used as a failed-sign-in limiter key, so it must be bounded before it
// reaches the limiter maps.
const maxEmailLen = 254

func (s *Server) handleLocalLogin(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.AuthMode.Local() {
		writeError(w, http.StatusNotFound, "not_enabled", "local accounts are not enabled")
		return
	}
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := readJSON(w, r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	email := NormalizeEmail(req.Email)
	if email == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "email and password are required")
		return
	}
	if len(email) > maxEmailLen {
		writeError(w, http.StatusBadRequest, "bad_request", "email is too long")
		return
	}

	ip := s.clientIP(r)
	accountKey, clientKey, addressKey := "acct:"+email, "acct:"+email+"|addr:"+ip, "addr:"+ip
	for _, check := range []struct {
		l   *auth.Limiter
		key string
	}{{s.accountLimiter, clientKey}, {s.addressLimiter, addressKey}} {
		if ok, wait := check.l.Allowed(check.key); !ok {
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
			writeError(w, http.StatusTooManyRequests, "rate_limited", "too many failed sign-ins; try again later")
			return
		}
	}
	if d := s.accountBackoff.Delay(accountKey); d > 0 {
		if !s.waiting.Enter(addressKey) {
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(d.Seconds()))))
			writeError(w, http.StatusTooManyRequests, "rate_limited", "too many sign-ins waiting; try again later")
			return
		}
		err := sleep(r.Context(), d)
		s.waiting.Leave(addressKey)
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "busy", "sign-in is busy; try again")
			return
		}
	}

	userID, hash, err := s.store.LocalCredentials(r.Context(), email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		s.log.Error("credential lookup failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "sign-in failed")
		return
	}
	select {
	case s.hashSlots <- struct{}{}:
	case <-r.Context().Done():
		writeError(w, http.StatusServiceUnavailable, "busy", "sign-in is busy; try again")
		return
	}
	ok := false
	if errors.Is(err, store.ErrNotFound) {
		auth.BurnPasswordCheck(req.Password)
	} else if ok, err = auth.VerifyPassword(hash, req.Password); err != nil {
		s.log.Error("stored password hash is unreadable", "user", userID, "err", err)
	}
	<-s.hashSlots
	if !ok {
		s.accountLimiter.Fail(clientKey)
		s.addressLimiter.Fail(addressKey)
		s.accountBackoff.Fail(accountKey)
		s.log.Info("local sign-in failed", "ip", ip)
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "wrong email or password")
		return
	}
	// The account's own counters yield to its correct password. The
	// per-address aggregate does not: it is the anti-credential-stuffing cap,
	// and one valid credential must not wipe it.
	s.accountLimiter.Reset(clientKey)
	s.accountBackoff.Reset(accountKey)
	_ = s.store.TouchLocalIdentity(r.Context(), email)
	s.recordSignIn(r.Context(), userID)

	sess, err := s.startSession(r.Context(), w, r, userID, methodLocal, nil)
	if err != nil {
		s.log.Error("create session failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "sign-in failed")
		return
	}
	u, err := s.store.GetUser(r.Context(), userID)
	if err != nil {
		s.log.Error("load user failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "sign-in failed")
		return
	}
	s.log.Info("local sign-in", "user", userID)
	writeJSON(w, http.StatusOK, newMe(sess, u))
}

// recordSignIn stamps the user's last sign-in. With demo data on, someone
// signing in for the first time joins the demo org as an Owner, so the
// screens have something to show. Failures are logged, never fatal: the
// sign-in itself has already succeeded.
func (s *Server) recordSignIn(ctx context.Context, userID string) {
	now := time.Now()
	first, err := s.store.RecordSignIn(ctx, userID, now)
	if err != nil {
		s.log.Error("record sign-in failed", "user", userID, "err", err)
		return
	}
	if !first || !s.cfg.SeedDemoData {
		return
	}
	added, err := s.store.JoinOrg(ctx, seed.DemoOrgID, userID, store.RoleOwner, now)
	switch {
	case errors.Is(err, store.ErrNotFound):
		s.log.Warn("demo org is missing; run dispatch seed", "org", seed.DemoOrgID)
	case err != nil:
		s.log.Error("join demo org failed", "user", userID, "err", err)
	case added:
		s.log.Info("joined demo org as Owner", "user", userID, "org", seed.DemoOrgID)
	}
}

// sleep waits d, or returns ctx's error if it ends first.
func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// handleLogout deletes the server session. For a Zitadel session it also
// returns the provider's end-session URL, which the web app navigates to so
// the Zitadel session ends as well, and Zitadel tells the other VBCDX apps
// (back-channel logout). It marks the browser as signed out on purpose, so
// it is not signed silently back in.
func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	sess, _, err := s.currentSession(r)
	if errors.Is(err, errNoSession) {
		s.setMarker(w, signedOutMarker, 0)
		s.clearSessionCookie(w)
		writeJSON(w, http.StatusOK, map[string]string{"redirect_url": "/"})
		return
	}
	if err != nil {
		s.log.Error("session lookup failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "sign-out failed")
		return
	}
	if !validCSRF(r, sess) {
		writeError(w, http.StatusForbidden, "csrf", "missing or wrong "+csrfHeader+" header")
		return
	}
	if err := s.store.DeleteSession(r.Context(), sess.IDHash); err != nil {
		s.log.Error("delete session failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "sign-out failed")
		return
	}
	// Close any WebSocket opened with this session.
	_ = s.bus.Conn().Publish(bus.SessionRevokedSubject(sess.IDHash), nil)
	s.clearSessionCookie(w)
	s.setMarker(w, signedOutMarker, 0)

	redirect := "/"
	if sess.Method == methodZitadel && s.oidc != nil {
		if u := s.oidc.EndSessionURL(r.Context(), sess.IDTokenHint); u != "" {
			redirect = u
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"redirect_url": redirect})
}

// handleOIDCLogin starts a Zitadel sign-in. With ?prompt=none it is a
// silent one: allowed once per silentMarkerTTL, never after an explicit
// sign-out, and any failure lands quietly back on the sign-in page.
func (s *Server) handleOIDCLogin(w http.ResponseWriter, r *http.Request) {
	silent := r.URL.Query().Get("prompt") == "none"
	if s.oidc == nil {
		if silent {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		http.Redirect(w, r, "/?error=zitadel_not_enabled", http.StatusFound)
		return
	}
	if silent {
		if !s.silentSignInAllowed(r) {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		// Set before anything can fail, so no outcome leads to a retry loop.
		s.setMarker(w, silentMarker, silentMarkerTTL)
	}
	target, err := s.oidc.Start(r.Context(), w, silent)
	if err != nil {
		s.log.Error("start Zitadel sign-in failed", "err", err, "silent", silent)
		if silent {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		http.Redirect(w, r, "/?error=provider_unavailable", http.StatusFound)
		return
	}
	http.Redirect(w, r, target, http.StatusFound)
}

func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if s.oidc == nil {
		http.Redirect(w, r, "/?error=zitadel_not_enabled", http.StatusFound)
		return
	}
	id, silent, err := s.oidc.Callback(r.Context(), w, r)
	if err != nil {
		if silent {
			// login_required and friends: no Zitadel session to join. The
			// silent marker is still set, so the web app shows sign-in.
			s.log.Info("silent Zitadel sign-in did not complete", "err", err)
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		s.log.Warn("Zitadel sign-in rejected", "err", err)
		http.Redirect(w, r, "/?error=signin_failed", http.StatusFound)
		return
	}
	u, err := s.store.UpsertOIDCUser(r.Context(), id.Issuer, id.Subject, id.Email, id.Name)
	if err != nil {
		s.log.Error("link Zitadel user failed", "err", err)
		http.Redirect(w, r, "/?error=signin_failed", http.StatusFound)
		return
	}
	s.recordSignIn(r.Context(), u.ID)
	if _, err := s.startSession(r.Context(), w, r, u.ID, methodZitadel, &id); err != nil {
		s.log.Error("create session failed", "err", err)
		http.Redirect(w, r, "/?error=signin_failed", http.StatusFound)
		return
	}
	s.log.Info("Zitadel sign-in", "user", u.ID, "silent", silent)
	http.Redirect(w, r, "/", http.StatusFound)
}

// handleBackchannelLogout receives Zitadel's back-channel logout: when a
// Zitadel session ends (sign-out from any VBCDX app), Zitadel POSTs a signed
// logout_token here, and every Dispatch session from that Zitadel session
// (or, without a sid, for that user) is deleted and its WebSockets closed.
// No session or CSRF token: the token's signature is the authentication.
// https://openid.net/specs/openid-connect-backchannel-1_0.html#BCResponse
func (s *Server) handleBackchannelLogout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if s.oidc == nil {
		writeError(w, http.StatusNotFound, "not_enabled", "Zitadel sign-in is not enabled")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "unreadable form body")
		return
	}
	raw := r.PostForm.Get("logout_token")
	if raw == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "logout_token is required")
		return
	}
	lt, err := s.oidc.VerifyLogoutToken(r.Context(), raw)
	if err != nil {
		if !errors.Is(err, auth.ErrLogoutToken) {
			s.log.Error("back-channel logout: provider unavailable", "err", err)
			writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "the sign-in provider is not reachable")
			return
		}
		s.log.Warn("back-channel logout token rejected", "err", err)
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid logout_token")
		return
	}
	ids, err := s.store.BackchannelLogout(r.Context(), store.LogoutToken{
		Issuer: lt.Issuer, TokenID: lt.TokenID, Expires: lt.Expiry, SessionID: lt.SessionID, Subject: lt.Subject,
	})
	if errors.Is(err, store.ErrReplayed) {
		s.log.Warn("back-channel logout token replayed", "jti", lt.TokenID)
		writeError(w, http.StatusBadRequest, "invalid_request", "logout_token already used")
		return
	}
	if err != nil {
		s.log.Error("back-channel logout failed", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "logout failed")
		return
	}
	for _, id := range ids {
		_ = s.bus.Conn().Publish(bus.SessionRevokedSubject(id), nil)
	}
	s.log.Info("back-channel logout", "sessions", len(ids), "has_sid", lt.SessionID != "")
	w.WriteHeader(http.StatusOK)
}
