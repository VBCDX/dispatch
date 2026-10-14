// Package server is Dispatch's HTTP surface: the JSON API, sign-in, the
// agent WebSocket and the embedded web app.
package server

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"path/filepath"
	"runtime"
	"time"

	"github.com/VBCDX/dispatch/internal/agentauth"
	"github.com/VBCDX/dispatch/internal/auth"
	"github.com/VBCDX/dispatch/internal/bus"
	"github.com/VBCDX/dispatch/internal/config"
	"github.com/VBCDX/dispatch/internal/messaging"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/webhooks"
)

// Failed sign-ins. One client address is refused for failWindow after
// accountFailLimit failures on one account, or addressFailLimit in all.
// Across every address an account is slowed, never refused: past
// accountFreeFailures each attempt waits accountDelay, doubling per failure
// up to accountMaxDelay, so a guesser elsewhere cannot lock the owner out of
// their correct password. A successful sign-in clears the account's own
// counters, never the per-address aggregate. At most
// waitPerAddress attempts from one address, and waitTotal in all, wait out
// a slow-down at once; any more get 429 straight away.
const (
	accountFailLimit    = 10
	addressFailLimit    = 50
	failWindow          = 15 * time.Minute
	accountFreeFailures = 5
	accountDelay        = time.Second
	accountMaxDelay     = 10 * time.Second
	waitPerAddress      = 2
	waitTotal           = 256
)

// Server holds the dependencies every handler needs.
type Server struct {
	cfg   *config.Config
	store *store.Store
	bus   *bus.Bus
	oidc  *auth.OIDC
	log   *slog.Logger
	web   fs.FS

	accountLimiter *auth.Limiter // keyed by account and client address
	addressLimiter *auth.Limiter
	accountBackoff *auth.Backoff
	waiting        *auth.Waiting // keyed by client address
	// hashSlots caps concurrent password checks: each argon2id check holds
	// 19 MiB, so unbounded parallel sign-ins could exhaust memory.
	hashSlots chan struct{}
	now       func() time.Time

	// The agent message path.
	hub        *messaging.Hub
	access     agentauth.Cache
	agents     *agentRegistry
	browsers   *browserRegistry // signed-in browser sockets
	agentFails *auth.Limiter    // failed agent token checks, by client address
	nodeID     string           // tells this node's access changes from other nodes'

	// Webhooks and listeners. hooks is nil, and hooksErr says why, when
	// the secret key could not be set up.
	hooks         *webhooks.Service
	hooksErr      string
	listenerCalls *auth.Limiter // calls per listener
}

// New wires a Server. web is the built web app (may be empty); oidc is nil
// unless AUTH_MODE includes zitadel.
func New(cfg *config.Config, st *store.Store, b *bus.Bus, oidc *auth.OIDC, web fs.FS, log *slog.Logger) *Server {
	s := &Server{
		cfg: cfg, store: st, bus: b, oidc: oidc, web: web, log: log,
		accountLimiter: auth.NewLimiter(accountFailLimit, failWindow),
		addressLimiter: auth.NewLimiter(addressFailLimit, failWindow),
		accountBackoff: auth.NewBackoff(accountFreeFailures, accountDelay, accountMaxDelay, failWindow),
		waiting:        auth.NewWaiting(waitPerAddress, waitTotal),
		hashSlots:      make(chan struct{}, max(2, runtime.NumCPU())),
		now:            time.Now,
		hub:            messaging.NewHub(b, log),
		agents:         &agentRegistry{conns: map[string]*agentConn{}},
		browsers:       &browserRegistry{conns: map[*wsConn]struct{}{}},
		agentFails:     auth.NewLimiter(agentFailLimit, agentFailWindow),
		nodeID:         store.NewID("node"),
	}
	s.access = agentauth.NewMemory(st.LookupAgentAccess, func() time.Time { return s.now() })
	s.listenerCalls = auth.NewLimiter(listenerCallLimit, listenerCallWindow)
	keyFile := ""
	if cfg.DataDir != "" {
		keyFile = filepath.Join(cfg.DataDir, "webhook.key")
	}
	if box, err := webhooks.NewBox(cfg.SessionSecret, keyFile); err != nil {
		s.hooksErr = err.Error()
		log.Error("webhooks disabled: secret key unavailable", "err", err)
	} else {
		s.hooks = webhooks.New(b, st, box, log, webhooks.Options{AllowPrivate: cfg.WebhookAllowPrivate})
	}
	if err := s.subscribeAccessChanges(); err != nil {
		// Without it, revocations still apply within agentauth's refresh
		// interval and the per-connection re-check.
		log.Error("subscribe to access changes failed", "err", err)
	}
	return s
}

