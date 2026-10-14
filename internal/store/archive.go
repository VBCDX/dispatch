package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"time"
)

// ArchivedMessage is a message copied from the JetStream stream into the
// history table. The archiver does this off the send path; a send never
// waits for it.
type ArchivedMessage struct {
	ID           string
	OrgID        string
	WorkspaceID  string
	AuthorKind   string // user, agent or listener
	AuthorID     string
	AuthorFrom   string // a listener call's client address
	Body         string
	Payload      json.RawMessage // optional
	ThreadRootID string          // the root it replies to; empty for a root
	CreatedAt    time.Time
	Trk          string
	StreamSeq    uint64
}

// defaultRetentionDays applies when a workspace has no settings row.
const defaultRetentionDays = 30

// ArchiveMessage stores m unless a message with its ID is already there,
// and keeps the thread's reply count. It reports whether it inserted, so
// a redelivered message is a no-op. Retention comes from the workspace's
// settings.
func (s *Store) ArchiveMessage(ctx context.Context, m ArchivedMessage) (bool, error) {
	var inserted bool
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		created := millis(m.CreatedAt)
		if m.AuthorKind == "listener" && m.AuthorFrom == "" {
			m.AuthorFrom = "unknown" // the schema requires a listener's caller address
		}
		var days sql.NullInt64
		err := tx.QueryRowContext(ctx, s.q(`SELECT retention_days FROM workspace_settings WHERE id = ?`), m.WorkspaceID).Scan(&days)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		if !days.Valid || days.Int64 <= 0 {
			days = sql.NullInt64{Int64: defaultRetentionDays, Valid: true}
		}
		deleteAt := created + days.Int64*86_400_000
		var payload, payloadStorage any
		if len(m.Payload) > 0 {
			payload, payloadStorage = string(m.Payload), "inline"
		}
		res, err := tx.ExecContext(ctx, s.q(
			`INSERT INTO messages (id, org_id, workspace_id, author_kind, author_id, author_from, body_storage, body_text,
			        payload_storage, payload_json, audience_mode, parent_id, thread_root_id, created_at, trk,
			        stream_entry_id, delete_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'inline', ?, ?, ?, 'all', ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO NOTHING`),
			m.ID, m.OrgID, m.WorkspaceID, m.AuthorKind, m.AuthorID, nullable(m.AuthorFrom), m.Body,
			payloadStorage, payload,
			nullable(m.ThreadRootID), nullable(m.ThreadRootID), created, m.Trk,
			strconv.FormatUint(m.StreamSeq, 10), deleteAt)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil || n == 0 {
			return err
		}
		inserted = true
		if m.ThreadRootID == "" {
			return nil
		}
		// The root must be a message in the same workspace; a reply to an
		// unknown root stays a plain message with the thread ID recorded.
		var rootDelete int64
		err = tx.QueryRowContext(ctx, s.q(`SELECT delete_at FROM messages WHERE id = ? AND workspace_id = ?`),
			m.ThreadRootID, m.WorkspaceID).Scan(&rootDelete)
		if err == sql.ErrNoRows {
			return nil
		}
		if err != nil {
			return err
		}
		var participants sql.NullString
		err = tx.QueryRowContext(ctx, s.q(`SELECT participants FROM threads WHERE id = ?`), m.ThreadRootID).Scan(&participants)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		type participant struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
		}
		var ps []participant
		if participants.Valid {
			if err := json.Unmarshal([]byte(participants.String), &ps); err != nil {
				return err
			}
		} else {
			var rk, ri string
			if err := tx.QueryRowContext(ctx, s.q(`SELECT author_kind, author_id FROM messages WHERE id = ?`), m.ThreadRootID).Scan(&rk, &ri); err != nil {
				return err
			}
			ps = append(ps, participant{rk, ri})
		}
		seen := false
		for _, p := range ps {
			seen = seen || (p.Kind == m.AuthorKind && p.ID == m.AuthorID)
		}
		if !seen {
			ps = append(ps, participant{m.AuthorKind, m.AuthorID})
		}
		pj, err := json.Marshal(ps)
		if err != nil {
			return err
		}
		if !participants.Valid {
			_, err = tx.ExecContext(ctx, s.q(
				`INSERT INTO threads (id, org_id, workspace_id, reply_count, last_reply_at, participants, updated_at, delete_at)
				 VALUES (?, ?, ?, 1, ?, ?, ?, ?)`),
				m.ThreadRootID, m.OrgID, m.WorkspaceID, created, string(pj), created, max(rootDelete, deleteAt))
			return err
		}
		_, err = tx.ExecContext(ctx, s.q(
			`UPDATE threads SET reply_count = reply_count + 1,
			        last_reply_at = CASE WHEN last_reply_at IS NULL OR last_reply_at < ? THEN ? ELSE last_reply_at END,
			        participants = ?, updated_at = ?, delete_at = CASE WHEN delete_at < ? THEN ? ELSE delete_at END
			  WHERE id = ?`),
			created, created, string(pj), created, deleteAt, deleteAt, m.ThreadRootID)
		return err
	})
	return inserted, err
}
