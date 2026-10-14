package server

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

// csrfOf returns the CSRF token of the session a client from h.as holds.
func (h *harness) csrfOf(c *http.Client) string {
	h.t.Helper()
	m, code := h.me(c)
	if code != http.StatusOK {
		h.t.Fatalf("GET /api/me = %d", code)
	}
	return m.CSRFToken
}

// write sends a state-changing request with the client's CSRF token and
// checks the status.
func (h *harness) write(c *http.Client, method, path string, body any, want int) *http.Response {
	h.t.Helper()
	res := h.do(c, method, path, body, http.Header{csrfHeader: {h.csrfOf(c)}})
	if res.StatusCode != want {
		e := decode[apiError](h.t, res)
		h.t.Fatalf("%s %s = %d (%s: %s), want %d", method, path, res.StatusCode, e.Error, e.Message, want)
	}
	return res
}

type membersResponse struct {
	Members       []memberJSON       `json:"members"`
	DefaultAdmins []defaultAdminJSON `json:"default_admins"`
	CanAdmin      bool               `json:"can_admin"`
}

type auditResponse struct {
	Events []auditJSON `json:"events"`
}

func findMember(ms []memberJSON, kind, id string) *memberJSON {
	for i := range ms {
		if ms[i].Kind == kind && ms[i].MemberID == id {
			return &ms[i]
		}
	}
	return nil
}

func sameSet(a, b []string) bool {
	a, b = slices.Clone(a), slices.Clone(b)
	slices.Sort(a)
	slices.Sort(b)
	return slices.Equal(a, b)
}

func objects(es []auditJSON) []string {
	out := []string{}
	for _, e := range es {
		out = append(out, e.Object)
	}
	return out
}

