package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/seed"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

// seedNow is when the demo data is loaded in these tests; the mock's
// instants are relative to it.
var seedNow = time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)

// seeded runs fn on each backend with the demo data loaded.
func seeded(t *testing.T, fn func(t *testing.T, ctx context.Context, st *store.Store)) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		ctx := context.Background()
		st := storetest.Open(t, b)
		if _, err := seed.Load(ctx, st, seedNow); err != nil {
			t.Fatal(err)
		}
		fn(t, ctx, st)
	})
}

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func wantNotFound(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("%s: err = %v, want ErrNotFound", what, err)
	}
}

func ids[T any](xs []T, id func(T) string) []string {
	out := []string{}
	for _, x := range xs {
		out = append(out, id(x))
	}
	return out
}

func eq(t *testing.T, what string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

// cursorOf is the paging cursor for a row: its sort timestamp and its ID.
func cursorOf(at time.Time, id string) *store.Cursor {
	return &store.Cursor{At: at, ID: id}
}

func TestReadOrgsAndPeople(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		o, err := st.GetOrg(ctx, "org_acme")
		check(t, err)
		eq(t, "org name", o.Name, "Acme Corp")
		eq(t, "org created by", o.CreatedBy, store.Principal{Kind: "user", ID: "u_dana"})
		_, err = st.GetOrg(ctx, "org_missing")
		wantNotFound(t, "GetOrg(missing)", err)

		orgs, err := st.ListUserOrgs(ctx, "u_mia")
		check(t, err)
		eq(t, "Mia's orgs", ids(orgs, func(o store.UserOrg) string { return o.ID + ":" + o.Role + ":" + o.Status }),
			[]string{"org_acme:user:active", "org_nw:user:active"})

		people, err := st.ListOrgMembers(ctx, "org_acme")
		check(t, err)
		eq(t, "Acme people", ids(people, func(p store.OrgMember) string { return p.Name + ":" + p.Role }),
			[]string{"Dana Keller:Owner", "Mia Chen:user", "Ravi Mehta:userAdmin", "Sam Ortiz:user"})
		people, err = st.ListOrgMembers(ctx, "org_nw")
		check(t, err)
		eq(t, "Northwind people", ids(people, func(p store.OrgMember) string { return p.UserID }), []string{"u_leo", "u_mia"})

		m, err := st.GetOrgMembership(ctx, "org_acme", "u_ravi")
		check(t, err)
		eq(t, "Ravi's role", m.Role, "userAdmin")
		_, err = st.GetOrgMembership(ctx, "org_nw", "u_dana")
		wantNotFound(t, "Dana in Northwind", err)

		last, err := st.LastActive(ctx, "org_acme")
		check(t, err)
		eq(t, "Mia last active", last["u_mia"], seedNow.Add(-6*time.Minute))
		eq(t, "Dana last active", last["u_dana"], seedNow.Add(-24*time.Hour))
		if _, ok := last["u_leo"]; ok {
			t.Error("Leo has no Acme activity but shows a last-active time")
		}

		sessions, err := st.ListUserSessions(ctx, "u_dana", seedNow)
		check(t, err)
		eq(t, "Dana's sessions", ids(sessions, func(s store.UserSession) string { return s.Device + " · " + s.Place }),
			[]string{"MacBook Pro · San Francisco", "iPhone · San Francisco"})
		sessions, err = st.ListUserSessions(ctx, "u_dana", seedNow.Add(365*24*time.Hour))
		check(t, err)
		eq(t, "sessions after expiry", len(sessions), 0)
	})
}

