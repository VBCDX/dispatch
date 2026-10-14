package server

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/config"
	"github.com/VBCDX/dispatch/internal/seed"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

// testClock moves the server's clock forward. Install it before the first
// request.
type testClock struct{ skew atomic.Int64 }

func (c *testClock) now() time.Time          { return time.Now().Add(time.Duration(c.skew.Load())) }
func (c *testClock) advance(d time.Duration) { c.skew.Add(int64(d)) }

func (h *harness) clock() *testClock {
	c := &testClock{}
	h.srv.now = c.now
	return c
}

type agentRotateJSON struct {
	AgentToken string     `json:"agent_token"`
	ValidUntil *time.Time `json:"old_token_valid_until"`
}

// accepted fails unless the token pair is accepted.
func accepted(t testing.TB, h *harness, c connectJSON) {
	t.Helper()
	if res := h.do(h.client(), http.MethodGet, "/agent/v1/me", nil, http.Header{
		"Authorization": {"Bearer " + c.AgentToken}, hdrWorkspaceToken: {c.WorkspaceToken},
	}); res.StatusCode != http.StatusOK {
		t.Fatalf("tokens %s…/%s… refused: %d %s", c.AgentToken[:14], c.WorkspaceToken[:11], res.StatusCode, readAll(t, res))
	}
}

func refusedNow(t testing.TB, h *harness, c connectJSON) {
	t.Helper()
	wantHTTPStatus(t, dialErr(h, c), http.StatusUnauthorized)
}

// Rotating a workspace token or an agent token leaves the old one working
// for 10 minutes, connected or not; then it stops and its socket closes.
func TestRotatedTokenGracePeriod(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		clock := h.clock()
		dana := h.person("u_dana")
		ws := "/api/v1/orgs/org_acme/workspaces/" + relWS + "/agents/"

		old := h.enroll(dana, relWS, "switcher")
		conn := h.dialAgent(old)

		before := time.Now()
		rot := decode[connectJSON](t, h.post(dana, ws+old.Agent.ID+"/token/rotate", nil, http.StatusOK))
		if u := rot.OldTokenValidUntil; u == nil || u.Before(before.Add(store.TokenGrace-time.Minute)) || u.After(time.Now().Add(store.TokenGrace+time.Minute)) {
			t.Fatalf("old_token_valid_until = %v, want about 10 minutes from now", u)
		}
		agentRot := decode[agentRotateJSON](t, h.post(dana, "/api/v1/orgs/org_acme/agents/"+old.Agent.ID+"/token/rotate", nil, http.StatusOK))
		if agentRot.ValidUntil == nil {
			t.Fatal("agent token rotation: no old_token_valid_until")
		}
		fresh := connectJSON{Agent: old.Agent, AgentToken: agentRot.AgentToken, WorkspaceToken: rot.WorkspaceToken}

		// Every mix of old and new works during the grace period, and the
		// socket on the old pair stays up.
		for _, c := range []connectJSON{old, fresh, {AgentToken: old.AgentToken, WorkspaceToken: fresh.WorkspaceToken}, {AgentToken: fresh.AgentToken, WorkspaceToken: old.WorkspaceToken}} {
			accepted(t, h, c)
		}
		if res := h.agentPost(old, map[string]string{"body": "still me"}); res.StatusCode != http.StatusCreated {
			t.Fatalf("send on the old tokens in the grace period = %d", res.StatusCode)
		}
		if f := next(t, conn, "msg"); f.Message.Body != "still me" {
			t.Fatalf("old socket got %+v", f)
		}
		clock.advance(store.TokenGrace - time.Minute)
		h.srv.AccessChanged(old.Agent.ID, "", "") // re-read from the database, as a refresh would
		accepted(t, h, old)

		// Past the grace period the old tokens stop, the socket closes, and
		// the new ones carry on.
		clock.advance(2 * time.Minute)
		h.srv.AccessChanged(old.Agent.ID, "", "")
		if code := closedWith(t, conn, 3*time.Second); code != int(closeUnauthenticated) {
			t.Errorf("after the grace period: close code = %d, want %d", code, closeUnauthenticated)
		}
		refusedNow(t, h, old)
		refusedNow(t, h, connectJSON{AgentToken: old.AgentToken, WorkspaceToken: fresh.WorkspaceToken})
		refusedNow(t, h, connectJSON{AgentToken: fresh.AgentToken, WorkspaceToken: old.WorkspaceToken})
		accepted(t, h, fresh)
	})
}

