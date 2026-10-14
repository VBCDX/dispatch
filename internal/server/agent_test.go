package server

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/VBCDX/dispatch/internal/agentclient"
	"github.com/VBCDX/dispatch/internal/store"
	"github.com/VBCDX/dispatch/internal/store/storetest"
)

// The demo data's Release train workspace in Acme Corp: Dana (Owner) and
// Ravi are its workspace admins, Mia a member, Sam not a member.
const relWS = "ws_rel"

// person is a signed-in browser client with its CSRF token.
type person struct {
	c    *http.Client
	csrf string
}

func (h *harness) person(userID string) person {
	h.t.Helper()
	token, csrf := rand.Text(), rand.Text()
	now := time.Now()
	if err := h.st.CreateSession(context.Background(), store.Session{
		IDHash: hashToken(token), UserID: userID, Method: methodLocal, CSRFToken: csrf,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}); err != nil {
		h.t.Fatal(err)
	}
	c := h.client()
	u, _ := url.Parse(h.ts.URL)
	c.Jar.SetCookies(u, []*http.Cookie{{Name: h.srv.cookieName(), Value: token, Path: "/"}})
	return person{c, csrf}
}

func (h *harness) post(p person, path string, body any, want int) *http.Response {
	h.t.Helper()
	if body == nil {
		body = map[string]any{}
	}
	res := h.do(p.c, http.MethodPost, path, body, http.Header{csrfHeader: {p.csrf}})
	if res.StatusCode != want {
		h.t.Fatalf("POST %s = %d, want %d: %s", path, res.StatusCode, want, readAll(h.t, res))
	}
	return res
}

// enroll registers a new agent in the workspace and returns its tokens.
func (h *harness) enroll(p person, wsID, label string) connectJSON {
	h.t.Helper()
	res := h.post(p, "/api/v1/orgs/org_acme/workspaces/"+wsID+"/agents", map[string]string{"label": label}, http.StatusCreated)
	c := decode[connectJSON](h.t, res)
	if !strings.HasPrefix(c.AgentToken, "dsp_agent_") || !strings.HasPrefix(c.WorkspaceToken, "dsp_ws_") {
		h.t.Fatalf("enroll returned %+v", c)
	}
	return c
}

func (h *harness) dialAgent(c connectJSON) *agentclient.Client {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a, err := agentclient.Dial(ctx, h.ts.URL, c.AgentToken, c.WorkspaceToken)
	if err != nil {
		h.t.Fatalf("dial agent %s: %v", c.Agent.Name, err)
	}
	h.t.Cleanup(func() { a.CloseNow() })
	return a
}

// next reads frames until one has op (skipping others), or fails.
func next(t testing.TB, a *agentclient.Client, op string) agentclient.Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		f, err := a.Next(ctx)
		if err != nil {
			t.Fatalf("waiting for %q: %v", op, err)
		}
		if f.Op == op || op == "" {
			return f
		}
		if f.Op == "error" {
			t.Fatalf("waiting for %q: error frame %+v", op, f)
		}
	}
}

// collect reads frames until it has one of each op (later frames of an op
// already seen fail the test, so nothing is silently skipped).
func collect(t testing.TB, a *agentclient.Client, ops ...string) map[string]agentclient.Frame {
	t.Helper()
	out := map[string]agentclient.Frame{}
	for len(out) < len(ops) {
		f := next(t, a, "")
		if _, dup := out[f.Op]; dup || !slices.Contains(ops, f.Op) {
			t.Fatalf("waiting for %v: unexpected frame %+v", ops, f)
		}
		out[f.Op] = f
	}
	return out
}

// closedWith waits for the server to close the socket and returns the code.
func closedWith(t testing.TB, a *agentclient.Client, within time.Duration) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), within)
	defer cancel()
	for {
		_, err := a.Next(ctx)
		if err != nil {
			if ctx.Err() != nil {
				t.Fatalf("socket still open after %s", within)
			}
			return agentclient.CloseStatus(err)
		}
	}
}

func dialErr(h *harness, c connectJSON) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	a, err := agentclient.Dial(ctx, h.ts.URL, c.AgentToken, c.WorkspaceToken)
	if err == nil {
		a.CloseNow()
	}
	return err
}

func wantHTTPStatus(t testing.TB, err error, status int) {
	t.Helper()
	var he *agentclient.HTTPError
	if !errors.As(err, &he) || he.Status != status {
		t.Fatalf("dial err = %v, want HTTP %d", err, status)
	}
}

