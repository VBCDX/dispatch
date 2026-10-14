package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/VBCDX/dispatch/internal/messaging"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/webhooks"
)

// The Webhooks tab under /api/v1/ (browser session; writes need a
// workspace admin), and the public listener endpoint outside systems post
// to. Delivery itself runs in internal/webhooks, off the send path.

const (
	// listenerCallLimit is how many calls one listener accepts per
	// listenerCallWindow, signed or not.
	listenerCallLimit  = 120
	listenerCallWindow = time.Minute
	listenerMaxBody    = 64 << 10
	recentLimit        = 50
)

func (s *Server) routesWebhooks(mux *http.ServeMux) {
	const ws = "/api/v1/orgs/{org}/workspaces/{ws}"
	mux.HandleFunc("GET "+ws+"/webhooks", s.requireSession(s.handleListWebhooks))
	mux.HandleFunc("POST "+ws+"/webhooks", s.requireSession(s.handleCreateWebhook))
	mux.HandleFunc("PATCH "+ws+"/webhooks/{hook}", s.requireSession(s.handleUpdateWebhook))
	mux.HandleFunc("DELETE "+ws+"/webhooks/{hook}", s.requireSession(s.handleDeleteWebhook))
	mux.HandleFunc("POST "+ws+"/webhooks/{hook}/secret/rotate", s.requireSession(s.handleRotateWebhookSecret))
	mux.HandleFunc("POST "+ws+"/webhook-dead-letters/{dl}/redeliver", s.requireSession(s.handleRedeliver))
	mux.HandleFunc("POST "+ws+"/listeners", s.requireSession(s.handleCreateListener))
	mux.HandleFunc("PATCH "+ws+"/listeners/{lsn}", s.requireSession(s.handleUpdateListener))
	mux.HandleFunc("DELETE "+ws+"/listeners/{lsn}", s.requireSession(s.handleDeleteListener))
	mux.HandleFunc("POST "+ws+"/listeners/{lsn}/secret/rotate", s.requireSession(s.handleRotateListenerSecret))

	mux.HandleFunc("POST /hooks/v1/{listener}", s.handleListenerCall)
	mux.HandleFunc("/hooks/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such endpoint")
	})
}

// RunWebhooks matches and delivers webhooks until ctx is cancelled.
// Sending never waits for it.
func (s *Server) RunWebhooks(ctx context.Context) {
	if s.hooks == nil {
		return
	}
	for {
		err := s.hooks.Run(ctx)
		if ctx.Err() != nil {
			return
		}
		s.log.Error("webhook delivery stopped; restarting", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

// webhooksReady writes a 503 when webhooks could not be set up.
func (s *Server) webhooksReady(w http.ResponseWriter) bool {
	if s.hooks == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "webhooks are unavailable on this server: "+s.hooksErr)
		return false
	}
	return true
}

func (s *Server) listenerURL(id string) string { return s.cfg.PublicURL.String() + "/hooks/v1/" + id }

/* ---------------------------------------------------------------------- */
/* JSON                                                                    */
/* ---------------------------------------------------------------------- */

type webhookFilterJSON struct {
	AuthorKinds []string `json:"author_kinds"`
	AuthorIDs   []string `json:"author_ids"`
	Threads     string   `json:"threads"`
	Contains    string   `json:"contains"`
}

type webhookJSON struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	URL             string            `json:"url"`
	Filter          webhookFilterJSON `json:"filter"`
	Paused          bool              `json:"paused"`
	SecretLast4     string            `json:"secret_last4"`
	SecretRotatedAt time.Time         `json:"secret_rotated_at"`
	CreatedAt       time.Time         `json:"created_at"`
	CreatedBy       string            `json:"created_by"`
}