// The old token's grace period ends at once when the token is revoked, the
// agent is revoked, or it is rotated again; a revoked workspace token gets
// no grace period when it is rotated.
func TestRevokeEndsGracePeriod(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana := h.person("u_dana")
		ws := "/api/v1/orgs/org_acme/workspaces/" + relWS + "/agents/"

		a := h.enroll(dana, relWS, "graceful")
		conn := h.dialAgent(a)
		r1 := decode[connectJSON](t, h.post(dana, ws+a.Agent.ID+"/token/rotate", nil, http.StatusOK))
		accepted(t, h, a)

		// Rotating again: the first token stops now, the second has the
		// grace period.
		r2 := decode[connectJSON](t, h.post(dana, ws+a.Agent.ID+"/token/rotate", nil, http.StatusOK))
		if code := closedWith(t, conn, 3*time.Second); code != int(closeUnauthenticated) {
			t.Errorf("rotated twice: close code = %d, want %d", code, closeUnauthenticated)
		}
		refusedNow(t, h, a)
		second := connectJSON{AgentToken: a.AgentToken, WorkspaceToken: r1.WorkspaceToken}
		accepted(t, h, second)
		conn = h.dialAgent(second)

		h.post(dana, ws+a.Agent.ID+"/token/revoke", nil, http.StatusOK)
		if code := closedWith(t, conn, 3*time.Second); code != int(closeUnauthenticated) {
			t.Errorf("revoked: close code = %d, want %d", code, closeUnauthenticated)
		}
		refusedNow(t, h, second)
		refusedNow(t, h, connectJSON{AgentToken: a.AgentToken, WorkspaceToken: r2.WorkspaceToken})

		// Rotating a revoked token: the new one works, the revoked one never
		// comes back.
		r3 := decode[connectJSON](t, h.post(dana, ws+a.Agent.ID+"/token/rotate", nil, http.StatusOK))
		if r3.OldTokenValidUntil != nil {
			t.Errorf("rotating a revoked token gave old_token_valid_until = %v", r3.OldTokenValidUntil)
		}
		refusedNow(t, h, connectJSON{AgentToken: a.AgentToken, WorkspaceToken: r2.WorkspaceToken})
		accepted(t, h, connectJSON{AgentToken: a.AgentToken, WorkspaceToken: r3.WorkspaceToken})

		// Revoking the agent ends its agent token's grace period too.
		c := h.enroll(dana, relWS, "agent-grace")
		h.post(dana, "/api/v1/orgs/org_acme/agents/"+c.Agent.ID+"/token/rotate", nil, http.StatusOK)
		conn = h.dialAgent(c)
		h.post(dana, "/api/v1/orgs/org_acme/agents/"+c.Agent.ID+"/revoke", nil, http.StatusOK)
		if code := closedWith(t, conn, 3*time.Second); code != int(closeUnauthenticated) {
			t.Errorf("agent revoked: close code = %d, want %d", code, closeUnauthenticated)
		}
		refusedNow(t, h, c)
	})
}

// expectUnwatched reads the next frame: the server stopping the watch on
// wsID because access was removed.
func expectUnwatched(t testing.TB, w *wsClient, wsID string) {
	t.Helper()
	f := w.expect("unwatched")
	if f.Workspace != wsID || f.Error != "access removed" {
		t.Fatalf("unwatched frame = %+v, want workspace %s with error \"access removed\"", f, wsID)
	}
}

func (h *harness) watch(w *wsClient, org, wsID string) {
	h.t.Helper()
	w.send(wsIn{Op: "watch", Org: org, Workspace: wsID})
	if f := w.expect("watching"); f.Workspace != wsID {
		h.t.Fatalf("watching %+v, want %s", f, wsID)
	}
}

func (h *harness) say(p person, org, wsID, body string) {
	h.t.Helper()
	h.post(p, "/api/v1/orgs/"+org+"/workspaces/"+wsID+"/messages", map[string]string{"body": body}, http.StatusCreated)
}

// nextMessage reads frames until a "message" frame and returns it.
func nextMessage(t testing.TB, w *wsClient) wsOut {
	t.Helper()
	for {
		f, err := w.recv(5 * time.Second)
		if err != nil {
			t.Fatalf("waiting for a message frame: %v", err)
		}
		if f.Op == "message" {
			return f
		}
		if f.Op != "event" {
			t.Fatalf("waiting for a message frame: got %+v", f)
		}
	}
}