// The issue's acceptance path: an Owner creates a workspace, adds a member,
// changes their role and removes them, and sees each action in Audit.
func TestAdminWorkspaceLifecycle(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana := h.as("u_dana")

		res := h.write(dana, http.MethodPost, "/api/v1/orgs/org_acme/workspaces",
			map[string]any{"name": "  Launch  ", "description": "Ship it.", "default_expiry_hours": 24}, http.StatusCreated)
		ws := decode[workspaceResponse](t, res).Workspace
		if ws.Name != "Launch" || ws.Description != "Ship it." || ws.DefaultExpiryHours == nil || *ws.DefaultExpiryHours != 24 ||
			ws.RetentionDays != store.DefaultRetention || !ws.CanAdmin || ws.MyRole == nil || *ws.MyRole != roleWorkspaceAdmin || ws.Humans != 1 {
			t.Fatalf("created workspace = %+v", ws)
		}
		base := "/api/v1/orgs/org_acme/workspaces/" + ws.ID

		// The same name again, in any case, is a conflict.
		h.write(dana, http.MethodPost, "/api/v1/orgs/org_acme/workspaces", map[string]any{"name": "LAUNCH"}, http.StatusConflict)
		h.write(dana, http.MethodPost, "/api/v1/orgs/org_acme/workspaces", map[string]any{"name": " "}, http.StatusBadRequest)

		// Add Mia as a member, then make her admin, then remove her.
		res = h.write(dana, http.MethodPost, base+"/members", map[string]any{"kind": "user", "id": "u_mia", "write": false}, http.StatusCreated)
		mia := decode[map[string]memberJSON](t, res)["member"]
		if mia.Role != store.WSRoleMember || !mia.Read || mia.Write || mia.Name != "Mia Chen" || mia.AddedBy == nil || mia.AddedBy.ID != "u_dana" {
			t.Fatalf("added member = %+v", mia)
		}
		h.write(dana, http.MethodPost, base+"/members", map[string]any{"kind": "user", "id": "u_mia"}, http.StatusConflict)

		res = h.write(dana, http.MethodPatch, base+"/members/"+mia.ID, map[string]any{"role": store.WSRoleAdmin, "write": true}, http.StatusOK)
		mia = decode[map[string]memberJSON](t, res)["member"]
		if mia.Role != store.WSRoleAdmin || !mia.Write || mia.DelegatedBy == nil || mia.DelegatedBy.Label != "Dana Keller" {
			t.Fatalf("after delegating admin = %+v", mia)
		}
		// Mia now administers it, so she sees it and can rename it.
		h.get(h.as("u_mia"), base, http.StatusOK)
		h.write(h.as("u_mia"), http.MethodPatch, base, map[string]any{"name": "Launch pad", "default_expiry_hours": nil}, http.StatusOK)

		h.write(dana, http.MethodDelete, base+"/members/"+mia.ID, nil, http.StatusNoContent)
		h.get(h.as("u_mia"), base, http.StatusNotFound)
		h.write(dana, http.MethodDelete, base+"/members/"+mia.ID, nil, http.StatusNotFound)

		// Every step is in the workspace audit, newest first.
		events := decode[auditResponse](t, h.get(dana, base+"/audit", http.StatusOK)).Events
		want := []string{
			"Removed Mia Chen from Launch pad",
			"Changed Launch pad settings · defaultExpiryHours",
			"Renamed workspace Launch to Launch pad",
			"Changed Mia Chen's access in Launch → read + write",
			"Delegated admin on Launch to Mia Chen (user)",
			"Added Mia Chen (user) to Launch as member (read)",
			"Added Dana Keller (user) to Launch as admin",
			"Created workspace Launch",
		}
		// Rows written by one request share a timestamp, so compare as sets
		// after checking the newest.
		got := objects(events)
		if len(got) == 0 || got[0] != want[0] || !sameSet(got, want) {
			t.Fatalf("workspace audit =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
		}
		for _, e := range events {
			if e.Actor.Kind != "user" || e.Workspace == nil || e.Workspace.ID != ws.ID || !strings.HasPrefix(e.Trk, "trk_") || len(e.Trk) != 12 {
				t.Errorf("audit row %q: actor %+v workspace %+v trk %q", e.Object, e.Actor, e.Workspace, e.Trk)
			}
		}
		byObject := map[string]auditJSON{}
		for _, e := range events {
			byObject[e.Object] = e
		}
		removed, settings := byObject[want[0]], byObject[want[1]]
		if removed.Actor.ID != "u_dana" || !removed.Shared || len(removed.Changes) == 0 || len(removed.Detail) != 0 {
			t.Errorf("member removal row (shared, with changes): %+v", removed)
		}
		if settings.Actor.ID != "u_mia" || settings.Shared || len(settings.Detail) == 0 || len(settings.Changes) != 0 {
			t.Errorf("settings row (Dispatch's own, with detail): %+v", settings)
		}

		// Delete it: gone from the list, 404 to open, still in the org audit as deleted.
		h.write(dana, http.MethodDelete, base, nil, http.StatusNoContent)
		h.get(dana, base, http.StatusNotFound)
		org := decode[auditResponse](t, h.get(dana, "/api/v1/orgs/org_acme/audit", http.StatusOK)).Events
		if org[0].Object != "Deleted workspace Launch pad" || org[0].Workspace == nil || !org[0].Workspace.Deleted || org[0].Severity != "warn" {
			t.Errorf("org audit after delete: %+v", org[0])
		}
	})
}