func toWebhookJSON(h store.WorkspaceWebhook) webhookJSON {
	f := h.Filter
	return webhookJSON{
		ID: h.ID, Name: h.Name, URL: h.URL, Paused: h.Paused,
		Filter:      webhookFilterJSON{AuthorKinds: orEmpty(f.AuthorKinds), AuthorIDs: orEmpty(f.AuthorIDs), Threads: f.Threads, Contains: f.Contains},
		SecretLast4: h.SecretLast4, SecretRotatedAt: h.SecretRotatedAt, CreatedAt: h.CreatedAt, CreatedBy: h.CreatedBy.Label,
	}
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

type attemptJSON struct {
	At     time.Time `json:"at"`
	Status int       `json:"status"`
	MS     int       `json:"ms"`
	Note   string    `json:"note,omitempty"`
}

func toAttempts(as []store.WebhookAttempt) []attemptJSON {
	out := make([]attemptJSON, 0, len(as))
	for _, a := range as {
		out = append(out, attemptJSON{At: time.UnixMilli(a.At).UTC(), Status: a.Status, MS: a.MS, Note: a.Note})
	}
	return out
}

type deliveryJSON struct {
	ID            string        `json:"id"`
	WebhookID     string        `json:"webhook_id"`
	MessageID     string        `json:"message_id"`
	Seq           uint64        `json:"seq"`
	State         string        `json:"state"`
	AttemptCount  int           `json:"attempt_count"`
	Attempts      []attemptJSON `json:"attempts"`
	NextAttemptAt *time.Time    `json:"next_attempt_at"`
	UpdatedAt     time.Time     `json:"updated_at"`
}

type deadLetterJSON struct {
	ID         string        `json:"id"`
	WebhookID  string        `json:"webhook_id"`
	DeliveryID string        `json:"delivery_id"`
	MessageID  string        `json:"message_id"`
	URL        string        `json:"url"`
	Attempts   []attemptJSON `json:"attempts"`
	DeadAt     time.Time     `json:"dead_at"`
}

type listenerJSON struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	URL             string     `json:"url"`
	Paused          bool       `json:"paused"`
	SecretLast4     string     `json:"secret_last4"`
	SecretRotatedAt time.Time  `json:"secret_rotated_at"`
	CallCount       int64      `json:"call_count"`
	LastCallAt      *time.Time `json:"last_call_at"`
	CreatedAt       time.Time  `json:"created_at"`
	CreatedBy       string     `json:"created_by"`
}

func (s *Server) toListenerJSON(l store.WorkspaceListener) listenerJSON {
	return listenerJSON{
		ID: l.ID, Name: l.Name, URL: s.listenerURL(l.ID), Paused: l.Paused,
		SecretLast4: l.SecretLast4, SecretRotatedAt: l.SecretRotatedAt, CallCount: l.CallCount, LastCallAt: l.LastCallAt,
		CreatedAt: l.CreatedAt, CreatedBy: l.CreatedBy.Label,
	}
}

type listenerCallJSON struct {
	ID         string    `json:"id"`
	ListenerID string    `json:"listener_id"`
	At         time.Time `json:"at"`
	Status     int       `json:"status"`
	FromIP     string    `json:"from_ip,omitempty"` // admins only: it is personal data
	Bytes      int64     `json:"bytes"`
	MessageID  string    `json:"message_id,omitempty"`
	Summary    string    `json:"summary,omitempty"`
}

/* ---------------------------------------------------------------------- */
/* The tab                                                                 */
/* ---------------------------------------------------------------------- */

