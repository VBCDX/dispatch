package server

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/VBCDX/dispatch/internal/config"
)

func TestReadJSONTakesExactlyOneValue(t *testing.T) {
	for body, wantErr := range map[string]bool{
		`{"email":"a","password":"b"}`:               false,
		"{\"email\":\"a\",\"password\":\"b\"} \n":    false,
		`{"email":"a","password":"b"}{"email":"c"}`:  true,
		`{"email":"a","password":"b"} {"email":"c"}`: true,
		`{"email":"a","password":"b"}x`:              true,
		`{"email":"a","password":"b"}]`:              true,
		`{"email":"a","password":"b"},`:              true,
		`{"email":"a","password":"b"}{"email":"c"`:   true,
		`{"email":"a","password":"b","admin":true}`:  true,
		``: true,
	} {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		var v struct{ Email, Password string }
		err := readJSON(httptest.NewRecorder(), r, &v)
		if (err != nil) != wantErr {
			t.Errorf("body %q: err = %v, want error %v", body, err, wantErr)
		}
	}
}

func TestClientIP(t *testing.T) {
	s := &Server{cfg: &config.Config{TrustedProxies: []netip.Prefix{
		netip.MustParsePrefix("127.0.0.0/8"),   // a proxy on this host
		netip.MustParsePrefix("::1/128"),       //
		netip.MustParsePrefix("172.18.0.0/16"), // a reverse proxy's Docker network
		netip.MustParsePrefix("10.0.0.5/32"),   // a reverse proxy on the LAN
	}}}
	for _, tc := range []struct {
		peer string
		xff  []string
		want string
	}{
		{"172.18.0.3:5000", []string{"198.51.100.7"}, "198.51.100.7"},
		{"[::1]:5000", []string{"2001:db8::1"}, "2001:db8::1"},
		// Trusted hops are skipped; what the client wrote to their left is not read.
		{"172.18.0.3:5000", []string{"203.0.113.66, 198.51.100.7, 10.0.0.5"}, "198.51.100.7"},
		{"172.18.0.3:5000", []string{"203.0.113.66", "198.51.100.7, 10.0.0.5"}, "198.51.100.7"},
		// The first untrusted hop wins, even if it is on the LAN.
		{"172.18.0.3:5000", []string{"198.51.100.7, 10.0.0.99"}, "10.0.0.99"},
		{"127.0.0.1:5000", []string{"198.51.100.7:4711"}, "198.51.100.7"},
		{"127.0.0.1:5000", []string{"[2001:db8::1]:443"}, "2001:db8::1"},
		{"127.0.0.1:5000", []string{"::ffff:198.51.100.7"}, "198.51.100.7"},
		// An unreadable entry stops the walk at the last proxy reached.
		{"127.0.0.1:5000", []string{"198.51.100.7, not-an-address"}, "127.0.0.1"},
		{"127.0.0.1:5000", []string{"198.51.100.7, not-an-address, 10.0.0.5"}, "10.0.0.5"},
		{"127.0.0.1:5000", []string{"10.0.0.5"}, "10.0.0.5"},
		{"127.0.0.1:5000", nil, "127.0.0.1"},
		// A peer that is not a listed proxy is the client, whatever it sends,
		// private address or not.
		{"203.0.113.5:5000", []string{"198.51.100.7"}, "203.0.113.5"},
		{"10.0.1.4:5000", []string{"198.51.100.7"}, "10.0.1.4"},
		{"10.0.0.99:5000", []string{"198.51.100.7"}, "10.0.0.99"},
	} {
		r := httptest.NewRequest(http.MethodPost, "/", nil)
		r.RemoteAddr = tc.peer
		for _, v := range tc.xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := s.clientIP(r); got != tc.want {
			t.Errorf("peer %s, X-Forwarded-For %q: client %q, want %q", tc.peer, tc.xff, got, tc.want)
		}
	}

	// CF-Connecting-IP and X-Real-IP are never read, even from a trusted proxy.
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("CF-Connecting-IP", "198.51.100.7")
	r.Header.Set("X-Real-IP", "198.51.100.8")
	if got := s.clientIP(r); got != "127.0.0.1" {
		t.Errorf("CF-Connecting-IP / X-Real-IP changed the client to %q", got)
	}

	// With no proxies configured (the default) the peer is always the client.
	s.cfg.TrustedProxies = nil
	r = httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	r.Header.Set("X-Forwarded-For", "198.51.100.7")
	if got := s.clientIP(r); got != "127.0.0.1" {
		t.Errorf("with no trusted proxies: client %q, want the peer", got)
	}
}
