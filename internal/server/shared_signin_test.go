package server

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/auth/oidctest"
	"github.com/VBCDX/dispatch/internal/config"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

// Issue 9: one sign-in across the VBCDX suite. The fake provider stands in
// for Zitadel: it keeps one provider session (sid) that every app signing
// in through it shares.

func (h *harness) authConfig(c *http.Client) authConfigResponse {
	h.t.Helper()
	return decode[authConfigResponse](h.t, h.do(c, http.MethodGet, "/api/auth/config", nil, nil))
}

// zitadelSignIn runs an interactive sign-in to the end.
func (h *harness) zitadelSignIn(c *http.Client) meResponse {
	h.t.Helper()
	res := h.do(c, http.MethodGet, h.oidcFlow(c), nil, nil)
	if res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/" {
		h.t.Fatalf("callback = %d → %q", res.StatusCode, res.Header.Get("Location"))
	}
	me, status := h.me(c)
	if status != http.StatusOK {
		h.t.Fatalf("me after Zitadel sign-in = %d", status)
	}
	return me
}

// silentSignIn follows /auth/oidc/login?prompt=none through the provider
// and the callback, and returns where the browser ends up plus how many
// requests reached the provider.
func (h *harness) silentSignIn(c *http.Client) (landing string, providerHops int) {
	h.t.Helper()
	next := "/auth/oidc/login?prompt=none"
	for range 5 {
		res := h.do(c, http.MethodGet, next, nil, nil)
		if res.StatusCode != http.StatusFound {
			h.t.Fatalf("GET %s = %d during silent sign-in", next, res.StatusCode)
		}
		loc := res.Header.Get("Location")
		switch {
		case strings.HasPrefix(loc, h.idp.URL+"/authorize"):
			if u, _ := url.Parse(loc); u.Query().Get("prompt") != "none" {
				h.t.Fatalf("silent sign-in sent the browser to %q without prompt=none", loc)
			}
			providerHops++
		case strings.HasPrefix(loc, h.ts.URL+"/auth/oidc/callback"):
		default:
			return loc, providerHops
		}
		next = loc
	}
	h.t.Fatal("silent sign-in did not settle after 5 redirects")
	return "", 0
}

// session loads the stored session behind a client's cookie.
func (h *harness) session(c *http.Client) store.Session {
	h.t.Helper()
	for _, ck := range c.Jar.Cookies(mustURL(h.ts.URL)) {
		if ck.Name == h.srv.cookieName() {
			sess, _, err := h.st.GetSession(h.t.Context(), hashToken(ck.Value), time.Now())
			if err != nil {
				h.t.Fatal(err)
			}
			return sess
		}
	}
	h.t.Fatal("no session cookie")
	return store.Session{}
}

// backchannel POSTs a logout token the way Zitadel does: form-encoded,
// server to server, no cookies.
func (h *harness) backchannel(token string) int {
	h.t.Helper()
	res, err := http.PostForm(h.ts.URL+"/auth/oidc/backchannel-logout", url.Values{"logout_token": {token}})
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	if cc := res.Header.Get("Cache-Control"); cc != "no-store" {
		h.t.Errorf("back-channel logout Cache-Control = %q, want no-store", cc)
	}
	return res.StatusCode
}

// Signed in to another app (the provider session exists): a fresh browser
// is signed in to Dispatch without being asked.
func TestSilentSignInJoinsProviderSession(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := newHarness(t, b, config.AuthZitadel, nil)
		c := h.client()
		if !h.authConfig(c).SilentSignIn {
			t.Fatal("silent_sign_in = false for a fresh browser with Zitadel on")
		}
		landing, hops := h.silentSignIn(c)
		if landing != "/" || hops != 1 {
			t.Fatalf("silent sign-in landed on %q after %d provider hops; want / after 1", landing, hops)
		}
		me, status := h.me(c)
		if status != http.StatusOK || me.Method != "zitadel" || me.User.Email != "zed@example.com" {
			t.Fatalf("me after silent sign-in = %d %+v", status, me)
		}
		sess := h.session(c)
		if sess.OIDCSID != h.idp.SessionID() || sess.OIDCSubject != "user-123" || sess.OIDCIssuer != h.idp.Issuer() {
			t.Fatalf("session keeps iss=%q sub=%q sid=%q; want the provider's", sess.OIDCIssuer, sess.OIDCSubject, sess.OIDCSID)
		}
		if p := h.idp.Prompts(); len(p) != 1 || p[0] != "none" {
			t.Fatalf("provider prompts = %q", p)
		}
	})
}