// GET .../webhooks: everything the Webhooks tab shows. Anyone who can see
// the workspace can read it; no secret is ever returned.
func (s *Server) handleListWebhooks(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.loadWorkspace(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	hooks, err := s.store.ListWorkspaceWebhooks(ctx, v.orgID, ws.ID)
	if err != nil {
		s.internalError(w, "list webhooks", err)
		return
	}
	listeners, err := s.store.ListWorkspaceListeners(ctx, v.orgID, ws.ID)
	if err != nil {
		s.internalError(w, "list listeners", err)
		return
	}
	limit := recentLimit
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil {
		limit = n
	}
	deliveries, err := s.store.ListWebhookDeliveries(ctx, v.orgID, ws.ID, r.URL.Query().Get("webhook"), limit)
	if err != nil {
		s.internalError(w, "list deliveries", err)
		return
	}
	dead, err := s.store.ListWebhookDeadLetters(ctx, v.orgID, ws.ID, limit)
	if err != nil {
		s.internalError(w, "list dead letters", err)
		return
	}
	calls, err := s.store.ListWorkspaceListenerCalls(ctx, v.orgID, ws.ID, r.URL.Query().Get("listener"), limit)
	if err != nil {
		s.internalError(w, "list listener calls", err)
		return
	}
	admin := v.canAdmin(ws.ID)
	out := struct {
		Webhooks      []webhookJSON      `json:"webhooks"`
		Listeners     []listenerJSON     `json:"listeners"`
		Deliveries    []deliveryJSON     `json:"deliveries"`
		DeadLetters   []deadLetterJSON   `json:"dead_letters"`
		ListenerCalls []listenerCallJSON `json:"listener_calls"`
		CanAdmin      bool               `json:"can_admin"`
		AllowPrivate  bool               `json:"allow_private"`
		Available     bool               `json:"available"`
	}{
		Webhooks: []webhookJSON{}, Listeners: []listenerJSON{}, Deliveries: []deliveryJSON{},
		DeadLetters: []deadLetterJSON{}, ListenerCalls: []listenerCallJSON{},
		CanAdmin: admin, AllowPrivate: s.cfg.WebhookAllowPrivate, Available: s.hooks != nil,
	}
	for _, h := range hooks {
		out.Webhooks = append(out.Webhooks, toWebhookJSON(h))
	}
	for _, l := range listeners {
		out.Listeners = append(out.Listeners, s.toListenerJSON(l))
	}
	for _, d := range deliveries {
		out.Deliveries = append(out.Deliveries, deliveryJSON{
			ID: d.ID, WebhookID: d.WebhookID, MessageID: d.MessageID, Seq: d.Seq, State: d.State,
			AttemptCount: d.AttemptCount, Attempts: toAttempts(d.Attempts), NextAttemptAt: d.NextAttemptAt, UpdatedAt: d.UpdatedAt,
		})
	}
	for _, d := range dead {
		out.DeadLetters = append(out.DeadLetters, deadLetterJSON{
			ID: d.ID, WebhookID: d.WebhookID, DeliveryID: d.DeliveryID, MessageID: d.MessageID, URL: d.URL,
			Attempts: toAttempts(d.Attempts), DeadAt: d.DeadAt,
		})
	}
	for _, c := range calls {
		cj := listenerCallJSON{ID: c.ID, ListenerID: c.ListenerID, At: c.At, Status: c.Status, Bytes: c.Bytes, MessageID: c.MessageID, Summary: c.Summary}
		if admin {
			cj.FromIP = c.FromIP
		}
		out.ListenerCalls = append(out.ListenerCalls, cj)
	}
	writeJSON(w, http.StatusOK, out)
}

type webhookRequest struct {
	Name   *string            `json:"name"`
	URL    *string            `json:"url"`
	Filter *webhookFilterJSON `json:"filter"`
	Paused *bool              `json:"paused"`
}

func (f *webhookFilterJSON) store() *store.WebhookFilter {
	if f == nil {
		return nil
	}
	return &store.WebhookFilter{AuthorKinds: f.AuthorKinds, AuthorIDs: f.AuthorIDs, Threads: f.Threads, Contains: f.Contains}
}

func validURL(w http.ResponseWriter, raw string) (string, bool) {
	u, err := webhooks.ValidateURL(raw)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid", err.Error())
		return "", false
	}
	return u.String(), true
}

