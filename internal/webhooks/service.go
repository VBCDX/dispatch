package webhooks

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/VBCDX/dispatch/internal/bus"
	"github.com/VBCDX/dispatch/internal/store"
)

// The stream that holds delivery jobs: one per (message, webhook), removed
// once delivered or dead-lettered.
const (
	JobsStream    = "DISPATCH_WEBHOOKS"
	jobsSubjects  = "whk.>"
	jobsMaxAge    = 7 * 24 * time.Hour
	matcherName   = "webhooks"
	workerName    = "webhook_worker"
	EventMessage  = "message.created"
	maxNoteLength = 200
)

// ChangedSubject is published after a webhook or listener changes, so
// every node reloads its copy. Clients can neither publish nor subscribe
// to it.
const ChangedSubject = bus.SubjectPrefix + "sys.webhooks"

// DefaultBackoff is the wait before each retry. A delivery that fails all
// of them (len+1 attempts, about four hours in all) becomes a dead letter.
var DefaultBackoff = []time.Duration{
	10 * time.Second, 30 * time.Second, 2 * time.Minute, 10 * time.Minute,
	30 * time.Minute, time.Hour, 2 * time.Hour,
}

// Options configures a Service. Zero values take the defaults.
type Options struct {
	// AllowPrivate lets deliveries reach private, loopback and link-local
	// addresses (WEBHOOK_ALLOW_PRIVATE). Off by default.
	AllowPrivate bool
	// Timeout bounds each POST, connection included. Default 10s.
	Timeout time.Duration
	// Backoff is the wait before each retry. Default DefaultBackoff.
	Backoff []time.Duration
	// Workers is how many deliveries run at once. Default 16.
	Workers int
	// Reload is how often the whole configuration is re-read, as a
	// backstop to ChangedSubject. Default 30s.
	Reload time.Duration
	Now    func() time.Time
}

// Store is what the service needs from the database.
type Store interface {
	LoadWebhookConfig(ctx context.Context) ([]store.WorkspaceWebhook, []store.WorkspaceListener, error)
	RecordDeliveryAttempt(ctx context.Context, a store.DeliveryAttempt, now time.Time) error
}

// Hook is an outgoing webhook as the workers see it.
type Hook struct {
	store.WorkspaceWebhook
	secret    string
	secretErr error
}

// Listener is an incoming listener with its secret opened.
type Listener struct {
	store.WorkspaceListener
	Secret    string
	SecretErr error
}

// Service matches messages to webhooks, delivers them, and holds the
// listeners the HTTP endpoint checks calls against.
type Service struct {
	b      *bus.Bus
	js     jetstream.JetStream
	st     Store
	box    *Box
	log    *slog.Logger
	opts   Options
	client *http.Client

	mu        sync.RWMutex
	loaded    bool
	byWS      map[string][]*Hook
	byID      map[string]*Hook
	listeners map[string]*Listener
}

