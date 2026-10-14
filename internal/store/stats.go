package store

import (
	"context"
	"time"
)

// WorkspaceStats are the per-workspace counts on the Workspaces list.
type WorkspaceStats struct {
	Humans      int
	Agents      int
	Messages24h int // messages sent in the 24 hours before now
	Waiting     int // unexpired messages some targeted, unfiltered agent hasn't acked
	Webhooks    int // fire hooks and listeners on unexpired messages, plus workspace webhooks and listeners
}

// unexpired is true for a message m that has neither reached its expiry
// nor been ended early. It takes now in Unix ms as its one argument.
const unexpired = `(m.expires_at IS NULL OR m.expires_at > ?) AND m.expired_early_at IS NULL`

// ListWorkspaceStats returns the list counts for every active workspace in
// an org, keyed by workspace ID. A workspace with nothing in it has a zero
// entry.
func (s *Store) ListWorkspaceStats(ctx context.Context, orgID string, now time.Time) (map[string]WorkspaceStats, error) {
	out := map[string]WorkspaceStats{}
	nowMs := millis(now)
	err := s.queryRows(ctx, `SELECT id FROM workspaces WHERE org_id = ? AND status = 'active'`, []any{orgID},
		func(r rowScanner) error {
			var id string
			err := r.Scan(&id)
			out[id] = WorkspaceStats{}
			return err
		})
	if err != nil {
		return nil, err
	}
	// add runs a query returning (workspace_id, n) rows and stores n with set.
	add := func(query string, args []any, set func(*WorkspaceStats, int)) error {
		return s.queryRows(ctx, query, args, func(r rowScanner) error {
			var id string
			var n int
			if err := r.Scan(&id, &n); err != nil {
				return err
			}
			if st, ok := out[id]; ok {
				set(&st, n)
				out[id] = st
			}
			return nil
		})
	}
	if err := s.queryRows(ctx, `SELECT workspace_id, member_kind, COUNT(*) FROM workspace_memberships
		 WHERE org_id = ? GROUP BY workspace_id, member_kind`, []any{orgID}, func(r rowScanner) error {
		var id, kind string
		var n int
		if err := r.Scan(&id, &kind, &n); err != nil {
			return err
		}
		if st, ok := out[id]; ok {
			switch kind {
			case "user":
				st.Humans = n
			case "agent":
				st.Agents = n
			}
			out[id] = st
		}
		return nil
	}); err != nil {
		return nil, err
	}
	if err := add(`SELECT m.workspace_id, COUNT(*) FROM messages m
		 WHERE m.org_id = ? AND m.created_at > ? GROUP BY m.workspace_id`,
		[]any{orgID, nowMs - (24 * time.Hour).Milliseconds()}, func(st *WorkspaceStats, n int) { st.Messages24h = n }); err != nil {
		return nil, err
	}
	if err := add(`SELECT m.workspace_id, COUNT(*) FROM messages m
		 WHERE m.org_id = ? AND `+unexpired+`
		   AND COALESCE(m.receipt_counts_acked, 0) < COALESCE(m.receipt_counts_targets, 0) - COALESCE(m.receipt_counts_filtered, 0)
		 GROUP BY m.workspace_id`,
		[]any{orgID, nowMs}, func(st *WorkspaceStats, n int) { st.Waiting = n }); err != nil {
		return nil, err
	}
	if err := add(`SELECT h.workspace_id, COUNT(*) FROM webhooks h JOIN messages m ON m.id = h.message_id
		 WHERE h.org_id = ? AND `+unexpired+` GROUP BY h.workspace_id`,
		[]any{orgID, nowMs}, func(st *WorkspaceStats, n int) { st.Webhooks = n }); err != nil {
		return nil, err
	}
	// Workspace webhooks and listeners (the Webhooks tab) count too.
	for _, table := range []string{"workspace_webhooks", "workspace_listeners"} {
		if err := add(`SELECT workspace_id, COUNT(*) FROM `+table+` WHERE org_id = ? GROUP BY workspace_id`,
			[]any{orgID}, func(st *WorkspaceStats, n int) { st.Webhooks += n }); err != nil {
			return nil, err
		}
	}
	return out, nil
}
