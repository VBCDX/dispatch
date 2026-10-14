package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/VBCDX/dispatch/internal/config"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

type wsClient struct {
	t    testing.TB
	conn *websocket.Conn
}

func (h *harness) dialWS(c *http.Client, header http.Header) (*wsClient, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.ts.URL, "http")+"/api/ws",
		&websocket.DialOptions{HTTPClient: c, HTTPHeader: header})
	if err != nil {
		return nil, res, err
	}
	conn.SetReadLimit(wsMaxFrame)
	h.t.Cleanup(func() { conn.CloseNow() })
	return &wsClient{t: h.t, conn: conn}, res, nil
}

func (h *harness) mustDialWS(c *http.Client) *wsClient {
	h.t.Helper()
	ws, _, err := h.dialWS(c, nil)
	if err != nil {
		h.t.Fatalf("dial WebSocket: %v", err)
	}
	return ws
}

func (w *wsClient) send(v any) {
	w.t.Helper()
	b, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := w.conn.Write(ctx, websocket.MessageText, b); err != nil {
		w.t.Fatalf("ws write: %v", err)
	}
}

// recv reads one frame. A timeout closes the connection (coder/websocket
// closes on a cancelled read), so a "nothing arrives" check must come last.
func (w *wsClient) recv(timeout time.Duration) (wsOut, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	_, b, err := w.conn.Read(ctx)
	if err != nil {
		return wsOut{}, err
	}
	var out wsOut
	if err := json.Unmarshal(b, &out); err != nil {
		w.t.Fatalf("server sent invalid JSON %q", b)
	}
	return out, nil
}

func (w *wsClient) expect(op string) wsOut {
	w.t.Helper()
	out, err := w.recv(5 * time.Second)
	if err != nil {
		w.t.Fatalf("waiting for %q: %v", op, err)
	}
	if out.Op != op {
		w.t.Fatalf("got %+v, want op %q", out, op)
	}
	return out
}

func (h *harness) signedInClient(email string) *http.Client {
	h.t.Helper()
	h.createUser(email, testPassword)
	c := h.client()
	if res := h.login(c, email, testPassword); res.StatusCode != http.StatusOK {
		h.t.Fatalf("login %s = %d", email, res.StatusCode)
	}
	return c
}

// Acceptance criterion 5: publish and receive over the WebSocket through
// the embedded NATS server.
func TestWebSocketPublishReceive(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := newHarness(t, b, config.AuthLocal, nil)
		c := h.signedInClient("ty@example.com")
		sub, pub := h.mustDialWS(c), h.mustDialWS(c)

		sub.send(wsIn{Op: "sub", Subject: "room.*"})
		sub.expect("subscribed")

		pub.send(wsIn{Op: "pub", Subject: "room.a", Data: json.RawMessage(`{"text":"hello"}`), ID: "1"})
		if ack := pub.expect("ack"); ack.ID != "1" {
			t.Fatalf("ack = %+v", ack)
		}
		msg := sub.expect("msg")
		if msg.Subject != "room.a" || string(msg.Data) != `{"text":"hello"}` {
			t.Fatalf("msg = %+v (subjects must be relative to the user's space)", msg)
		}

		sub.send(wsIn{Op: "unsub", Subject: "room.*"})
		sub.expect("unsubscribed") // the two sockets are not ordered; wait for the unsub to land
		pub.send(wsIn{Op: "pub", Subject: "room.a", Data: json.RawMessage(`2`), ID: "2"})
		pub.expect("ack")
		if out, err := sub.recv(300 * time.Millisecond); err == nil {
			t.Fatalf("received %+v after unsubscribing", out)
		}
	})
}

func TestWebSocketUsersAreIsolated(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthLocal, nil)
	alice := h.mustDialWS(h.signedInClient("alice@example.com"))
	mallory := h.mustDialWS(h.signedInClient("mallory@example.com"))

	mallory.send(wsIn{Op: "sub", Subject: ">"})
	mallory.expect("subscribed")

	// "$" never passes validation, so the JetStream API ($JS.API.…) and
	// system subjects are unreachable. Anything valid is prefixed with the
	// caller's own space, so "dispatch.u.<someone else>.x" is harmless.
	for _, subj := range []string{
		"$JS.API.STREAM.LIST", "$SYS.REQ.SERVER.PING", "a..b", ".a", "a.", "a b", "", "a.>.b", "a.b>",
		strings.Repeat("a", wsMaxSubjectLen+1),
	} {
		mallory.send(wsIn{Op: "sub", Subject: subj, ID: "s"})
		if out := mallory.expect("error"); out.ID != "s" {
			t.Fatalf("sub %q: %+v", subj, out)
		}
	}
	for _, subj := range []string{"room.*", "room.>", ">"} {
		mallory.send(wsIn{Op: "pub", Subject: subj, ID: "p"})
		if out := mallory.expect("error"); out.Error != "invalid subject" {
			t.Fatalf("pub to wildcard %q: %+v", subj, out)
		}
	}

	// Last, because a timed-out read closes the client connection.
	alice.send(wsIn{Op: "pub", Subject: "secret", Data: json.RawMessage(`"for alice only"`), ID: "a"})
	alice.expect("ack")
	if out, err := mallory.recv(300 * time.Millisecond); err == nil {
		t.Fatalf("another user's wildcard subscription received %+v", out)
	}
}

func TestWebSocketNeedsSession(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthLocal, nil)
	_, res, err := h.dialWS(h.client(), nil)
	if err == nil || res == nil || res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("dial without a session: err=%v status=%v; want 401", err, res)
	}
}

func TestWebSocketRefusesCrossOrigin(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthLocal, nil)
	c := h.signedInClient("ty@example.com")
	_, res, err := h.dialWS(c, http.Header{"Origin": {"https://evil.example"}})
	if err == nil || res == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin dial: err=%v; want 403", err)
	}
	if _, _, err := h.dialWS(c, http.Header{"Origin": {h.cfg.Origin()}}); err != nil {
		t.Fatalf("same-origin dial refused: %v", err)
	}
}

func TestWebSocketClosesOnSignOut(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthLocal, nil)
	c := h.signedInClient("ty@example.com")
	other := h.mustDialWS(h.signedInClient("other@example.com"))
	ws := h.mustDialWS(c)
	ws.send(wsIn{Op: "sub", Subject: "x"})
	ws.expect("subscribed")

	me, _ := h.me(c)
	if _, status := h.logout(c, me.CSRFToken); status != http.StatusOK {
		t.Fatalf("logout = %d", status)
	}
	if _, err := ws.recv(3 * time.Second); err == nil {
		t.Fatal("WebSocket still open after its session was signed out")
	}
	other.send(wsIn{Op: "sub", Subject: "x", ID: "still-here"})
	if out := other.expect("subscribed"); out.ID != "still-here" {
		t.Fatalf("another user's socket was affected: %+v", out)
	}
}

func TestWebSocketRejectsBadFrames(t *testing.T) {
	h := newHarness(t, storetest.Backends(t)[0], config.AuthLocal, nil)
	ws := h.mustDialWS(h.signedInClient("ty@example.com"))
	ctx := context.Background()
	_ = ws.conn.Write(ctx, websocket.MessageText, []byte("not json"))
	ws.expect("error")
	ws.send(map[string]string{"op": "launch-missiles"})
	ws.expect("error")
	ws.send(wsIn{Op: "pub", Subject: "a", ID: "bad", Data: nil})
	if ack := ws.expect("ack"); ack.ID != "bad" {
		t.Fatalf("publish with no data should store JSON null and ack: %+v", ack)
	}
}
