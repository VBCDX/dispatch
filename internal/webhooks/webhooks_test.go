package webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/bus"
	"github.com/VBCDX/dispatch/internal/messaging"
	"github.com/VBCDX/dispatch/internal/store"
)

func TestSignAndVerify(t *testing.T) {
	const secret = "whsec_test"
	now := time.Unix(1_800_000_000, 0)
	body := []byte(`{"hello":"world"}`)
	sig := Sign(secret, now, body)
	if !strings.HasPrefix(sig, "t=1800000000,v1=") {
		t.Fatalf("signature = %q", sig)
	}
	if err := Verify(secret, sig, body, now.Add(time.Minute), SignatureTolerance); err != nil {
		t.Fatalf("own signature refused: %v", err)
	}
	other := Sign("whsec_other", now, body)
	for name, c := range map[string]struct {
		header string
		body   []byte
		now    time.Time
		want   error
	}{
		"tampered body":    {sig, []byte(`{"hello":"World"}`), now, ErrBadSignature},
		"wrong secret":     {other, body, now, ErrBadSignature},
		"too old":          {sig, body, now.Add(SignatureTolerance + time.Second), ErrStale},
		"from the future":  {sig, body, now.Add(-SignatureTolerance - time.Second), ErrStale},
		"empty":            {"", body, now, ErrNoSignature},
		"no timestamp":     {strings.Split(sig, ",")[1], body, now, ErrNoSignature},
		"garbage v1":       {"t=1800000000,v1=zz", body, now, ErrNoSignature},
		"timestamp moved":  {strings.Replace(sig, "t=1800000000", "t=1800000001", 1), body, now, ErrBadSignature},
		"second v1 checks": {other + "," + strings.Split(sig, ",")[1], body, now, nil},
	} {
		if err := Verify(secret, c.header, c.body, c.now, SignatureTolerance); !errors.Is(err, c.want) {
			t.Errorf("%s: Verify = %v, want %v", name, err, c.want)
		}
	}
}

func TestBlockedAddresses(t *testing.T) {
	for _, a := range []string{
		"127.0.0.1", "::1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "fe80::1",
		"fc00::1", "100.64.0.1", "0.0.0.0", "::", "224.0.0.1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
		"64:ff9b::a00:1", "255.255.255.255", "198.18.0.1",
	} {
		if !Blocked(netip.MustParseAddr(a)) {
			t.Errorf("%s is not blocked", a)
		}
	}
	for _, a := range []string{"1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "8.8.8.8"} {
		if Blocked(netip.MustParseAddr(a)) {
			t.Errorf("%s is blocked", a)
		}
	}
}

func TestValidateURL(t *testing.T) {
	for _, ok := range []string{"https://example.com/hook", "http://localhost:9000/x", "http://127.0.0.1/x", "https://10.0.0.1/x"} {
		if _, err := ValidateURL(ok); err != nil {
			t.Errorf("%s refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "example.com", "http://example.com/x", "ftp://example.com", "https://u:p@example.com", "https://example.com/#x", "/relative"} {
		if _, err := ValidateURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

// The address check runs when connecting, so a loopback target is refused
// unless private addresses are allowed.
func TestClientBlocksPrivateAddresses(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer ts.Close()
	_, err := NewClient(time.Second, false).Post(ts.URL, "application/json", strings.NewReader("{}"))
	if !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("loopback POST err = %v, want ErrBlockedAddress", err)
	}
	// "localhost" resolves to loopback: still refused.
	_, err = NewClient(time.Second, false).Post(strings.Replace(ts.URL, "127.0.0.1", "localhost", 1), "application/json", strings.NewReader("{}"))
	if !errors.Is(err, ErrBlockedAddress) {
		t.Fatalf("localhost POST err = %v, want ErrBlockedAddress", err)
	}
	res, err := NewClient(time.Second, true).Post(ts.URL, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("with private addresses allowed: %v", err)
	}
	res.Body.Close()
}

/* ---------------------------------------------------------------------- */
/* The delivery service, against local test servers                       */
/* ---------------------------------------------------------------------- */

type fakeStore struct {
	mu        sync.Mutex
	hooks     []store.WorkspaceWebhook
	listeners []store.WorkspaceListener
	attempts  []store.DeliveryAttempt
}

func (f *fakeStore) LoadWebhookConfig(context.Context) ([]store.WorkspaceWebhook, []store.WorkspaceListener, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]store.WorkspaceWebhook(nil), f.hooks...), append([]store.WorkspaceListener(nil), f.listeners...), nil
}

func (f *fakeStore) RecordDeliveryAttempt(_ context.Context, a store.DeliveryAttempt, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attempts = append(f.attempts, a)
	return nil
}

func (f *fakeStore) states() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, a := range f.attempts {
		out = append(out, a.State)
	}
	return out
}

