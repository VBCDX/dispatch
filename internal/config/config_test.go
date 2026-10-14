package config

import (
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestDefaults(t *testing.T) {
	c, err := load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if c.AuthMode != AuthLocal || c.ListenAddr != ":8080" || c.DatabaseURL != "sqlite://data/dispatch.db" ||
		c.NATSStoreDir != "data/nats" || c.SessionTTL != 24*time.Hour || c.SecureCookies() ||
		c.Origin() != "http://localhost:8080" || c.GAMeasurementID != "" {
		t.Fatalf("unexpected defaults: %+v", c)
	}
}

// Analytics is off unless a well-formed GA4 measurement id is configured;
// a typo fails at start-up instead of silently sending nothing.
func TestGAMeasurementID(t *testing.T) {
	c, err := load(env(map[string]string{"GA_MEASUREMENT_ID": "G-ABC123DEF4"}))
	if err != nil || c.GAMeasurementID != "G-ABC123DEF4" {
		t.Fatalf("valid GA id: %+v, %v", c, err)
	}
	for _, bad := range []string{"UA-123456-1", "G-", "G-abc", "abc123", "G-ABC 123"} {
		if _, err := load(env(map[string]string{"GA_MEASUREMENT_ID": bad})); err == nil {
			t.Errorf("GA_MEASUREMENT_ID=%q: accepted", bad)
		}
	}
}

func TestZitadelModeNeedsClientSettings(t *testing.T) {
	_, err := load(env(map[string]string{"AUTH_MODE": "zitadel", "PUBLIC_URL": "https://dispatch.example.com"}))
	if err == nil || !strings.Contains(err.Error(), "OIDC_ISSUER") || !strings.Contains(err.Error(), "OIDC_CLIENT_SECRET") {
		t.Fatalf("err = %v; want missing OIDC settings named", err)
	}
	c, err := load(env(map[string]string{
		"AUTH_MODE": "both", "PUBLIC_URL": "https://dispatch.example.com/",
		"OIDC_ISSUER": "https://auth.example.com/", "OIDC_CLIENT_ID": "id", "OIDC_CLIENT_SECRET": "secret",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.OIDC.Issuer != "https://auth.example.com" ||
		c.OIDC.RedirectURL != "https://dispatch.example.com/auth/oidc/callback" ||
		c.OIDC.PostLogoutRedirectURL != "https://dispatch.example.com/" || !c.SecureCookies() ||
		!c.AuthMode.Local() || !c.AuthMode.Zitadel() {
		t.Fatalf("unexpected config: %+v", c)
	}
}

func TestRejectsBadValues(t *testing.T) {
	for name, m := range map[string]map[string]string{
		"unknown auth mode":       {"AUTH_MODE": "ldap"},
		"plain http off loopback": {"PUBLIC_URL": "http://dispatch.example.com"},
		"relative public url":     {"PUBLIC_URL": "/dispatch"},
		"short session secret":    {"SESSION_SECRET": "short"},
		"tiny session ttl":        {"SESSION_TTL": "5s"},
		"bootstrap email only":    {"BOOTSTRAP_ADMIN_EMAIL": "a@example.com"},
		"bootstrap password only": {"BOOTSTRAP_ADMIN_PASSWORD": "a long password"},
		"unparseable session ttl": {"SESSION_TTL": "forever"},
	} {
		if _, err := load(env(m)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestLoopbackHTTPAllowed(t *testing.T) {
	for _, u := range []string{"http://localhost:8080", "http://127.0.0.1:9000", "http://[::1]:8080"} {
		if _, err := load(env(map[string]string{"PUBLIC_URL": u})); err != nil {
			t.Errorf("%s: %v", u, err)
		}
	}
}

// The Zitadel callback is served at the root and its flow cookie is scoped
// to /auth/oidc/, so a public URL with a path, or a redirect URL anywhere
// else, would make every sign-in fail. Both are refused at startup.
func TestRedirectURLMatchesWhatIsServed(t *testing.T) {
	zitadel := func(extra map[string]string) map[string]string {
		m := map[string]string{
			"AUTH_MODE": "zitadel", "PUBLIC_URL": "https://dispatch.example.com",
			"OIDC_ISSUER": "https://auth.example.com", "OIDC_CLIENT_ID": "id", "OIDC_CLIENT_SECRET": "secret",
		}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	for name, m := range map[string]map[string]string{
		"public url with a path":         {"PUBLIC_URL": "https://dispatch.example.com/dispatch"},
		"public url with a query":        {"PUBLIC_URL": "https://dispatch.example.com/?a=b"},
		"redirect on another path":       zitadel(map[string]string{"OIDC_REDIRECT_URL": "https://dispatch.example.com/callback"}),
		"redirect on another host":       zitadel(map[string]string{"OIDC_REDIRECT_URL": "https://other.example.com/auth/oidc/callback"}),
		"redirect with a trailing slash": zitadel(map[string]string{"OIDC_REDIRECT_URL": "https://dispatch.example.com/auth/oidc/callback/"}),
	} {
		if _, err := load(env(m)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	for _, m := range []map[string]string{
		zitadel(nil),
		zitadel(map[string]string{"PUBLIC_URL": "https://dispatch.example.com/"}),
		zitadel(map[string]string{"OIDC_REDIRECT_URL": "https://dispatch.example.com/auth/oidc/callback"}),
	} {
		c, err := load(env(m))
		if err != nil {
			t.Fatalf("%v: %v", m, err)
		}
		if c.OIDC.RedirectURL != "https://dispatch.example.com/auth/oidc/callback" {
			t.Fatalf("redirect URL = %q", c.OIDC.RedirectURL)
		}
	}
}

func TestTrustedProxies(t *testing.T) {
	c, err := load(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.TrustedProxies) != 0 {
		t.Fatalf("default trusted proxies = %v, want none", c.TrustedProxies)
	}
	c, err = load(env(map[string]string{"TRUSTED_PROXIES": "10.0.1.0/24, 10.0.0.5  ::1,fd00::/8,10.0.2.7/16"}))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"10.0.1.0/24", "10.0.0.5/32", "::1/128", "fd00::/8", "10.0.0.0/16"}
	if len(c.TrustedProxies) != len(want) {
		t.Fatalf("trusted proxies = %v, want %v", c.TrustedProxies, want)
	}
	for i, p := range c.TrustedProxies {
		if p.String() != want[i] {
			t.Errorf("trusted proxy %d = %s, want %s", i, p, want[i])
		}
	}
	for _, bad := range []string{"proxy.example.com", "10.0.0.0/33", "0.0.0.0/0", "::/0", "fe80::1%eth0"} {
		if _, err := load(env(map[string]string{"TRUSTED_PROXIES": bad})); err == nil {
			t.Errorf("TRUSTED_PROXIES=%q was accepted", bad)
		}
	}
}

func TestSeedDemoData(t *testing.T) {
	for v, want := range map[string]bool{"": false, "false": false, "0": false, "true": true, "TRUE": true, "1": true} {
		c, err := load(env(map[string]string{"SEED_DEMO_DATA": v}))
		if err != nil || c.SeedDemoData != want {
			t.Errorf("SEED_DEMO_DATA=%q: SeedDemoData = %v, %v; want %v", v, c != nil && c.SeedDemoData, err, want)
		}
	}
	if _, err := load(env(map[string]string{"SEED_DEMO_DATA": "yes"})); err == nil {
		t.Error("SEED_DEMO_DATA=yes accepted")
	}
}

func TestWebhookAllowPrivate(t *testing.T) {
	for v, want := range map[string]bool{"": false, "false": false, "0": false, "true": true, "TRUE": true, "1": true} {
		c, err := load(env(map[string]string{"WEBHOOK_ALLOW_PRIVATE": v}))
		if err != nil || c.WebhookAllowPrivate != want {
			t.Errorf("WEBHOOK_ALLOW_PRIVATE=%q: WebhookAllowPrivate = %v, %v; want %v", v, c != nil && c.WebhookAllowPrivate, err, want)
		}
	}
	if _, err := load(env(map[string]string{"WEBHOOK_ALLOW_PRIVATE": "yes"})); err == nil {
		t.Error("WEBHOOK_ALLOW_PRIVATE=yes accepted")
	}
}

func TestSuiteApps(t *testing.T) {
	c, err := load(env(map[string]string{"SUITE_APPS": " Dispatch=https://dispatch.example.com , Keyhole=https://keyhole.example.com/,"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(c.SuiteApps) != 2 || c.SuiteApps[0] != (SuiteApp{"Dispatch", "https://dispatch.example.com"}) ||
		c.SuiteApps[1] != (SuiteApp{"Keyhole", "https://keyhole.example.com/"}) {
		t.Fatalf("SuiteApps = %+v", c.SuiteApps)
	}
	if c, err := load(env(nil)); err != nil || len(c.SuiteApps) != 0 {
		t.Fatalf("unset SUITE_APPS = %+v, %v; want none", c.SuiteApps, err)
	}
	if _, err := load(env(map[string]string{"SUITE_APPS": "Local=http://localhost:9090"})); err != nil {
		t.Fatalf("http on localhost refused: %v", err)
	}
	for _, bad := range []string{"Dispatch", "=https://x.example", "Dispatch=", "Dispatch=dispatch.example.com", "Dispatch=http://dispatch.example.com", "Dispatch=javascript:alert(1)"} {
		if _, err := load(env(map[string]string{"SUITE_APPS": bad})); err == nil || !strings.Contains(err.Error(), "SUITE_APPS") {
			t.Errorf("SUITE_APPS=%q accepted (err %v)", bad, err)
		}
	}
}
