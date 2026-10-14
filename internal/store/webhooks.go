package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Workspace webhooks and listeners: the records behind the Webhooks tab.
// Configuration changes run in one transaction with their audit row, as
// the other admin writes do. Delivery and listener-call records are written
// by the webhook workers and the listener endpoint, never by the message
// send path.

// Limits on webhook configuration.
const (
	MaxWebhookName       = 80
	MaxWebhooksPerWS     = 20
	MaxListenersPerWS    = 20
	MaxFilterIDs         = 50
	MaxFilterContains    = 200
	maxAttemptsKept      = 20
	webhookRecordDays    = 30
	listenerCallKeepDays = 30
)

// Author kinds a webhook filter can name.
var webhookAuthorKinds = []string{"agent", "user", "listener"}

// WebhookFilter chooses which of a workspace's messages a webhook gets.
// Every set condition must hold.
type WebhookFilter struct {
	// AuthorKinds the message's author must be one of (agent, user,
	// listener). Never empty once stored.
	AuthorKinds []string `json:"author_kinds"`
	// AuthorIDs, when not empty, the author must be one of.
	AuthorIDs []string `json:"author_ids"`
	// Threads is all, roots (messages that start a thread or stand alone)
	// or replies.
	Threads string `json:"threads"`
	// Contains, when set, must appear in the body (case-insensitive).
	Contains string `json:"contains"`
}

// DefaultWebhookFilter is every message by an agent or a person. Messages
// from listeners are left out unless asked for, so a webhook pointed at
// its own workspace's listener cannot loop.
func DefaultWebhookFilter() WebhookFilter {
	return WebhookFilter{AuthorKinds: []string{"agent", "user"}, Threads: "all"}
}

func (f *WebhookFilter) clean() error {
	if len(f.AuthorKinds) == 0 {
		f.AuthorKinds = DefaultWebhookFilter().AuthorKinds
	}
	var kinds []string
	for _, k := range f.AuthorKinds {
		if !slices.Contains(webhookAuthorKinds, k) {
			return invalid("author kinds are agent, user or listener, not %q", k)
		}
		if !slices.Contains(kinds, k) {
			kinds = append(kinds, k)
		}
	}
	f.AuthorKinds = kinds
	var ids []string
	for _, id := range f.AuthorIDs {
		if id = strings.TrimSpace(id); id != "" && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	if len(ids) > MaxFilterIDs {
		return invalid("a filter names at most %d authors", MaxFilterIDs)
	}
	f.AuthorIDs = ids
	switch f.Threads {
	case "":
		f.Threads = "all"
	case "all", "roots", "replies":
	default:
		return invalid("threads is all, roots or replies, not %q", f.Threads)
	}
	f.Contains = strings.TrimSpace(f.Contains)
	if len([]rune(f.Contains)) > MaxFilterContains {
		return invalid("the text filter is at most %d characters", MaxFilterContains)
	}
	return nil
}

// Matches reports whether a message passes the filter.
func (f WebhookFilter) Matches(authorKind, authorID, threadID, body string) bool {
	if !slices.Contains(f.AuthorKinds, authorKind) {
		return false
	}
	if len(f.AuthorIDs) > 0 && !slices.Contains(f.AuthorIDs, authorID) {
		return false
	}
	switch f.Threads {
	case "roots":
		if threadID != "" {
			return false
		}
	case "replies":
		if threadID == "" {
			return false
		}
	}
	return f.Contains == "" || strings.Contains(strings.ToLower(body), strings.ToLower(f.Contains))
}

// WorkspaceWebhook is an outgoing webhook.
type WorkspaceWebhook struct {
	ID              string
	OrgID           string
	WorkspaceID     string
	Name            string
	URL             string
	Filter          WebhookFilter
	SecretSealed    string
	SecretLast4     string
	SecretRotatedAt time.Time
	Paused          bool
	CreatedAt       time.Time
	CreatedBy       Actor
	UpdatedAt       time.Time
}

// WorkspaceListener is an incoming listener.
type WorkspaceListener struct {
	ID              string
	OrgID           string
	WorkspaceID     string
	Name            string
	SecretSealed    string
	SecretLast4     string
	SecretRotatedAt time.Time
	Paused          bool
	CallCount       int64
	LastCallAt      *time.Time
	CreatedAt       time.Time
	CreatedBy       Actor
	UpdatedAt       time.Time
}

// Secret is a freshly issued signing secret: sealed for storage, and its
// last four characters for display. The plaintext never reaches the store.
type Secret struct {
	Sealed string
	Last4  string
}

// WebhookInput is a new webhook. URL must already be validated.
type WebhookInput struct {
	Name   string
	URL    string
	Filter WebhookFilter
	Secret Secret
}

// WebhookPatch changes a webhook. Nil fields are left as they are; a
// non-empty Secret replaces the signing secret.
type WebhookPatch struct {
	Name   *string
	URL    *string
	Filter *WebhookFilter
	Paused *bool
	Secret Secret
}

func cleanHookName(name, what string) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", invalid("a %s needs a name", what)
	case len([]rune(name)) > MaxWebhookName:
		return "", invalid("a %s name is at most %d characters", what, MaxWebhookName)
	}
	return name, nil
}