// New builds a Service. Run starts it.
func New(b *bus.Bus, st Store, box *Box, log *slog.Logger, opts Options) *Service {
	if opts.Timeout <= 0 {
		opts.Timeout = 10 * time.Second
	}
	if opts.Backoff == nil {
		opts.Backoff = DefaultBackoff
	}
	if opts.Workers <= 0 {
		opts.Workers = 16
	}
	if opts.Reload <= 0 {
		opts.Reload = 30 * time.Second
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{
		b: b, js: b.JetStream(), st: st, box: box, log: log, opts: opts,
		client: NewClient(opts.Timeout, opts.AllowPrivate),
		byWS:   map[string][]*Hook{}, byID: map[string]*Hook{}, listeners: map[string]*Listener{},
	}
}

// Box is the secret box the service opens secrets with.
func (s *Service) Box() *Box { return s.box }

/* ---------------------------------------------------------------------- */
/* Configuration held in memory                                            */
/* ---------------------------------------------------------------------- */

// Reload re-reads every webhook and listener from the database.
func (s *Service) Reload(ctx context.Context) error {
	hooks, listeners, err := s.st.LoadWebhookConfig(ctx)
	if err != nil {
		return err
	}
	byWS, byID, ls := map[string][]*Hook{}, map[string]*Hook{}, map[string]*Listener{}
	for _, h := range hooks {
		x := &Hook{WorkspaceWebhook: h}
		x.secret, x.secretErr = s.box.Open(h.SecretSealed)
		byWS[h.WorkspaceID] = append(byWS[h.WorkspaceID], x)
		byID[h.ID] = x
	}
	for _, l := range listeners {
		x := &Listener{WorkspaceListener: l}
		x.Secret, x.SecretErr = s.box.Open(l.SecretSealed)
		ls[l.ID] = x
	}
	s.mu.Lock()
	s.byWS, s.byID, s.listeners, s.loaded = byWS, byID, ls, true
	s.mu.Unlock()
	return nil
}

// Changed reloads this node's copy now and tells the other nodes to.
func (s *Service) Changed(ctx context.Context) {
	if err := s.Reload(ctx); err != nil {
		s.log.Error("webhooks: reload failed", "err", err)
	}
	if err := s.b.Conn().Publish(ChangedSubject, nil); err != nil {
		s.log.Warn("webhooks: announce change failed", "err", err)
	}
}

// Listener returns an active listener's settings. ok is false when the
// configuration has not loaded yet; l is nil when there is no such
// listener.
func (s *Service) Listener(id string) (l *Listener, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.listeners[id], s.loaded
}

func (s *Service) hook(id string) *Hook {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.byID[id]
}

// match returns the active webhooks a message goes to.
func (s *Service) match(m streamMessage) []*Hook {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*Hook
	for _, h := range s.byWS[m.WorkspaceID] {
		if !h.Paused && h.OrgID == m.OrgID && h.Filter.Matches(m.Author.Kind, m.Author.ID, m.ThreadID, m.Body) {
			out = append(out, h)
		}
	}
	return out
}

/* ---------------------------------------------------------------------- */
/* Running                                                                 */
/* ---------------------------------------------------------------------- */

// Run matches and delivers until ctx ends. It returns an error only if it
// could not start.
func (s *Service) Run(ctx context.Context) error {
	if _, err := s.js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:       JobsStream,
		Subjects:   []string{jobsSubjects},
		Retention:  jetstream.WorkQueuePolicy,
		Storage:    jetstream.FileStorage,
		MaxAge:     jobsMaxAge,
		MaxBytes:   1 << 30,
		Duplicates: 2 * time.Minute,
	}); err != nil {
		return fmt.Errorf("webhooks: jobs stream: %w", err)
	}
	if err := s.Reload(ctx); err != nil {
		return fmt.Errorf("webhooks: load: %w", err)
	}
	sub, err := s.b.Conn().Subscribe(ChangedSubject, func(*nats.Msg) {
		if err := s.Reload(ctx); err != nil {
			s.log.Error("webhooks: reload failed", "err", err)
		}
	})
	if err != nil {
		return fmt.Errorf("webhooks: subscribe: %w", err)
	}
	defer sub.Unsubscribe()

	// The matcher reads the messages stream. It starts at the newest
	// message the first time, so turning webhooks on doesn't replay a
	// week of history, and resumes where it left off after a restart.
	matcher, err := s.js.CreateOrUpdateConsumer(ctx, bus.MessagesStream, jetstream.ConsumerConfig{
		Durable:       matcherName,
		FilterSubject: "ws.*.msg",
		DeliverPolicy: jetstream.DeliverNewPolicy,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       30 * time.Second,
		MaxAckPending: 1000,
	})
	if err != nil {
		return fmt.Errorf("webhooks: matcher consumer: %w", err)
	}
	mc, err := matcher.Consume(s.matchOne, jetstream.ConsumeErrHandler(func(_ jetstream.ConsumeContext, err error) {
		s.log.Debug("webhooks: matcher consumer", "err", err)
	}))
	if err != nil {
		return fmt.Errorf("webhooks: matcher consume: %w", err)
	}
	defer mc.Stop()

	worker, err := s.js.CreateOrUpdateConsumer(ctx, JobsStream, jetstream.ConsumerConfig{
		Durable:       workerName,
		AckPolicy:     jetstream.AckExplicitPolicy,
		AckWait:       s.opts.Timeout + time.Minute,
		MaxAckPending: 1000,
	})
	if err != nil {
		return fmt.Errorf("webhooks: worker consumer: %w", err)
	}
	it, err := worker.Messages(jetstream.PullMaxMessages(s.opts.Workers * 2))
	if err != nil {
		return fmt.Errorf("webhooks: worker messages: %w", err)
	}

	var wg sync.WaitGroup
	slots := make(chan struct{}, s.opts.Workers)
	go func() {
		<-ctx.Done()
		it.Stop()
	}()
	go func() {
		t := time.NewTicker(s.opts.Reload)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := s.Reload(ctx); err != nil && ctx.Err() == nil {
					s.log.Warn("webhooks: periodic reload failed", "err", err)
				}
			}
		}
	}()
	for {
		m, err := it.Next()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, jetstream.ErrMsgIteratorClosed) {
				break
			}
			s.log.Debug("webhooks: worker next", "err", err)
			select { // don't spin on a repeating error
			case <-ctx.Done():
			case <-time.After(100 * time.Millisecond):
			}
			continue
		}
		slots <- struct{}{}
		wg.Add(1)
		go func() {
			defer func() { <-slots; wg.Done() }()
			s.deliverOne(ctx, m)
		}()
	}
	wg.Wait()
	return nil
}