func TestReadWorkspacesAndMembers(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		ws, err := st.ListWorkspaces(ctx, "org_acme", false)
		check(t, err)
		eq(t, "Acme workspaces", ids(ws, func(w store.Workspace) string { return w.Name }), []string{"Incidents", "Release train", "Sandbox"})

		rel, err := st.GetWorkspace(ctx, "org_acme", "ws_rel")
		check(t, err)
		eq(t, "Release train blocklist", rel.AgentBlocklist, []string{"ag_scraper"})
		eq(t, "Release train retention", rel.RetentionDays, 90)
		if rel.DefaultExpiryHours == nil || *rel.DefaultExpiryHours != 24 {
			t.Errorf("Release train default expiry = %v, want 24", rel.DefaultExpiryHours)
		}
		if !strings.HasPrefix(rel.Description, "Everything that gets a release out") {
			t.Errorf("description = %q", rel.Description)
		}
		sbx, err := st.GetWorkspace(ctx, "org_acme", "ws_sbx")
		check(t, err)
		if sbx.DefaultExpiryHours != nil {
			t.Errorf("Sandbox default expiry = %d, want none", *sbx.DefaultExpiryHours)
		}
		_, err = st.GetWorkspace(ctx, "org_nw", "ws_rel")
		wantNotFound(t, "Acme workspace read through Northwind", err)

		// A soft-deleted workspace leaves the list but still resolves.
		_, err = st.DB().ExecContext(ctx, "UPDATE workspaces SET status = 'deleted' WHERE id = 'ws_sbx'")
		check(t, err)
		ws, err = st.ListWorkspaces(ctx, "org_acme", false)
		check(t, err)
		eq(t, "after deleting Sandbox", len(ws), 2)
		ws, err = st.ListWorkspaces(ctx, "org_acme", true)
		check(t, err)
		eq(t, "including deleted", len(ws), 3)

		members, err := st.ListWorkspaceMembers(ctx, "org_acme", "ws_rel")
		check(t, err)
		eq(t, "Release train members", ids(members, func(m store.WorkspaceMember) string { return m.Member.ID }),
			[]string{"u_dana", "u_mia", "u_ravi", "ag_builder", "ag_planner", "ag_reviewer", "ag_scraper", "ag_deployer"})
		byID := map[string]store.WorkspaceMember{}
		for _, m := range members {
			byID[m.Member.ID] = m
		}
		planner := byID["ag_planner"]
		eq(t, "planner shared role", planner.Role, "member")
		eq(t, "planner agent role", planner.AgentRole, "workspace_admin")
		eq(t, "planner delegated by", planner.DelegatedBy, &store.Principal{Kind: "user", ID: "u_dana"})
		if planner.Token == nil || planner.Token.Current.Last4 != "Pl9a" || planner.Token.Current.Prefix != "dsp_ws_" {
			t.Errorf("planner workspace token = %+v, want dsp_ws_…Pl9a", planner.Token)
		}
		eq(t, "scraper can write", byID["ag_scraper"].Write, false)
		eq(t, "Ravi role", byID["u_ravi"].Role, "workspace_admin")
		eq(t, "deployer added by", byID["ag_deployer"].AddedBy, store.Principal{Kind: "agent", ID: "ag_planner"})
		if byID["u_mia"].Token != nil || !byID["u_mia"].Read {
			t.Errorf("a human member has a token or can't read: %+v", byID["u_mia"])
		}

		deployer, err := st.ListMemberships(ctx, "org_acme", "agent", "ag_deployer")
		check(t, err)
		eq(t, "deployer's workspaces", ids(deployer, func(m store.WorkspaceMember) string { return m.WorkspaceID }), []string{"ws_inc", "ws_rel"})
	})
}

// A workspace created outside Dispatch -- the shared `workspaces` row exists,
// the Dispatch-owned `workspace_settings` row does not (the state
// ensureSettings documents) -- must stay readable: the read paths and the
// write pre-read materialize the settings row instead of failing with a 500.
// The fail-closed scanWorkspace made the whole org list (and
// every write path that pre-reads the workspace) fail for this supported state.
func TestWorkspaceCreatedOutsideDispatch(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		_, err := st.DB().ExecContext(ctx, `INSERT INTO workspaces
			(id, org_id, name, status, created_at, created_by_kind, created_by_id, updated_at, rev)
			VALUES ('ws_ext', 'org_acme', 'Outside', 'active', 0, 'user', 'u_dana', 0, 0)`)
		check(t, err)

		w, err := st.GetWorkspace(ctx, "org_acme", "ws_ext")
		check(t, err)
		eq(t, "materialized retention", w.RetentionDays, store.DefaultRetention)

		list, err := st.ListWorkspaces(ctx, "org_acme", false)
		check(t, err)
		found := false
		for _, x := range list {
			if x.ID == "ws_ext" {
				found = true
				eq(t, "listed retention", x.RetentionDays, store.DefaultRetention)
			}
		}
		if !found {
			t.Errorf("outside-Dispatch workspace missing from the org list (%v)",
				ids(list, func(w store.Workspace) string { return w.ID }))
		}

		// The write pre-read (activeWorkspace) tolerates it too, and the
		// update edits the materialized row.
		retention := 120
		if _, err := st.UpdateWorkspace(ctx, "org_acme", "ws_ext", store.Actor{Kind: "user", ID: "u_dana"},
			store.WorkspacePatch{RetentionDays: &retention}, seedNow.Add(time.Hour)); err != nil {
			t.Errorf("UpdateWorkspace on an outside-Dispatch workspace: %v", err)
		}
		w, err = st.GetWorkspace(ctx, "org_acme", "ws_ext")
		check(t, err)
		eq(t, "updated retention", w.RetentionDays, 120)
	})
}

