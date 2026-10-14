// Package bus runs NATS with JetStream inside the Dispatch process. The
// server opens no network port: Dispatch talks to it over an in-process
// connection, so on one node a message never crosses a socket between
// being received from one agent and delivered to another.
//
// Embedding and the in-process connection: https://docs.nats.io/running-a-nats-service/clients#embedding-nats
// (server.Options.DontListen, server.Server.InProcessConn, nats.InProcessServer).
package bus

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// SubjectPrefix is the root of every subject Dispatch publishes on.
const SubjectPrefix = "dispatch."

// The stream that captures the WebSocket proof's messages. It exists to
// show the send path goes through JetStream; the real per-workspace
// streams come with the data model.
const (
	proofStream   = "DISPATCH_PROOF"
	proofSubjects = SubjectPrefix + "u.>"
)

// The stream that carries every workspace's agent messages. Each
// workspace has its own subject space, ws.<workspace id>.>, so an agent's
// consumer filters to its workspace and the archiver reads them all.
const (
	MessagesStream   = "DISPATCH_MESSAGES"
	messagesSubjects = "ws.>"
	// MessagesMaxAge is how long the stream keeps a message for delivery
	// and replay. History beyond it lives in the database.
	MessagesMaxAge = 7 * 24 * time.Hour
)

// Options configures the embedded server.
type Options struct {
	// StoreDir is where JetStream keeps file-backed streams.
	StoreDir string
	// Logger receives NATS server logs; nil silences them.
	Logger server.Logger
}

// Bus is the embedded NATS server and the process's connection to it.
type Bus struct {
	ns *server.Server
	nc *nats.Conn
	js jetstream.JetStream
}

// Start boots the embedded server and connects to it in process.
func Start(ctx context.Context, opts Options) (*Bus, error) {
	ns, err := server.NewServer(&server.Options{
		ServerName: "dispatch",
		DontListen: true,
		JetStream:  true,
		StoreDir:   opts.StoreDir,
		NoSigs:     true,
		NoLog:      opts.Logger == nil,
	})
	if err != nil {
		return nil, fmt.Errorf("bus: create server: %w", err)
	}
	if opts.Logger != nil {
		ns.SetLoggerV2(opts.Logger, false, false, false)
	}
	ns.Start()
	if !ns.ReadyForConnections(30 * time.Second) {
		ns.Shutdown()
		return nil, errors.New("bus: embedded NATS server did not become ready")
	}

	nc, err := nats.Connect("", nats.InProcessServer(ns), nats.Name("dispatch"), nats.MaxReconnects(-1))
	if err != nil {
		ns.Shutdown()
		return nil, fmt.Errorf("bus: in-process connect: %w", err)
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		ns.Shutdown()
		return nil, fmt.Errorf("bus: jetstream: %w", err)
	}
	if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     proofStream,
		Subjects: []string{proofSubjects},
		Storage:  jetstream.FileStorage,
		MaxAge:   24 * time.Hour,
		MaxBytes: 256 << 20,
		Discard:  jetstream.DiscardOld,
	}); err != nil {
		nc.Close()
		ns.Shutdown()
		return nil, fmt.Errorf("bus: create stream: %w", err)
	}
	if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:       MessagesStream,
		Subjects:   []string{messagesSubjects},
		Storage:    jetstream.FileStorage,
		MaxAge:     MessagesMaxAge,
		MaxBytes:   1 << 30,
		Discard:    jetstream.DiscardOld,
		Duplicates: 2 * time.Minute,
	}); err != nil {
		nc.Close()
		ns.Shutdown()
		return nil, fmt.Errorf("bus: create messages stream: %w", err)
	}
	return &Bus{ns: ns, nc: nc, js: js}, nil
}

// Conn is the in-process client connection, for subscribing.
func (b *Bus) Conn() *nats.Conn { return b.nc }

// JetStream is the in-process JetStream context, for consumers.
func (b *Bus) JetStream() jetstream.JetStream { return b.js }

// Publish stores the message in JetStream and returns once the stream has
// acknowledged it. Subscribers receive it as soon as the server routes it.
func (b *Bus) Publish(ctx context.Context, subject string, data []byte) error {
	_, err := b.js.Publish(ctx, subject, data)
	return err
}

// Ready reports whether the server, the connection and JetStream are usable.
func (b *Bus) Ready() error {
	switch {
	case !b.ns.Running():
		return errors.New("bus: server not running")
	case !b.nc.IsConnected():
		return fmt.Errorf("bus: connection %s", b.nc.Status())
	case !b.ns.JetStreamEnabled():
		return errors.New("bus: JetStream not enabled")
	}
	return nil
}

// Close closes the connection and shuts the server down.
func (b *Bus) Close() {
	b.nc.Close()
	b.ns.Shutdown()
	b.ns.WaitForShutdown()
}

// SessionRevokedSubject is published when a session is signed out, so every
// WebSocket opened with it closes. It sits outside the per-user subject
// space, so clients can neither publish nor subscribe to it.
func SessionRevokedSubject(sessionIDHash string) string {
	return SubjectPrefix + "sys.session." + sessionIDHash + ".revoked"
}

// AccessChangedSubject is published when an agent's access may have
// changed (a token rotated or revoked, an agent revoked, a membership or
// blocklist changed). Every node drops its cached access and re-checks the
// live connections it names. Clients can neither publish nor subscribe to it.
const AccessChangedSubject = SubjectPrefix + "sys.access"