// streamMessage is the part of a stream message the matcher reads.
type streamMessage struct {
	ID          string `json:"id"`
	OrgID       string `json:"org_id"`
	WorkspaceID string `json:"workspace_id"`
	Author      struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	} `json:"author"`
	Body     string `json:"body"`
	ThreadID string `json:"thread_id"`
}

// Job is one delivery waiting on the jobs stream.
type Job struct {
	DeliveryID  string          `json:"delivery_id"`
	OrgID       string          `json:"org_id"`
	WorkspaceID string          `json:"workspace_id"`
	WebhookID   string          `json:"webhook_id"`
	MessageID   string          `json:"message_id"`
	Seq         uint64          `json:"seq"`
	Body        json.RawMessage `json:"body"` // the exact JSON to POST
}

// Envelope is the JSON body of every delivery (docs/webhooks.md).
type Envelope struct {
	ID          string          `json:"id"`
	Type        string          `json:"type"`
	CreatedAt   time.Time       `json:"created_at"`
	WebhookID   string          `json:"webhook_id"`
	WorkspaceID string          `json:"workspace_id"`
	Seq         uint64          `json:"seq"`
	Message     json.RawMessage `json:"message"`
}

func jobSubject(webhookID string) string { return "whk." + webhookID }

func (s *Service) matchOne(m jetstream.Msg) {
	meta, err := m.Metadata()
	if err != nil {
		_ = m.Term()
		return
	}
	var msg streamMessage
	if err := json.Unmarshal(m.Data(), &msg); err != nil || msg.ID == "" {
		_ = m.Term()
		return
	}
	for _, h := range s.match(msg) {
		deliveryID := store.NewID("whd")
		body, err := json.Marshal(Envelope{
			ID: deliveryID, Type: EventMessage, CreatedAt: s.opts.Now().UTC(), WebhookID: h.ID,
			WorkspaceID: msg.WorkspaceID, Seq: meta.Sequence.Stream, Message: m.Data(),
		})
		if err == nil {
			err = s.enqueue(context.Background(), Job{
				DeliveryID: deliveryID, OrgID: h.OrgID, WorkspaceID: msg.WorkspaceID, WebhookID: h.ID,
				MessageID: msg.ID, Seq: meta.Sequence.Stream, Body: body,
			}, h.ID+"."+msg.ID)
		}
		if err != nil {
			// The jobs already queued for this message are deduplicated by
			// their message ID when it comes round again.
			s.log.Warn("webhooks: queue delivery failed, will retry", "message", msg.ID, "webhook", h.ID, "err", err)
			_ = m.NakWithDelay(5 * time.Second)
			return
		}
	}
	_ = m.Ack()
}

func (s *Service) enqueue(ctx context.Context, j Job, dedupe string) error {
	data, err := json.Marshal(j)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = s.js.PublishMsg(ctx, &nats.Msg{
		Subject: jobSubject(j.WebhookID), Data: data,
		Header: nats.Header{jetstream.MsgIDHeader: []string{dedupe}},
	})
	return err
}

// Redeliver queues a dead letter's delivery again, with a fresh set of
// attempts. The caller has already taken it off the dead-letter list.
func (s *Service) Redeliver(ctx context.Context, d store.WebhookDeadLetter, orgID string) error {
	return s.enqueue(ctx, Job{
		DeliveryID: d.DeliveryID, OrgID: orgID, WorkspaceID: d.WorkspaceID, WebhookID: d.WebhookID,
		MessageID: d.MessageID, Seq: d.Seq, Body: d.Body,
	}, d.DeliveryID+".r."+store.NewID("r"))
}