func TestReadAgents(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		agents, err := st.ListAgents(ctx, "org_acme")
		check(t, err)
		eq(t, "Acme agents", ids(agents, func(a store.Agent) string { return a.Label }),
			[]string{"builder", "deployer", "planner", "reviewer", "triage-bot", "web-scraper"})

		planner, err := st.GetAgent(ctx, "org_acme", "ag_planner")
		check(t, err)
		eq(t, "planner token", planner.Token.Current, store.TokenInfo{Prefix: "dsp_agent_", Last4: "Pn7w", IssuedAt: seedNow.Add(-20 * 24 * time.Hour)})
		eq(t, "planner client", *planner.Client, store.AgentClient{Name: "Claude Code", Version: "2.1.4", Via: "MCP", At: planner.Client.At})
		eq(t, "planner created by", planner.CreatedByLabel, "Dana Keller")

		reviewer, err := st.GetAgent(ctx, "org_acme", "ag_reviewer")
		check(t, err)
		eq(t, "reviewer agent blocklist", reviewer.Filters.AgentBlocklist, []string{"ag_scraper"})
		deployer, err := st.GetAgent(ctx, "org_acme", "ag_deployer")
		check(t, err)
		eq(t, "deployer workspace blocklist", deployer.Filters.WorkspaceBlocklist, []string{"ws_sbx"})
		scraper, err := st.GetAgent(ctx, "org_acme", "ag_scraper")
		check(t, err)
		eq(t, "scraper filters", [2]bool{scraper.Filters.Read, scraper.Filters.Write}, [2]bool{true, false})
		triage, err := st.GetAgent(ctx, "org_acme", "ag_triage")
		check(t, err)
		eq(t, "triage status", triage.Status, "suspended")

		_, err = st.GetAgent(ctx, "org_nw", "ag_planner")
		wantNotFound(t, "Acme agent read through Northwind", err)

		sidecars, err := st.ListSidecars(ctx, "org_acme", "ag_planner")
		check(t, err)
		eq(t, "planner sidecars", len(sidecars), 0)
	})
}