// RunArchiver copies agent messages from the stream into the database
// until ctx is cancelled. Sending and receiving never wait for it.
func (s *Server) RunArchiver(ctx context.Context) {
	for {
		err := s.hub.RunArchiver(ctx, s.store)
		if ctx.Err() != nil {
			return
		}
		s.log.Error("message archiver stopped; restarting", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

// Handler returns the full HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /readyz", s.handleReadyz)

	mux.HandleFunc("GET /api/auth/config", s.handleAuthConfig)
	mux.HandleFunc("POST /api/auth/login", s.handleLocalLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/me", s.requireSession(s.handleMe))
	mux.HandleFunc("GET /api/ws", s.requireSession(s.handleWebSocket))
	s.routesV1(mux)
	s.routesMessages(mux)
	s.routesWebhooks(mux)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such endpoint")
	})

	mux.HandleFunc("GET /agent/v1/ws", s.handleAgentWS)
	mux.HandleFunc("GET /agent/v1/me", s.handleAgentMe)
	mux.HandleFunc("POST /agent/v1/messages", s.handleAgentSend)
	mux.HandleFunc("/agent/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such endpoint")
	})

	mux.HandleFunc("GET /auth/oidc/login", s.handleOIDCLogin)
	mux.HandleFunc("GET /auth/oidc/callback", s.handleOIDCCallback)
	mux.HandleFunc("POST /auth/oidc/backchannel-logout", s.handleBackchannelLogout)

	mux.Handle("/", s.staticHandler())

	// Go's cross-origin protection rejects unsafe-method requests a browser
	// marks as cross-site (Sec-Fetch-Site, falling back to Origin vs Host).
	// https://pkg.go.dev/net/http#CrossOriginProtection
	cop := http.NewCrossOriginProtection()
	if err := cop.AddTrustedOrigin(s.cfg.Origin()); err != nil {
		s.log.Warn("cross-origin protection: could not trust PUBLIC_URL origin", "err", err)
	}
	// Zitadel calls this server to server. It uses no cookie, so a browser
	// cannot be tricked into anything here; the signed token is the check.
	cop.AddInsecureBypassPattern("POST /auth/oidc/backchannel-logout")
	// Outside systems call listeners server to server, with no cookie; the
	// signature is the check.
	cop.AddInsecureBypassPattern("POST /hooks/v1/{listener}")
	return s.securityHeaders(cop.Handler(mux))
}

// RunMaintenance removes expired sessions and stale limiter entries until
// ctx is cancelled.
func (s *Server) RunMaintenance(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := s.store.DeleteExpiredSessions(ctx, s.now()); err != nil {
				s.log.Warn("expired session cleanup failed", "err", err)
			} else if n > 0 {
				s.log.Info("expired sessions removed", "count", n)
			}
			s.accountLimiter.Sweep()
			s.addressLimiter.Sweep()
			s.accountBackoff.Sweep()
			s.agentFails.Sweep()
			s.listenerCalls.Sweep()
			if n, err := s.store.DeleteExpiredWebhookRecords(ctx, s.now()); err != nil {
				s.log.Warn("expired webhook record cleanup failed", "err", err)
			} else if n > 0 {
				s.log.Info("expired webhook records removed", "count", n)
			}
		}
	}
}

// securityHeaders sets the headers every response carries. The CSP allows the
// GA4 tag hosts only when analytics is configured (GA_MEASUREMENT_ID); with
// no measurement id the strict default policy stands unchanged.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		// HSTS only when the deployment is served over HTTPS (the same signal
		// that sets Secure cookies); on http (localhost) it stays a no-op.
		// Deliberately no includeSubDomains: Dispatch must not set transport
		// policy for sibling hosts it does not own.
		if s.cfg.SecureCookies() {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		h.Set("Content-Security-Policy", contentSecurityPolicy(s.cfg.GAMeasurementID))
		next.ServeHTTP(w, r)
	})
}

// contentSecurityPolicy is the CSP header. The GA4 hosts enter the policy only
// when a measurement id is configured; with analytics off nothing about the
// policy changes.
func contentSecurityPolicy(gaMeasurementID string) string {
	const base = "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
	if gaMeasurementID == "" {
		return base
	}
	return "default-src 'self'; " +
		"img-src 'self' data: https://*.google-analytics.com https://www.googletagmanager.com; " +
		"script-src 'self' https://www.googletagmanager.com; " +
		"connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; " +
		"object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
}

func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok\n"))
}

func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	checks := map[string]string{"database": "ok", "nats": "ok"}
	status := http.StatusOK
	if err := s.store.Ping(ctx); err != nil {
		// The driver error can name hosts, ports and users and this handler
		// is unauthenticated: log the detail, report only the state.
		s.log.Warn("readyz: database ping failed", "err", err)
		checks["database"] = "unavailable"
		status = http.StatusServiceUnavailable
	}
	if err := s.bus.Ready(); err != nil {
		s.log.Warn("readyz: nats not ready", "err", err)
		checks["nats"] = "unavailable"
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, checks)
}