// A person who loses access to a workspace while watching its Messages
// tab stops receiving at once: suspended, removed from the workspace, no
// longer an org admin, removed from the org, or the workspace deleted.
// Watches they still may see carry on.
func TestRemovedPeopleStopWatching(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana, leo := h.person("u_dana"), h.person("u_leo")
		const acme, people = "/api/v1/orgs/org_acme", "/api/v1/orgs/org_acme/people/"
		ws := acme + "/workspaces/"

		// Suspended in Acme: Release train stops; Northwind's Docs site
		// (another org) keeps coming.
		mia := h.person("u_mia")
		miaWS := h.mustDialWS(mia.c)
		h.watch(miaWS, "org_acme", relWS)
		h.watch(miaWS, "org_nw", "ws_docs")
		h.post(dana, people+"u_mia/suspend", nil, http.StatusNoContent)
		expectUnwatched(t, miaWS, relWS)
		h.say(dana, "org_acme", relWS, "while suspended")
		h.say(leo, "org_nw", "ws_docs", "docs news")
		if f := nextMessage(t, miaWS); f.Workspace != "ws_docs" {
			t.Fatalf("suspended Mia got a message from %s, want only ws_docs", f.Workspace)
		}

		// Removed from the workspace's members.
		h.post(dana, people+"u_mia/resume", nil, http.StatusNoContent)
		h.watch(miaWS, "org_acme", relWS)
		if res := h.do(dana.c, http.MethodDelete, ws+relWS+"/members/wm_rel_mia", nil, http.Header{csrfHeader: {dana.csrf}}); res.StatusCode != http.StatusNoContent {
			t.Fatalf("remove member = %d: %s", res.StatusCode, readAll(t, res))
		}
		expectUnwatched(t, miaWS, relWS)
		h.say(dana, "org_acme", relWS, "after removal")
		h.say(leo, "org_nw", "ws_docs", "more docs news")
		if f := nextMessage(t, miaWS); f.Workspace != "ws_docs" {
			t.Fatalf("removed Mia got a message from %s, want only ws_docs", f.Workspace)
		}
		// And she can't watch it again.
		miaWS.send(wsIn{Op: "watch", Org: "org_acme", Workspace: relWS})
		if f := miaWS.expect("error"); f.Error != "no such workspace" {
			t.Fatalf("re-watch after removal = %+v", f)
		}

		// No longer an org admin: Sam saw Sandbox only as a userAdmin.
		h.do(dana.c, http.MethodPatch, people+"u_sam", map[string]string{"role": store.RoleUserAdmin}, http.Header{csrfHeader: {dana.csrf}})
		samWS := h.mustDialWS(h.person("u_sam").c)
		h.watch(samWS, "org_acme", "ws_sbx")
		h.watch(samWS, "org_acme", "ws_inc") // a member there: stays
		if res := h.do(dana.c, http.MethodPatch, people+"u_sam", map[string]string{"role": store.RoleUser}, http.Header{csrfHeader: {dana.csrf}}); res.StatusCode != http.StatusNoContent {
			t.Fatalf("demote = %d: %s", res.StatusCode, readAll(t, res))
		}
		expectUnwatched(t, samWS, "ws_sbx")
		h.say(dana, "org_acme", "ws_inc", "incident update")
		if f := nextMessage(t, samWS); f.Workspace != "ws_inc" {
			t.Fatalf("demoted Sam got a message from %s, want ws_inc", f.Workspace)
		}

		// Removed from the organization.
		raviWS := h.mustDialWS(h.person("u_ravi").c)
		h.watch(raviWS, "org_acme", relWS)
		if res := h.do(dana.c, http.MethodDelete, people+"u_ravi", nil, http.Header{csrfHeader: {dana.csrf}}); res.StatusCode != http.StatusNoContent {
			t.Fatalf("remove from org = %d: %s", res.StatusCode, readAll(t, res))
		}
		expectUnwatched(t, raviWS, relWS)

		// The workspace deleted.
		danaWS := h.mustDialWS(dana.c)
		h.watch(danaWS, "org_acme", "ws_inc")
		if res := h.do(dana.c, http.MethodDelete, ws+"ws_inc", nil, http.Header{csrfHeader: {dana.csrf}}); res.StatusCode != http.StatusNoContent {
			t.Fatalf("delete workspace = %d: %s", res.StatusCode, readAll(t, res))
		}
		expectUnwatched(t, danaWS, "ws_inc")
		expectUnwatched(t, samWS, "ws_inc")
	})
}

