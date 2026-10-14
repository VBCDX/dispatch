// Package config reads Dispatch's settings from the environment. Every
// variable read here is listed in .env.example.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// AuthMode selects which sign-in methods are offered.
type AuthMode string

const (
	AuthLocal   AuthMode = "local"
	AuthZitadel AuthMode = "zitadel"
	AuthBoth    AuthMode = "both"
)

// Local reports whether email-and-password sign-in is enabled.
func (m AuthMode) Local() bool { return m == AuthLocal || m == AuthBoth }

// Zitadel reports whether OpenID Connect sign-in is enabled.
func (m AuthMode) Zitadel() bool { return m == AuthZitadel || m == AuthBoth }

// OIDC holds the Zitadel (or any OpenID Connect provider) client settings.
type OIDC struct {
	Issuer                string
	ClientID              string
	ClientSecret          string
	RedirectURL           string
	PostLogoutRedirectURL string
	Scopes                []string
}

// SuiteApp is one VBCDX app in the suite switcher.
type SuiteApp struct {
	Name string
	URL  string
}

// Bootstrap describes a local account to create on first start, when the
// database has no users at all.
type Bootstrap struct {
	Email    string
	Name     string
	Password string
}

// Config is the full runtime configuration.
type Config struct {
	ListenAddr     string
	PublicURL      *url.URL
	DatabaseURL    string
	DataDir        string
	NATSStoreDir   string
	AuthMode       AuthMode
	OIDC           OIDC
	SessionTTL     time.Duration
	SessionSecret  string
	TrustedProxies []netip.Prefix
	Bootstrap      Bootstrap
	LogLevel       string
	// SeedDemoData loads the demo data into an empty database when the
	// server starts, and adds anyone signing in for the first time to the
	// demo org as an Owner.
	SeedDemoData bool
	// SuiteApps are the VBCDX apps the app switcher links to, Dispatch
	// included; empty hides the switcher.
	SuiteApps []SuiteApp
	// GAMeasurementID is the GA4 measurement id of the operator's web data
	// stream. Empty disables analytics: the web app loads no tag and
	// the CSP stays strict. Public (it is baked into the page).
	GAMeasurementID string
	// WebhookAllowPrivate lets webhook deliveries reach private, loopback
	// and link-local addresses. Off by default, so a webhook can't be used
	// to reach hosts inside the network Dispatch runs in.
	WebhookAllowPrivate bool
}

// SecureCookies reports whether cookies get the Secure attribute. They do
// whenever the public URL is https; plain http is only accepted on loopback.
func (c *Config) SecureCookies() bool { return c.PublicURL.Scheme == "https" }

// Origin is the scheme://host[:port] browsers send in the Origin header.
func (c *Config) Origin() string { return c.PublicURL.Scheme + "://" + c.PublicURL.Host }

// FromEnv loads the configuration from environment variables.
func FromEnv() (*Config, error) { return load(os.Getenv) }