func TestReadMessages(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		msgs, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{})
		check(t, err)
		eq(t, "Release train messages", ids(msgs, func(m store.Message) string { return m.ID }),
			[]string{"msg_08", "msg_07", "msg_05c", "msg_05b", "msg_06", "msg_05a", "msg_05", "msg_04", "msg_03", "msg_02", "msg_01", "msg_09"})

		page, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{Limit: 2})
		check(t, err)
		next, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{Limit: 2, Before: cursorOf(page[1].CreatedAt, page[1].ID)})
		check(t, err)
		eq(t, "second page", ids(next, func(m store.Message) string { return m.ID }), []string{"msg_05c", "msg_05b"})

		var walked []string
		var cursor *store.Cursor
		for {
			p, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{Limit: 3, Before: cursor})
			check(t, err)
			if len(p) == 0 {
				break
			}
			walked = append(walked, ids(p, func(m store.Message) string { return m.ID })...)
			last := p[len(p)-1]
			cursor = cursorOf(last.CreatedAt, last.ID)
		}
		eq(t, "paging walks every message exactly once", walked, ids(msgs, func(m store.Message) string { return m.ID }))

		tagged, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{Tag: "deploy"})
		check(t, err)
		eq(t, "#deploy", ids(tagged, func(m store.Message) string { return m.ID }), []string{"msg_05b", "msg_05a", "msg_05"})

		thread, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{ThreadRootID: "msg_05"})
		check(t, err)
		eq(t, "msg_05 thread", ids(thread, func(m store.Message) string { return m.ID }), []string{"msg_05a", "msg_05b", "msg_05c"})

		roots, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{RootsOnly: true})
		check(t, err)
		eq(t, "top-level messages", len(roots), 7)

		mine, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{AuthorKind: "user", AuthorID: "u_mia"})
		check(t, err)
		eq(t, "Mia's messages", ids(mine, func(m store.Message) string { return m.ID }), []string{"msg_08"})

		none, err := st.ListMessages(ctx, "org_nw", "ws_rel", store.MessageFilter{})
		check(t, err)
		eq(t, "Release train through Northwind", len(none), 0)

		m2, err := st.GetMessage(ctx, "org_acme", "msg_02")
		check(t, err)
		eq(t, "msg_02 tags", m2.Tags, []string{"ci", "release-4.2"})
		eq(t, "msg_02 author", m2.Author, store.Author{Kind: "agent", ID: "ag_builder"})
		eq(t, "msg_02 thread root", m2.ThreadRootID, "msg_01")
		var payload struct{ Branch string }
		check(t, json.Unmarshal(m2.Payload, &payload))
		eq(t, "msg_02 payload branch", payload.Branch, "release/4.2")

		m3, err := st.GetMessage(ctx, "org_acme", "msg_03")
		check(t, err)
		eq(t, "msg_03 audience", m3.Audience, store.Audience{Mode: "only", AgentIDs: []string{"ag_builder", "ag_planner"}})
		m7, err := st.GetMessage(ctx, "org_acme", "msg_07")
		check(t, err)
		eq(t, "msg_07 author", m7.Author, store.Author{Kind: "listener", ID: "lsn_8Kq2vT", From: "198.51.100.7"})
		m1, err := st.GetMessage(ctx, "org_acme", "msg_01")
		check(t, err)
		eq(t, "msg_01 receipt counts", m1.ReceiptCounts, store.ReceiptCounts{Targets: 4, Delivered: 3, Read: 3, Acked: 2, Filtered: 1})
		if m1.ExpiresAt == nil || !m1.ExpiresAt.Equal(seedNow.Add(21*time.Hour)) {
			t.Errorf("msg_01 expires %v, want now + 21h", m1.ExpiresAt)
		}
		eq(t, "msg_01 webhook", m1.WebhookID, "")
		_, err = st.GetMessage(ctx, "org_nw", "msg_01")
		wantNotFound(t, "Acme message through Northwind", err)
	})
}

// A Before cursor with ThreadRootID would page backwards (replies order
// oldest first); it is refused instead of returning silently wrong pages.
func TestReadMessagesRejectsBeforeWithThreadRoot(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		_, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{
			ThreadRootID: "trk_tie", Before: cursorOf(time.Now(), "msg_x")})
		if err == nil {
			t.Fatal("ThreadRootID with Before must be refused")
		}
	})
}

// A page boundary on rows that share a timestamp must not skip the rows after
// the boundary: the cursor carries the ID tie-break too.
func TestReadMessagesPagesTiedTimestamps(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		// An instant no seeded message shares, so the three tied rows sort first.
		_, err := st.DB().ExecContext(ctx, `INSERT INTO messages
			(id, org_id, workspace_id, author_kind, author_id, body_storage, body_text, audience_mode, created_at, trk, delete_at)
			VALUES ('msg_tie_c', 'org_acme', 'ws_rel', 'user', 'u_mia', 'inline', 'tied row', 'all', 4102444800000, 'trk_tie', 0),
			       ('msg_tie_b', 'org_acme', 'ws_rel', 'user', 'u_mia', 'inline', 'tied row', 'all', 4102444800000, 'trk_tie', 0),
			       ('msg_tie_a', 'org_acme', 'ws_rel', 'user', 'u_mia', 'inline', 'tied row', 'all', 4102444800000, 'trk_tie', 0)`)
		check(t, err)

		page, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{Limit: 2})
		check(t, err)
		eq(t, "first page", ids(page, func(m store.Message) string { return m.ID }), []string{"msg_tie_c", "msg_tie_b"})

		last := page[len(page)-1]
		next, err := st.ListMessages(ctx, "org_acme", "ws_rel", store.MessageFilter{Limit: 1, Before: cursorOf(last.CreatedAt, last.ID)})
		check(t, err)
		eq(t, "the tied row after the boundary is not skipped", ids(next, func(m store.Message) string { return m.ID }), []string{"msg_tie_a"})
	})
}

