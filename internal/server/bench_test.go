package server

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/VBCDX/dispatch/internal/config"
	"github.com/VBCDX/dispatch/internal/seed"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

// BenchmarkWebSocketPubSub measures send-to-receive latency on one node:
// a publisher WebSocket sends a frame, the server publishes it to JetStream
// through the in-process NATS connection, and a subscriber WebSocket on the
// same subject receives it. Both sockets are real TCP connections over
// loopback. Messages are sent one at a time, so each sample is the latency
// of a single message, not throughput.
//
// Run: go test -run '^$' -bench WebSocketPubSub -benchtime 5000x ./internal/server
func BenchmarkWebSocketPubSub(b *testing.B) {
	h := newHarness(b, storetest.Backends(b)[0], config.AuthLocal, nil)
	c := h.signedInClient("bench@example.com")
	sub, pub := h.mustDialWS(c), h.mustDialWS(c)
	sub.send(wsIn{Op: "sub", Subject: "bench"})
	sub.expect("subscribed")

	ctx := context.Background()
	roundTrip := func(i int) time.Duration {
		frame, _ := json.Marshal(wsIn{Op: "pub", Subject: "bench", Data: json.RawMessage(strconv.Itoa(i))})
		start := time.Now()
		if err := pub.conn.Write(ctx, websocket.MessageText, frame); err != nil {
			b.Fatal(err)
		}
		_, got, err := sub.conn.Read(ctx)
		if err != nil {
			b.Fatal(err)
		}
		elapsed := time.Since(start)
		var m wsOut
		if err := json.Unmarshal(got, &m); err != nil || m.Op != "msg" || string(m.Data) != strconv.Itoa(i) {
			b.Fatalf("message %d: got %s", i, got)
		}
		return elapsed
	}

	for i := 0; i < 200; i++ { // warm up: JIT-free, but fills buffers and pools
		roundTrip(-1 - i)
	}

	samples := make([]time.Duration, 0, b.N)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		samples = append(samples, roundTrip(i))
	}
	b.StopTimer()

	slices.Sort(samples)
	pct := func(p float64) time.Duration { return samples[min(len(samples)-1, int(float64(len(samples))*p))] }
	us := func(d time.Duration) float64 { return float64(d.Nanoseconds()) / 1e3 }
	b.ReportMetric(us(pct(0.50)), "p50-µs")
	b.ReportMetric(us(pct(0.99)), "p99-µs")
	b.ReportMetric(0, "ns/op") // per-op time is the mean; the percentiles above are what matter
	if len(samples) >= 100 {   // skip the testing package's b.N=1 probe run
		fmt.Printf("websocket send→receive over embedded NATS, %d messages: p50=%s p90=%s p99=%s max=%s\n",
			len(samples), pct(0.50), pct(0.90), pct(0.99), samples[len(samples)-1])
	}
}

// BenchmarkAgentSendReceive measures the agent message path on one node:
// one agent sends a message frame on /agent/v1/ws, the server checks the
// tokens from its in-process cache and publishes to the workspace's
// JetStream subject, and the durable consumer of a second agent in the
// same workspace delivers it on that agent's socket. Both sockets are
// real TCP connections over loopback. Each sample is one message, sent
// one at a time; the receiver acks each one, as a real agent does, after
// the sample is taken.
//
// Run: go test -run '^$' -bench AgentSendReceive -benchtime 5000x ./internal/server
func BenchmarkAgentSendReceive(b *testing.B) {
	h := newHarness(b, storetest.Backends(b)[0], config.AuthLocal, nil)
	if _, err := seed.Load(context.Background(), h.st, time.Now()); err != nil {
		b.Fatal(err)
	}
	dana := h.person("u_dana")
	sender, receiver := h.dialAgent(h.enroll(dana, relWS, "bench-sender")), h.dialAgent(h.enroll(dana, relWS, "bench-receiver"))

	ctx := context.Background()
	roundTrip := func(i int) time.Duration {
		body := strconv.Itoa(i)
		start := time.Now()
		if err := sender.Send(ctx, body, body, ""); err != nil {
			b.Fatal(err)
		}
		f, err := receiver.Next(ctx)
		elapsed := time.Since(start)
		if err != nil || f.Op != "msg" || f.Message.Body != body {
			b.Fatalf("message %d: got %+v, %v", i, f, err)
		}
		if err := receiver.Ack(ctx, f.Seq); err != nil {
			b.Fatal(err)
		}
		for range 2 { // the sender's "sent" answer and its own copy
			if _, err := sender.Next(ctx); err != nil {
				b.Fatal(err)
			}
		}
		return elapsed
	}

	for i := 0; i < 200; i++ { // warm up: fills the access cache, buffers and pools
		roundTrip(-1 - i)
	}

	samples := make([]time.Duration, 0, b.N)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		samples = append(samples, roundTrip(i))
	}
	b.StopTimer()

	slices.Sort(samples)
	pct := func(p float64) time.Duration { return samples[min(len(samples)-1, int(float64(len(samples))*p))] }
	us := func(d time.Duration) float64 { return float64(d.Nanoseconds()) / 1e3 }
	b.ReportMetric(us(pct(0.50)), "p50-µs")
	b.ReportMetric(us(pct(0.99)), "p99-µs")
	b.ReportMetric(0, "ns/op")
	if len(samples) >= 100 {
		fmt.Printf("agent send→receive over /agent/v1/ws and JetStream, %d messages: p50=%s p90=%s p99=%s max=%s\n",
			len(samples), pct(0.50), pct(0.90), pct(0.99), samples[len(samples)-1])
	}
}