const webhookCols2 = `id, org_id, workspace_id, name, url, filter_author_kinds, filter_author_ids, filter_threads, filter_contains,
	secret_sealed, secret_last4, secret_rotated_at, paused, created_at, created_by_kind, created_by_id, created_by_label, updated_at`

func scanWorkspaceWebhook(r rowScanner) (WorkspaceWebhook, error) {
	var h WorkspaceWebhook
	var kinds, ids, contains, byID sql.NullString
	var rotated, created, updated int64
	if err := r.Scan(&h.ID, &h.OrgID, &h.WorkspaceID, &h.Name, &h.URL, &kinds, &ids, &h.Filter.Threads, &contains,
		&h.SecretSealed, &h.SecretLast4, &rotated, &h.Paused, &created, &h.CreatedBy.Kind, &byID, &h.CreatedBy.Label, &updated); err != nil {
		return h, err
	}
	var err error
	if h.Filter.AuthorKinds, err = decodeJSON[[]string](kinds); err != nil {
		return h, fmt.Errorf("store: webhook %s filter: %w", h.ID, err)
	}
	if h.Filter.AuthorIDs, err = decodeJSON[[]string](ids); err != nil {
		return h, fmt.Errorf("store: webhook %s filter: %w", h.ID, err)
	}
	h.Filter.Contains, h.CreatedBy.ID = contains.String, byID.String
	h.SecretRotatedAt, h.CreatedAt, h.UpdatedAt = fromMillis(rotated), fromMillis(created), fromMillis(updated)
	return h, nil
}

func jsonText(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}

func filterIDs(f WebhookFilter) (any, error) {
	if len(f.AuthorIDs) == 0 {
		return nil, nil
	}
	return jsonText(f.AuthorIDs)
}

// CreateWorkspaceWebhook adds an outgoing webhook to an active workspace.
func (s *Store) CreateWorkspaceWebhook(ctx context.Context, orgID, wsID string, by Actor, in WebhookInput, now time.Time) (WorkspaceWebhook, error) {
	name, err := cleanHookName(in.Name, "webhook")
	if err != nil {
		return WorkspaceWebhook{}, err
	}
	if err := in.Filter.clean(); err != nil {
		return WorkspaceWebhook{}, err
	}
	if in.URL == "" || in.Secret.Sealed == "" {
		return WorkspaceWebhook{}, invalid("a webhook needs a URL")
	}
	h := WorkspaceWebhook{
		ID: NewID("wh"), OrgID: orgID, WorkspaceID: wsID, Name: name, URL: in.URL, Filter: in.Filter,
		SecretSealed: in.Secret.Sealed, SecretLast4: in.Secret.Last4, SecretRotatedAt: now.UTC(),
		CreatedAt: now.UTC(), CreatedBy: Actor{Kind: by.Kind, ID: by.ID, Label: by.Label}, UpdatedAt: now.UTC(),
	}
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, s.q("SELECT COUNT(*) FROM workspace_webhooks WHERE org_id = ? AND workspace_id = ?"), orgID, wsID).Scan(&n); err != nil {
			return err
		}
		if n >= MaxWebhooksPerWS {
			return invalid("a workspace has at most %d webhooks", MaxWebhooksPerWS)
		}
		kinds, err := jsonText(h.Filter.AuthorKinds)
		if err != nil {
			return err
		}
		ids, err := filterIDs(h.Filter)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO workspace_webhooks (id, org_id, workspace_id, name, url,
			    filter_author_kinds, filter_author_ids, filter_threads, filter_contains,
			    secret_sealed, secret_last4, secret_rotated_at, paused, created_at, created_by_kind, created_by_id, created_by_label, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			h.ID, orgID, wsID, h.Name, h.URL, kinds, ids, h.Filter.Threads, nullable(h.Filter.Contains),
			h.SecretSealed, h.SecretLast4, millis(now), false, millis(now), by.Kind, nullable(by.ID), by.Label, millis(now)); err != nil {
			return err
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Type: "webhook",
			Subject: &AuditSubject{Kind: "webhook", ID: h.ID, Label: h.Name},
			Object:  fmt.Sprintf("Added webhook %s to %s", h.Name, w.Name),
			Changes: []Change{{Field: "url", Before: nil, After: h.URL}, {Field: "filter", Before: nil, After: h.Filter}},
		})
		return err
	})
	return h, err
}

