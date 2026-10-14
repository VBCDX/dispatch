// Package messaging is the agent message path: publishing a message to its
// workspace's JetStream subject, delivering a workspace's messages to an
// agent through a durable consumer, and copying every message into the
// database off the hot path.
//
// Nothing here reads or writes SQL while sending or delivering. The
// archiver is the only part that touches the database, from its own
// consumer; if it is slow or down, sending and receiving carry on and the
// archive catches up from the stream.
package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/VBCDX/dispatch/internal/bus"
	"github.com/VBCDX/dispatch/internal/store"
)

// Limits on one message.
const (
	MaxBodyBytes    = 32 << 10
	MaxPayloadBytes = 16 << 10
)

// Delivery settings for an agent's durable consumer.
const (
	// maxAckPending is how far delivery may run ahead of an agent's acks.
	// An agent that never acks stops receiving after this many messages.
	maxAckPending = 10_000
	// ackWait is long on purpose: an agent's unacked messages are resent
	// when it reconnects (the consumer is reset to its ack floor), not on
	// a timer while it is still connected.
	ackWait = time.Hour
	// inactiveThreshold removes an agent's consumer after this long with no
	// connection. Everything still in the stream then is newer than its
	// last connection, so recreating it from the membership's start loses
	// nothing (bus.MessagesMaxAge is shorter).
	inactiveThreshold = 30 * 24 * time.Hour
	// pullBatch is how many messages the client library keeps requested.
	pullBatch = 256
)

// Errors a send can return; the caller turns them into 4xx responses.
var (
	ErrEmptyBody   = errors.New("body is empty")
	ErrBodyTooLong = fmt.Errorf("body is longer than %d bytes", MaxBodyBytes)
	ErrBadUTF8     = errors.New("body is not valid UTF-8")
	ErrPayload     = fmt.Errorf("payload must be a JSON object or array of at most %d bytes", MaxPayloadBytes)
	ErrBadThread   = errors.New("thread_id is not a message ID")
)

// Author is who wrote a message.
type Author struct {
	Kind  string `json:"kind"` // agent, user or listener
	ID    string `json:"id"`
	Label string `json:"label"`
	// From is a listener call's client address. It travels in a stream
	// header (authorFromHeader) for the archive, never in the message
	// agents and the web app receive.
	From string `json:"-"`
}

// Message is what goes on the stream and what agents and the web app
// receive. Its JSON is the agent protocol's message object
// (docs/agent-protocol.md).
type Message struct {
	ID          string          `json:"id"`
	OrgID       string          `json:"org_id"`
	WorkspaceID string          `json:"workspace_id"`
	Author      Author          `json:"author"`
	Body        string          `json:"body"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	ThreadID    string          `json:"thread_id,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
	Trk         string          `json:"trk"`
}

// NewMessage validates a send and builds the message with fresh IDs.
func NewMessage(orgID, workspaceID string, author Author, body string, payload json.RawMessage, threadID string, now time.Time) (Message, error) {
	switch {
	case strings.TrimSpace(body) == "":
		return Message{}, ErrEmptyBody
	case len(body) > MaxBodyBytes:
		return Message{}, ErrBodyTooLong
	case !utf8.ValidString(body):
		return Message{}, ErrBadUTF8
	case threadID != "" && (!ValidID(threadID) || !strings.HasPrefix(threadID, "msg_")):
		return Message{}, ErrBadThread
	}
	if p := strings.TrimSpace(string(payload)); p != "" && p != "null" {
		if len(p) > MaxPayloadBytes || (p[0] != '{' && p[0] != '[') || !json.Valid([]byte(p)) {
			return Message{}, ErrPayload
		}
		payload = json.RawMessage(p)
	} else {
		payload = nil
	}
	return Message{
		ID: store.NewID("msg"), OrgID: orgID, WorkspaceID: workspaceID, Author: author,
		Body: body, Payload: payload, ThreadID: threadID, CreatedAt: now.UTC(), Trk: store.NewID("trk"),
	}, nil
}

// ValidID reports whether id can be used inside a NATS subject and a
// consumer name: 1 to 64 letters, digits, '_' or '-'.
func ValidID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// Subject is where a workspace's messages are published.
func Subject(workspaceID string) string { return "ws." + workspaceID + ".msg" }