// A plain member can't do any admin action. Where they can see the
// resource it is 403; where they can't it is 404.
func TestAdminPlainMemberRefused(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		mia := h.as("u_mia") // a user in Acme, a member (not admin) of Release train only
		rel := "/api/v1/orgs/org_acme/workspaces/ws_rel"
		inc := "/api/v1/orgs/org_acme/workspaces/ws_inc" // Mia isn't a member
		cases := []struct {
			method, path string
			body         any
			want         int
		}{
			{http.MethodPost, "/api/v1/orgs/org_acme/workspaces", map[string]any{"name": "Mine"}, http.StatusForbidden},
			{http.MethodPatch, rel, map[string]any{"name": "Renamed"}, http.StatusForbidden},
			{http.MethodDelete, rel, nil, http.StatusForbidden},
			{http.MethodPost, rel + "/members", map[string]any{"kind": "user", "id": "u_sam"}, http.StatusForbidden},
			{http.MethodPatch, rel + "/members/wm_rel_mia", map[string]any{"role": store.WSRoleAdmin}, http.StatusForbidden},
			{http.MethodDelete, rel + "/members/wm_rel_builder", nil, http.StatusForbidden},
			{http.MethodPut, rel + "/access/blocklist/ag_builder", nil, http.StatusForbidden},
			{http.MethodDelete, rel + "/access/blocklist/ag_scraper", nil, http.StatusForbidden},
			{http.MethodPost, "/api/v1/orgs/org_acme/invitations", map[string]any{"email": "x@example.com"}, http.StatusForbidden},
			{http.MethodPatch, "/api/v1/orgs/org_acme/people/u_sam", map[string]any{"role": "userAdmin"}, http.StatusForbidden},
			{http.MethodPost, "/api/v1/orgs/org_acme/people/u_sam/suspend", map[string]any{}, http.StatusForbidden},
			{http.MethodDelete, "/api/v1/orgs/org_acme/people/u_sam", nil, http.StatusForbidden},
			// A workspace she can't see, and another org's: 404, never 403.
			{http.MethodPatch, inc, map[string]any{"name": "Renamed"}, http.StatusNotFound},
			{http.MethodDelete, inc, nil, http.StatusNotFound},
			{http.MethodPost, inc + "/members", map[string]any{"kind": "user", "id": "u_mia"}, http.StatusNotFound},
			{http.MethodDelete, inc + "/members/wm_inc_sam", nil, http.StatusNotFound},
			{http.MethodPut, inc + "/access/blocklist/ag_builder", nil, http.StatusNotFound},
		}
		for _, tc := range cases {
			h.write(mia, tc.method, tc.path, tc.body, tc.want)
		}
		// Nothing changed and nothing was audited by her.
		events := decode[auditResponse](t, h.get(h.as("u_dana"), "/api/v1/orgs/org_acme/audit?actor=u_mia", http.StatusOK)).Events
		for _, e := range events {
			if e.Type == "admin" {
				t.Errorf("refused write was audited: %+v", e)
			}
		}
		ms := decode[membersResponse](t, h.get(mia, rel+"/members", http.StatusOK))
		if ms.CanAdmin || findMember(ms.Members, "agent", "ag_builder") == nil {
			t.Errorf("Release train members for Mia: can_admin %v, %d members", ms.CanAdmin, len(ms.Members))
		}

		// A workspace admin who isn't an org admin edits their workspace but
		// can't create workspaces or manage people.
		sam := h.as("u_sam") // admin of Incidents
		h.write(sam, http.MethodPatch, inc, map[string]any{"description": "Live incidents only."}, http.StatusOK)
		h.write(sam, http.MethodPost, "/api/v1/orgs/org_acme/workspaces", map[string]any{"name": "Sam's"}, http.StatusForbidden)
		h.write(sam, http.MethodPatch, rel, map[string]any{"name": "x"}, http.StatusNotFound)
	})
}

// Writes are checked against the caller's org and need the CSRF token.
func TestAdminScopeAndCSRF(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		leo, dana := h.as("u_leo"), h.as("u_dana")

		// An Owner of another org gets 404 for everything in Acme.
		h.write(leo, http.MethodPost, "/api/v1/orgs/org_acme/workspaces", map[string]any{"name": "Hijack"}, http.StatusNotFound)
		h.write(leo, http.MethodDelete, "/api/v1/orgs/org_acme/workspaces/ws_rel", nil, http.StatusNotFound)
		h.write(leo, http.MethodDelete, "/api/v1/orgs/org_nw/workspaces/ws_rel", nil, http.StatusNotFound)
		h.write(leo, http.MethodPost, "/api/v1/orgs/org_acme/invitations", map[string]any{"email": "x@example.com"}, http.StatusNotFound)
		h.write(leo, http.MethodDelete, "/api/v1/orgs/org_acme/people/u_mia", nil, http.StatusNotFound)
		h.get(leo, "/api/v1/orgs/org_acme/people", http.StatusNotFound)
		h.get(leo, "/api/v1/orgs/org_acme/agents/ag_planner", http.StatusNotFound)
		h.get(leo, "/api/v1/orgs/org_acme/audit", http.StatusNotFound)

		// Acme's Owner can't pull another org's people or agents into Acme.
		h.write(dana, http.MethodPost, "/api/v1/orgs/org_acme/workspaces/ws_rel/members", map[string]any{"kind": "user", "id": "u_leo"}, http.StatusBadRequest)
		h.write(dana, http.MethodPost, "/api/v1/orgs/org_acme/workspaces/ws_rel/members", map[string]any{"kind": "agent", "id": "ag_docs"}, http.StatusBadRequest)
		h.write(dana, http.MethodPut, "/api/v1/orgs/org_acme/workspaces/ws_rel/access/blocklist/ag_docs", nil, http.StatusBadRequest)
		// A membership ID from another workspace is 404.
		h.write(dana, http.MethodDelete, "/api/v1/orgs/org_acme/workspaces/ws_rel/members/wm_inc_sam", nil, http.StatusNotFound)
		h.write(dana, http.MethodDelete, "/api/v1/orgs/org_acme/workspaces/ws_rel/members/wm_docs_mia", nil, http.StatusNotFound)

		// Without the CSRF header every write is refused before anything else.
		res := h.do(dana, http.MethodDelete, "/api/v1/orgs/org_acme/workspaces/ws_rel", nil, nil)
		if res.StatusCode != http.StatusForbidden || decode[apiError](t, res).Error != "csrf" {
			t.Errorf("delete without CSRF = %d", res.StatusCode)
		}
		res = h.do(dana, http.MethodPost, "/api/v1/orgs/org_acme/workspaces", map[string]any{"name": "x"}, http.Header{csrfHeader: {"wrong"}})
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("create with a wrong CSRF token = %d", res.StatusCode)
		}
		h.get(dana, "/api/v1/orgs/org_acme/workspaces/ws_rel", http.StatusOK)
	})
}

