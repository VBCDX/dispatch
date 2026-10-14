package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/store/storetest"
)

// The API's before_id cursor completes the store's tie-break: a page walked
// with the last row's created_at + id does not skip a row that shares the
// boundary timestamp.
func TestMessagesAPIPagesTiedTimestamps(t *testing.T) {
	for _, b := range storetest.Backends(t) {
		t.Run(b.Name, func(t *testing.T) {
			h := seededHarness(t, b)
			ctx := context.Background()
			// An instant no seeded message shares, so the three tied rows sort
			// first (newest first).
			_, err := h.st.DB().ExecContext(ctx, `INSERT INTO messages
				(id, org_id, workspace_id, author_kind, author_id, body_storage, body_text, audience_mode, created_at, trk, delete_at)
				VALUES ('msg_page_c', 'org_acme', 'ws_rel', 'user', 'u_mia', 'inline', 'paging row', 'all', 4102444800000, 'trk_page', 0),
				       ('msg_page_b', 'org_acme', 'ws_rel', 'user', 'u_mia', 'inline', 'paging row', 'all', 4102444800000, 'trk_page', 0),
				       ('msg_page_a', 'org_acme', 'ws_rel', 'user', 'u_mia', 'inline', 'paging row', 'all', 4102444800000, 'trk_page', 0)`)
			if err != nil {
				t.Fatal(err)
			}

			base := "/api/v1/orgs/org_acme/workspaces/ws_rel/messages"
			dana := h.as("u_dana")

			page := decode[messagesResponse](t, h.get(dana, base+"?limit=2", http.StatusOK))
			if ids := messageIDs(page.Messages); len(ids) != 2 || ids[0] != "msg_page_c" || ids[1] != "msg_page_b" {
				t.Fatalf("first page = %v, want [msg_page_c msg_page_b]", ids)
			}

			last := page.Messages[1]
			next := decode[messagesResponse](t, h.get(dana,
				base+"?limit=1&before="+url.QueryEscape(last.CreatedAt.Format(time.RFC3339Nano))+"&before_id="+last.ID,
				http.StatusOK))
			if ids := messageIDs(next.Messages); len(ids) != 1 || ids[0] != "msg_page_a" {
				t.Fatalf("second page = %v, want [msg_page_a] (the tied row after the boundary)", ids)
			}
		})
	}
}

// The audit endpoint's before_id pass-through, over a tied pair from the
// seeded data: the HTTP-level counterpart of the store test.
func TestAuditAPIPagesTiedTimestamps(t *testing.T) {
	for _, b := range storetest.Backends(t) {
		t.Run(b.Name, func(t *testing.T) {
			h := seededHarness(t, b)
			base := "/api/v1/orgs/org_acme/audit"
			dana := h.as("u_dana")

			all := decode[auditResponse](t, h.get(dana, base+"?limit=500", http.StatusOK)).Events
			var first, second auditJSON
			found := false
			for i := 0; i+1 < len(all); i++ {
				if all[i].At.Equal(all[i+1].At) {
					first, second = all[i], all[i+1]
					found = true
					break
				}
			}
			if !found {
				t.Fatal("the seeded audit data has no tied instants to page over")
			}

			limit := 0
			for i, e := range all {
				if e.ID == first.ID {
					limit = i + 1
					break
				}
			}
			page := decode[auditResponse](t, h.get(dana, base+fmt.Sprintf("?limit=%d", limit), http.StatusOK)).Events
			if len(page) == 0 || page[len(page)-1].ID != first.ID {
				t.Fatalf("page does not end at %s; the tied pair moved", first.ID)
			}
			next := decode[auditResponse](t, h.get(dana,
				base+"?limit=20&before="+url.QueryEscape(first.At.Format(time.RFC3339Nano))+"&before_id="+first.ID,
				http.StatusOK)).Events
			if len(next) == 0 || next[0].ID != second.ID {
				got := "<empty>"
				if len(next) > 0 {
					got = next[0].ID
				}
				t.Fatalf("next page starts at %s, want %s (the tied row after the boundary)", got, second.ID)
			}
		})
	}
}

func messageIDs(ms []messageJSON) []string {
	out := make([]string, 0, len(ms))
	for _, m := range ms {
		out = append(out, m.ID)
	}
	return out
}
