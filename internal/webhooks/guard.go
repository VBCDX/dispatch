package webhooks

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"
)

// ErrBlockedAddress is a delivery refused because its host resolves to a
// private, loopback, link-local or otherwise internal address, and
// WEBHOOK_ALLOW_PRIVATE is off.
var ErrBlockedAddress = errors.New("webhooks: target resolves to a private or internal address")

// Ranges net/netip has no predicate for, that must never be reachable from
// a webhook either.
var extraBlocked = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),       // "this network"
	netip.MustParsePrefix("100.64.0.0/10"),   // carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),    // IETF protocol assignments
	netip.MustParsePrefix("192.0.2.0/24"),    // documentation
	netip.MustParsePrefix("198.18.0.0/15"),   // benchmarking
	netip.MustParsePrefix("198.51.100.0/24"), // documentation
	netip.MustParsePrefix("203.0.113.0/24"),  // documentation
	netip.MustParsePrefix("240.0.0.0/4"),     // reserved, and broadcast
	netip.MustParsePrefix("64:ff9b::/96"),    // NAT64: could map to any IPv4 address
	netip.MustParsePrefix("64:ff9b:1::/48"),  // local-use NAT64
	netip.MustParsePrefix("2001:db8::/32"),   // documentation
}

// Blocked reports whether a delivery may not connect to addr.
func Blocked(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast() || addr.IsMulticast() || addr.IsUnspecified() {
		return true
	}
	for _, p := range extraBlocked {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// ValidateURL checks a webhook target as typed by an admin: an absolute
// https URL, or http only for localhost. Whether the host may be reached
// is decided when connecting, not here, because DNS can change.
func ValidateURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if len(raw) > 2048 {
		return nil, errors.New("the URL is longer than 2048 characters")
	}
	u, err := url.Parse(raw)
	switch {
	case err != nil || u.Host == "" || u.Hostname() == "":
		return nil, errors.New("the URL must be absolute, like https://example.com/hooks/dispatch")
	case u.User != nil:
		return nil, errors.New("the URL must not contain a user name or password")
	case u.Fragment != "":
		return nil, errors.New("the URL must not contain a #fragment")
	case u.Scheme == "https":
	case u.Scheme == "http" && isLocalhost(u.Hostname()):
	default:
		return nil, errors.New("the URL must use https (http is allowed only for localhost)")
	}
	return u, nil
}

func isLocalhost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	a, err := netip.ParseAddr(host)
	return err == nil && a.Unmap().IsLoopback()
}

// NewClient returns the HTTP client deliveries use. Every connection is
// checked after DNS resolution, at dial time, so a name that resolves to an
// internal address (or is re-pointed at one later) is refused unless
// allowPrivate is set. Redirects are not followed and no proxy is used: a
// redirect or proxy would otherwise route around the check.
func NewClient(timeout time.Duration, allowPrivate bool) *http.Client {
	d := &net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	if !allowPrivate {
		d.Control = func(network, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil {
				return fmt.Errorf("%w: %s", ErrBlockedAddress, address)
			}
			if Blocked(ap.Addr()) {
				return fmt.Errorf("%w: %s", ErrBlockedAddress, ap.Addr())
			}
			return nil
		}
	}
	tr := &http.Transport{
		Proxy:                 nil,
		DialContext:           d.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   timeout,
		ResponseHeaderTimeout: timeout,
	}
	return &http.Client{
		Timeout:   timeout,
		Transport: tr,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// isBlocked reports whether err came from the address check.
func isBlocked(err error) bool { return errors.Is(err, ErrBlockedAddress) }