// GetWorkspaceWebhook loads one webhook of a workspace.
func (s *Store) GetWorkspaceWebhook(ctx context.Context, orgID, wsID, id string) (WorkspaceWebhook, error) {
	h, err := scanWorkspaceWebhook(s.db.QueryRowContext(ctx, s.q("SELECT "+webhookCols2+
		" FROM workspace_webhooks WHERE org_id = ? AND workspace_id = ? AND id = ?"), orgID, wsID, id))
	return h, notFound(err)
}

// ListWorkspaceWebhooks returns a workspace's webhooks, oldest first.
func (s *Store) ListWorkspaceWebhooks(ctx context.Context, orgID, wsID string) ([]WorkspaceWebhook, error) {
	var out []WorkspaceWebhook
	err := s.queryRows(ctx, "SELECT "+webhookCols2+" FROM workspace_webhooks WHERE org_id = ? AND workspace_id = ? ORDER BY created_at, id",
		[]any{orgID, wsID}, func(r rowScanner) error {
			h, err := scanWorkspaceWebhook(r)
			out = append(out, h)
			return err
		})
	return out, err
}

// UpdateWorkspaceWebhook changes a webhook. It returns the webhook and
// whether anything changed.
func (s *Store) UpdateWorkspaceWebhook(ctx context.Context, orgID, wsID, id string, by Actor, p WebhookPatch, now time.Time) (WorkspaceWebhook, error) {
	var h WorkspaceWebhook
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		h, err = scanWorkspaceWebhook(tx.QueryRowContext(ctx, s.q("SELECT "+webhookCols2+
			" FROM workspace_webhooks WHERE org_id = ? AND workspace_id = ? AND id = ?"), orgID, wsID, id))
		if err != nil {
			return notFound(err)
		}
		var changes []Change
		object := ""
		if p.Name != nil {
			name, err := cleanHookName(*p.Name, "webhook")
			if err != nil {
				return err
			}
			if name != h.Name {
				changes = append(changes, Change{Field: "name", Before: h.Name, After: name})
				h.Name = name
			}
		}
		if p.URL != nil && *p.URL != h.URL {
			if *p.URL == "" {
				return invalid("a webhook needs a URL")
			}
			changes = append(changes, Change{Field: "url", Before: h.URL, After: *p.URL})
			h.URL = *p.URL
		}
		if p.Filter != nil {
			f := *p.Filter
			if err := f.clean(); err != nil {
				return err
			}
			before, _ := json.Marshal(h.Filter)
			after, _ := json.Marshal(f)
			if string(before) != string(after) {
				changes = append(changes, Change{Field: "filter", Before: h.Filter, After: f})
				h.Filter = f
			}
		}
		if p.Paused != nil && *p.Paused != h.Paused {
			changes = append(changes, Change{Field: "paused", Before: h.Paused, After: *p.Paused})
			h.Paused = *p.Paused
			object = fmt.Sprintf("Resumed webhook %s in %s", h.Name, w.Name)
			if h.Paused {
				object = fmt.Sprintf("Paused webhook %s in %s", h.Name, w.Name)
			}
		}
		if p.Secret.Sealed != "" {
			changes = append(changes, Change{Field: "secret", Before: "…" + h.SecretLast4, After: "…" + p.Secret.Last4})
			h.SecretSealed, h.SecretLast4, h.SecretRotatedAt = p.Secret.Sealed, p.Secret.Last4, now.UTC()
			if len(changes) == 1 {
				object = fmt.Sprintf("Rotated the signing secret of webhook %s in %s", h.Name, w.Name)
			}
		}
		if len(changes) == 0 {
			return nil
		}
		if len(changes) > 1 || object == "" {
			object = fmt.Sprintf("Changed webhook %s in %s", h.Name, w.Name)
		}
		kinds, err := jsonText(h.Filter.AuthorKinds)
		if err != nil {
			return err
		}
		ids, err := filterIDs(h.Filter)
		if err != nil {
			return err
		}
		h.UpdatedAt = now.UTC()
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE workspace_webhooks SET name = ?, url = ?, filter_author_kinds = ?, filter_author_ids = ?,
			    filter_threads = ?, filter_contains = ?, secret_sealed = ?, secret_last4 = ?, secret_rotated_at = ?, paused = ?, updated_at = ?
			 WHERE id = ?`),
			h.Name, h.URL, kinds, ids, h.Filter.Threads, nullable(h.Filter.Contains),
			h.SecretSealed, h.SecretLast4, millis(h.SecretRotatedAt), h.Paused, millis(now), h.ID); err != nil {
			return err
		}
		severity := "info"
		if p.Paused != nil && *p.Paused {
			severity = "warn"
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Type: "webhook", Severity: severity,
			Subject: &AuditSubject{Kind: "webhook", ID: h.ID, Label: h.Name},
			Object:  object, Changes: changes,
		})
		return err
	})
	return h, err
}

// DeleteWorkspaceWebhook removes a webhook with its delivery records and
// dead letters. Jobs already queued for it are dropped by the workers.
func (s *Store) DeleteWorkspaceWebhook(ctx context.Context, orgID, wsID, id string, by Actor, now time.Time) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		h, err := scanWorkspaceWebhook(tx.QueryRowContext(ctx, s.q("SELECT "+webhookCols2+
			" FROM workspace_webhooks WHERE org_id = ? AND workspace_id = ? AND id = ?"), orgID, wsID, id))
		if err != nil {
			return notFound(err)
		}
		for _, q := range []string{
			"DELETE FROM workspace_webhooks WHERE id = ?",
			"DELETE FROM webhook_deliveries WHERE webhook_id = ?",
			"DELETE FROM webhook_dead_letters WHERE webhook_id = ?",
		} {
			if _, err := tx.ExecContext(ctx, s.q(q), id); err != nil {
				return err
			}
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Type: "webhook", Severity: "warn",
			Subject: &AuditSubject{Kind: "webhook", ID: h.ID, Label: h.Name},
			Object:  fmt.Sprintf("Deleted webhook %s from %s", h.Name, w.Name),
			Changes: []Change{{Field: "url", Before: h.URL, After: nil}},
		})
		return err
	})
}

/* ---------------------------------------------------------------------- */
/* Deliveries and dead letters                                             */
/* ---------------------------------------------------------------------- */

// WebhookDelivery is one message's delivery to one webhook.
type WebhookDelivery struct {
	ID            string
	WorkspaceID   string
	WebhookID     string
	MessageID     string
	Seq           uint64
	State         string // retrying, delivered, dead or dropped
	AttemptCount  int
	Attempts      []WebhookAttempt
	NextAttemptAt *time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// DeliveryAttempt is the outcome of one POST, as the worker reports it.
type DeliveryAttempt struct {
	OrgID, WorkspaceID, WebhookID, MessageID, DeliveryID string
	Seq                                                  uint64
	Attempt                                              WebhookAttempt
	State                                                string // retrying, delivered, dead or dropped
	NextAttemptAt                                        *time.Time
	// Dead letter, when State is dead: the URL and the exact body sent.
	URL  string
	Body []byte
}

// RecordDeliveryAttempt stores an attempt's outcome on its delivery row,
// creating it on the first attempt. When the state is dead it also writes
// the dead letter, in the same transaction.
func (s *Store) RecordDeliveryAttempt(ctx context.Context, a DeliveryAttempt, now time.Time) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		var attempts sql.NullString
		var count int
		err := tx.QueryRowContext(ctx, s.q("SELECT attempts, attempt_count FROM webhook_deliveries WHERE id = ?"), a.DeliveryID).Scan(&attempts, &count)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		list, err := decodeJSON[[]WebhookAttempt](attempts)
		if err != nil {
			return err
		}
		if a.Attempt.ID != "" {
			list = append(list, a.Attempt)
			count++
		}
		if len(list) > maxAttemptsKept {
			list = list[len(list)-maxAttemptsKept:]
		}
		if list == nil {
			list = []WebhookAttempt{}
		}
		text, err := jsonText(list)
		if err != nil {
			return err
		}
		var next any
		if a.NextAttemptAt != nil {
			next = millis(*a.NextAttemptAt)
		}
		deleteAt := millis(now.Add(webhookRecordDays * 24 * time.Hour))
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO webhook_deliveries (id, org_id, workspace_id, webhook_id, message_id, seq, state,
			    attempt_count, attempts, next_attempt_at, created_at, updated_at, delete_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET state = excluded.state, attempt_count = excluded.attempt_count,
			    attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at,
			    updated_at = excluded.updated_at, delete_at = excluded.delete_at`),
			a.DeliveryID, a.OrgID, a.WorkspaceID, a.WebhookID, a.MessageID, int64(a.Seq), a.State,
			count, text, next, millis(now), millis(now), deleteAt); err != nil {
			return err
		}
		if a.State != "dead" {
			return nil
		}
		_, err = tx.ExecContext(ctx, s.q(`INSERT INTO webhook_dead_letters (id, org_id, workspace_id, webhook_id, message_id, url, trigger,
			    attempts, reason, dead_at, delete_at, delivery_id, body, seq)
			 VALUES (?, ?, ?, ?, ?, ?, 'send', ?, 'gave_up', ?, ?, ?, ?, ?)`),
			NewID("dl"), a.OrgID, a.WorkspaceID, a.WebhookID, a.MessageID, a.URL,
			text, millis(now), deleteAt, a.DeliveryID, string(a.Body), int64(a.Seq))
		return err
	})
}