// newSecret issues a signing secret: the plaintext for the response, the
// sealed form for the store.
func (s *Server) newSecret() (string, store.Secret) {
	secret := webhooks.NewSecret()
	return secret, store.Secret{Sealed: s.hooks.Box().Seal(secret), Last4: webhooks.Last4(secret)}
}

// POST .../webhooks: the response carries the signing secret, the only
// time it is shown.
func (s *Server) handleCreateWebhook(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok || !s.webhooksReady(w) {
		return
	}
	var req webhookRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if req.URL == nil {
		writeError(w, http.StatusBadRequest, "invalid", "a webhook needs a URL")
		return
	}
	url, ok := validURL(w, *req.URL)
	if !ok {
		return
	}
	in := store.WebhookInput{URL: url, Filter: store.DefaultWebhookFilter()}
	if req.Name != nil {
		in.Name = *req.Name
	}
	if f := req.Filter.store(); f != nil {
		in.Filter = *f
	}
	secret, sealed := s.newSecret()
	in.Secret = sealed
	h, err := s.store.CreateWorkspaceWebhook(r.Context(), v.orgID, ws.ID, actor(r), in, s.now())
	if err != nil {
		s.storeError(w, "webhook", err)
		return
	}
	if req.Paused != nil && *req.Paused {
		if h, err = s.store.UpdateWorkspaceWebhook(r.Context(), v.orgID, ws.ID, h.ID, actor(r), store.WebhookPatch{Paused: req.Paused}, s.now()); err != nil {
			s.storeError(w, "webhook", err)
			return
		}
	}
	s.hooks.Changed(r.Context())
	writeJSON(w, http.StatusCreated, map[string]any{"webhook": toWebhookJSON(h), "secret": secret})
}

// PATCH .../webhooks/{hook}: rename, re-target, re-filter, pause or resume.
func (s *Server) handleUpdateWebhook(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok || !s.webhooksReady(w) {
		return
	}
	var req webhookRequest
	if !decodeBody(w, r, &req) {
		return
	}
	p := store.WebhookPatch{Name: req.Name, Filter: req.Filter.store(), Paused: req.Paused}
	if req.URL != nil {
		url, ok := validURL(w, *req.URL)
		if !ok {
			return
		}
		p.URL = &url
	}
	h, err := s.store.UpdateWorkspaceWebhook(r.Context(), v.orgID, ws.ID, r.PathValue("hook"), actor(r), p, s.now())
	if err != nil {
		s.storeError(w, "webhook", err)
		return
	}
	s.hooks.Changed(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"webhook": toWebhookJSON(h)})
}

// POST .../webhooks/{hook}/secret/rotate: a new signing secret, shown
// once. The old one stops being used at once.
func (s *Server) handleRotateWebhookSecret(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok || !s.webhooksReady(w) {
		return
	}
	secret, sealed := s.newSecret()
	h, err := s.store.UpdateWorkspaceWebhook(r.Context(), v.orgID, ws.ID, r.PathValue("hook"), actor(r), store.WebhookPatch{Secret: sealed}, s.now())
	if err != nil {
		s.storeError(w, "webhook", err)
		return
	}
	s.hooks.Changed(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"webhook": toWebhookJSON(h), "secret": secret})
}