func TestReadReceiptsThreadsAndTags(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		rs, err := st.ListReceipts(ctx, "org_acme", "msg_01")
		check(t, err)
		eq(t, "msg_01 receipts", ids(rs, func(r store.Receipt) string { return r.AgentID + ":" + r.State }),
			[]string{"ag_builder:acked", "ag_deployer:read", "ag_reviewer:acked", "ag_scraper:filtered"})
		scraper := rs[3]
		eq(t, "filtered rule", scraper.FilteredRule, "workspace agent blocklist")
		eq(t, "filtered after send", scraper.FilteredAfterSend, false)

		triage, err := st.ListAgentReceipts(ctx, "org_acme", "ag_triage", 0)
		check(t, err)
		eq(t, "triage receipts", ids(triage, func(r store.Receipt) string { return r.MessageID + ":" + r.State + ":" + r.HeldCause }),
			[]string{"msg_10:held:suspended"})

		threads, err := st.ListThreads(ctx, "org_acme", "ws_rel")
		check(t, err)
		eq(t, "Release train threads", ids(threads, func(t store.Thread) string { return t.RootID }), []string{"msg_06", "msg_05", "msg_01"})
		th, err := st.GetThread(ctx, "org_acme", "msg_05")
		check(t, err)
		eq(t, "msg_05 replies", th.ReplyCount, 3)
		eq(t, "msg_05 participants", th.Participants, []store.Author{{Kind: "agent", ID: "ag_planner"}, {Kind: "agent", ID: "ag_deployer"}})
		_, err = st.GetThread(ctx, "org_acme", "msg_08")
		wantNotFound(t, "thread of a message with no replies", err)

		tags, err := st.ListTags(ctx, "org_acme", "ws_rel")
		check(t, err)
		counts := map[string]int{}
		for _, tg := range tags {
			counts[tg.Tag] = tg.MessageCount
		}
		eq(t, "#release-4.2 count", counts["release-4.2"], 10)
		eq(t, "#qa count", counts["qa"], 1)
		eq(t, "most recent tag", tags[0].Tag, "qa")
	})
}

func TestReadContextNotes(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		notes, err := st.ListContextNotes(ctx, "org_acme", "ws_rel")
		check(t, err)
		eq(t, "Release train notes", ids(notes, func(n store.ContextNote) string { return n.ID }), []string{"nt_1", "nt_2"})
		n, err := st.GetContextNote(ctx, "org_acme", "nt_1")
		check(t, err)
		eq(t, "nt_1 version", n.Version, 3)
		eq(t, "nt_1 updated by", n.UpdatedBy, store.Actor{Kind: "agent", ID: "ag_planner", Label: "planner"})
		eq(t, "nt_1 tags", n.Tags, []string{"release-4.2", "plan"})

		vs, err := st.ListContextNoteVersions(ctx, "org_acme", "nt_1")
		check(t, err)
		eq(t, "nt_1 history", ids(vs, func(v store.ContextNoteVersion) string { return v.By.Label }), []string{"planner", "Dana Keller", "planner"})
		eq(t, "v2 author", vs[1].By, store.Actor{Kind: "user", ID: "u_dana", Label: "Dana Keller"})

		_, err = st.GetContextNote(ctx, "org_nw", "nt_1")
		wantNotFound(t, "Acme note through Northwind", err)
	})
}