func (h *harness) agentPost(c connectJSON, body any) *http.Response {
	h.t.Helper()
	return h.do(h.client(), http.MethodPost, "/agent/v1/messages", body, http.Header{
		"Authorization": {"Bearer " + c.AgentToken}, hdrWorkspaceToken: {c.WorkspaceToken},
	})
}

func (h *harness) runArchiver() {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { h.srv.RunArchiver(ctx); close(done) }()
	h.t.Cleanup(func() { cancel(); <-done })
}

type messagesResponse struct {
	Messages []messageJSON     `json:"messages"`
	Agents   []agentMemberJSON `json:"agents"`
	CanPost  bool              `json:"can_post"`
}

// Two agents in one workspace exchange messages, a person sees them live
// over the browser socket and posts one the agents receive, and history
// reaches the database.
func TestAgentsExchangeMessagesLive(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		h.runArchiver()
		dana := h.person("u_dana")
		alphaT, betaT := h.enroll(dana, relWS, "alpha"), h.enroll(dana, relWS, "beta")
		alpha, beta := h.dialAgent(alphaT), h.dialAgent(betaT)
		if alpha.Ready.Agent.Name != "alpha" || alpha.Ready.Workspace.ID != relWS || !alpha.Ready.Read || !alpha.Ready.Write {
			t.Fatalf("ready = %+v", alpha.Ready)
		}

		browser := h.mustDialWS(dana.c)
		browser.send(wsIn{Op: "watch", Org: "org_acme", Workspace: relWS})
		browser.expect("watching")

		ctx := context.Background()
		if err := alpha.Send(ctx, "c1", "hello from alpha", ""); err != nil {
			t.Fatal(err)
		}
		// alpha gets its "sent" answer and its own copy of the message, in
		// either order.
		mine := collect(t, alpha, "sent", "msg")
		sent := mine["sent"]
		if sent.ID != "c1" || sent.Seq == 0 || sent.Message == nil || sent.Message.Author.Label != "alpha" {
			t.Fatalf("sent = %+v", sent)
		}
		got := next(t, beta, "msg")
		if got.Seq != sent.Seq || got.Message.ID != sent.Message.ID || got.Message.Body != "hello from alpha" ||
			got.Message.Author.Kind != "agent" || got.Message.Author.ID != alphaT.Agent.ID {
			t.Fatalf("beta got %+v, want alpha's message", got)
		}
		if own := mine["msg"]; own.Message.ID != sent.Message.ID {
			t.Fatalf("alpha's own copy = %+v", own)
		}
		live := browser.expect("message")
		var lm struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(live.Data, &lm)
		if live.Workspace != relWS || live.Seq != sent.Seq || lm.ID != sent.Message.ID {
			t.Fatalf("browser got %+v", live)
		}

		// beta replies in the thread and acks; the browser sees the ack.
		if err := beta.Send(ctx, "r1", "on it", sent.Message.ID); err != nil {
			t.Fatal(err)
		}
		reply := collect(t, beta, "sent", "msg")["sent"]
		if err := beta.Ack(ctx, got.Seq); err != nil {
			t.Fatal(err)
		}
		for {
			f := browser.expect2("message", "event")
			if f.Op == "event" && strings.Contains(string(f.Data), `"kind":"ack"`) &&
				strings.Contains(string(f.Data), betaT.Agent.ID) {
				break
			}
		}
		if r := next(t, alpha, "msg"); r.Message.ThreadID != sent.Message.ID || r.Message.Body != "on it" {
			t.Fatalf("alpha got %+v, want beta's reply in the thread", r)
		}

		// A person posts; both agents receive it, authored by the person.
		res := h.post(dana, "/api/v1/orgs/org_acme/workspaces/"+relWS+"/messages", map[string]string{"body": "from Dana"}, http.StatusCreated)
		posted := decode[struct {
			Message struct{ ID string } `json:"message"`
		}](t, res)
		for _, a := range []*agentclient.Client{alpha, beta} {
			f := next(t, a, "msg")
			if f.Message.ID != posted.Message.ID || f.Message.Author.Kind != "user" || f.Message.Author.ID != "u_dana" {
				t.Fatalf("agent got %+v, want Dana's message", f)
			}
		}

		// The archiver copies all three into history, with the thread.
		var hist messagesResponse
		deadline := time.Now().Add(10 * time.Second)
		for {
			hist = decode[messagesResponse](t, h.get(dana.c, "/api/v1/orgs/org_acme/workspaces/"+relWS+"/messages", http.StatusOK))
			found := 0
			for _, m := range hist.Messages {
				if m.ID == sent.Message.ID || m.ID == reply.Message.ID || m.ID == posted.Message.ID {
					found++
				}
			}
			if found == 3 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("history has %d of 3 messages: %+v", found, hist.Messages)
			}
			time.Sleep(50 * time.Millisecond)
		}
		for _, m := range hist.Messages {
			if m.ID == reply.Message.ID && (m.ThreadID != sent.Message.ID || m.Seq != reply.Seq || m.Author.Label != "beta") {
				t.Errorf("archived reply = %+v", m)
			}
		}
		th, err := h.st.GetThread(ctx, "org_acme", sent.Message.ID)
		if err != nil || th.ReplyCount != 1 {
			t.Errorf("thread = %+v, %v; want 1 reply", th, err)
		}
		for _, a := range hist.Agents {
			switch a.AgentID {
			case betaT.Agent.ID:
				if !a.Online || a.AckedSeq != got.Seq {
					t.Errorf("beta = %+v, want online with acked_seq %d", a, got.Seq)
				}
			case alphaT.Agent.ID:
				if !a.Online || a.AckedSeq != 0 {
					t.Errorf("alpha = %+v, want online, nothing acked", a)
				}
			}
		}
	})
}