// No provider session: login_required brings the browser back to the
// sign-in page, quietly, and it is not tried again.
func TestSilentSignInLoginRequiredDoesNotLoop(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthBoth, nil)
	h.idp.SetSession("")
	c := h.client()
	landing, hops := h.silentSignIn(c)
	if landing != "/" || hops != 1 {
		t.Fatalf("silent sign-in landed on %q after %d provider hops; want / (no error shown) after 1", landing, hops)
	}
	if _, status := h.me(c); status != http.StatusUnauthorized {
		t.Fatalf("me after login_required = %d", status)
	}
	if h.authConfig(c).SilentSignIn {
		t.Fatal("silent_sign_in still true after a failed attempt: the web app would loop")
	}
	// Even if the web app asked again, the server does not go to the provider.
	if landing, hops := h.silentSignIn(c); landing != "/" || hops != 0 {
		t.Fatalf("second silent attempt: landed on %q after %d provider hops; want / after 0", landing, hops)
	}
	if n := len(h.idp.Prompts()); n != 1 {
		t.Fatalf("provider saw %d authorization requests; want 1", n)
	}
	// The sign-in page still works, interactively.
	h.zitadelSignIn(c)
	if p := h.idp.Prompts(); p[len(p)-1] != "" {
		t.Fatalf("interactive sign-in sent prompt=%q", p[len(p)-1])
	}
}

// A silent attempt that fails for any other reason (a provider error, a
// tampered callback) also lands quietly on the sign-in page.
func TestSilentSignInOtherErrorsFallBack(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthZitadel, nil)
	h.idp.IDTokenClaims = func(claims map[string]any) { claims["aud"] = "some-other-app" }
	c := h.client()
	if landing, _ := h.silentSignIn(c); landing != "/" {
		t.Fatalf("silent sign-in with a bad ID token landed on %q, want /", landing)
	}
	if _, status := h.me(c); status != http.StatusUnauthorized {
		t.Fatal("a rejected silent sign-in signed the browser in")
	}
	if h.authConfig(c).SilentSignIn {
		t.Fatal("silent_sign_in still true after a failed attempt")
	}

	// Provider unreachable when the silent attempt starts.
	h = newHarness(t, storetest.Backends(t)[0], config.AuthZitadel, nil)
	h.idp.Close()
	c2 := h.client()
	if landing, hops := h.silentSignIn(c2); landing != "/" || hops != 0 {
		t.Fatalf("silent sign-in with the provider down landed on %q (%d hops), want /", landing, hops)
	}
	if h.authConfig(c2).SilentSignIn {
		t.Fatal("silent_sign_in still true after the provider was unreachable")
	}
}

// Someone who signed out on purpose is not signed straight back in, even
// though the provider session (from another app) is still there.
func TestNoSilentSignInAfterSignOut(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthZitadel, nil)
	c := h.client()
	me := h.zitadelSignIn(c)
	if _, status := h.logout(c, me.CSRFToken); status != http.StatusOK {
		t.Fatalf("logout = %d", status)
	}
	if h.authConfig(c).SilentSignIn {
		t.Fatal("silent_sign_in = true straight after an explicit sign-out")
	}
	before := len(h.idp.Prompts())
	if landing, hops := h.silentSignIn(c); landing != "/" || hops != 0 {
		t.Fatalf("silent attempt after sign-out landed on %q after %d provider hops; want / after 0", landing, hops)
	}
	if _, status := h.me(c); status != http.StatusUnauthorized || len(h.idp.Prompts()) != before {
		t.Fatal("signed back in silently after an explicit sign-out")
	}
	// Signing in again by choice lifts the block.
	h.zitadelSignIn(c)
	if !h.authConfig(c).SilentSignIn {
		t.Fatal("silent sign-in still blocked after the person signed in again")
	}
}

func TestLocalSignOutAlsoBlocksSilentSignIn(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthBoth, nil)
	h.createUser("ty@example.com", testPassword)
	c := h.client()
	me := decode[meResponse](t, h.login(c, "ty@example.com", testPassword))
	h.logout(c, me.CSRFToken)
	if h.authConfig(c).SilentSignIn {
		t.Fatal("silent_sign_in = true after signing out of a local account")
	}
}