func TestReadWebhooks(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		hooks, err := st.ListWebhooks(ctx, "org_acme", "ws_rel")
		check(t, err)
		eq(t, "Release train webhooks", ids(hooks, func(h store.Webhook) string { return h.ID + ":" + h.Mode }), []string{"wh_06:listen", "wh_05:fire"})

		fire, err := st.GetWebhook(ctx, "org_acme", "wh_05")
		check(t, err)
		f := fire.Fire
		if f == nil || fire.Listen != nil {
			t.Fatalf("wh_05 = %+v, want a fire hook only", fire)
		}
		eq(t, "wh_05 state", f.State, "delivered")
		eq(t, "wh_05 trigger", f.Trigger, "all-ack")
		eq(t, "wh_05 auth", [2]any{f.AuthUser, f.HasPassword}, [2]any{"dispatch", true})
		eq(t, "wh_05 attempts", ids(f.Attempts, func(a store.WebhookAttempt) string { return a.ID }), []string{"wa_1", "wa_2"})
		eq(t, "wh_05 first attempt at", f.Attempts[0].At, seedNow.Add(-12*time.Minute).UnixMilli())

		listen, err := st.GetWebhook(ctx, "org_acme", "wh_06")
		check(t, err)
		l := listen.Listen
		if l == nil || listen.Fire != nil {
			t.Fatalf("wh_06 = %+v, want a listener only", listen)
		}
		eq(t, "wh_06 listener", [4]any{l.ListenerID, l.User, l.Password.Last4, l.State}, [4]any{"lsn_8Kq2vT", "buildfarm", "x9Q2", "open"})
		eq(t, "wh_06 calls", l.CallCount, 2)

		calls, err := st.ListListenerCalls(ctx, "org_acme", "lsn_8Kq2vT", 0)
		check(t, err)
		eq(t, "listener calls", ids(calls, func(c store.ListenerCall) string { return c.ID + ":" + c.AppendedMessageID }), []string{"lc_2:msg_07", "lc_1:"})

		dead, err := st.ListDeadLetters(ctx, "org_acme", "ws_rel")
		check(t, err)
		eq(t, "dead letters", len(dead), 0)

		_, err = st.GetWebhook(ctx, "org_nw", "wh_05")
		wantNotFound(t, "Acme webhook through Northwind", err)
	})
}

// A data-integrity fault in the read layer is reported, never smoothed into a
// plausible-looking value: a human member with no access row
// keeps the human defaults, and an agent member with no access row gets no
// access. A missing workspace_settings row is NOT a fault -- it is the
// supported "created outside Dispatch" state and is materialized on read
// with the defaults, never reported as retention 0.
func TestReadReportsMissingRelatedRows(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		// Missing workspace_settings row: readable, materialized with the
		// defaults. Raw SQL uses literals, not `?` (Postgres reads `?` as an
		// operator).
		if _, err := st.DB().ExecContext(ctx, `DELETE FROM workspace_settings WHERE org_id = 'org_acme' AND id = 'ws_rel'`); err != nil {
			t.Fatal(err)
		}
		w, err := st.GetWorkspace(ctx, "org_acme", "ws_rel")
		if err != nil {
			t.Fatalf("GetWorkspace with no settings row: %v", err)
		}
		eq(t, "materialized retention", w.RetentionDays, store.DefaultRetention)

		// Missing membership_access rows: an agent must not be reported as
		// able to write; a human keeps the defaults.
		if _, err := st.DB().ExecContext(ctx,
			`DELETE FROM membership_access WHERE org_id = 'org_acme' AND workspace_id = 'ws_rel' AND member_id IN ('ag_deployer', 'u_dana')`); err != nil {
			t.Fatal(err)
		}
		members, err := st.ListWorkspaceMembers(ctx, "org_acme", "ws_rel")
		if err != nil {
			t.Fatal(err)
		}
		byID := map[string]store.WorkspaceMember{}
		for _, m := range members {
			byID[m.Member.ID] = m
		}
		if agent, ok := byID["ag_deployer"]; !ok || agent.Read || agent.Write {
			t.Errorf("agent ag_deployer with no access row = %+v, want read/write false", agent)
		}
		if human, ok := byID["u_dana"]; !ok || !human.Read || !human.Write {
			t.Errorf("user u_dana with no access row = %+v, want the human defaults (true, true)", human)
		}
	})
}