// expect2 reads one frame that must be one of two ops.
func (w *wsClient) expect2(a, b string) wsOut {
	w.t.Helper()
	out, err := w.recv(5 * time.Second)
	if err != nil {
		w.t.Fatalf("waiting for %q or %q: %v", a, b, err)
	}
	if out.Op != a && out.Op != b {
		w.t.Fatalf("got %+v, want %q or %q", out, a, b)
	}
	return out
}

// A reconnect resumes after the last acknowledged message: nothing
// acknowledged comes again, nothing unacknowledged is lost.
func TestAgentReconnectResumesFromLastAck(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana := h.person("u_dana")
		senderT, readerT := h.enroll(dana, relWS, "sender"), h.enroll(dana, relWS, "reader")
		reader := h.dialAgent(readerT)
		ctx := context.Background()

		var seqs []uint64
		for i := range 5 {
			res := h.agentPost(senderT, map[string]string{"body": fmt.Sprintf("m%d", i)})
			if res.StatusCode != http.StatusCreated {
				t.Fatalf("send = %d: %s", res.StatusCode, readAll(t, res))
			}
			seqs = append(seqs, decode[struct {
				Seq uint64 `json:"seq"`
			}](t, res).Seq)
		}
		for i := range 5 {
			if f := next(t, reader, "msg"); f.Seq != seqs[i] {
				t.Fatalf("message %d: seq %d, want %d", i, f.Seq, seqs[i])
			}
		}
		if err := reader.Ack(ctx, seqs[2]); err != nil { // acks m0..m2 at once
			t.Fatal(err)
		}
		// The ack is stored before the socket's feed stops, so a crash
		// right after it still counts it.
		time.Sleep(100 * time.Millisecond)
		reader.CloseNow()

		// Sent while the reader is away.
		h.agentPost(senderT, map[string]string{"body": "m5"})

		reader = h.dialAgent(readerT)
		if reader.Ready.ResumeFrom != seqs[2]+1 {
			t.Errorf("resume_from = %d, want %d", reader.Ready.ResumeFrom, seqs[2]+1)
		}
		var bodies []string
		for range 3 {
			f := next(t, reader, "msg")
			bodies = append(bodies, f.Message.Body)
			if f.Seq <= seqs[2] {
				t.Fatalf("an acknowledged message came again: %+v", f)
			}
		}
		if strings.Join(bodies, ",") != "m3,m4,m5" {
			t.Errorf("after reconnect got %v, want m3,m4,m5", bodies)
		}
	})
}