func (f *fakeStore) last() store.DeliveryAttempt {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attempts[len(f.attempts)-1]
}

// waitFor polls cond until it holds or the time runs out.
func waitFor(t *testing.T, within time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type rig struct {
	t      *testing.T
	st     *fakeStore
	svc    *Service
	hub    *messaging.Hub
	secret string
}

const (
	testOrg = "org_t"
	testWS  = "ws_t"
)

// newRig runs a Service on a fresh embedded NATS with one webhook to url.
func newRig(t *testing.T, url string, opts Options, filter store.WebhookFilter) *rig {
	t.Helper()
	b, err := bus.Start(context.Background(), bus.Options{StoreDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.Close)
	box, err := NewBox(strings.Repeat("k", 40), "")
	if err != nil {
		t.Fatal(err)
	}
	secret := NewSecret()
	st := &fakeStore{hooks: []store.WorkspaceWebhook{{
		ID: "wh_t", OrgID: testOrg, WorkspaceID: testWS, Name: "test", URL: url,
		Filter: filter, SecretSealed: box.Seal(secret), SecretLast4: Last4(secret),
	}}}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := New(b, st, box, log, opts)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- svc.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("Run: %v", err)
		}
	})
	// Run creates the matcher consumer at the newest message; wait for it
	// before sending.
	waitFor(t, 5*time.Second, "the matcher consumer", func() bool {
		_, err := b.JetStream().Consumer(context.Background(), bus.MessagesStream, matcherName)
		return err == nil
	})
	return &rig{t: t, st: st, svc: svc, hub: messaging.NewHub(b, log), secret: secret}
}

// send publishes a message as an agent and returns how long the send took.
func (r *rig) send(body string) (messaging.Message, time.Duration) {
	r.t.Helper()
	m, err := messaging.NewMessage(testOrg, testWS, messaging.Author{Kind: "agent", ID: "ag_1", Label: "alpha"}, body, nil, "", time.Now())
	if err != nil {
		r.t.Fatal(err)
	}
	start := time.Now()
	if _, _, err := r.hub.Publish(context.Background(), m); err != nil {
		r.t.Fatal(err)
	}
	return m, time.Since(start)
}

type received struct {
	header http.Header
	body   []byte
}

// target is a webhook receiver whose answer the test controls.
type target struct {
	mu     sync.Mutex
	got    []received
	status atomic.Int32
	delay  atomic.Int64
}

func (tg *target) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	tg.mu.Lock()
	tg.got = append(tg.got, received{r.Header.Clone(), b})
	tg.mu.Unlock()
	if d := time.Duration(tg.delay.Load()); d > 0 {
		select {
		case <-time.After(d):
		case <-r.Context().Done():
		}
	}
	w.WriteHeader(int(tg.status.Load()))
}

func (tg *target) count() int {
	tg.mu.Lock()
	defer tg.mu.Unlock()
	return len(tg.got)
}

func (tg *target) at(i int) received {
	tg.mu.Lock()
	defer tg.mu.Unlock()
	return tg.got[i]
}

var fast = []time.Duration{50 * time.Millisecond, 50 * time.Millisecond, 50 * time.Millisecond}