// fallbackRows lists a workspace's audit rows recording the fall back to
// the default admins.
func (h *harness) fallbackRows(wsID string) []auditJSON {
	h.t.Helper()
	var out []auditJSON
	for _, e := range decode[auditResponse](h.t, h.get(h.as("u_dana"), "/api/v1/orgs/org_acme/workspaces/"+wsID+"/audit?limit=500", http.StatusOK)).Events {
		if e.Result == "Default admins" {
			out = append(out, e)
		}
	}
	return out
}

// When a workspace loses its last named human admin, by a demotion, a
// removal from the workspace or the org, or a suspension, the audit log
// records that the org's Owners and userAdmins became its default admins.
// Losing one of two named admins records nothing.
func TestAuditDefaultAdminFallback(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana, ravi := h.as("u_dana"), h.as("u_ravi")
		const acme = "/api/v1/orgs/org_acme"
		ws := acme + "/workspaces/"

		// Suspending Ravi: Sandbox (his alone) falls back, Release train
		// (Dana is admin too) doesn't.
		h.write(dana, http.MethodPost, acme+"/people/u_ravi/suspend", nil, http.StatusNoContent)
		rows := h.fallbackRows("ws_sbx")
		if len(rows) != 1 {
			t.Fatalf("Sandbox fallback rows after suspending its only admin = %d, want 1", len(rows))
		}
		want := "Sandbox has no explicit human admin — default admins: Dana Keller (org Owners/userAdmins)"
		if e := rows[0]; e.Object != want || e.Reason == "" || e.Actor.ID != "u_dana" || e.Workspace == nil || e.Workspace.ID != "ws_sbx" {
			t.Errorf("fallback row = %+v, want object %q by Dana with a reason", e, want)
		}
		if n := len(h.fallbackRows(relWS)); n != 0 {
			t.Errorf("Release train fallback rows = %d, want 0 (Dana is still its admin)", n)
		}
		h.write(dana, http.MethodPost, acme+"/people/u_ravi/resume", nil, http.StatusNoContent)

		// Demoting: one of two admins records nothing, the last one does.
		h.write(dana, http.MethodPatch, ws+"ws_inc/members/wm_inc_sam", map[string]string{"role": store.WSRoleMember}, http.StatusOK)
		if n := len(h.fallbackRows("ws_inc")); n != 0 {
			t.Fatalf("Incidents fallback rows after demoting one of two admins = %d, want 0", n)
		}
		h.write(ravi, http.MethodPatch, ws+"ws_inc/members/wm_inc_dana", map[string]string{"role": store.WSRoleMember}, http.StatusOK)
		if rows := h.fallbackRows("ws_inc"); len(rows) != 1 || rows[0].Object != "Incidents has no explicit human admin — default admins: Dana Keller, Ravi Mehta (org Owners/userAdmins)" {
			t.Fatalf("Incidents fallback rows after demoting its last admin = %v", objects(rows))
		}

		// Removing from the workspace.
		h.write(dana, http.MethodDelete, ws+relWS+"/members/wm_rel_ravi", nil, http.StatusNoContent)
		if n := len(h.fallbackRows(relWS)); n != 0 {
			t.Fatalf("Release train fallback rows after removing one of two admins = %d, want 0", n)
		}
		h.write(ravi, http.MethodDelete, ws+relWS+"/members/wm_rel_dana", nil, http.StatusNoContent)
		if n := len(h.fallbackRows(relWS)); n != 1 {
			t.Fatalf("Release train fallback rows after removing its last admin = %d, want 1", n)
		}

		// Removing from the organization: Sandbox falls back again.
		h.write(dana, http.MethodDelete, acme+"/people/u_ravi", nil, http.StatusNoContent)
		if rows := h.fallbackRows("ws_sbx"); len(rows) != 2 || rows[0].Object != want {
			t.Fatalf("Sandbox fallback rows after removing Ravi from the org = %v", objects(rows))
		}
	})
}

type inviteResponse struct {
	Person    personJSON `json:"person"`
	InviteURL string     `json:"invite_url"`
}

type offerResponse struct {
	Invitation invitationOfferJSON `json:"invitation"`
}

