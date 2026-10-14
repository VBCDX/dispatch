package store_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/VBCDX/dispatch/internal/store"
)

func TestListWorkspaceStats(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		stats, err := st.ListWorkspaceStats(ctx, "org_acme", seedNow)
		check(t, err)
		eq(t, "Acme stats", stats, map[string]store.WorkspaceStats{
			"ws_rel": {Humans: 3, Agents: 5, Messages24h: 11, Waiting: 8, Webhooks: 2},
			"ws_inc": {Humans: 2, Agents: 3, Messages24h: 2, Waiting: 1, Webhooks: 0},
			"ws_sbx": {Humans: 1, Agents: 2, Messages24h: 1, Waiting: 0, Webhooks: 0},
		})

		// An expired message stops counting as waiting and its webhook stops
		// counting; so does one ended early. A deleted workspace drops out.
		past := seedNow.UnixMilli() - 1
		_, err = st.DB().ExecContext(ctx, "UPDATE messages SET expires_at = "+fmt.Sprint(past)+" WHERE id = 'msg_06'")
		check(t, err)
		_, err = st.DB().ExecContext(ctx, "UPDATE messages SET expired_early_at = "+fmt.Sprint(past)+" WHERE id = 'msg_08'")
		check(t, err)
		_, err = st.DB().ExecContext(ctx, "UPDATE workspaces SET status = 'deleted' WHERE id = 'ws_sbx'")
		check(t, err)
		stats, err = st.ListWorkspaceStats(ctx, "org_acme", seedNow)
		check(t, err)
		eq(t, "Release train after expiry", stats["ws_rel"], store.WorkspaceStats{Humans: 3, Agents: 5, Messages24h: 11, Waiting: 6, Webhooks: 1})
		if _, ok := stats["ws_sbx"]; ok {
			t.Error("a deleted workspace still has stats")
		}

		stats, err = st.ListWorkspaceStats(ctx, "org_nw", seedNow)
		check(t, err)
		eq(t, "Northwind stats", stats, map[string]store.WorkspaceStats{
			"ws_docs": {Humans: 2, Agents: 1, Messages24h: 1, Waiting: 1},
		})
		stats, err = st.ListWorkspaceStats(ctx, "org_missing", seedNow)
		check(t, err)
		eq(t, "missing org stats", len(stats), 0)
	})
}