func TestAdminAgentMembersAndAccess(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana := h.as("u_dana")
		inc := "/api/v1/orgs/org_acme/workspaces/ws_inc"

		// An agent added here has no workspace token until the Connect tab issues one.
		res := h.write(dana, http.MethodPost, inc+"/members", map[string]any{"kind": "agent", "id": "ag_planner", "role": store.WSRoleAdmin, "read": false, "write": true}, http.StatusCreated)
		m := decode[map[string]memberJSON](t, res)["member"]
		if m.Kind != "agent" || m.Role != store.WSRoleAdmin || !m.Read || !m.Write || m.Token != nil || m.Name != "planner" {
			t.Fatalf("added agent = %+v", m)
		}
		var hash string
		if err := h.st.DB().QueryRowContext(context.Background(), "SELECT token_current_hash FROM membership_access WHERE id = '"+m.ID+"'").Scan(&hash); err != nil || hash != "unissued:"+m.ID {
			t.Errorf("placeholder token hash = %q, %v", hash, err)
		}
		check := decode[ladderJSON](t, h.get(dana, inc+"/access/check?agent=ag_planner&op=read", http.StatusOK))
		if check.Allowed || !strings.Contains(check.Reason, "No workspace token") {
			t.Errorf("ladder for an agent without a token = %+v", check)
		}

		// Read off turns write off; write on turns read back on.
		res = h.write(dana, http.MethodPatch, inc+"/members/"+m.ID, map[string]any{"read": false}, http.StatusOK)
		if got := decode[map[string]memberJSON](t, res)["member"]; got.Read || got.Write {
			t.Errorf("after read off: %+v", got)
		}
		res = h.write(dana, http.MethodPatch, inc+"/members/"+m.ID, map[string]any{"write": true}, http.StatusOK)
		if got := decode[map[string]memberJSON](t, res)["member"]; !got.Read || !got.Write {
			t.Errorf("after write on: %+v", got)
		}
		res = h.write(dana, http.MethodPatch, inc+"/members/"+m.ID, map[string]any{"role": store.WSRoleMember}, http.StatusOK)
		if got := decode[map[string]memberJSON](t, res)["member"]; got.Role != store.WSRoleMember || got.DelegatedBy != nil {
			t.Errorf("after removing agent admin: %+v", got)
		}

		// A seeded agent with a token: the ladder passes, then the blocklist wins.
		check = decode[ladderJSON](t, h.get(dana, inc+"/access/check?agent=ag_deployer&op=write", http.StatusOK))
		if !check.Allowed || len(check.Steps) != 6 {
			t.Fatalf("deployer write in Incidents = %+v", check)
		}
		h.write(dana, http.MethodPut, inc+"/access/blocklist/ag_deployer", nil, http.StatusOK)
		res = h.write(dana, http.MethodPut, inc+"/access/blocklist/ag_deployer", nil, http.StatusOK)
		if decode[map[string]bool](t, res)["changed"] {
			t.Error("blocking twice reported a change")
		}
		check = decode[ladderJSON](t, h.get(dana, inc+"/access/check?agent=ag_deployer&op=write", http.StatusOK))
		if check.Allowed || check.Steps[2].Pass || !strings.Contains(check.Reason, "blocks this agent") {
			t.Errorf("after blocking: %+v", check)
		}
		access := decode[map[string]any](t, h.get(dana, inc+"/access", http.StatusOK))
		if bl := access["blocklist"].([]any); len(bl) != 1 || bl[0].(map[string]any)["label"] != "deployer" {
			t.Errorf("blocklist = %v", access["blocklist"])
		}
		h.write(dana, http.MethodDelete, inc+"/access/blocklist/ag_deployer", nil, http.StatusOK)
		check = decode[ladderJSON](t, h.get(dana, inc+"/access/check?agent=ag_deployer&op=write", http.StatusOK))
		if !check.Allowed {
			t.Errorf("after unblocking: %+v", check)
		}

		// The Agents screen lists the agent with its Incidents membership.
		agents := decode[map[string][]agentJSON](t, h.get(dana, "/api/v1/orgs/org_acme/agents", http.StatusOK))["agents"]
		var planner *agentJSON
		for i := range agents {
			if agents[i].ID == "ag_planner" {
				planner = &agents[i]
			}
		}
		if planner == nil || len(planner.Workspaces) != 2 || planner.Token == nil || planner.Token.Current.Last4 != "Pn7w" {
			t.Fatalf("planner on the Agents screen = %+v", planner)
		}
		// Mia (member of Release train only) sees planner's Release train membership, not Incidents.
		detail := decode[struct {
			Agent agentJSON `json:"agent"`
		}](t, h.get(h.as("u_mia"), "/api/v1/orgs/org_acme/agents/ag_planner", http.StatusOK)).Agent
		if len(detail.Workspaces) != 1 || detail.Workspaces[0].ID != "ws_rel" {
			t.Errorf("planner's workspaces for Mia = %+v", detail.Workspaces)
		}
		h.get(dana, "/api/v1/orgs/org_acme/agents/ag_docs", http.StatusNotFound)

		// Removing the agent and deleting the workspace are both audited.
		h.write(dana, http.MethodDelete, inc+"/members/"+m.ID, nil, http.StatusNoContent)
		h.write(dana, http.MethodDelete, inc, nil, http.StatusNoContent)
		var revoked int
		if err := h.st.DB().QueryRowContext(context.Background(), "SELECT COUNT(*) FROM membership_access WHERE workspace_id = 'ws_inc' AND token_revoked_at IS NOT NULL").Scan(&revoked); err != nil || revoked != 3 {
			t.Errorf("revoked workspace tokens after delete = %d, %v", revoked, err)
		}
	})
}

