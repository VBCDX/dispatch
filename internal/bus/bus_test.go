package bus

import (
	"context"
	"testing"
	"time"
)

func TestPublishGoesThroughJetStream(t *testing.T) {
	ctx := context.Background()
	b, err := Start(ctx, Options{StoreDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if err := b.Ready(); err != nil {
		t.Fatalf("Ready: %v", err)
	}

	sub, err := b.Conn().SubscribeSync(SubjectPrefix + "u.user-1.room")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Publish(ctx, SubjectPrefix+"u.user-1.room", []byte(`"hi"`)); err != nil {
		t.Fatal(err)
	}
	msg, err := sub.NextMsg(2 * time.Second)
	if err != nil || string(msg.Data) != `"hi"` {
		t.Fatalf("subscriber got %v, %v", msg, err)
	}

	stream, err := b.js.Stream(ctx, proofStream)
	if err != nil {
		t.Fatal(err)
	}
	info, err := stream.Info(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if info.State.Msgs != 1 {
		t.Fatalf("stream holds %d messages, want 1: the publish must be stored by JetStream", info.State.Msgs)
	}

	// Subjects outside the per-user space are not captured (and Publish
	// waits for a stream ack, so it fails rather than silently dropping).
	pctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	if err := b.Publish(pctx, SubjectPrefix+"sys.something", nil); err == nil {
		t.Fatal("publish to a subject no stream captures should fail")
	}
}

func TestStreamSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	b, err := Start(ctx, Options{StoreDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Publish(ctx, SubjectPrefix+"u.user-1.room", []byte(`1`)); err != nil {
		t.Fatal(err)
	}
	b.Close()

	b, err = Start(ctx, Options{StoreDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	stream, err := b.js.Stream(ctx, proofStream)
	if err != nil {
		t.Fatal(err)
	}
	info, _ := stream.Info(ctx)
	if info.State.Msgs != 1 {
		t.Fatalf("after restart the stream holds %d messages, want 1 (file-backed)", info.State.Msgs)
	}
}