// A valid logout token ends every Dispatch session from that provider
// session, and nothing else; the old cookie stops working.
func TestBackchannelLogoutEndsMatchingSessions(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := newHarness(t, b, config.AuthZitadel, nil)
		sidA := h.idp.SessionID()
		a1, a2 := h.client(), h.client()
		h.zitadelSignIn(a1)
		h.zitadelSignIn(a2)
		h.idp.SetSession("sid-other-browser")
		other := h.client()
		h.zitadelSignIn(other)
		h.idp.SetUser(oidctest.User{Subject: "someone-else", Email: "else@example.com", Name: "Else"})
		h.idp.SetSession(sidA) // same sid, different subject: must survive a sid+sub token
		stranger := h.client()
		h.zitadelSignIn(stranger)

		if got := h.backchannel(h.idp.Sign(t, h.idp.LogoutTokenClaims(sidA, "user-123"))); got != http.StatusOK {
			t.Fatalf("back-channel logout = %d, want 200", got)
		}
		for name, c := range map[string]*http.Client{"a1": a1, "a2": a2} {
			if _, status := h.me(c); status != http.StatusUnauthorized {
				t.Fatalf("%s: me after back-channel logout = %d, want 401", name, status)
			}
		}
		if _, status := h.me(other); status != http.StatusOK {
			t.Fatal("a session from a different provider session was ended")
		}
		if _, status := h.me(stranger); status != http.StatusOK {
			t.Fatal("another user's session was ended")
		}

		// No sid: every session for the subject.
		if got := h.backchannel(h.idp.Sign(t, h.idp.LogoutTokenClaims("", "user-123"))); got != http.StatusOK {
			t.Fatalf("sub-only back-channel logout = %d, want 200", got)
		}
		if _, status := h.me(other); status != http.StatusUnauthorized {
			t.Fatal("a sub-only logout token left the subject's session alive")
		}
		if _, status := h.me(stranger); status != http.StatusOK {
			t.Fatal("a sub-only logout token ended another user's session")
		}

		// A token naming no live session is still a success.
		if got := h.backchannel(h.idp.Sign(t, h.idp.LogoutTokenClaims("sid-gone", ""))); got != http.StatusOK {
			t.Fatalf("logout token for no live session = %d, want 200", got)
		}
	})
}

