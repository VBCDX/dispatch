package messaging

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/bus"
)

func newHub(t *testing.T) *Hub {
	t.Helper()
	b, err := bus.Start(context.Background(), bus.Options{StoreDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(b.Close)
	return NewHub(b, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func publish(t *testing.T, h *Hub, ws, body string) uint64 {
	t.Helper()
	m, err := NewMessage("org_1", ws, Author{Kind: "agent", ID: "ag_1", Label: "a"}, body, nil, "", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	seq, _, err := h.Publish(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	return seq
}

// A feed delivers only its workspace, in order, and resumes after the
// last ack; an ack racing Stop is refused, never a panic.
func TestFeedResumesAfterAckAndSurvivesLateAcks(t *testing.T) {
	h := newHub(t)
	ctx := context.Background()
	got := make(chan uint64, 10)
	var acked sync.WaitGroup
	f, err := h.Subscribe(ctx, "wm_1", "ws_a", time.Now().Add(-time.Minute), func(seq uint64, _ []byte) { got <- seq }, func(uint64) { acked.Done() })
	if err != nil {
		t.Fatal(err)
	}
	s1 := publish(t, h, "ws_a", "one")
	publish(t, h, "ws_b", "elsewhere")
	s2 := publish(t, h, "ws_a", "two")
	for _, want := range []uint64{s1, s2} {
		select {
		case seq := <-got:
			if seq != want {
				t.Fatalf("delivered %d, want %d", seq, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("nothing delivered")
		}
	}
	acked.Add(1)
	if !f.Ack(s1) {
		t.Fatal("ack refused")
	}
	acked.Wait()
	f.Stop()
	if f.Ack(s2) {
		t.Error("an ack after Stop was accepted")
	}
	f.Stop() // twice is fine

	f, err = h.Subscribe(ctx, "wm_1", "ws_a", time.Time{}, func(seq uint64, _ []byte) { got <- seq }, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	if f.From != s1+1 {
		t.Errorf("From = %d, want %d", f.From, s1+1)
	}
	select {
	case seq := <-got:
		if seq != s2 {
			t.Errorf("after resume delivered %d, want %d", seq, s2)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nothing delivered after resume")
	}
}

func TestNewMessageValidation(t *testing.T) {
	a := Author{Kind: "agent", ID: "ag_1"}
	for name, tc := range map[string]struct {
		body, thread, payload string
		want                  error
	}{
		"blank":           {body: "  ", want: ErrEmptyBody},
		"too long":        {body: string(make([]byte, MaxBodyBytes+1)), want: ErrBodyTooLong},
		"bad UTF-8":       {body: "\xff", want: ErrBadUTF8},
		"bad thread":      {body: "x", thread: "ws.>", want: ErrBadThread},
		"scalar payload":  {body: "x", payload: "42", want: ErrPayload},
		"invalid payload": {body: "x", payload: "{", want: ErrPayload},
		"ok":              {body: "x", thread: "msg_abc", payload: `{"k":1}`},
	} {
		_, err := NewMessage("o", "w", a, tc.body, []byte(tc.payload), tc.thread, time.Now())
		if err != tc.want {
			t.Errorf("%s: err = %v, want %v", name, err, tc.want)
		}
	}
}