type peopleResponse struct {
	People    []personJSON `json:"people"`
	CanInvite bool         `json:"can_invite"`
}

func findPerson(ps []personJSON, id string) *personJSON {
	for i := range ps {
		if ps[i].UserID == id {
			return &ps[i]
		}
	}
	return nil
}

func TestAdminPeople(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana, ravi := h.as("u_dana"), h.as("u_ravi")
		people := "/api/v1/orgs/org_acme/people"

		// Invite: stored and pending, no email; the same address again is a conflict.
		res := h.write(ravi, http.MethodPost, "/api/v1/orgs/org_acme/invitations", map[string]any{"email": "Nia@Example.com", "role": "user"}, http.StatusCreated)
		nia := decode[inviteResponse](t, res).Person
		if nia.Status != "invited" || nia.Email != "Nia@Example.com" || nia.Role != "user" {
			t.Fatalf("invited = %+v", nia)
		}
		h.write(ravi, http.MethodPost, "/api/v1/orgs/org_acme/invitations", map[string]any{"email": "nia@example.com"}, http.StatusConflict)
		h.write(ravi, http.MethodPost, "/api/v1/orgs/org_acme/invitations", map[string]any{"email": "not-an-email"}, http.StatusBadRequest)
		// Only Owners invite or make Owners.
		h.write(ravi, http.MethodPost, "/api/v1/orgs/org_acme/invitations", map[string]any{"email": "boss@example.com", "role": "Owner"}, http.StatusForbidden)
		list := decode[peopleResponse](t, h.get(dana, people, http.StatusOK))
		p := findPerson(list.People, nia.UserID)
		if p == nil || p.Invitation == nil || p.Invitation.InvitedBy == nil || p.Invitation.InvitedBy.ID != "u_ravi" || !list.CanInvite {
			t.Fatalf("invited person on People = %+v", p)
		}
		// The invitee can be added to a workspace before accepting.
		h.write(dana, http.MethodPost, "/api/v1/orgs/org_acme/workspaces/ws_sbx/members", map[string]any{"kind": "user", "id": nia.UserID}, http.StatusCreated)

		// Role changes: a userAdmin manages users but not Owners or themselves.
		h.write(ravi, http.MethodPatch, people+"/u_mia", map[string]any{"role": "userAdmin"}, http.StatusNoContent)
		h.write(ravi, http.MethodPatch, people+"/u_dana", map[string]any{"role": "user"}, http.StatusForbidden)
		h.write(ravi, http.MethodPatch, people+"/u_ravi", map[string]any{"role": "user"}, http.StatusForbidden)
		h.write(ravi, http.MethodPatch, people+"/u_sam", map[string]any{"role": "Owner"}, http.StatusForbidden)
		h.write(dana, http.MethodPatch, people+"/u_sam", map[string]any{"role": "Boss"}, http.StatusBadRequest)
		h.write(dana, http.MethodPatch, people+"/u_nobody", map[string]any{"role": "user"}, http.StatusNotFound)
		h.write(dana, http.MethodPatch, people+"/u_leo", map[string]any{"role": "user"}, http.StatusNotFound)

		// Suspend and resume: the person keeps their memberships; an invitee
		// goes back to invited.
		h.write(dana, http.MethodPost, people+"/u_sam/suspend", map[string]any{"reason": "On leave"}, http.StatusNoContent)
		h.write(dana, http.MethodPost, people+"/u_sam/suspend", nil, http.StatusConflict)
		h.get(h.as("u_sam"), "/api/v1/orgs/org_acme/workspaces", http.StatusNotFound)
		h.write(dana, http.MethodPost, people+"/u_sam/resume", nil, http.StatusNoContent)
		h.get(h.as("u_sam"), "/api/v1/orgs/org_acme/workspaces/ws_inc", http.StatusOK)
		h.write(dana, http.MethodPost, people+"/"+nia.UserID+"/suspend", nil, http.StatusNoContent)
		h.write(dana, http.MethodPost, people+"/"+nia.UserID+"/resume", nil, http.StatusNoContent)
		list = decode[peopleResponse](t, h.get(dana, people, http.StatusOK))
		if p := findPerson(list.People, nia.UserID); p == nil || p.Status != "invited" {
			t.Errorf("invitee after suspend and resume = %+v", p)
		}

		// The last active Owner can't be demoted, suspended or removed, even by
		// another Owner-to-be; once there are two, one can step down.
		h.write(dana, http.MethodPatch, people+"/u_ravi", map[string]any{"role": "Owner"}, http.StatusNoContent)
		h.write(ravi, http.MethodPatch, people+"/u_dana", map[string]any{"role": "userAdmin"}, http.StatusNoContent)
		h.write(dana, http.MethodPatch, people+"/u_ravi", map[string]any{"role": "user"}, http.StatusForbidden) // Dana is no longer an Owner
		ravi = h.as("u_ravi")
		h.write(ravi, http.MethodPatch, people+"/u_dana", map[string]any{"role": "user"}, http.StatusNoContent)
		var owners int
		if err := h.st.DB().QueryRowContext(context.Background(), "SELECT COUNT(*) FROM org_memberships WHERE org_id = 'org_acme' AND role = 'Owner' AND status = 'active'").Scan(&owners); err != nil || owners != 1 {
			t.Fatalf("active Owners = %d, %v", owners, err)
		}
		for _, run := range []func(context.Context) error{
			func(ctx context.Context) error {
				_, err := h.st.SetOrgRole(ctx, "org_acme", "u_ravi", "user", store.Actor{Kind: "system", Label: "test"}, h.srv.now())
				return err
			},
			func(ctx context.Context) error {
				_, err := h.st.SuspendOrgMember(ctx, "org_acme", "u_ravi", "", store.Actor{Kind: "system", Label: "test"}, h.srv.now())
				return err
			},
			func(ctx context.Context) error {
				return h.st.RemoveOrgMember(ctx, "org_acme", "u_ravi", store.Actor{Kind: "system", Label: "test"}, h.srv.now())
			},
		} {
			if err := run(context.Background()); err != store.ErrLastOwner {
				t.Errorf("acting on the last active Owner: err = %v, want ErrLastOwner", err)
			}
		}

		// Remove: their workspace memberships go too; a pending invitation is revoked.
		h.write(ravi, http.MethodDelete, people+"/u_mia", nil, http.StatusNoContent)
		h.get(h.as("u_mia"), "/api/v1/orgs/org_acme/workspaces", http.StatusNotFound)
		ms := decode[membersResponse](t, h.get(ravi, "/api/v1/orgs/org_acme/workspaces/ws_rel/members", http.StatusOK))
		if findMember(ms.Members, "user", "u_mia") != nil {
			t.Error("Mia is still a Release train member after leaving the org")
		}
		h.get(h.as("u_mia"), "/api/v1/orgs/org_nw/workspaces", http.StatusOK) // her other org is untouched
		h.write(ravi, http.MethodDelete, people+"/"+nia.UserID, nil, http.StatusNoContent)
		var status string
		if err := h.st.DB().QueryRowContext(context.Background(), "SELECT status FROM invitations WHERE email_lower = 'nia@example.com'").Scan(&status); err != nil || status != "revoked" {
			t.Errorf("invitation after removing the invitee = %q, %v", status, err)
		}

		// Each change is in the org audit, with no workspace.
		got := objects(decode[auditResponse](t, h.get(ravi, "/api/v1/orgs/org_acme/audit?limit=6", http.StatusOK)).Events)
		want := []string{"Removed Nia from the organization", "Removed Mia Chen from the organization", "Changed Dana Keller's org role userAdmin → user",
			"Changed Dana Keller's org role Owner → userAdmin", "Changed Ravi Mehta's org role userAdmin → Owner", "Resumed Nia"}
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("org audit = %q, want %q", got, want)
		}
	})
}