func (s *Server) handleDeleteWebhook(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok || !s.webhooksReady(w) {
		return
	}
	if err := s.store.DeleteWorkspaceWebhook(r.Context(), v.orgID, ws.ID, r.PathValue("hook"), actor(r), s.now()); err != nil {
		s.storeError(w, "webhook", err)
		return
	}
	s.hooks.Changed(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

// POST .../webhook-dead-letters/{dl}/redeliver: queue a dead letter again,
// byte for byte, with a fresh set of attempts.
func (s *Server) handleRedeliver(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok || !s.webhooksReady(w) {
		return
	}
	d, err := s.store.TakeDeadLetter(r.Context(), v.orgID, ws.ID, r.PathValue("dl"), actor(r), s.now())
	if err != nil {
		s.storeError(w, "dead letter", err)
		return
	}
	if err := s.hooks.Redeliver(r.Context(), d, v.orgID); err != nil {
		// The dead letter is already off the list; say so rather than
		// pretend it was queued.
		s.log.Error("redeliver: queue failed", "dead_letter", d.ID, "err", err)
		writeError(w, http.StatusServiceUnavailable, "unavailable", "could not queue the redelivery; the dead letter was removed, so send the message again")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"delivery_id": d.DeliveryID})
}

/* ---------------------------------------------------------------------- */
/* Listeners                                                               */
/* ---------------------------------------------------------------------- */

type listenerRequest struct {
	Name   *string `json:"name"`
	Paused *bool   `json:"paused"`
}

// POST .../listeners: the response carries the URL and the signing secret,
// the only time the secret is shown.
func (s *Server) handleCreateListener(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok || !s.webhooksReady(w) {
		return
	}
	var req listenerRequest
	if !decodeBody(w, r, &req) {
		return
	}
	name := ""
	if req.Name != nil {
		name = *req.Name
	}
	secret, sealed := s.newSecret()
	l, err := s.store.CreateWorkspaceListener(r.Context(), v.orgID, ws.ID, actor(r), name, sealed, s.now())
	if err != nil {
		s.storeError(w, "listener", err)
		return
	}
	s.hooks.Changed(r.Context())
	writeJSON(w, http.StatusCreated, map[string]any{"listener": s.toListenerJSON(l), "secret": secret})
}

func (s *Server) handleUpdateListener(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok || !s.webhooksReady(w) {
		return
	}
	var req listenerRequest
	if !decodeBody(w, r, &req) {
		return
	}
	l, err := s.store.UpdateWorkspaceListener(r.Context(), v.orgID, ws.ID, r.PathValue("lsn"), actor(r),
		store.ListenerPatch{Name: req.Name, Paused: req.Paused}, s.now())
	if err != nil {
		s.storeError(w, "listener", err)
		return
	}
	s.hooks.Changed(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"listener": s.toListenerJSON(l)})
}

func (s *Server) handleRotateListenerSecret(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok || !s.webhooksReady(w) {
		return
	}
	secret, sealed := s.newSecret()
	l, err := s.store.UpdateWorkspaceListener(r.Context(), v.orgID, ws.ID, r.PathValue("lsn"), actor(r), store.ListenerPatch{Secret: sealed}, s.now())
	if err != nil {
		s.storeError(w, "listener", err)
		return
	}
	s.hooks.Changed(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"listener": s.toListenerJSON(l), "secret": secret})
}