// Revoking a workspace token or the agent closes its socket at once and
// refuses it from then on, even during a rotation's grace period.
func TestRevokeDisconnectsAgent(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana := h.person("u_dana")
		ws := "/api/v1/orgs/org_acme/workspaces/" + relWS + "/agents/"

		a := h.enroll(dana, relWS, "revokee")
		conn := h.dialAgent(a)
		h.post(dana, ws+a.Agent.ID+"/token/revoke", nil, http.StatusOK)
		if code := closedWith(t, conn, 3*time.Second); code != int(closeUnauthenticated) {
			t.Errorf("close code = %d, want %d", code, closeUnauthenticated)
		}
		wantHTTPStatus(t, dialErr(h, a), http.StatusUnauthorized)
		if res := h.agentPost(a, map[string]string{"body": "x"}); res.StatusCode != http.StatusUnauthorized {
			t.Errorf("HTTP send after revoke = %d, want 401", res.StatusCode)
		}

		// Rotating issues a new workspace token that works; the old one doesn't.
		rot := decode[connectJSON](t, h.post(dana, ws+a.Agent.ID+"/token/rotate", nil, http.StatusOK))
		fresh := a
		fresh.WorkspaceToken = rot.WorkspaceToken
		conn = h.dialAgent(fresh)
		wantHTTPStatus(t, dialErr(h, a), http.StatusUnauthorized)

		// A second rotation leaves the old token working for its grace
		// period (TestRotatedTokenGracePeriod); revoking ends that at once.
		h.post(dana, ws+a.Agent.ID+"/token/rotate", nil, http.StatusOK)
		h.post(dana, ws+a.Agent.ID+"/token/revoke", nil, http.StatusOK)
		if code := closedWith(t, conn, 3*time.Second); code != int(closeUnauthenticated) {
			t.Errorf("revoked in its grace period: close code = %d, want %d", code, closeUnauthenticated)
		}
		wantHTTPStatus(t, dialErr(h, fresh), http.StatusUnauthorized)

		// Revoking the agent itself cuts off every workspace.
		c := h.enroll(dana, relWS, "agent-revokee")
		conn = h.dialAgent(c)
		h.post(dana, "/api/v1/orgs/org_acme/agents/"+c.Agent.ID+"/revoke", nil, http.StatusOK)
		if code := closedWith(t, conn, 3*time.Second); code != int(closeUnauthenticated) {
			t.Errorf("agent revoke: close code = %d, want %d", code, closeUnauthenticated)
		}
		wantHTTPStatus(t, dialErr(h, c), http.StatusUnauthorized)
	})
}

// Access changes made in the database (by other screens) take effect
// through AccessChanged: a workspace blocklist closes the socket, a
// membership without write refuses sends.
func TestAccessChangesApplyToLiveAgents(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana := h.person("u_dana")
		a := h.enroll(dana, relWS, "changer")
		conn := h.dialAgent(a)

		h.exec("UPDATE membership_access SET write = false WHERE member_id = '" + a.Agent.ID + "'")
		h.srv.AccessChanged(a.Agent.ID, "", "")
		res := h.agentPost(a, map[string]string{"body": "x"})
		if res.StatusCode != http.StatusForbidden || !strings.Contains(readAll(t, res), `"rule":"membership"`) {
			t.Errorf("send without write = %d, want 403 naming the membership rule", res.StatusCode)
		}
		if err := conn.Send(context.Background(), "w1", "x", ""); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		f, err := conn.Next(ctx)
		if err != nil || f.Op != "error" || f.Error != "forbidden" || f.Rule != store.RuleMembership {
			t.Errorf("socket send without write = %+v, %v", f, err)
		}

		h.exec("INSERT INTO workspace_settings_agent_blocklist (workspace_id, org_id, agent_id) VALUES ('" + relWS + "', 'org_acme', '" + a.Agent.ID + "')")
		h.srv.AccessChanged("", "", relWS)
		if code := closedWith(t, conn, 3*time.Second); code != int(closeForbidden) {
			t.Errorf("blocklisted: close code = %d, want %d", code, closeForbidden)
		}
		wantHTTPStatus(t, dialErr(h, a), http.StatusForbidden)
	})
}

// A second socket with the same tokens replaces the first.
func TestNewerAgentConnectionReplacesOlder(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		a := h.enroll(h.person("u_dana"), relWS, "twin")
		first := h.dialAgent(a)
		second := h.dialAgent(a)
		if code := closedWith(t, first, 3*time.Second); code != int(closeReplaced) {
			t.Errorf("close code = %d, want %d", code, closeReplaced)
		}
		h.agentPost(a, map[string]string{"body": "still here"})
		if f := next(t, second, "msg"); f.Message.Body != "still here" {
			t.Errorf("second got %+v", f)
		}
	})
}

