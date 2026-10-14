package config

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// .env.example and docker-compose.yml are what someone with a fresh clone
// starts from. These tests keep install-specific defaults out of
// .env.example, and keep docker-compose.yml passing through every setting
// load reads. (envexample_test.go checks .env.example lists them all.)

// readVars returns every environment variable load reads, with sign-in set
// to both so the OIDC settings are read too.
func readVars(t *testing.T) []string {
	t.Helper()
	seen := map[string]bool{}
	_, _ = load(func(k string) string {
		seen[k] = true
		if k == "AUTH_MODE" {
			return "both"
		}
		return ""
	})
	var out []string
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	if len(out) < 20 {
		t.Fatalf("load read only %d variables (%v); the recorder is broken", len(out), out)
	}
	return out
}

var envLine = regexp.MustCompile(`^([A-Z][A-Z0-9_]*)=(.*)$`)

// envExample returns the KEY=value assignments in the repository's
// .env.example, in file order.
func envExample(t *testing.T) map[string]string {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "..", ".env.example"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if m := envLine.FindStringSubmatch(sc.Text()); m != nil {
			if _, dup := out[m[1]]; dup {
				t.Errorf(".env.example sets %s twice", m[1])
			}
			out[m[1]] = m[2]
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// A value in .env.example is copied into every new install's .env, so it
// must not point at anyone's real service: everything is blank except the
// local defaults below.
func TestEnvExampleHasNoInstallDefaults(t *testing.T) {
	allowed := map[string]string{
		"AUTH_MODE":  "local",
		"PUBLIC_URL": "http://localhost:8080",
	}
	example := envExample(t)
	for k, v := range example {
		if want, ok := allowed[k]; ok {
			if v != want {
				t.Errorf(".env.example: %s=%q, want %q", k, v, want)
			}
			continue
		}
		if v != "" {
			t.Errorf(".env.example: %s=%q, want it blank (put examples in a comment)", k, v)
		}
	}
	for k := range allowed {
		if _, ok := example[k]; !ok {
			t.Errorf(".env.example does not list %s", k)
		}
	}
}

// docker-compose.yml passes every setting from .env through to Dispatch,
// except the ones it fixes on purpose: the bundled Postgres URL, and the
// listen address and data paths the image sets to match the port mapping and
// the /data volume.
func TestComposePassesEveryVariable(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	compose := string(raw)
	passthrough := func(k string) bool { return strings.Contains(compose, "      "+k+": ${"+k+":-") }
	fixed := map[string]bool{"DATABASE_URL": true, "LISTEN_ADDR": true, "DATA_DIR": true, "NATS_STORE_DIR": true}
	if !strings.Contains(compose, "      DATABASE_URL: postgres://") {
		t.Error("docker-compose.yml no longer sets DATABASE_URL to the bundled Postgres")
	}
	for _, k := range readVars(t) {
		switch {
		case fixed[k] && passthrough(k):
			t.Errorf("docker-compose.yml passes %s through from .env; the image fixes it", k)
		case !fixed[k] && !passthrough(k):
			t.Errorf("docker-compose.yml does not pass %s through (want `%s: ${%s:-...}`)", k, k, k)
		}
	}
}