// filter is every subject of one workspace.
func filter(workspaceID string) string { return "ws." + workspaceID + ".>" }

// eventsSubject carries a workspace's live receipt and presence events for
// the web app. Core NATS only: nothing is stored.
func eventsSubject(workspaceID string) string {
	return bus.SubjectPrefix + "sys.ws." + workspaceID + ".events"
}

// authorFromHeader carries Author.From on the stream.
const authorFromHeader = "Dispatch-Author-From"

func consumerName(membershipID string) string { return "agent_" + membershipID }

// Hub publishes and delivers messages.
type Hub struct {
	b   *bus.Bus
	js  jetstream.JetStream
	log *slog.Logger
}

// NewHub wraps the bus.
func NewHub(b *bus.Bus, log *slog.Logger) *Hub {
	return &Hub{b: b, js: b.JetStream(), log: log}
}

// Publish stores m in the stream and returns its stream sequence and the
// encoded message. It returns once JetStream has the message; delivery to
// connected agents is pushed from the stream.
func (h *Hub) Publish(ctx context.Context, m Message) (uint64, []byte, error) {
	if !ValidID(m.WorkspaceID) {
		return 0, nil, fmt.Errorf("messaging: invalid workspace ID %q", m.WorkspaceID)
	}
	data, err := json.Marshal(m)
	if err != nil {
		return 0, nil, err
	}
	hdr := nats.Header{jetstream.MsgIDHeader: []string{m.ID}}
	if m.Author.From != "" {
		hdr.Set(authorFromHeader, m.Author.From)
	}
	ack, err := h.js.PublishMsg(ctx, &nats.Msg{Subject: Subject(m.WorkspaceID), Data: data, Header: hdr})
	if err != nil {
		return 0, nil, err
	}
	return ack.Sequence, data, nil
}

// Event is a live receipt or presence change in a workspace, for the web
// app. Kind is "ack" (AgentID acknowledged up to Seq) or "presence"
// (Online changed).
type Event struct {
	Kind    string `json:"kind"`
	AgentID string `json:"agent_id"`
	Seq     uint64 `json:"seq,omitempty"`
	Online  *bool  `json:"online,omitempty"`
}

// PublishEvent sends a live event to the workspace's watchers. It is best
// effort: a lost event only delays a screen update.
func (h *Hub) PublishEvent(workspaceID string, e Event) {
	data, err := json.Marshal(e)
	if err == nil {
		err = h.b.Conn().Publish(eventsSubject(workspaceID), data)
	}
	if err != nil {
		h.log.Debug("publish workspace event failed", "err", err)
	}
}

// Feed delivers one agent membership's messages, in stream order, from the
// message after its last acknowledged one.
type Feed struct {
	cons jetstream.Consumer
	cc   jetstream.ConsumeContext
	// From is the first stream sequence this feed may deliver.
	From uint64

	nc *nats.Conn
	// pending maps each delivered, unacked stream sequence to its ack
	// subject. Only the subject is kept, not the message.
	mu      sync.Mutex
	pending map[uint64]string
	// sendMu guards sending on acks against Stop closing it: Ack holds it
	// shared, Stop exclusively.
	sendMu  sync.RWMutex
	stopped bool
	acks    chan uint64
	done    chan struct{}
	onAck   func(seq uint64)
	log     *slog.Logger
}