// Bad or missing tokens are 401; tokens are checked as a pair.
func TestAgentAuthentication(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana := h.person("u_dana")
		a, other := h.enroll(dana, relWS, "one"), h.enroll(dana, relWS, "two")
		for name, c := range map[string]connectJSON{
			"no tokens":         {},
			"wrong agent token": {AgentToken: "dsp_agent_nope", WorkspaceToken: a.WorkspaceToken},
			"wrong ws token":    {AgentToken: a.AgentToken, WorkspaceToken: "dsp_ws_nope"},
			"mixed pair":        {AgentToken: a.AgentToken, WorkspaceToken: other.WorkspaceToken},
			"swapped":           {AgentToken: a.WorkspaceToken, WorkspaceToken: a.AgentToken},
		} {
			if res := h.agentPost(c, map[string]string{"body": "x"}); res.StatusCode != http.StatusUnauthorized {
				t.Errorf("%s: HTTP send = %d, want 401", name, res.StatusCode)
			}
			wantHTTPStatus(t, dialErr(h, c), http.StatusUnauthorized)
		}
		res := h.do(h.client(), http.MethodGet, "/agent/v1/me", nil, http.Header{
			"Authorization": {"Bearer " + a.AgentToken}, hdrWorkspaceToken: {a.WorkspaceToken}, hdrAgentID: {other.Agent.ID},
		})
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("mismatched X-Dispatch-Agent-Id = %d, want 401", res.StatusCode)
		}
		if res := h.agentPost(a, map[string]string{"body": " "}); res.StatusCode != http.StatusBadRequest {
			t.Errorf("empty body = %d, want 400", res.StatusCode)
		}
	})
}

// Only workspace admins and org admins can connect agents; people who
// can't see the workspace get 404, as everywhere in the API.
func TestEnrollmentPermissions(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		path := "/api/v1/orgs/org_acme/workspaces/" + relWS + "/agents"
		h.post(h.person("u_mia"), path, map[string]string{"label": "mias"}, http.StatusForbidden)
		h.post(h.person("u_sam"), path, map[string]string{"label": "sams"}, http.StatusNotFound)
		h.post(h.person("u_leo"), path, map[string]string{"label": "leos"}, http.StatusNotFound)
		ravi := h.person("u_ravi")
		h.enroll(ravi, relWS, "ravis")
		h.post(ravi, path, map[string]string{"label": "RAVIS"}, http.StatusConflict)         // names are unique, ignoring case
		h.post(ravi, path, map[string]string{"agent_id": "ag_builder"}, http.StatusConflict) // already a member
		h.post(ravi, path, map[string]string{"label": "x", "agent_id": "y"}, http.StatusBadRequest)
		h.post(h.person("u_mia"), "/api/v1/orgs/org_acme/agents/ag_builder/token/rotate", nil, http.StatusForbidden)

		// Tokens are stored hashed, never in plaintext.
		c := h.enroll(ravi, relWS, "hashed")
		var n int
		if err := h.st.DB().QueryRow("SELECT COUNT(*) FROM membership_access WHERE token_current_hash = '" + c.WorkspaceToken + "'").Scan(&n); err != nil || n != 0 {
			t.Errorf("plaintext workspace token found in the database (%d, %v)", n, err)
		}
		if err := h.st.DB().QueryRow("SELECT COUNT(*) FROM agent_profiles WHERE token_current_hash = '" + hashToken(c.AgentToken) + "'").Scan(&n); err != nil || n != 1 {
			t.Errorf("agent token hash rows = %d, %v; want 1", n, err)
		}
		// The enrollment is audited.
		if err := h.st.DB().QueryRow("SELECT COUNT(*) FROM audit_events WHERE subject_id = '" + c.Agent.ID + "' AND type = 'access'").Scan(&n); err != nil || n != 1 {
			t.Errorf("audit rows = %d, %v; want 1", n, err)
		}
	})
}

// Mia is a member of Release train; Sam isn't and can't watch it.
func TestWatchNeedsWorkspaceAccess(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		sam := h.mustDialWS(h.person("u_sam").c)
		sam.send(wsIn{Op: "watch", Org: "org_acme", Workspace: relWS})
		if f := sam.expect("error"); f.Error != "no such workspace" {
			t.Errorf("sam watch = %+v", f)
		}
		mia := h.mustDialWS(h.person("u_mia").c)
		mia.send(wsIn{Op: "watch", Org: "org_acme", Workspace: relWS})
		mia.expect("watching")
	})
}