func load(getenv func(string) string) (*Config, error) {
	get := func(key, def string) string {
		if v := strings.TrimSpace(getenv(key)); v != "" {
			return v
		}
		return def
	}

	c := &Config{
		ListenAddr:    get("LISTEN_ADDR", ":8080"),
		DataDir:       get("DATA_DIR", "data"),
		AuthMode:      AuthMode(strings.ToLower(get("AUTH_MODE", "local"))),
		SessionSecret: getenv("SESSION_SECRET"),
		LogLevel:      get("LOG_LEVEL", "info"),
	}
	c.DatabaseURL = get("DATABASE_URL", "sqlite://"+c.DataDir+"/dispatch.db")
	c.NATSStoreDir = get("NATS_STORE_DIR", c.DataDir+"/nats")

	var errs []error

	proxies, err := parseTrustedProxies(getenv("TRUSTED_PROXIES"))
	if err != nil {
		errs = append(errs, err)
	}
	c.TrustedProxies = proxies

	switch c.AuthMode {
	case AuthLocal, AuthZitadel, AuthBoth:
	default:
		errs = append(errs, fmt.Errorf("AUTH_MODE must be zitadel, local or both, got %q", c.AuthMode))
	}

	pub, err := url.Parse(get("PUBLIC_URL", "http://localhost:8080"))
	switch {
	case err != nil:
		errs = append(errs, fmt.Errorf("PUBLIC_URL: %w", err))
	case pub.Scheme != "https" && pub.Scheme != "http", pub.Host == "":
		errs = append(errs, fmt.Errorf("PUBLIC_URL must be an absolute http(s) URL, got %q", pub.String()))
	case pub.Scheme == "http" && !isLoopback(pub.Hostname()):
		errs = append(errs, fmt.Errorf("PUBLIC_URL must use https unless the host is localhost, got %q", pub.String()))
	case strings.Trim(pub.Path, "/") != "" || pub.RawQuery != "" || pub.Fragment != "":
		// Every route, including the Zitadel callback, is served from the root.
		errs = append(errs, fmt.Errorf("PUBLIC_URL must be scheme://host[:port] with no path, got %q (Dispatch cannot be served under a path)", pub.String()))
	default:
		pub.Path = ""
		c.PublicURL = pub
	}

	ttl, err := time.ParseDuration(get("SESSION_TTL", "24h"))
	if err != nil || ttl < time.Minute {
		errs = append(errs, fmt.Errorf("SESSION_TTL must be a duration of at least 1m, got %q", getenv("SESSION_TTL")))
	}
	c.SessionTTL = ttl

	if c.SessionSecret != "" && len(c.SessionSecret) < 32 {
		errs = append(errs, errors.New("SESSION_SECRET must be at least 32 characters"))
	}

	if c.AuthMode.Zitadel() {
		c.OIDC = OIDC{
			Issuer:       strings.TrimSuffix(getenv("OIDC_ISSUER"), "/"),
			ClientID:     getenv("OIDC_CLIENT_ID"),
			ClientSecret: getenv("OIDC_CLIENT_SECRET"),
			Scopes:       strings.Fields(get("OIDC_SCOPES", "openid profile email")),
		}
		for key, v := range map[string]string{
			"OIDC_ISSUER":        c.OIDC.Issuer,
			"OIDC_CLIENT_ID":     c.OIDC.ClientID,
			"OIDC_CLIENT_SECRET": c.OIDC.ClientSecret,
		} {
			if v == "" {
				errs = append(errs, fmt.Errorf("%s is required when AUTH_MODE is %s", key, c.AuthMode))
			}
		}
		if c.PublicURL != nil {
			// The callback is always served here, and the cookie carrying the
			// sign-in flow is scoped to its path, so the redirect URL is
			// derived rather than configurable. OIDC_REDIRECT_URL may only
			// restate it.
			c.OIDC.RedirectURL = c.PublicURL.String() + "/auth/oidc/callback"
			if v := get("OIDC_REDIRECT_URL", c.OIDC.RedirectURL); v != c.OIDC.RedirectURL {
				errs = append(errs, fmt.Errorf("OIDC_REDIRECT_URL must be %q (PUBLIC_URL + /auth/oidc/callback), got %q; change PUBLIC_URL or unset OIDC_REDIRECT_URL", c.OIDC.RedirectURL, v))
			}
			c.OIDC.PostLogoutRedirectURL = get("OIDC_POST_LOGOUT_REDIRECT_URL", c.PublicURL.String()+"/")
		}
	}

	c.Bootstrap = Bootstrap{
		Email:    getenv("BOOTSTRAP_ADMIN_EMAIL"),
		Name:     getenv("BOOTSTRAP_ADMIN_NAME"),
		Password: getenv("BOOTSTRAP_ADMIN_PASSWORD"),
	}
	if (c.Bootstrap.Email == "") != (c.Bootstrap.Password == "") {
		errs = append(errs, errors.New("BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must be set together"))
	}

	switch v := strings.ToLower(getenv("SEED_DEMO_DATA")); v {
	case "", "false", "0":
	case "true", "1":
		c.SeedDemoData = true
	default:
		errs = append(errs, fmt.Errorf("SEED_DEMO_DATA must be true or false, got %q", v))
	}

	switch v := strings.ToLower(getenv("WEBHOOK_ALLOW_PRIVATE")); v {
	case "", "false", "0":
	case "true", "1":
		c.WebhookAllowPrivate = true
	default:
		errs = append(errs, fmt.Errorf("WEBHOOK_ALLOW_PRIVATE must be true or false, got %q", v))
	}

	apps, err := parseSuiteApps(getenv("SUITE_APPS"))
	if err != nil {
		errs = append(errs, err)
	}
	c.SuiteApps = apps

	if v := strings.TrimSpace(getenv("GA_MEASUREMENT_ID")); v != "" {
		if !gaMeasurementIDRe.MatchString(v) {
			errs = append(errs, fmt.Errorf("GA_MEASUREMENT_ID must look like a GA4 measurement id (G-XXXXXXXXXX), got %q", v))
		} else {
			c.GAMeasurementID = v
		}
	}

	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	return c, nil
}

// gaMeasurementIDRe matches a GA4 web-stream measurement id. Strict on
// purpose: a typo should fail at start-up, not silently send nothing.
var gaMeasurementIDRe = regexp.MustCompile(`^G-[A-Z0-9]{4,20}$`)

// parseSuiteApps reads a comma-separated list of Name=URL pairs, for
// example "Dispatch=https://dispatch.example.com,Keyhole=https://keyhole.example.com".
func parseSuiteApps(v string) ([]SuiteApp, error) {
	var out []SuiteApp
	for _, f := range strings.Split(v, ",") {
		if f = strings.TrimSpace(f); f == "" {
			continue
		}
		name, raw, ok := strings.Cut(f, "=")
		name, raw = strings.TrimSpace(name), strings.TrimSpace(raw)
		u, err := url.Parse(raw)
		switch {
		case !ok || name == "" || raw == "":
			return nil, fmt.Errorf("SUITE_APPS: %q is not Name=URL", f)
		case err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http"):
			return nil, fmt.Errorf("SUITE_APPS: %q is not an absolute http(s) URL", raw)
		case u.Scheme == "http" && !isLoopback(u.Hostname()):
			return nil, fmt.Errorf("SUITE_APPS: %q must use https unless the host is localhost", raw)
		}
		out = append(out, SuiteApp{Name: name, URL: u.String()})
	}
	return out, nil
}

// parseTrustedProxies reads a comma- or space-separated list of addresses
// and CIDR networks.
func parseTrustedProxies(v string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, f := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' }) {
		p, err := netip.ParsePrefix(f)
		if err != nil {
			a, aerr := netip.ParseAddr(f)
			if aerr != nil || a.Zone() != "" {
				return nil, fmt.Errorf("TRUSTED_PROXIES: %q is not an IP address or CIDR network", f)
			}
			p = netip.PrefixFrom(a, a.BitLen())
		}
		if p.Bits() == 0 {
			return nil, fmt.Errorf("TRUSTED_PROXIES: %q would let every client choose its own address", f)
		}
		out = append(out, p.Masked())
	}
	return out, nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