func TestReadAudit(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		all, err := st.ListAuditEvents(ctx, "org_acme", store.AuditFilter{})
		check(t, err)
		eq(t, "Acme audit rows", len(all), 13)
		eq(t, "newest row", all[0].ID, "ev_1")

		blocked, err := st.ListAuditEvents(ctx, "org_acme", store.AuditFilter{Type: "blocked"})
		check(t, err)
		eq(t, "blocked rows", ids(blocked, func(e store.AuditEvent) string { return e.ID }), []string{"ev_2", "ev_10"})
		var detail struct {
			Kind  string
			Steps []struct{ Rule string }
		}
		check(t, json.Unmarshal(blocked[0].Detail, &detail))
		eq(t, "ev_2 detail kind", detail.Kind, "access")
		eq(t, "ev_2 link", blocked[0].LinkTo, "/workspaces/wks_rel/access")

		sbx, err := st.ListAuditEvents(ctx, "org_acme", store.AuditFilter{WorkspaceID: "ws_sbx"})
		check(t, err)
		eq(t, "Sandbox rows", ids(sbx, func(e store.AuditEvent) string { return e.ID }), []string{"ev_10"})

		dana, err := st.ListAuditEvents(ctx, "org_acme", store.AuditFilter{ActorID: "u_dana"})
		check(t, err)
		eq(t, "Dana's rows", len(dana), 2)

		visible, err := st.ListAuditEvents(ctx, "org_acme", store.AuditFilter{VisibleWorkspaces: []string{"ws_inc"}})
		check(t, err)
		eq(t, "rows visible to an Incidents-only member", len(visible), 0)
		visible, err = st.ListAuditEvents(ctx, "org_acme", store.AuditFilter{VisibleWorkspaces: []string{"ws_sbx", "ws_inc"}})
		check(t, err)
		eq(t, "rows visible to a Sandbox member", ids(visible, func(e store.AuditEvent) string { return e.ID }), []string{"ev_10"})

		page, err := st.ListAuditEvents(ctx, "org_acme", store.AuditFilter{Limit: 3})
		check(t, err)
		eq(t, "page size", len(page), 3)

		// In the seeded data ev_5/ev_6 and ev_11/ev_12 share an instant. A page
		// boundary on one of a tied pair must not skip the other.
		var walked []string
		var cursor *store.Cursor
		for {
			p, err := st.ListAuditEvents(ctx, "org_acme", store.AuditFilter{Limit: 5, Before: cursor})
			check(t, err)
			if len(p) == 0 {
				break
			}
			walked = append(walked, ids(p, func(e store.AuditEvent) string { return e.ID })...)
			last := p[len(p)-1]
			cursor = cursorOf(last.At, last.ID)
		}
		eq(t, "paging walks every audit row exactly once", walked, ids(all, func(e store.AuditEvent) string { return e.ID }))

		shared := 0
		for _, e := range all {
			if e.Shared {
				shared++
				if e.Detail != nil || e.LinkTo != "" {
					t.Errorf("shared row %s carries app detail or a link", e.ID)
				}
			}
		}
		eq(t, "shared rows", shared, 2)

		nw, err := st.ListAuditEvents(ctx, "org_nw", store.AuditFilter{})
		check(t, err)
		eq(t, "Northwind rows", ids(nw, func(e store.AuditEvent) string { return e.ID }), []string{"ev_n1"})
	})
}

func TestReadSettings(t *testing.T) {
	seeded(t, func(t *testing.T, ctx context.Context, st *store.Store) {
		s, err := st.GetOrgSettings(ctx, "org_acme")
		check(t, err)
		orgDefaults := store.Notifications{WebhookFailing: true, BlockedAttempt: true, MessageExpiring: false, AgentOffline: true, MemberAdded: false}
		eq(t, "Acme notifications", s.Notifications, orgDefaults)
		_, err = st.GetOrgSettings(ctx, "org_missing")
		wantNotFound(t, "settings of a missing org", err)

		n, err := st.GetNotifications(ctx, "org_acme", "u_dana")
		check(t, err)
		eq(t, "Dana's notifications (org defaults)", n, orgDefaults)

		_, err = st.DB().ExecContext(ctx, `INSERT INTO notification_preferences
			(org_id, user_id, webhook_failing, blocked_attempt, message_expiring, agent_offline, member_added, updated_at)
			VALUES ('org_acme', 'u_dana', FALSE, FALSE, TRUE, FALSE, TRUE, 1)`)
		check(t, err)
		n, err = st.GetNotifications(ctx, "org_acme", "u_dana")
		check(t, err)
		eq(t, "Dana's own notifications", n, store.Notifications{MessageExpiring: true, MemberAdded: true})
	})
}

// No read model carries a token hash or a secret.
func TestReadModelsHoldNoSecrets(t *testing.T) {
	for _, v := range []any{store.TokenInfo{}, store.Credential{}, store.Agent{}, store.WorkspaceMember{}, store.Webhook{},
		store.FireHook{}, store.Listener{}, store.Sidecar{}} {
		typ := reflect.TypeOf(v)
		for i := 0; i < typ.NumField(); i++ {
			name := strings.ToLower(typ.Field(i).Name)
			if strings.Contains(name, "hash") || strings.Contains(name, "secret") || name == "password" && typ.Field(i).Type.Kind() == reflect.String {
				t.Errorf("%s.%s may hold a secret", typ.Name(), typ.Field(i).Name)
			}
		}
	}
}