// The proof that the send and deliver path does not use SQL: once an
// agent pair has been seen, the database is closed, and agents still send
// over the socket and HTTP and receive each other's messages.
func TestSendAndDeliverWithoutTheDatabase(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana := h.person("u_dana")
		aT, bT := h.enroll(dana, relWS, "solo-a"), h.enroll(dana, relWS, "solo-b")
		a, bb := h.dialAgent(aT), h.dialAgent(bT)

		if err := h.st.Close(); err != nil {
			t.Fatal(err)
		}
		if err := h.st.Ping(context.Background()); err == nil {
			t.Fatal("database still reachable after Close")
		}

		ctx := context.Background()
		if err := a.Send(ctx, "c1", "no SQL here", ""); err != nil {
			t.Fatal(err)
		}
		collect(t, a, "sent", "msg")
		if f := next(t, bb, "msg"); f.Message.Body != "no SQL here" {
			t.Fatalf("b got %+v", f)
		}
		if err := bb.Ack(ctx, 0); err != nil { // ignored: unknown seq
			t.Fatal(err)
		}
		res := h.agentPost(bT, map[string]string{"body": "over HTTP"})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("HTTP send with the database closed = %d: %s", res.StatusCode, readAll(t, res))
		}
		for {
			f := next(t, a, "msg")
			if f.Message.Body == "over HTTP" {
				break
			}
		}
	})
}

// The workspace management screens change agent access through
// their own endpoints; those take effect on live agents too.
func TestWorkspaceManagementAppliesToLiveAgents(t *testing.T) {
	storetest.Run(t, func(t *testing.T, b storetest.Backend) {
		h := seededHarness(t, b)
		dana := h.person("u_dana")
		ws := "/api/v1/orgs/org_acme/workspaces/" + relWS

		// Blocking an agent on the Access tab closes its socket.
		a := h.enroll(dana, relWS, "blockee")
		conn := h.dialAgent(a)
		res := h.do(dana.c, http.MethodPut, ws+"/access/blocklist/"+a.Agent.ID, nil, http.Header{csrfHeader: {dana.csrf}})
		if res.StatusCode != http.StatusOK {
			t.Fatalf("block = %d: %s", res.StatusCode, readAll(t, res))
		}
		if code := closedWith(t, conn, 3*time.Second); code != int(closeForbidden) {
			t.Errorf("blocked: close code = %d, want %d", code, closeForbidden)
		}

		// Removing an agent on the Members tab closes its socket.
		c := h.enroll(dana, relWS, "removee")
		conn = h.dialAgent(c)
		var mid string
		if err := h.st.DB().QueryRow("SELECT id FROM workspace_memberships WHERE member_id = '" + c.Agent.ID + "'").Scan(&mid); err != nil {
			t.Fatal(err)
		}
		res = h.do(dana.c, http.MethodDelete, ws+"/members/"+mid, nil, http.Header{csrfHeader: {dana.csrf}})
		if res.StatusCode != http.StatusNoContent {
			t.Fatalf("remove = %d: %s", res.StatusCode, readAll(t, res))
		}
		if code := closedWith(t, conn, 3*time.Second); code != int(closeUnauthenticated) {
			t.Errorf("removed: close code = %d, want %d", code, closeUnauthenticated)
		}

		// An agent added on the Members tab has no usable workspace token
		// until the Connect tab issues one.
		other := h.enroll(dana, "ws_sbx", "newcomer")
		res = h.do(dana.c, http.MethodPost, ws+"/members", map[string]any{"kind": "agent", "id": other.Agent.ID, "role": "member"}, http.Header{csrfHeader: {dana.csrf}})
		if res.StatusCode != http.StatusCreated {
			t.Fatalf("add member = %d: %s", res.StatusCode, readAll(t, res))
		}
		issued := decode[connectJSON](t, h.post(dana, ws+"/agents/"+other.Agent.ID+"/token/rotate", nil, http.StatusOK))
		here := h.dialAgent(connectJSON{AgentToken: other.AgentToken, WorkspaceToken: issued.WorkspaceToken})
		if here.Ready.Workspace.ID != relWS {
			t.Errorf("connected to %+v, want %s", here.Ready.Workspace, relWS)
		}
	})
}