// Subscribe starts delivering the membership's messages to deliver. The
// consumer is created on first use, starting at since (when the agent
// joined the workspace), and otherwise reset to its ack floor, so a
// reconnect resumes after the last acknowledged message without gaps or
// redelivered acknowledged messages. deliver runs on one goroutine, in
// order; it must not block. onAck is called after each ack is stored.
//
// Only one Feed per membership may run at a time: the caller makes a new
// connection replace the old one.
func (h *Hub) Subscribe(ctx context.Context, membershipID, workspaceID string, since time.Time,
	deliver func(seq uint64, data []byte), onAck func(seq uint64)) (*Feed, error) {
	if !ValidID(membershipID) || !ValidID(workspaceID) {
		return nil, errors.New("messaging: invalid membership or workspace ID")
	}
	name := consumerName(membershipID)
	var from uint64
	cons, err := h.js.Consumer(ctx, bus.MessagesStream, name)
	switch {
	case errors.Is(err, jetstream.ErrConsumerNotFound):
		start := since.UTC()
		cons, err = h.js.CreateConsumer(ctx, bus.MessagesStream, jetstream.ConsumerConfig{
			Durable:           name,
			FilterSubject:     filter(workspaceID),
			DeliverPolicy:     jetstream.DeliverByStartTimePolicy,
			OptStartTime:      &start,
			AckPolicy:         jetstream.AckAllPolicy,
			AckWait:           ackWait,
			MaxAckPending:     maxAckPending,
			InactiveThreshold: inactiveThreshold,
		})
		if err != nil {
			return nil, fmt.Errorf("messaging: create consumer: %w", err)
		}
		from = cons.CachedInfo().AckFloor.Stream + 1
	case err != nil:
		return nil, fmt.Errorf("messaging: load consumer: %w", err)
	default:
		res, err := h.js.ResetConsumer(ctx, bus.MessagesStream, name)
		if err != nil {
			return nil, fmt.Errorf("messaging: reset consumer: %w", err)
		}
		from = res.ResetSeq
	}

	f := &Feed{
		cons: cons, From: from, nc: h.b.Conn(), pending: map[uint64]string{},
		acks: make(chan uint64, 1024), done: make(chan struct{}), onAck: onAck, log: h.log,
	}
	f.cc, err = cons.Consume(func(m jetstream.Msg) {
		meta, err := m.Metadata()
		if err != nil {
			h.log.Warn("message without metadata", "err", err)
			return
		}
		seq := meta.Sequence.Stream
		f.mu.Lock()
		f.pending[seq] = m.Reply()
		f.mu.Unlock()
		deliver(seq, m.Data())
	}, jetstream.PullMaxMessages(pullBatch), jetstream.ConsumeErrHandler(func(_ jetstream.ConsumeContext, err error) {
		h.log.Debug("agent consumer", "consumer", name, "err", err)
	}))
	if err != nil {
		return nil, fmt.Errorf("messaging: consume: %w", err)
	}
	go f.ackLoop()
	return f, nil
}

// Ack acknowledges every delivered message up to and including seq. Acks
// are stored in order on a separate goroutine, so they never hold up a
// send. It returns false if seq was not delivered on this feed or is
// already acknowledged.
func (f *Feed) Ack(seq uint64) bool {
	f.mu.Lock()
	_, ok := f.pending[seq]
	f.mu.Unlock()
	if !ok {
		return false
	}
	f.sendMu.RLock()
	defer f.sendMu.RUnlock()
	if f.stopped {
		return false
	}
	f.acks <- seq // ackLoop never takes sendMu, so this always drains
	return true
}

func (f *Feed) ackLoop() {
	defer close(f.done)
	for seq := range f.acks {
		f.mu.Lock()
		reply, ok := f.pending[seq]
		if ok {
			for s := range f.pending {
				if s <= seq {
					delete(f.pending, s)
				}
			}
		}
		f.mu.Unlock()
		if !ok {
			continue // a later cumulative ack already covered it
		}
		// A synchronous ack ("+ACK" as a request, as DoubleAck does): once it
		// returns, the consumer's ack floor includes seq, so a reconnect
		// right after resumes past it.
		if _, err := f.nc.Request(reply, []byte("+ACK"), 5*time.Second); err != nil {
			f.log.Warn("ack failed", "seq", seq, "err", err)
			continue
		}
		if f.onAck != nil {
			f.onAck(seq)
		}
	}
}

// Stop ends delivery and waits for queued acks to be stored, so the next
// connection resumes after them.
// It is safe to call Ack during or after Stop: the ack is refused.
func (f *Feed) Stop() {
	f.cc.Stop()
	f.sendMu.Lock()
	if !f.stopped {
		f.stopped = true
		close(f.acks)
	}
	f.sendMu.Unlock()
	<-f.done
}

// AckFloors returns, for each membership, the last stream sequence its
// agent acknowledged (0 when it has no consumer yet).
func (h *Hub) AckFloors(ctx context.Context, membershipIDs []string) map[string]uint64 {
	out := make(map[string]uint64, len(membershipIDs))
	for _, id := range membershipIDs {
		if !ValidID(id) {
			continue
		}
		c, err := h.js.Consumer(ctx, bus.MessagesStream, consumerName(id))
		if err != nil {
			continue
		}
		out[id] = c.CachedInfo().AckFloor.Stream
	}
	return out
}