// ListWebhookDeliveries returns a workspace's most recent deliveries,
// newest first; webhookID narrows them to one webhook. A delivery recorded
// while its webhook was being deleted is left out.
func (s *Store) ListWebhookDeliveries(ctx context.Context, orgID, wsID, webhookID string, limit int) ([]WebhookDelivery, error) {
	query := `SELECT id, workspace_id, webhook_id, message_id, seq, state, attempt_count, attempts, next_attempt_at, created_at, updated_at
		  FROM webhook_deliveries WHERE org_id = ? AND workspace_id = ?
		   AND webhook_id IN (SELECT id FROM workspace_webhooks WHERE org_id = ?)`
	args := []any{orgID, wsID, orgID}
	if webhookID != "" {
		query += " AND webhook_id = ?"
		args = append(args, webhookID)
	}
	query += fmt.Sprintf(" ORDER BY updated_at DESC, id LIMIT %d", clampLimit(limit))
	var out []WebhookDelivery
	err := s.queryRows(ctx, query, args, func(r rowScanner) error {
		var d WebhookDelivery
		var seq, created, updated int64
		var attempts sql.NullString
		var next sql.NullInt64
		if err := r.Scan(&d.ID, &d.WorkspaceID, &d.WebhookID, &d.MessageID, &seq, &d.State, &d.AttemptCount, &attempts, &next, &created, &updated); err != nil {
			return err
		}
		at, err := decodeJSON[[]WebhookAttempt](attempts)
		d.Seq, d.Attempts, d.NextAttemptAt, d.CreatedAt, d.UpdatedAt = uint64(seq), at, timePtr(next), fromMillis(created), fromMillis(updated)
		out = append(out, d)
		return err
	})
	return out, err
}