// A failing target is retried with backoff until it answers 2xx; every
// attempt is signed with the webhook's secret and carries the same
// delivery ID and the message.
func TestDeliveryRetriesUntilDelivered(t *testing.T) {
	tg := &target{}
	tg.status.Store(503)
	ts := httptest.NewServer(tg)
	defer ts.Close()
	r := newRig(t, ts.URL+"/hook", Options{AllowPrivate: true, Backoff: fast}, store.DefaultWebhookFilter())

	m, _ := r.send("deploy finished")
	waitFor(t, 5*time.Second, "two failed attempts", func() bool { return tg.count() >= 2 })
	tg.status.Store(200)
	waitFor(t, 5*time.Second, "delivery", func() bool { s := r.st.states(); return len(s) > 0 && s[len(s)-1] == "delivered" })

	if got := r.st.states(); strings.Join(got, ",") != "retrying,retrying,delivered" {
		t.Fatalf("states = %v", got)
	}
	var deliveryID string
	for i := range tg.count() {
		rc := tg.at(i)
		if err := Verify(r.secret, rc.header.Get(SignatureHeader), rc.body, time.Now(), SignatureTolerance); err != nil {
			t.Fatalf("attempt %d: signature: %v", i+1, err)
		}
		if rc.header.Get(EventHeader) != EventMessage || rc.header.Get(WebhookHeader) != "wh_t" {
			t.Fatalf("attempt %d headers: %v", i+1, rc.header)
		}
		var env Envelope
		if err := json.Unmarshal(rc.body, &env); err != nil {
			t.Fatal(err)
		}
		var msg messaging.Message
		if err := json.Unmarshal(env.Message, &msg); err != nil {
			t.Fatal(err)
		}
		if msg.ID != m.ID || msg.Body != "deploy finished" || env.Type != EventMessage || env.WorkspaceID != testWS || env.Seq == 0 {
			t.Fatalf("attempt %d envelope = %+v, message %+v", i+1, env, msg)
		}
		if deliveryID == "" {
			deliveryID = env.ID
		}
		if env.ID != deliveryID || rc.header.Get(DeliveryHeader) != deliveryID {
			t.Fatalf("attempt %d delivery ID %q, want the same %q on every attempt", i+1, env.ID, deliveryID)
		}
	}
	if last := r.st.last(); last.DeliveryID != deliveryID || last.Attempt.Status != 200 || last.MessageID != m.ID {
		t.Fatalf("last record = %+v", last)
	}
}

// When every attempt fails, the delivery becomes a dead letter carrying
// the exact body; redelivering it reaches the target once it is back.
func TestDeadLetterAndRedeliver(t *testing.T) {
	tg := &target{}
	tg.status.Store(500)
	ts := httptest.NewServer(tg)
	defer ts.Close()
	r := newRig(t, ts.URL, Options{AllowPrivate: true, Backoff: fast[:2]}, store.DefaultWebhookFilter())

	r.send("will fail")
	waitFor(t, 5*time.Second, "a dead letter", func() bool { s := r.st.states(); return len(s) > 0 && s[len(s)-1] == "dead" })
	if got := r.st.states(); strings.Join(got, ",") != "retrying,retrying,dead" || tg.count() != 3 {
		t.Fatalf("states = %v after %d attempts, want 3 attempts then dead", got, tg.count())
	}
	dead := r.st.last()
	if dead.URL != ts.URL || string(dead.Body) != string(tg.at(0).body) {
		t.Fatalf("dead letter = %+v", dead)
	}

	tg.status.Store(204)
	if err := r.svc.Redeliver(context.Background(), store.WebhookDeadLetter{
		WorkspaceID: testWS, WebhookID: "wh_t", DeliveryID: dead.DeliveryID, MessageID: dead.MessageID, Seq: dead.Seq, Body: dead.Body,
	}, testOrg); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, "redelivery", func() bool { return r.st.last().State == "delivered" })
	if got := tg.at(tg.count() - 1); string(got.body) != string(dead.Body) || got.header.Get(DeliveryHeader) != dead.DeliveryID {
		t.Fatalf("redelivered %s %v", got.body, got.header)
	}
}

// A target on a private address is refused without trying again, and
// nothing reaches it.
func TestPrivateAddressIsBlocked(t *testing.T) {
	tg := &target{}
	tg.status.Store(200)
	ts := httptest.NewServer(tg)
	defer ts.Close()
	r := newRig(t, ts.URL, Options{Backoff: fast}, store.DefaultWebhookFilter())

	r.send("to an internal host")
	waitFor(t, 5*time.Second, "a dead letter", func() bool { s := r.st.states(); return len(s) > 0 && s[len(s)-1] == "dead" })
	if got := r.st.states(); len(got) != 1 {
		t.Fatalf("states = %v, want one attempt and dead", got)
	}
	if note := r.st.last().Attempt.Note; !strings.Contains(note, "private") {
		t.Fatalf("note = %q", note)
	}
	if tg.count() != 0 {
		t.Fatalf("the private target received %d requests", tg.count())
	}
}