// A member who isn't an org admin sees their workspaces' audit rows and the
// rows with no workspace, never another workspace's.
func TestAdminAuditVisibility(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		h.write(h.as("u_dana"), http.MethodPatch, "/api/v1/orgs/org_acme/workspaces/ws_inc", map[string]any{"retention_days": 400}, http.StatusOK)
		h.write(h.as("u_dana"), http.MethodPost, "/api/v1/orgs/org_acme/invitations", map[string]any{"email": "z@example.com"}, http.StatusCreated)
		events := decode[auditResponse](t, h.get(h.as("u_mia"), "/api/v1/orgs/org_acme/audit?limit=500", http.StatusOK)).Events
		sawOrgRow := false
		for _, e := range events {
			if e.Workspace != nil && e.Workspace.ID != "ws_rel" {
				t.Errorf("Mia sees a row from %s: %s", e.Workspace.ID, e.Object)
			}
			sawOrgRow = sawOrgRow || (e.Workspace == nil && strings.HasPrefix(e.Object, "Invited"))
		}
		if !sawOrgRow {
			t.Error("Mia doesn't see the org-level invitation row")
		}
		h.get(h.as("u_mia"), "/api/v1/orgs/org_acme/workspaces/ws_inc/audit", http.StatusNotFound)
		h.get(h.as("u_mia"), "/api/v1/orgs/org_acme/audit?before=yesterday", http.StatusBadRequest)
		all := decode[auditResponse](t, h.get(h.as("u_ravi"), "/api/v1/orgs/org_acme/audit?type=admin&limit=500", http.StatusOK)).Events
		for _, e := range all {
			if e.Type != "admin" {
				t.Errorf("type filter let through %s", e.Type)
			}
		}
	})
}
