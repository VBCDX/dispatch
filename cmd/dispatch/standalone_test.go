package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Dispatch must run with no identity provider at all. These tests
// drive the real serve() entry point (config from the environment, real
// SQLite, real embedded NATS, real HTTP listener), not a hand-built Server.

// clearAuthEnv blanks every sign-in variable, so values inherited from the
// environment running the tests cannot change what is being proved.
func clearAuthEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"AUTH_MODE", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URL",
		"OIDC_POST_LOGOUT_REDIRECT_URL", "OIDC_SCOPES", "SESSION_SECRET", "SESSION_TTL",
		"BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_NAME", "BOOTSTRAP_ADMIN_PASSWORD",
		"DATABASE_URL", "NATS_STORE_DIR", "SEED_DEMO_DATA", "SUITE_APPS", "GA_MEASUREMENT_ID",
		"TRUSTED_PROXIES", "WEBHOOK_ALLOW_PRIVATE", "LISTEN_ADDR", "PUBLIC_URL", "DATA_DIR",
	} {
		t.Setenv(k, "")
	}
}

// freeAddr returns a loopback address with a port that was free a moment ago.
func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

// With AUTH_MODE=local, every OIDC_* variable is ignored, even when a
// stranger's .env still carries an issuer and client settings: the server
// boots, the bootstrap admin signs in, and the issuer is never contacted.
func TestLocalModeServesWithoutContactingAnIssuer(t *testing.T) {
	clearAuthEnv(t)

	var issuerHits atomic.Int64
	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		issuerHits.Add(1)
		t.Errorf("local mode contacted the OIDC issuer: %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}))
	defer issuer.Close()

	addr := freeAddr(t)
	base := "http://" + addr
	const email, password = "admin@example.com", "a throwaway bootstrap password"
	t.Setenv("AUTH_MODE", "local")
	t.Setenv("LISTEN_ADDR", addr)
	t.Setenv("PUBLIC_URL", base)
	t.Setenv("DATA_DIR", t.TempDir())
	t.Setenv("OIDC_ISSUER", issuer.URL)
	t.Setenv("OIDC_CLIENT_ID", "left-over-client-id")
	t.Setenv("OIDC_CLIENT_SECRET", "left-over-client-secret")
	t.Setenv("BOOTSTRAP_ADMIN_EMAIL", email)
	t.Setenv("BOOTSTRAP_ADMIN_NAME", "Admin")
	t.Setenv("BOOTSTRAP_ADMIN_PASSWORD", password)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serve(ctx) }()
	defer func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("serve returned %v on shutdown", err)
			}
		case <-time.After(20 * time.Second):
			t.Error("serve did not shut down")
		}
	}()

	jar, _ := cookiejar.New(nil)
	c := &http.Client{
		Jar:     jar,
		Timeout: 10 * time.Second,
		// Report redirects instead of following them.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	ready := false
	for i := 0; i < 300 && !ready; i++ { // up to 30s: the race detector slows start-up
		select {
		case err := <-done:
			t.Fatalf("serve exited before it was ready: %v", err)
		default:
		}
		if res, err := c.Get(base + "/readyz"); err == nil {
			ready = res.StatusCode == http.StatusOK
			res.Body.Close()
		}
		if !ready {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if !ready {
		t.Fatal("/readyz never answered 200")
	}

	get := func(path string) (*http.Response, []byte) {
		t.Helper()
		res, err := c.Get(base + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res, body
	}

	if res, _ := get("/healthz"); res.StatusCode != http.StatusOK {
		t.Fatalf("/healthz = %d", res.StatusCode)
	}

	res, body := get("/api/auth/config")
	var ac struct {
		Local   bool `json:"local"`
		Zitadel bool `json:"zitadel"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &ac) != nil || !ac.Local || ac.Zitadel {
		t.Fatalf("/api/auth/config = %d %s; want local on, zitadel off", res.StatusCode, body)
	}

	// The Zitadel entry points exist but do nothing in local mode.
	if res, _ := get("/auth/oidc/login"); res.StatusCode != http.StatusFound ||
		res.Header.Get("Location") != "/?error=zitadel_not_enabled" {
		t.Fatalf("/auth/oidc/login = %d to %q; want 302 to /?error=zitadel_not_enabled", res.StatusCode, res.Header.Get("Location"))
	}
	if res, _ := get("/auth/oidc/login?prompt=none"); res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/" {
		t.Fatalf("silent /auth/oidc/login = %d to %q; want 302 to /", res.StatusCode, res.Header.Get("Location"))
	}

	login := func(pw string) *http.Response {
		t.Helper()
		b, _ := json.Marshal(map[string]string{"email": email, "password": pw})
		req, _ := http.NewRequest(http.MethodPost, base+"/api/auth/login", bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", base)
		res, err := c.Do(req)
		if err != nil {
			t.Fatalf("POST /api/auth/login: %v", err)
		}
		return res
	}
	if res := login("not the bootstrap password"); res.StatusCode != http.StatusUnauthorized {
		res.Body.Close()
		t.Fatalf("wrong password: %d, want 401", res.StatusCode)
	} else {
		res.Body.Close()
	}
	res = login(password)
	body, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("bootstrap admin sign-in = %d %s", res.StatusCode, body)
	}

	res, body = get("/api/me")
	var me struct {
		User struct {
			Email string `json:"email"`
		} `json:"user"`
		Method string `json:"method"`
	}
	if res.StatusCode != http.StatusOK || json.Unmarshal(body, &me) != nil || me.User.Email != email || me.Method != "local" {
		t.Fatalf("/api/me = %d %s; want the bootstrap admin, method local", res.StatusCode, body)
	}

	if n := issuerHits.Load(); n != 0 {
		t.Fatalf("the OIDC issuer was contacted %d times in local mode", n)
	}
}

// AUTH_MODE=zitadel or both without the OIDC settings refuses to start, and
// says which settings are missing, before anything listens.
func TestZitadelModesWithoutOIDCFailAtStartup(t *testing.T) {
	for _, mode := range []string{"zitadel", "both", "ZITADEL"} {
		t.Run(mode, func(t *testing.T) {
			clearAuthEnv(t)
			addr := freeAddr(t)
			t.Setenv("AUTH_MODE", mode)
			t.Setenv("LISTEN_ADDR", addr)
			t.Setenv("DATA_DIR", t.TempDir())

			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			err := serve(ctx)
			if err == nil {
				t.Fatal("serve started without OIDC settings")
			}
			for _, key := range []string{"OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"} {
				if !strings.Contains(err.Error(), key+" is required when AUTH_MODE is") {
					t.Errorf("error does not name %s: %v", key, err)
				}
			}
			// Nothing was listening: the failure is at startup.
			if conn, derr := net.DialTimeout("tcp", addr, time.Second); derr == nil {
				conn.Close()
				t.Errorf("something is listening on %s after a failed start", addr)
			}
		})
	}
}