func (s *Server) handleDeleteListener(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok || !s.webhooksReady(w) {
		return
	}
	if err := s.store.DeleteWorkspaceListener(r.Context(), v.orgID, ws.ID, r.PathValue("lsn"), actor(r), s.now()); err != nil {
		s.storeError(w, "listener", err)
		return
	}
	s.hooks.Changed(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

/* ---------------------------------------------------------------------- */
/* The listener endpoint                                                   */
/* ---------------------------------------------------------------------- */

// listenerBody is the documented shape of a listener call. Any other JSON
// document becomes the payload of a message saying the listener was
// called; a body that isn't JSON becomes the message text.
type listenerBody struct {
	Body     *string         `json:"body"`
	Payload  json.RawMessage `json:"payload"`
	ThreadID string          `json:"thread_id"`
}

// POST /hooks/v1/{listener}: a signed call from outside becomes a message
// in the listener's workspace, through the normal JetStream path. The
// listener is looked up in memory; the only SQL is the call record.
func (s *Server) handleListenerCall(w http.ResponseWriter, r *http.Request) {
	if s.hooks == nil {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "listeners are unavailable on this server")
		return
	}
	l, loaded := s.hooks.Listener(r.PathValue("listener"))
	switch {
	case !loaded:
		writeError(w, http.StatusServiceUnavailable, "unavailable", "starting up; try again")
		return
	case l == nil:
		writeError(w, http.StatusNotFound, "not_found", "no such listener")
		return
	}
	now := s.now()
	call := store.WorkspaceListenerCall{
		ID: store.NewID("lc"), OrgID: l.OrgID, WorkspaceID: l.WorkspaceID, ListenerID: l.ID,
		At: now, FromIP: s.clientIP(r), Trk: store.NewID("trk"),
	}
	answer := func(status int, code, msg string) {
		call.Status = status
		if call.Summary == "" {
			call.Summary = msg
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
		defer cancel()
		if err := s.store.RecordListenerCall(ctx, call); err != nil {
			s.log.Warn("listener: record call failed", "listener", l.ID, "err", err)
		}
		if status == http.StatusAccepted {
			writeJSON(w, status, map[string]any{"message_id": call.MessageID, "trk": call.Trk})
			return
		}
		writeError(w, status, code, msg)
	}

	if allowed, wait := s.listenerCalls.Allowed(l.ID); !allowed {
		// Not recorded: a flood would otherwise fill the call log.
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many calls to this listener; try again later")
		return
	}
	s.listenerCalls.Fail(l.ID) // counts every call, not only failures
	if l.Paused {
		answer(http.StatusGone, "paused", "this listener is paused")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, listenerMaxBody))
	call.Bytes = int64(len(raw))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			answer(http.StatusRequestEntityTooLarge, "too_large", "the body is larger than 64 KiB")
			return
		}
		answer(http.StatusBadRequest, "invalid", "could not read the body")
		return
	}
	if l.SecretErr != nil {
		s.log.Error("listener: secret unreadable", "listener", l.ID, "err", l.SecretErr)
		answer(http.StatusUnauthorized, "unauthenticated", "signature check failed")
		return
	}
	if err := webhooks.Verify(l.Secret, r.Header.Get(webhooks.SignatureHeader), raw, now, webhooks.SignatureTolerance); err != nil {
		call.Summary = "refused: " + strings.TrimPrefix(err.Error(), "webhooks: ")
		answer(http.StatusUnauthorized, "unauthenticated", "signature check failed")
		return
	}

	body, payload, thread := listenerMessage(l.Name, raw)
	m, err := messaging.NewMessage(l.OrgID, l.WorkspaceID,
		messaging.Author{Kind: "listener", ID: l.ID, Label: l.Name, From: call.FromIP}, body, payload, thread, now)
	if err != nil {
		answer(http.StatusBadRequest, "invalid", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), agentPublishTimeout)
	defer cancel()
	if _, _, err := s.hub.Publish(ctx, m); err != nil {
		s.log.Error("listener: publish failed", "listener", l.ID, "err", err)
		answer(http.StatusServiceUnavailable, "unavailable", "could not post the message; try again")
		return
	}
	call.MessageID = m.ID
	call.Summary = summarize(body)
	answer(http.StatusAccepted, "", "")
}

// listenerMessage turns a call's body into a message's text, payload and
// thread.
func listenerMessage(name string, raw []byte) (body string, payload json.RawMessage, thread string) {
	trimmed := strings.TrimSpace(string(raw))
	if json.Valid([]byte(trimmed)) && trimmed != "" {
		var lb listenerBody
		if trimmed[0] == '{' && json.Unmarshal([]byte(trimmed), &lb) == nil && lb.Body != nil {
			return *lb.Body, lb.Payload, lb.ThreadID
		}
		if trimmed[0] == '{' || trimmed[0] == '[' {
			return "Call to listener " + name, json.RawMessage(trimmed), ""
		}
	}
	return string(raw), nil, ""
}

func summarize(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) > 120 {
		return string([]rune(s)[:120]) + "…"
	}
	return s
}