// WebhookDeadLetter is a delivery that failed every attempt.
type WebhookDeadLetter struct {
	ID          string
	WorkspaceID string
	WebhookID   string
	DeliveryID  string
	MessageID   string
	Seq         uint64
	URL         string
	Attempts    []WebhookAttempt
	DeadAt      time.Time
	Body        []byte
}

const deadLetterCols = `id, workspace_id, webhook_id, delivery_id, message_id, seq, url, attempts, dead_at, body`

func scanDeadLetter(r rowScanner) (WebhookDeadLetter, error) {
	var d WebhookDeadLetter
	var delivery, attempts, body sql.NullString
	var seq sql.NullInt64
	var dead int64
	if err := r.Scan(&d.ID, &d.WorkspaceID, &d.WebhookID, &delivery, &d.MessageID, &seq, &d.URL, &attempts, &dead, &body); err != nil {
		return d, err
	}
	at, err := decodeJSON[[]WebhookAttempt](attempts)
	d.DeliveryID, d.Seq, d.Attempts, d.DeadAt = delivery.String, uint64(seq.Int64), at, fromMillis(dead)
	if body.Valid {
		d.Body = []byte(body.String)
	}
	return d, err
}

// ListWebhookDeadLetters returns a workspace's dead letters from
// workspace webhooks, newest first.
func (s *Store) ListWebhookDeadLetters(ctx context.Context, orgID, wsID string, limit int) ([]WebhookDeadLetter, error) {
	var out []WebhookDeadLetter
	err := s.queryRows(ctx, "SELECT "+deadLetterCols+` FROM webhook_dead_letters
		  WHERE org_id = ? AND workspace_id = ? AND delivery_id IS NOT NULL
		    AND webhook_id IN (SELECT id FROM workspace_webhooks WHERE org_id = ?)
		  ORDER BY dead_at DESC, id`+fmt.Sprintf(" LIMIT %d", clampLimit(limit)),
		[]any{orgID, wsID, orgID}, func(r rowScanner) error {
			d, err := scanDeadLetter(r)
			out = append(out, d)
			return err
		})
	return out, err
}