// A message sent while the target is down (connection refused) is
// delivered once it comes back, and sending never waits on it.
func TestTargetDownThenBack(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close() // down: connections are refused
	r := newRig(t, "http://"+addr+"/hook", Options{AllowPrivate: true, Backoff: []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 300 * time.Millisecond, time.Second, time.Second}}, store.DefaultWebhookFilter())

	m, took := r.send("sent while the target was down")
	if took > 250*time.Millisecond {
		t.Fatalf("send took %s with the target down", took)
	}
	waitFor(t, 5*time.Second, "a failed attempt", func() bool { return len(r.st.states()) >= 1 })

	tg := &target{}
	tg.status.Store(200)
	ln, err = net.Listen("tcp", addr)
	if err != nil {
		t.Skipf("could not listen on %s again: %v", addr, err)
	}
	srv := &http.Server{Handler: tg}
	go srv.Serve(ln)
	defer srv.Close()

	waitFor(t, 10*time.Second, "delivery after the target came back", func() bool { return r.st.last().State == "delivered" })
	var env Envelope
	_ = json.Unmarshal(tg.at(0).body, &env)
	var msg messaging.Message
	_ = json.Unmarshal(env.Message, &msg)
	if msg.ID != m.ID {
		t.Fatalf("delivered %s, want %s", msg.ID, m.ID)
	}
}

// A slow target doesn't slow sending: messages publish in their usual time
// while deliveries hang.
func TestSlowTargetDoesNotSlowSending(t *testing.T) {
	tg := &target{}
	tg.status.Store(200)
	tg.delay.Store(int64(2 * time.Second))
	ts := httptest.NewServer(tg)
	defer ts.Close()
	r := newRig(t, ts.URL, Options{AllowPrivate: true, Timeout: 500 * time.Millisecond, Backoff: fast}, store.DefaultWebhookFilter())

	var worst time.Duration
	for i := range 50 {
		_, took := r.send("message " + string(rune('a'+i%26)))
		worst = max(worst, took)
	}
	if worst > 250*time.Millisecond {
		t.Fatalf("slowest send took %s while the target hung", worst)
	}
	waitFor(t, 5*time.Second, "the hung deliveries to time out and retry", func() bool {
		r.st.mu.Lock()
		defer r.st.mu.Unlock()
		for _, a := range r.st.attempts {
			if a.State == "retrying" && strings.Contains(a.Attempt.Note, "timed out") {
				return true
			}
		}
		return false
	})
}

// Paused webhooks and filtered-out messages get nothing; listener messages
// are left out by default.
func TestFiltersAndPause(t *testing.T) {
	tg := &target{}
	tg.status.Store(200)
	ts := httptest.NewServer(tg)
	defer ts.Close()
	r := newRig(t, ts.URL, Options{AllowPrivate: true, Backoff: fast}, store.WebhookFilter{AuthorKinds: []string{"agent"}, Threads: "all", Contains: "deploy"})

	r.send("unrelated chatter")
	m, _ := r.send("Deploy done")
	lm, _ := messaging.NewMessage(testOrg, testWS, messaging.Author{Kind: "listener", ID: "lsn_1", Label: "ci"}, "deploy from CI", nil, "", time.Now())
	if _, _, err := r.hub.Publish(context.Background(), lm); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, "one delivery", func() bool { return tg.count() >= 1 })
	time.Sleep(200 * time.Millisecond)
	if tg.count() != 1 || r.st.last().MessageID != m.ID {
		t.Fatalf("got %d deliveries, want only %s", tg.count(), m.ID)
	}

	r.st.mu.Lock()
	r.st.hooks[0].Paused = true
	r.st.mu.Unlock()
	if err := r.svc.Reload(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.send("deploy while paused")
	time.Sleep(300 * time.Millisecond)
	if tg.count() != 1 {
		t.Fatalf("a paused webhook received a delivery")
	}
}

func TestBoxKeepsSecretsAcrossRestarts(t *testing.T) {
	keyFile := t.TempDir() + "/webhook.key"
	a, err := NewBox("", keyFile)
	if err != nil {
		t.Fatal(err)
	}
	sealed := a.Seal("whsec_x")
	b, err := NewBox("", keyFile)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := b.Open(sealed); err != nil || got != "whsec_x" {
		t.Fatalf("reopened = %q, %v", got, err)
	}
	c, _ := NewBox(strings.Repeat("s", 40), keyFile)
	if _, err := c.Open(sealed); err == nil {
		t.Fatal("a box with another key opened the secret")
	}
	if s := NewSecret(); !strings.HasPrefix(s, SecretPrefix) || len(s) != len(SecretPrefix)+32 {
		t.Fatalf("NewSecret = %q", s)
	}
}