// Watch delivers a workspace's new messages and live events to a web app
// connection until the returned stop function is called. Messages carry
// their stream sequence, so the screen can place them against agents' ack
// floors. Watching uses an ephemeral ordered consumer and a core NATS
// subscription: nothing is stored for it.
func (h *Hub) Watch(ctx context.Context, workspaceID string, onMsg func(seq uint64, data []byte), onEvent func(data []byte)) (stop func(), err error) {
	if !ValidID(workspaceID) {
		return nil, errors.New("messaging: invalid workspace ID")
	}
	events, err := h.b.Conn().Subscribe(eventsSubject(workspaceID), func(m *nats.Msg) { onEvent(m.Data) })
	if err != nil {
		return nil, err
	}
	oc, err := h.js.OrderedConsumer(ctx, bus.MessagesStream, jetstream.OrderedConsumerConfig{
		FilterSubjects: []string{filter(workspaceID)},
		DeliverPolicy:  jetstream.DeliverNewPolicy,
	})
	if err != nil {
		_ = events.Unsubscribe()
		return nil, err
	}
	cc, err := oc.Consume(func(m jetstream.Msg) {
		meta, err := m.Metadata()
		if err != nil {
			return
		}
		onMsg(meta.Sequence.Stream, m.Data())
	})
	if err != nil {
		_ = events.Unsubscribe()
		return nil, err
	}
	return func() {
		cc.Stop()
		_ = events.Unsubscribe()
	}, nil
}

// Archiver copies every message from the stream into the database.
type Archiver interface {
	ArchiveMessage(ctx context.Context, m store.ArchivedMessage) (bool, error)
}

const archiverName = "archiver"

// RunArchiver copies messages into the database until ctx ends. A message
// that fails to store is retried with a growing delay; the send path never
// waits for it.
func (h *Hub) RunArchiver(ctx context.Context, st Archiver) error {
	cons, err := h.js.CreateOrUpdateConsumer(ctx, bus.MessagesStream, jetstream.ConsumerConfig{
		Durable:       archiverName,
		FilterSubject: "ws.*.msg",
		DeliverPolicy: jetstream.DeliverAllPolicy,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       time.Minute,
		MaxAckPending: 1000,
	})
	if err != nil {
		return fmt.Errorf("messaging: archiver consumer: %w", err)
	}
	cc, err := cons.Consume(func(m jetstream.Msg) {
		meta, err := m.Metadata()
		if err != nil {
			_ = m.Term()
			return
		}
		var msg Message
		if err := json.Unmarshal(m.Data(), &msg); err != nil || msg.ID == "" {
			h.log.Error("archiver: undecodable message dropped", "seq", meta.Sequence.Stream, "err", err)
			_ = m.Term()
			return
		}
		actx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err = st.ArchiveMessage(actx, store.ArchivedMessage{
			ID: msg.ID, OrgID: msg.OrgID, WorkspaceID: msg.WorkspaceID,
			AuthorKind: msg.Author.Kind, AuthorID: msg.Author.ID, AuthorFrom: m.Headers().Get(authorFromHeader),
			Body: msg.Body, Payload: msg.Payload, ThreadRootID: msg.ThreadID,
			CreatedAt: msg.CreatedAt, Trk: msg.Trk, StreamSeq: meta.Sequence.Stream,
		})
		cancel()
		if err != nil {
			delay := min(time.Duration(1<<min(meta.NumDelivered, 6))*time.Second, time.Minute)
			h.log.Warn("archiver: store failed, will retry", "message", msg.ID, "attempt", meta.NumDelivered, "retry_in", delay, "err", err)
			_ = m.NakWithDelay(delay)
			return
		}
		_ = m.Ack()
	}, jetstream.ConsumeErrHandler(func(_ jetstream.ConsumeContext, err error) {
		h.log.Debug("archiver consumer", "err", err)
	}))
	if err != nil {
		return fmt.Errorf("messaging: archiver consume: %w", err)
	}
	<-ctx.Done()
	cc.Stop()
	return nil
}