// invite has Dana invite email to Acme and returns the response.
func (h *harness) invite(dana *http.Client, email, role string) (inviteResponse, string) {
	h.t.Helper()
	res := decode[inviteResponse](h.t, h.write(dana, http.MethodPost, "/api/v1/orgs/org_acme/invitations", map[string]string{"email": email, "role": role}, http.StatusCreated))
	base, token, ok := strings.Cut(res.InviteURL, "/invite#")
	if !ok || base != h.ts.URL || !strings.HasPrefix(token, store.InvitationTokenPrefix) || len(token) < 40 {
		h.t.Fatalf("invite_url = %q, want %s/invite#dsp_inv_…", res.InviteURL, h.ts.URL)
	}
	return res, token
}

// accepting posts token to /api/v1/invitations/{op} and checks the status
// and, for a refusal, the error code.
func (h *harness) accepting(c *http.Client, op, token string, want int, code string) *http.Response {
	h.t.Helper()
	res := h.write(c, http.MethodPost, "/api/v1/invitations/"+op, map[string]string{"token": token}, want)
	if code != "" {
		if e := decode[apiError](h.t, res); e.Error != code {
			h.t.Fatalf("%s: error %q, want %q", op, e.Error, code)
		}
	}
	return res
}

func orgStatus(t testing.TB, h *harness, c *http.Client, orgID string) (role, status string) {
	t.Helper()
	for _, o := range decode[orgsResponse](t, h.get(c, "/api/v1/orgs", http.StatusOK)).Orgs {
		if o.ID == orgID {
			return o.Role, o.Status
		}
	}
	return "", ""
}

// An invite link, shown once to the inviter, joins whoever opens it while
// signed in (a local account or Zitadel, whatever their email) to the
// organization with the invited role. It works once, and not after the
// invitation is revoked or 7 days have passed. Someone already in the
// organization can't use it.
func TestInvitationLinks(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := newHarness(t, b, config.AuthBoth, nil)
		if _, err := seed.Load(context.Background(), h.st, time.Now()); err != nil {
			t.Fatal(err)
		}
		clock := h.clock()
		dana := h.as("u_dana")

		// A local account accepts an invitation sent to another address.
		inv, token := h.invite(dana, "newbie@example.com", store.RoleUserAdmin)
		local := h.signedInClient("someone.else@example.com")
		offer := decode[offerResponse](t, h.accepting(local, "preview", token, http.StatusOK, "")).Invitation
		if offer.Org.ID != "org_acme" || offer.Org.Name != "Acme Corp" || offer.Role != store.RoleUserAdmin || offer.Email != "newbie@example.com" || offer.InvitedBy != "Dana Keller" {
			t.Fatalf("preview = %+v", offer)
		}
		h.accepting(local, "accept", token, http.StatusOK, "")
		if role, status := orgStatus(t, h, local, "org_acme"); role != store.RoleUserAdmin || status != statusActive {
			t.Fatalf("after accepting: role %q status %q, want userAdmin active", role, status)
		}
		h.get(local, "/api/v1/orgs/org_acme/people", http.StatusOK)
		people := decode[peopleResponse](t, h.get(dana, "/api/v1/orgs/org_acme/people", http.StatusOK)).People
		if findPerson(people, inv.Person.UserID) != nil {
			t.Error("the invitee's placeholder is still on People after accepting")
		}
		me, _ := h.me(local)
		if p := findPerson(people, me.User.ID); p == nil || p.Status != statusActive || p.Role != store.RoleUserAdmin {
			t.Errorf("People shows the new member as %+v", p)
		}

		// Single use: not again, and not by anyone else.
		h.accepting(local, "accept", token, http.StatusGone, "invitation_accepted")
		h.accepting(h.signedInClient("third@example.com"), "accept", token, http.StatusGone, "invitation_accepted")

		// A Zitadel account accepts too.
		_, token2 := h.invite(dana, "zed@example.com", store.RoleUser)
		zc := h.client()
		h.zitadelSignIn(zc)
		h.accepting(zc, "accept", token2, http.StatusOK, "")
		if role, status := orgStatus(t, h, zc, "org_acme"); role != store.RoleUser || status != statusActive {
			t.Fatalf("Zitadel account after accepting: role %q status %q", role, status)
		}

		// Someone already in the organization can't use a link; it stays
		// usable for someone else.
		_, token3 := h.invite(dana, "spare@example.com", store.RoleUser)
		h.accepting(h.as("u_mia"), "accept", token3, http.StatusConflict, "already_member")
		h.accepting(h.signedInClient("spare.taker@example.com"), "accept", token3, http.StatusOK, "")

		// Revoking the invitation (removing the invitee) stops the link.
		inv4, token4 := h.invite(dana, "revoked@example.com", store.RoleUser)
		h.write(dana, http.MethodDelete, "/api/v1/orgs/org_acme/people/"+inv4.Person.UserID, nil, http.StatusNoContent)
		late := h.signedInClient("late@example.com")
		h.accepting(late, "preview", token4, http.StatusGone, "invitation_revoked")
		h.accepting(late, "accept", token4, http.StatusGone, "invitation_revoked")
		if _, status := orgStatus(t, h, late, "org_acme"); status != "" {
			t.Fatalf("a revoked link joined the org (%s)", status)
		}

		// A suspended invitee's link waits until they're resumed.
		inv5, token5 := h.invite(dana, "paused@example.com", store.RoleUser)
		h.write(dana, http.MethodPost, "/api/v1/orgs/org_acme/people/"+inv5.Person.UserID+"/suspend", nil, http.StatusNoContent)
		h.accepting(late, "accept", token5, http.StatusConflict, "suspended")
		h.write(dana, http.MethodPost, "/api/v1/orgs/org_acme/people/"+inv5.Person.UserID+"/resume", nil, http.StatusNoContent)

		events := decode[auditResponse](t, h.get(dana, "/api/v1/orgs/org_acme/audit?limit=500", http.StatusOK)).Events
		accepted := 0
		for _, e := range events {
			if strings.Contains(e.Object, "accepted the invitation for") {
				accepted++
			}
		}
		if accepted != 3 {
			t.Errorf("audit has %d acceptances, want 3: %v", accepted, objects(events))
		}

		// 7 days on, it has expired.
		_, token6 := h.invite(dana, "slow@example.com", store.RoleUser)
		clock.advance(7*24*time.Hour + time.Minute)
		slow := h.signedInClient("slow.taker@example.com")
		h.accepting(slow, "preview", token6, http.StatusGone, "invitation_expired")
		h.accepting(slow, "accept", token6, http.StatusGone, "invitation_expired")
		h.accepting(slow, "accept", token5, http.StatusGone, "invitation_expired")

		// Not a token at all.
		h.accepting(slow, "accept", "dsp_inv_nope", http.StatusNotFound, "not_found")
		h.accepting(slow, "accept", "nope", http.StatusNotFound, "not_found")
	})
}