// TakeDeadLetter removes a dead letter so it can be queued again, marks
// its delivery as retrying and records who asked, all in one transaction.
// It returns the dead letter as it was.
func (s *Store) TakeDeadLetter(ctx context.Context, orgID, wsID, id string, by Actor, now time.Time) (WebhookDeadLetter, error) {
	var d WebhookDeadLetter
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		d, err = scanDeadLetter(tx.QueryRowContext(ctx, s.q("SELECT "+deadLetterCols+
			" FROM webhook_dead_letters WHERE org_id = ? AND workspace_id = ? AND id = ? AND delivery_id IS NOT NULL"), orgID, wsID, id))
		if err != nil {
			return notFound(err)
		}
		var name string
		if err := tx.QueryRowContext(ctx, s.q("SELECT name FROM workspace_webhooks WHERE id = ?"), d.WebhookID).Scan(&name); err != nil {
			return notFound(err)
		}
		if len(d.Body) == 0 {
			return ErrState
		}
		if _, err := tx.ExecContext(ctx, s.q("DELETE FROM webhook_dead_letters WHERE id = ?"), id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q("UPDATE webhook_deliveries SET state = 'retrying', next_attempt_at = ?, updated_at = ? WHERE id = ?"),
			millis(now), millis(now), d.DeliveryID); err != nil {
			return err
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Type: "webhook",
			Subject: &AuditSubject{Kind: "webhook", ID: d.WebhookID, Label: name},
			Object:  fmt.Sprintf("Redelivered message %s to webhook %s in %s", d.MessageID, name, w.Name),
		})
		return err
	})
	return d, err
}

/* ---------------------------------------------------------------------- */
/* Listeners                                                               */
/* ---------------------------------------------------------------------- */

const listenerCols = `id, org_id, workspace_id, name, secret_sealed, secret_last4, secret_rotated_at, paused, call_count, last_call_at,
	created_at, created_by_kind, created_by_id, created_by_label, updated_at`

func scanListener(r rowScanner) (WorkspaceListener, error) {
	var l WorkspaceListener
	var byID sql.NullString
	var last sql.NullInt64
	var rotated, created, updated int64
	if err := r.Scan(&l.ID, &l.OrgID, &l.WorkspaceID, &l.Name, &l.SecretSealed, &l.SecretLast4, &rotated, &l.Paused, &l.CallCount, &last,
		&created, &l.CreatedBy.Kind, &byID, &l.CreatedBy.Label, &updated); err != nil {
		return l, err
	}
	l.CreatedBy.ID, l.LastCallAt = byID.String, timePtr(last)
	l.SecretRotatedAt, l.CreatedAt, l.UpdatedAt = fromMillis(rotated), fromMillis(created), fromMillis(updated)
	return l, nil
}

