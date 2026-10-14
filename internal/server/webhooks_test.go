package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
	"github.com/VBCDX/dispatch/internal/webhooks"
)

const relBase = "/api/v1/orgs/org_acme/workspaces/" + relWS

// runWebhooks starts webhook delivery with the given options, replacing
// the service New built, and waits for it to load.
func (h *harness) runWebhooks(opts webhooks.Options) {
	h.t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	h.srv.hooks = webhooks.New(h.srv.bus, h.st, h.srv.hooks.Box(), log, opts)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { h.srv.RunWebhooks(ctx); close(done) }()
	h.t.Cleanup(func() { cancel(); <-done })
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, loaded := h.srv.hooks.Listener("lsn_none"); loaded {
			if _, err := h.srv.bus.JetStream().Consumer(ctx, "DISPATCH_MESSAGES", "webhooks"); err == nil {
				return
			}
		}
		if time.Now().After(deadline) {
			h.t.Fatal("webhook delivery did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type tabResponse struct {
	Webhooks      []webhookJSON      `json:"webhooks"`
	Listeners     []listenerJSON     `json:"listeners"`
	Deliveries    []deliveryJSON     `json:"deliveries"`
	DeadLetters   []deadLetterJSON   `json:"dead_letters"`
	ListenerCalls []listenerCallJSON `json:"listener_calls"`
	CanAdmin      bool               `json:"can_admin"`
}

func (h *harness) tab(c *http.Client) tabResponse {
	h.t.Helper()
	return decode[tabResponse](h.t, h.get(c, relBase+"/webhooks", http.StatusOK))
}

// eventually polls the Webhooks tab until cond holds.
func (h *harness) eventually(c *http.Client, what string, cond func(tabResponse) bool) tabResponse {
	h.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		t := h.tab(c)
		if cond(t) {
			return t
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting for %s; tab = %+v", what, t)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

type hookTarget struct {
	mu     sync.Mutex
	bodies [][]byte
	sigs   []string
	status atomic.Int32
}

func (tg *hookTarget) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	tg.mu.Lock()
	tg.bodies = append(tg.bodies, b)
	tg.sigs = append(tg.sigs, r.Header.Get(webhooks.SignatureHeader))
	tg.mu.Unlock()
	w.WriteHeader(int(tg.status.Load()))
}

func (tg *hookTarget) count() int {
	tg.mu.Lock()
	defer tg.mu.Unlock()
	return len(tg.bodies)
}

type createdHook struct {
	Webhook webhookJSON `json:"webhook"`
	Secret  string      `json:"secret"`
}

type createdListener struct {
	Listener listenerJSON `json:"listener"`
	Secret   string       `json:"secret"`
}

// A workspace admin adds a webhook; an agent's message reaches it signed;
// a failing target retries into a dead letter that the admin redelivers;
// every change is audited.
func TestWebhookLifecycle(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		h.runArchiver()
		h.runWebhooks(webhooks.Options{AllowPrivate: true, Backoff: []time.Duration{50 * time.Millisecond, 50 * time.Millisecond}})
		dana, mia := h.as("u_dana"), h.as("u_mia")

		tg := &hookTarget{}
		tg.status.Store(200)
		ts := httptest.NewServer(tg)
		defer ts.Close()

		// Only admins write; URLs are checked.
		h.write(mia, http.MethodPost, relBase+"/webhooks", map[string]any{"name": "x", "url": ts.URL}, http.StatusForbidden)
		h.write(dana, http.MethodPost, relBase+"/webhooks", map[string]any{"name": "x", "url": "http://example.com/hook"}, http.StatusBadRequest)
		h.write(dana, http.MethodPost, relBase+"/webhooks", map[string]any{"name": "", "url": "https://example.com/hook"}, http.StatusBadRequest)
		h.write(dana, http.MethodPost, relBase+"/webhooks", map[string]any{"name": "x", "url": "https://example.com/hook",
			"filter": map[string]any{"threads": "sideways"}}, http.StatusBadRequest)

		created := decode[createdHook](t, h.write(dana, http.MethodPost, relBase+"/webhooks",
			map[string]any{"name": "CI", "url": ts.URL + "/hook"}, http.StatusCreated))
		hook := created.Webhook
		if !strings.HasPrefix(created.Secret, webhooks.SecretPrefix) || hook.SecretLast4 != webhooks.Last4(created.Secret) ||
			strings.Join(hook.Filter.AuthorKinds, ",") != "agent,user" || hook.Filter.Threads != "all" {
			t.Fatalf("created %+v", created)
		}
		// The tab never shows the secret, and a plain member can read it.
		tab := h.tab(mia)
		if len(tab.Webhooks) != 1 || tab.CanAdmin || tab.Webhooks[0].ID != hook.ID {
			t.Fatalf("Mia's tab = %+v", tab)
		}
		raw := readAll(t, h.get(mia, relBase+"/webhooks", http.StatusOK))
		if strings.Contains(raw, created.Secret) || strings.Contains(raw, "sealed") {
			t.Fatal("the tab leaks the secret")
		}

		// An agent's message is delivered, signed with the secret.
		agent := h.enroll(h.person("u_dana"), relWS, "hook-sender")
		if res := h.agentPost(agent, map[string]any{"body": "release cut"}); res.StatusCode != http.StatusCreated {
			t.Fatalf("agent send = %d", res.StatusCode)
		}
		h.eventually(dana, "a delivered delivery", func(t tabResponse) bool {
			return len(t.Deliveries) == 1 && t.Deliveries[0].State == "delivered"
		})
		tg.mu.Lock()
		body, sig := tg.bodies[0], tg.sigs[0]
		tg.mu.Unlock()
		if err := webhooks.Verify(created.Secret, sig, body, time.Now(), webhooks.SignatureTolerance); err != nil {
			t.Fatalf("delivery signature: %v", err)
		}
		var env webhooks.Envelope
		if err := json.Unmarshal(body, &env); err != nil || env.Type != "message.created" || !strings.Contains(string(env.Message), "release cut") {
			t.Fatalf("envelope %s (%v)", body, err)
		}

		// Rotating the secret signs later deliveries with the new one only.
		rotated := decode[createdHook](t, h.write(dana, http.MethodPost, relBase+"/webhooks/"+hook.ID+"/secret/rotate", nil, http.StatusOK))
		if rotated.Secret == created.Secret || rotated.Webhook.SecretLast4 != webhooks.Last4(rotated.Secret) {
			t.Fatalf("rotate = %+v", rotated)
		}

		// The target fails: two retries, then a dead letter.
		tg.status.Store(500)
		h.agentPost(agent, map[string]any{"body": "second"})
		tab = h.eventually(dana, "a dead letter", func(t tabResponse) bool { return len(t.DeadLetters) == 1 })
		dl := tab.DeadLetters[0]
		if len(dl.Attempts) != 3 || dl.Attempts[0].Status != 500 || dl.URL != ts.URL+"/hook" {
			t.Fatalf("dead letter = %+v", dl)
		}
		tg.mu.Lock()
		last, lastSig := tg.bodies[len(tg.bodies)-1], tg.sigs[len(tg.sigs)-1]
		tg.mu.Unlock()
		if webhooks.Verify(rotated.Secret, lastSig, last, time.Now(), webhooks.SignatureTolerance) != nil ||
			webhooks.Verify(created.Secret, lastSig, last, time.Now(), webhooks.SignatureTolerance) == nil {
			t.Fatal("after rotation, deliveries must be signed with the new secret only")
		}

		// Redelivery: Mia may not; Dana may, and it lands once the target is back.
		h.write(mia, http.MethodPost, relBase+"/webhook-dead-letters/"+dl.ID+"/redeliver", nil, http.StatusForbidden)
		tg.status.Store(200)
		h.write(dana, http.MethodPost, relBase+"/webhook-dead-letters/"+dl.ID+"/redeliver", nil, http.StatusAccepted)
		h.write(dana, http.MethodPost, relBase+"/webhook-dead-letters/"+dl.ID+"/redeliver", nil, http.StatusNotFound)
		h.eventually(dana, "the redelivery", func(t tabResponse) bool {
			for _, d := range t.Deliveries {
				if d.ID == dl.DeliveryID {
					return d.State == "delivered" && len(t.DeadLetters) == 0
				}
			}
			return false
		})

		// Pause stops deliveries; edit and delete work; all of it is audited.
		paused := true
		h.write(dana, http.MethodPatch, relBase+"/webhooks/"+hook.ID, map[string]any{"paused": paused}, http.StatusOK)
		n := tg.count()
		h.agentPost(agent, map[string]any{"body": "while paused"})
		time.Sleep(300 * time.Millisecond)
		if tg.count() != n {
			t.Fatal("a paused webhook was called")
		}
		h.write(dana, http.MethodPatch, relBase+"/webhooks/"+hook.ID, map[string]any{"name": "CI builds",
			"filter": map[string]any{"author_kinds": []string{"agent"}, "contains": "deploy"}}, http.StatusOK)
		h.write(dana, http.MethodDelete, relBase+"/webhooks/"+hook.ID, nil, http.StatusNoContent)
		h.write(dana, http.MethodDelete, relBase+"/webhooks/"+hook.ID, nil, http.StatusNotFound)

		audit := decode[auditResponse](t, h.get(dana, relBase+"/audit?type=webhook", http.StatusOK))
		got := strings.Join(objects(audit.Events), "\n")
		for _, want := range []string{
			"Added webhook CI to Release train",
			"Rotated the signing secret of webhook CI in Release train",
			"Redelivered message",
			"Paused webhook CI in Release train",
			"Changed webhook CI builds in Release train",
			"Deleted webhook CI builds from Release train",
		} {
			if !strings.Contains(got, want) {
				t.Errorf("audit is missing %q; have:\n%s", want, got)
			}
		}
		if tab := h.tab(dana); len(tab.Webhooks) != 0 || len(tab.Deliveries) != 0 {
			t.Fatalf("after delete, tab = %+v", tab)
		}
	})
}

// signedPost calls a listener URL with a body signed by secret.
func (h *harness) signedPost(url, secret string, body []byte) *http.Response {
	h.t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if secret != "" {
		req.Header.Set(webhooks.SignatureHeader, webhooks.Sign(secret, time.Now(), body))
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { res.Body.Close() })
	return res
}

// A signed call to a listener becomes a message from that listener: agents
// receive it live, it is archived with the caller's address, and the call
// is recorded. Unsigned, stale or paused calls are refused and recorded.
func TestListenerCallBecomesMessage(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		h.runArchiver()
		h.runWebhooks(webhooks.Options{})
		dana := h.as("u_dana")
		agentT := h.enroll(h.person("u_dana"), relWS, "watcher")
		agent := h.dialAgent(agentT)

		h.write(h.as("u_mia"), http.MethodPost, relBase+"/listeners", map[string]any{"name": "GitHub"}, http.StatusForbidden)
		cl := decode[createdListener](t, h.write(dana, http.MethodPost, relBase+"/listeners", map[string]any{"name": "GitHub"}, http.StatusCreated))
		if !strings.HasPrefix(cl.Secret, webhooks.SecretPrefix) || cl.Listener.URL != h.ts.URL+"/hooks/v1/"+cl.Listener.ID {
			t.Fatalf("created %+v", cl)
		}
		url := strings.Replace(cl.Listener.URL, h.ts.URL, h.ts.URL, 1)

		// Refused calls.
		body := []byte(`{"body":"build 4.2 is green","payload":{"build":"4.2"}}`)
		if res := h.signedPost(url, "", body); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unsigned call = %d", res.StatusCode)
		}
		if res := h.signedPost(url, "whsec_wrong", body); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("wrongly signed call = %d", res.StatusCode)
		}
		req, _ := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
		req.Header.Set(webhooks.SignatureHeader, webhooks.Sign(cl.Secret, time.Now().Add(-10*time.Minute), body))
		if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("stale call = %v, %v", res, err)
		} else {
			res.Body.Close()
		}
		if res := h.signedPost(h.ts.URL+"/hooks/v1/lsn_nope", cl.Secret, body); res.StatusCode != http.StatusNotFound {
			t.Fatalf("unknown listener = %d", res.StatusCode)
		}

		// The good call.
		res := h.signedPost(url, cl.Secret, body)
		if res.StatusCode != http.StatusAccepted {
			t.Fatalf("signed call = %d: %s", res.StatusCode, readAll(t, res))
		}
		accepted := decode[struct {
			MessageID string `json:"message_id"`
		}](t, res)
		got := next(t, agent, "msg")
		if got.Message.ID != accepted.MessageID || got.Message.Body != "build 4.2 is green" ||
			got.Message.Author.Kind != "listener" || got.Message.Author.ID != cl.Listener.ID || got.Message.Author.Label != "GitHub" ||
			!strings.Contains(string(got.Message.Payload), `"build":"4.2"`) {
			t.Fatalf("agent got %+v", got.Message)
		}
		if strings.Contains(string(mustJSON(t, got.Message)), "127.0.0.1") {
			t.Fatal("the caller's address reached the agent")
		}

		// Any other JSON document becomes the payload.
		if res := h.signedPost(url, cl.Secret, []byte(`{"action":"opened","number":7}`)); res.StatusCode != http.StatusAccepted {
			t.Fatalf("raw JSON call = %d", res.StatusCode)
		}
		if m := next(t, agent, "msg"); m.Message.Body != "Call to listener GitHub" || !strings.Contains(string(m.Message.Payload), `"number":7`) {
			t.Fatalf("raw JSON became %+v", m.Message)
		}

		// Paused: 410.
		h.write(dana, http.MethodPatch, relBase+"/listeners/"+cl.Listener.ID, map[string]any{"paused": true}, http.StatusOK)
		if res := h.signedPost(url, cl.Secret, body); res.StatusCode != http.StatusGone {
			t.Fatalf("paused call = %d", res.StatusCode)
		}

		// Calls are recorded, with the address for admins only.
		tab := h.eventually(dana, "five recorded calls", func(t tabResponse) bool { return len(t.ListenerCalls) >= 6 })
		statuses := map[int]int{}
		for _, c := range tab.ListenerCalls {
			statuses[c.Status]++
			if c.FromIP == "" {
				t.Errorf("an admin's call row has no address: %+v", c)
			}
		}
		if statuses[401] != 3 || statuses[202] != 2 || statuses[410] != 1 {
			t.Fatalf("call statuses = %v", statuses)
		}
		if l := tab.Listeners[0]; l.CallCount != 2 || l.LastCallAt == nil || !l.Paused {
			t.Fatalf("listener = %+v", l)
		}
		for _, c := range h.tab(h.as("u_mia")).ListenerCalls {
			if c.FromIP != "" {
				t.Fatal("a plain member sees callers' addresses")
			}
		}

		// The archive keeps the caller's address and labels the author.
		deadline := time.Now().Add(5 * time.Second)
		for {
			ms, err := h.st.ListMessages(context.Background(), "org_acme", relWS, store.MessageFilter{Limit: 10})
			if err != nil {
				t.Fatal(err)
			}
			var found *store.Message
			for i := range ms {
				if ms[i].ID == accepted.MessageID {
					found = &ms[i]
				}
			}
			if found != nil {
				if found.Author.Kind != "listener" || found.Author.From != "127.0.0.1" {
					t.Fatalf("archived author = %+v", found.Author)
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the listener's message was not archived")
			}
			time.Sleep(25 * time.Millisecond)
		}
		list := decode[messagesResponse](t, h.get(dana, relBase+"/messages", http.StatusOK))
		for _, m := range list.Messages {
			if m.ID == accepted.MessageID && m.Author.Label != "GitHub" {
				t.Fatalf("history labels the listener %q", m.Author.Label)
			}
		}

		// Rotate and delete.
		rot := decode[createdListener](t, h.write(dana, http.MethodPost, relBase+"/listeners/"+cl.Listener.ID+"/secret/rotate", nil, http.StatusOK))
		h.write(dana, http.MethodPatch, relBase+"/listeners/"+cl.Listener.ID, map[string]any{"paused": false}, http.StatusOK)
		if res := h.signedPost(url, cl.Secret, body); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("old secret after rotation = %d", res.StatusCode)
		}
		if res := h.signedPost(url, rot.Secret, body); res.StatusCode != http.StatusAccepted {
			t.Fatalf("new secret after rotation = %d", res.StatusCode)
		}
		h.write(dana, http.MethodDelete, relBase+"/listeners/"+cl.Listener.ID, nil, http.StatusNoContent)
		if res := h.signedPost(url, rot.Secret, body); res.StatusCode != http.StatusNotFound {
			t.Fatalf("deleted listener = %d", res.StatusCode)
		}
		audit := decode[auditResponse](t, h.get(dana, relBase+"/audit?type=webhook", http.StatusOK))
		got2 := strings.Join(objects(audit.Events), "\n")
		for _, want := range []string{"Added listener GitHub", "Paused listener GitHub", "Resumed listener GitHub",
			"Rotated the signing secret of listener GitHub", "Deleted listener GitHub"} {
			if !strings.Contains(got2, want) {
				t.Errorf("audit is missing %q; have:\n%s", want, got2)
			}
		}

		// Deleting the workspace closes its listeners at once.
		other := decode[createdListener](t, h.write(dana, http.MethodPost, relBase+"/listeners", map[string]any{"name": "Sentry"}, http.StatusCreated))
		if res := h.signedPost(other.Listener.URL, other.Secret, body); res.StatusCode != http.StatusAccepted {
			t.Fatalf("second listener = %d", res.StatusCode)
		}
		h.write(dana, http.MethodDelete, relBase, nil, http.StatusNoContent)
		if res := h.signedPost(other.Listener.URL, other.Secret, body); res.StatusCode != http.StatusNotFound {
			t.Fatalf("listener of a deleted workspace = %d", res.StatusCode)
		}
	})
}

// With WEBHOOK_ALLOW_PRIVATE off (the default), a webhook pointed at a
// loopback address is never called: its delivery goes straight to the
// dead letters, saying why.
func TestWebhookPrivateAddressBlockedByDefault(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		h.runWebhooks(webhooks.Options{Backoff: []time.Duration{time.Millisecond}})
		dana := h.as("u_dana")
		tg := &hookTarget{}
		tg.status.Store(200)
		ts := httptest.NewServer(tg)
		defer ts.Close()
		h.write(dana, http.MethodPost, relBase+"/webhooks", map[string]any{"name": "internal", "url": ts.URL}, http.StatusCreated)
		h.post(h.person("u_dana"), relBase+"/messages", map[string]string{"body": "hello"}, http.StatusCreated)
		tab := h.eventually(dana, "a dead letter", func(t tabResponse) bool { return len(t.DeadLetters) == 1 })
		if a := tab.DeadLetters[0].Attempts; len(a) != 1 || !strings.Contains(a[0].Note, "private") {
			t.Fatalf("attempts = %+v", a)
		}
		if tg.count() != 0 {
			t.Fatalf("the loopback target was called %d times", tg.count())
		}
	})
}

func mustJSON(t testing.TB, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