// After an explicit sign-out, silent sign-in is skipped only until the
// browser closes: the sign-out marker is a session cookie, with no
// Max-Age or Expires. A browser that kept only its persistent cookies
// (closed and reopened) tries silent sign-in again.
func TestSignOutSkipsSilentSignInUntilBrowserCloses(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := newHarness(t, b, config.AuthBoth, nil)
		h.createUser("ty@example.com", testPassword)
		c := h.client()
		me := decode[meResponse](t, h.login(c, "ty@example.com", testPassword))
		res := h.do(c, http.MethodPost, "/api/auth/logout", nil, http.Header{csrfHeader: {me.CSRFToken}})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("logout = %d", res.StatusCode)
		}
		var marker *http.Cookie
		for _, ck := range res.Cookies() {
			if ck.Name == h.srv.markerName(signedOutMarker) {
				marker = ck
			}
		}
		switch {
		case marker == nil:
			t.Fatal("sign-out set no signed-out marker")
		case marker.Value == "" || marker.MaxAge != 0 || !marker.Expires.IsZero() || strings.Contains(marker.Raw, "Max-Age") || strings.Contains(marker.Raw, "Expires"):
			t.Fatalf("signed-out marker = %+v, want a session cookie (no Max-Age, no Expires)", marker)
		case !marker.HttpOnly || marker.Path != "/":
			t.Errorf("signed-out marker = %+v, want HttpOnly on /", marker)
		}
		if h.authConfig(c).SilentSignIn {
			t.Fatal("silent_sign_in = true in the same browser session after signing out")
		}

		// Reopened browser: session cookies are gone, persistent ones stay.
		reopened := h.client()
		u, _ := url.Parse(h.ts.URL)
		for _, ck := range c.Jar.Cookies(u) {
			if ck.Name != h.srv.markerName(signedOutMarker) {
				reopened.Jar.SetCookies(u, []*http.Cookie{ck})
			}
		}
		if !h.authConfig(reopened).SilentSignIn {
			t.Fatal("silent_sign_in = false in a new browser session")
		}
	})
}