// CreateWorkspaceListener adds a listener to an active workspace.
func (s *Store) CreateWorkspaceListener(ctx context.Context, orgID, wsID string, by Actor, name string, secret Secret, now time.Time) (WorkspaceListener, error) {
	name, err := cleanHookName(name, "listener")
	if err != nil {
		return WorkspaceListener{}, err
	}
	l := WorkspaceListener{
		ID: NewID("lsn"), OrgID: orgID, WorkspaceID: wsID, Name: name,
		SecretSealed: secret.Sealed, SecretLast4: secret.Last4, SecretRotatedAt: now.UTC(),
		CreatedAt: now.UTC(), CreatedBy: Actor{Kind: by.Kind, ID: by.ID, Label: by.Label}, UpdatedAt: now.UTC(),
	}
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, s.q("SELECT COUNT(*) FROM workspace_listeners WHERE org_id = ? AND workspace_id = ?"), orgID, wsID).Scan(&n); err != nil {
			return err
		}
		if n >= MaxListenersPerWS {
			return invalid("a workspace has at most %d listeners", MaxListenersPerWS)
		}
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO workspace_listeners (id, org_id, workspace_id, name, secret_sealed, secret_last4,
			    secret_rotated_at, paused, call_count, created_at, created_by_kind, created_by_id, created_by_label, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`),
			l.ID, orgID, wsID, l.Name, l.SecretSealed, l.SecretLast4, millis(now), false, millis(now), by.Kind, nullable(by.ID), by.Label, millis(now)); err != nil {
			return err
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Type: "webhook",
			Subject: &AuditSubject{Kind: "listener", ID: l.ID, Label: l.Name},
			Object:  fmt.Sprintf("Added listener %s to %s", l.Name, w.Name),
		})
		return err
	})
	return l, err
}

// ListWorkspaceListeners returns a workspace's listeners, oldest first.
func (s *Store) ListWorkspaceListeners(ctx context.Context, orgID, wsID string) ([]WorkspaceListener, error) {
	var out []WorkspaceListener
	err := s.queryRows(ctx, "SELECT "+listenerCols+" FROM workspace_listeners WHERE org_id = ? AND workspace_id = ? ORDER BY created_at, id",
		[]any{orgID, wsID}, func(r rowScanner) error {
			l, err := scanListener(r)
			out = append(out, l)
			return err
		})
	return out, err
}

// ListenerPatch changes a listener. Nil fields are left as they are; a
// non-empty Secret replaces the signing secret.
type ListenerPatch struct {
	Name   *string
	Paused *bool
	Secret Secret
}

// UpdateWorkspaceListener renames, pauses, resumes or re-keys a listener.
func (s *Store) UpdateWorkspaceListener(ctx context.Context, orgID, wsID, id string, by Actor, p ListenerPatch, now time.Time) (WorkspaceListener, error) {
	var l WorkspaceListener
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		l, err = scanListener(tx.QueryRowContext(ctx, s.q("SELECT "+listenerCols+
			" FROM workspace_listeners WHERE org_id = ? AND workspace_id = ? AND id = ?"), orgID, wsID, id))
		if err != nil {
			return notFound(err)
		}
		var changes []Change
		object := ""
		if p.Name != nil {
			name, err := cleanHookName(*p.Name, "listener")
			if err != nil {
				return err
			}
			if name != l.Name {
				changes = append(changes, Change{Field: "name", Before: l.Name, After: name})
				l.Name = name
			}
		}
		if p.Paused != nil && *p.Paused != l.Paused {
			changes = append(changes, Change{Field: "paused", Before: l.Paused, After: *p.Paused})
			l.Paused = *p.Paused
			object = fmt.Sprintf("Resumed listener %s in %s", l.Name, w.Name)
			if l.Paused {
				object = fmt.Sprintf("Paused listener %s in %s", l.Name, w.Name)
			}
		}
		if p.Secret.Sealed != "" {
			changes = append(changes, Change{Field: "secret", Before: "…" + l.SecretLast4, After: "…" + p.Secret.Last4})
			l.SecretSealed, l.SecretLast4, l.SecretRotatedAt = p.Secret.Sealed, p.Secret.Last4, now.UTC()
			if len(changes) == 1 {
				object = fmt.Sprintf("Rotated the signing secret of listener %s in %s", l.Name, w.Name)
			}
		}
		if len(changes) == 0 {
			return nil
		}
		if len(changes) > 1 || object == "" {
			object = fmt.Sprintf("Changed listener %s in %s", l.Name, w.Name)
		}
		l.UpdatedAt = now.UTC()
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE workspace_listeners SET name = ?, paused = ?, secret_sealed = ?, secret_last4 = ?,
			    secret_rotated_at = ?, updated_at = ? WHERE id = ?`),
			l.Name, l.Paused, l.SecretSealed, l.SecretLast4, millis(l.SecretRotatedAt), millis(now), l.ID); err != nil {
			return err
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Type: "webhook",
			Subject: &AuditSubject{Kind: "listener", ID: l.ID, Label: l.Name},
			Object:  object, Changes: changes,
		})
		return err
	})
	return l, err
}

// DeleteWorkspaceListener removes a listener and its call records. Its
// URL answers 404 from then on.
func (s *Store) DeleteWorkspaceListener(ctx context.Context, orgID, wsID, id string, by Actor, now time.Time) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		l, err := scanListener(tx.QueryRowContext(ctx, s.q("SELECT "+listenerCols+
			" FROM workspace_listeners WHERE org_id = ? AND workspace_id = ? AND id = ?"), orgID, wsID, id))
		if err != nil {
			return notFound(err)
		}
		for _, q := range []string{
			"DELETE FROM workspace_listeners WHERE id = ?",
			"DELETE FROM workspace_listener_calls WHERE listener_id = ?",
		} {
			if _, err := tx.ExecContext(ctx, s.q(q), id); err != nil {
				return err
			}
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Type: "webhook", Severity: "warn",
			Subject: &AuditSubject{Kind: "listener", ID: l.ID, Label: l.Name},
			Object:  fmt.Sprintf("Deleted listener %s from %s", l.Name, w.Name),
		})
		return err
	})
}

// WorkspaceListenerCall is one call to a listener URL.
type WorkspaceListenerCall struct {
	ID          string
	OrgID       string
	WorkspaceID string
	ListenerID  string
	At          time.Time
	Status      int
	FromIP      string
	Bytes       int64
	MessageID   string
	Trk         string
	Summary     string
}