// deliverOne makes one attempt at a job and decides what happens next.
func (s *Service) deliverOne(ctx context.Context, m jetstream.Msg) {
	var j Job
	meta, err := m.Metadata()
	if err != nil || json.Unmarshal(m.Data(), &j) != nil || j.DeliveryID == "" {
		_ = m.Term()
		return
	}
	attempt := int(meta.NumDelivered)
	rec := store.DeliveryAttempt{
		OrgID: j.OrgID, WorkspaceID: j.WorkspaceID, WebhookID: j.WebhookID, MessageID: j.MessageID,
		DeliveryID: j.DeliveryID, Seq: j.Seq,
	}
	h := s.hook(j.WebhookID)
	switch {
	case h == nil:
		// Deleted, or its workspace was: its records are gone too.
		_ = m.Term()
		return
	case h.Paused:
		rec.State = "dropped"
		rec.Attempt = store.WebhookAttempt{ID: store.NewID("att"), At: s.opts.Now().UnixMilli(), Trk: store.NewID("trk"), Note: "not sent: the webhook is paused"}
		s.record(ctx, rec)
		_ = m.Ack()
		return
	}

	status, took, permanent, note := s.post(ctx, h, j, attempt)
	now := s.opts.Now()
	rec.Attempt = store.WebhookAttempt{ID: store.NewID("att"), At: now.UnixMilli(), Status: status, MS: int(took / time.Millisecond), Trk: store.NewID("trk"), Note: note}
	switch {
	case status >= 200 && status < 300:
		rec.State = "delivered"
		s.record(ctx, rec)
		_ = m.Ack()
	case !permanent && attempt <= len(s.opts.Backoff):
		wait := s.opts.Backoff[attempt-1]
		next := now.Add(wait)
		rec.State, rec.NextAttemptAt = "retrying", &next
		s.record(ctx, rec)
		_ = m.NakWithDelay(wait)
	default:
		rec.State, rec.URL, rec.Body = "dead", h.URL, j.Body
		if !s.record(ctx, rec) {
			// Keep the job rather than lose it: it is tried once more, and
			// dead-lettered then.
			_ = m.NakWithDelay(time.Minute)
			return
		}
		_ = m.Ack()
	}
}

// record stores an attempt; a failure is logged, never fatal to delivery.
func (s *Service) record(ctx context.Context, a store.DeliveryAttempt) bool {
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := s.st.RecordDeliveryAttempt(rctx, a, s.opts.Now()); err != nil {
		s.log.Warn("webhooks: record delivery failed", "delivery", a.DeliveryID, "state", a.State, "err", err)
		return false
	}
	return true
}

// post makes one signed POST. status is 0 when no response came back;
// permanent means retrying cannot help (a blocked address, an unreadable
// secret).
func (s *Service) post(ctx context.Context, h *Hook, j Job, attempt int) (status int, took time.Duration, permanent bool, note string) {
	if h.secretErr != nil {
		return 0, 0, true, h.secretErr.Error()
	}
	ctx, cancel := context.WithTimeout(ctx, s.opts.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.URL, bytes.NewReader(j.Body))
	if err != nil {
		return 0, 0, true, clip("bad URL: " + err.Error())
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Dispatch-Webhooks/1")
	req.Header.Set(EventHeader, EventMessage)
	req.Header.Set(DeliveryHeader, j.DeliveryID)
	req.Header.Set(WebhookHeader, h.ID)
	req.Header.Set("Dispatch-Attempt", strconv.Itoa(attempt))
	req.Header.Set(SignatureHeader, Sign(h.secret, s.opts.Now(), j.Body))
	start := time.Now()
	res, err := s.client.Do(req)
	took = time.Since(start)
	if err != nil {
		if isBlocked(err) {
			return 0, took, true, "blocked: the URL resolves to a private or internal address (WEBHOOK_ALLOW_PRIVATE is off)"
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return 0, took, false, fmt.Sprintf("timed out after %s", s.opts.Timeout)
		}
		return 0, took, false, clip(err.Error())
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	res.Body.Close()
	if res.StatusCode >= 300 && res.StatusCode < 400 {
		return res.StatusCode, took, false, "redirects are not followed"
	}
	return res.StatusCode, took, false, ""
}

func clip(s string) string {
	if len(s) > maxNoteLength {
		return s[:maxNoteLength] + "…"
	}
	return s
}