func TestBackchannelLogoutRejectsBadTokens(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthZitadel, nil)
	c := h.client()
	h.zitadelSignIn(c)
	sid := h.idp.SessionID()
	valid := func() map[string]any { return h.idp.LogoutTokenClaims(sid, "user-123") }
	now := time.Now()

	for _, tc := range []struct {
		name  string
		token func() string
	}{
		{"wrong audience", func() string { cl := valid(); cl["aud"] = []string{"some-other-app"}; return h.idp.Sign(t, cl) }},
		{"wrong issuer", func() string { cl := valid(); cl["iss"] = "https://evil.example"; return h.idp.Sign(t, cl) }},
		{"expired", func() string {
			cl := valid()
			cl["iat"], cl["exp"] = now.Add(-time.Hour).Unix(), now.Add(-45*time.Minute).Unix()
			return h.idp.Sign(t, cl)
		}},
		{"no exp", func() string { cl := valid(); delete(cl, "exp"); return h.idp.Sign(t, cl) }},
		{"no iat", func() string { cl := valid(); delete(cl, "iat"); return h.idp.Sign(t, cl) }},
		{"issued in the future", func() string { cl := valid(); cl["iat"] = now.Add(10 * time.Minute).Unix(); return h.idp.Sign(t, cl) }},
		{"missing event", func() string { cl := valid(); delete(cl, "events"); return h.idp.Sign(t, cl) }},
		{"other event only", func() string {
			cl := valid()
			cl["events"] = map[string]any{"http://schemas.openid.net/event/other": map[string]any{}}
			return h.idp.Sign(t, cl)
		}},
		{"event not an object", func() string {
			cl := valid()
			cl["events"] = map[string]any{oidctest.BackchannelLogoutEvent: "yes"}
			return h.idp.Sign(t, cl)
		}},
		{"event is null", func() string {
			cl := valid()
			cl["events"] = map[string]any{oidctest.BackchannelLogoutEvent: nil}
			return h.idp.Sign(t, cl)
		}},
		{"with nonce", func() string { cl := valid(); cl["nonce"] = "n"; return h.idp.Sign(t, cl) }},
		{"no jti", func() string { cl := valid(); delete(cl, "jti"); return h.idp.Sign(t, cl) }},
		{"neither sid nor sub", func() string { return h.idp.Sign(t, h.idp.LogoutTokenClaims("", "")) }},
		{"bad signature", func() string { return h.idp.SignWithForeignKey(t, valid()) }},
		{"not a JWT", func() string { return "not-a-jwt" }},
		{"empty", func() string { return "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := h.backchannel(tc.token()); got != http.StatusBadRequest {
				t.Fatalf("back-channel logout = %d, want 400", got)
			}
			if _, status := h.me(c); status != http.StatusOK {
				t.Fatal("a rejected logout token ended the session")
			}
		})
	}

	t.Run("an ID token is not a logout token", func(t *testing.T) {
		raw := h.session(c).IDTokenHint
		if raw == "" {
			t.Fatal("no ID token on the session")
		}
		if got := h.backchannel(raw); got != http.StatusBadRequest {
			t.Fatalf("ID token posted as logout token = %d, want 400", got)
		}
		if _, status := h.me(c); status != http.StatusOK {
			t.Fatal("an ID token ended the session")
		}
	})

	t.Run("reused jti", func(t *testing.T) {
		cl := h.idp.LogoutTokenClaims("sid-unrelated", "")
		token := h.idp.Sign(t, cl)
		if got := h.backchannel(token); got != http.StatusOK {
			t.Fatalf("first use = %d, want 200", got)
		}
		if got := h.backchannel(token); got != http.StatusBadRequest {
			t.Fatalf("replayed token = %d, want 400", got)
		}
		// Same jti, otherwise a fresh token aimed at the live session.
		again := valid()
		again["jti"] = cl["jti"]
		if got := h.backchannel(h.idp.Sign(t, again)); got != http.StatusBadRequest {
			t.Fatalf("reused jti = %d, want 400", got)
		}
		if _, status := h.me(c); status != http.StatusOK {
			t.Fatal("a token with a reused jti ended the session")
		}
	})

	t.Run("JSON body", func(t *testing.T) {
		res := h.do(h.client(), http.MethodPost, "/auth/oidc/backchannel-logout", map[string]string{"logout_token": h.idp.Sign(t, valid())}, nil)
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("JSON body = %d, want 400", res.StatusCode)
		}
	})

	// Finally the genuine token works, so the rejections above were about
	// the tampering, not the setup.
	if got := h.backchannel(h.idp.Sign(t, valid())); got != http.StatusOK {
		t.Fatalf("valid token = %d, want 200", got)
	}
	if _, status := h.me(c); status != http.StatusUnauthorized {
		t.Fatal("the valid logout token did not end the session")
	}
}

// The ended session's WebSockets close too, as on an ordinary sign-out.
func TestBackchannelLogoutClosesWebSockets(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthZitadel, nil)
	c := h.client()
	h.zitadelSignIn(c)
	ws := h.mustDialWS(c)
	ws.send(wsIn{Op: "sub", Subject: "x"})
	ws.expect("subscribed")
	if got := h.backchannel(h.idp.Sign(t, h.idp.LogoutTokenClaims(h.idp.SessionID(), ""))); got != http.StatusOK {
		t.Fatalf("back-channel logout = %d", got)
	}
	if _, err := ws.recv(3 * time.Second); err == nil {
		t.Fatal("WebSocket still open after a back-channel logout ended its session")
	}
}

func TestBackchannelLogoutNeedsZitadel(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthLocal, nil)
	res, err := http.PostForm(h.ts.URL+"/auth/oidc/backchannel-logout", url.Values{"logout_token": {"x"}})
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("back-channel logout with Zitadel off = %d, want 404", res.StatusCode)
	}
}

func TestSuiteAppsInAuthConfig(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthLocal, nil)
	if got := h.authConfig(h.client()); got.SilentSignIn || len(got.SuiteApps) != 0 {
		t.Fatalf("local mode, no SUITE_APPS: %+v", got)
	}
	h.cfg.SuiteApps = []config.SuiteApp{{Name: "Dispatch", URL: h.ts.URL + "/"}, {Name: "Keyhole", URL: "https://keyhole.example.com"}}
	got := h.authConfig(h.client()).SuiteApps
	if len(got) != 2 || got[0].Name != "Dispatch" || !got[0].Current || got[1].Name != "Keyhole" || got[1].Current || got[1].URL != "https://keyhole.example.com" {
		t.Fatalf("suite_apps = %+v", got)
	}
}