// RecordListenerCall stores a call and, when it became a message, counts
// it on the listener.
func (s *Store) RecordListenerCall(ctx context.Context, c WorkspaceListenerCall) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO workspace_listener_calls (id, org_id, workspace_id, listener_id, at, status,
			    from_ip, bytes, message_id, trk, summary, delete_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
			c.ID, c.OrgID, c.WorkspaceID, c.ListenerID, millis(c.At), c.Status, c.FromIP, c.Bytes,
			nullable(c.MessageID), c.Trk, nullable(c.Summary), millis(c.At.Add(listenerCallKeepDays*24*time.Hour))); err != nil {
			return err
		}
		if c.MessageID == "" {
			return nil
		}
		_, err := tx.ExecContext(ctx, s.q("UPDATE workspace_listeners SET call_count = call_count + 1, last_call_at = ? WHERE id = ?"),
			millis(c.At), c.ListenerID)
		return err
	})
}

// ListWorkspaceListenerCalls returns a workspace's most recent listener
// calls, newest first; listenerID narrows them to one listener.
func (s *Store) ListWorkspaceListenerCalls(ctx context.Context, orgID, wsID, listenerID string, limit int) ([]WorkspaceListenerCall, error) {
	query := `SELECT id, org_id, workspace_id, listener_id, at, status, from_ip, bytes, message_id, trk, summary
		  FROM workspace_listener_calls WHERE org_id = ? AND workspace_id = ?`
	args := []any{orgID, wsID}
	if listenerID != "" {
		query += " AND listener_id = ?"
		args = append(args, listenerID)
	}
	query += fmt.Sprintf(" ORDER BY at DESC, id LIMIT %d", clampLimit(limit))
	var out []WorkspaceListenerCall
	err := s.queryRows(ctx, query, args, func(r rowScanner) error {
		var c WorkspaceListenerCall
		var at int64
		var msg, summary sql.NullString
		if err := r.Scan(&c.ID, &c.OrgID, &c.WorkspaceID, &c.ListenerID, &at, &c.Status, &c.FromIP, &c.Bytes, &msg, &c.Trk, &summary); err != nil {
			return err
		}
		c.At, c.MessageID, c.Summary = fromMillis(at), msg.String, summary.String
		out = append(out, c)
		return nil
	})
	return out, err
}

/* ---------------------------------------------------------------------- */
/* What the workers keep in memory                                         */
/* ---------------------------------------------------------------------- */

// LoadWebhookConfig returns every webhook and listener of every active
// workspace in an active org, for the in-memory copy the delivery workers
// and the listener endpoint read.
func (s *Store) LoadWebhookConfig(ctx context.Context) ([]WorkspaceWebhook, []WorkspaceListener, error) {
	const active = ` JOIN workspaces w ON w.id = x.workspace_id AND w.org_id = x.org_id AND w.status = 'active'
		 JOIN orgs o ON o.id = x.org_id AND o.status = 'active'`
	var hooks []WorkspaceWebhook
	err := s.queryRows(ctx, "SELECT "+prefixCols("x.", webhookCols2)+" FROM workspace_webhooks x"+active, nil, func(r rowScanner) error {
		h, err := scanWorkspaceWebhook(r)
		hooks = append(hooks, h)
		return err
	})
	if err != nil {
		return nil, nil, err
	}
	var listeners []WorkspaceListener
	err = s.queryRows(ctx, "SELECT "+prefixCols("x.", listenerCols)+" FROM workspace_listeners x"+active, nil, func(r rowScanner) error {
		l, err := scanListener(r)
		listeners = append(listeners, l)
		return err
	})
	return hooks, listeners, err
}

// DeleteExpiredWebhookRecords removes delivery records, dead letters and
// listener calls past their keep-until time.
func (s *Store) DeleteExpiredWebhookRecords(ctx context.Context, now time.Time) (int64, error) {
	var total int64
	for _, q := range []string{
		"DELETE FROM webhook_deliveries WHERE delete_at < ?",
		"DELETE FROM webhook_dead_letters WHERE delete_at < ? AND delivery_id IS NOT NULL",
		"DELETE FROM workspace_listener_calls WHERE delete_at < ?",
	} {
		res, err := s.db.ExecContext(ctx, s.q(q), millis(now))
		if err != nil {
			return total, err
		}
		n, _ := res.RowsAffected()
		total += n
	}
	return total, nil
}

// ListenerNames maps each of an org's listener IDs to its name, for
// labelling the messages listeners post.
func (s *Store) ListenerNames(ctx context.Context, orgID string) (map[string]string, error) {
	out := map[string]string{}
	err := s.queryRows(ctx, "SELECT id, name FROM workspace_listeners WHERE org_id = ?", []any{orgID}, func(r rowScanner) error {
		var id, name string
		if err := r.Scan(&id, &name); err != nil {
			return err
		}
		out[id] = name
		return nil
	})
	return out, err
}
