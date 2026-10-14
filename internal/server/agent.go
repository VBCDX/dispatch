package server

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/nats-io/nats.go"

	"github.com/VBCDX/dispatch/internal/agentauth"
	"github.com/VBCDX/dispatch/internal/bus"
	"github.com/VBCDX/dispatch/internal/messaging"
	"github.com/VBCDX/dispatch/internal/store"
)

// The agent surface: /agent/v1/. An agent authenticates every request with
// its agent token and one workspace token (see docs/agent-protocol.md);
// both are checked against the in-process access cache, never SQL, once
// the pair has been seen.

// Agent-facing headers, as in the mock.
const (
	hdrWorkspaceToken = "X-Dispatch-Workspace-Token"
	hdrAgentID        = "X-Dispatch-Agent-Id"
	hdrWorkspaceID    = "X-Dispatch-Workspace-Id"
)

// Close codes on the agent socket. 4xxx codes are Dispatch's own; the
// client should not reconnect after 4401, 4403 or 4409.
const (
	closeUnauthenticated websocket.StatusCode = 4401 // a token was revoked, rotated or expired
	closeForbidden       websocket.StatusCode = 4403 // access was removed (blocklist, read and write off)
	closeReplaced        websocket.StatusCode = 4409 // a newer connection with the same tokens took over
	closeReconnect       websocket.StatusCode = 4000 // access changed: reconnect to pick it up
)

// Agent socket limits.
const (
	agentMaxFrame       = 64 << 10
	agentMaxHTTPBody    = 64 << 10
	agentSendQueue      = 1024
	agentRecheckEvery   = 15 * time.Second
	agentReplaceWait    = 5 * time.Second
	agentFailLimit      = 50 // failed token checks per client address per window
	agentFailWindow     = 15 * time.Minute
	agentPublishTimeout = 5 * time.Second
)

// accessKey identifies a token pair by its hashes.
type accessKey struct{ agent, ws string }

// newToken returns prefix followed by 32 random base62 characters
// (about 190 bits).
func newToken(prefix string) string {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	b := []byte(prefix)
	var buf [1]byte
	for n := 0; n < 32; {
		_, _ = rand.Read(buf[:]) // never fails on supported platforms
		if buf[0] >= 248 {       // 248 = 4 × 62: keep every character equally likely
			continue
		}
		b = append(b, alphabet[buf[0]%62])
		n++
	}
	return string(b)
}

func issued(token, prefix string) store.IssuedToken {
	return store.IssuedToken{Hash: hashToken(token), Prefix: prefix, Last4: token[len(token)-4:]}
}

// agentRefusal is a 401/403 with the access rule that decided it.
type agentRefusal struct {
	status int
	code   string
	rule   string
	msg    string
}

func (e *agentRefusal) Error() string { return e.msg }

func writeRefusal(w http.ResponseWriter, e *agentRefusal) {
	writeJSON(w, e.status, map[string]string{"error": e.code, "rule": e.rule, "message": e.msg})
}

var errUnauthenticated = &agentRefusal{status: http.StatusUnauthorized, code: "unauthenticated", rule: "token",
	msg: "send a valid agent token (Authorization: Bearer dsp_agent_…) and workspace token (" + hdrWorkspaceToken + ": dsp_ws_…)"}

// agentKey reads the token pair from the request.
func agentKey(r *http.Request) (accessKey, bool) {
	agentTok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	wsTok := r.Header.Get(hdrWorkspaceToken)
	if !ok || !strings.HasPrefix(agentTok, store.AgentTokenPrefix) || !strings.HasPrefix(wsTok, store.WorkspaceTokenPrefix) ||
		len(agentTok) > 200 || len(wsTok) > 200 {
		return accessKey{}, false
	}
	return accessKey{agent: hashToken(agentTok), ws: hashToken(wsTok)}, true
}

// authAgent checks the request's tokens and returns the pair's access. It
// writes the error response and returns false when they fail.
func (s *Server) authAgent(w http.ResponseWriter, r *http.Request) (store.AgentAccess, accessKey, bool) {
	ip := s.clientIP(r)
	if ok, retry := s.agentFails.Allowed(ip); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())+1))
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many failed token checks; try again later")
		return store.AgentAccess{}, accessKey{}, false
	}
	k, ok := agentKey(r)
	var a store.AgentAccess
	var err error
	if ok {
		a, err = s.access.Get(r.Context(), k.agent, k.ws)
	}
	if ok && err == nil {
		if id := r.Header.Get(hdrAgentID); id != "" && id != a.AgentID {
			ok = false
		}
		if id := r.Header.Get(hdrWorkspaceID); id != "" && id != a.WorkspaceID {
			ok = false
		}
	}
	switch {
	case !ok || errors.Is(err, agentauth.ErrUnauthenticated):
		s.agentFails.Fail(ip)
		writeRefusal(w, errUnauthenticated)
		return store.AgentAccess{}, accessKey{}, false
	case err != nil:
		s.log.Error("agent access lookup failed", "err", err)
		writeError(w, http.StatusServiceUnavailable, "unavailable", "access check unavailable; try again")
		return store.AgentAccess{}, accessKey{}, false
	case a.Refused != "":
		writeRefusal(w, refused(a.Refused))
		return store.AgentAccess{}, accessKey{}, false
	}
	return a, k, true
}

func refused(rule string) *agentRefusal {
	return &agentRefusal{status: http.StatusForbidden, code: "forbidden", rule: rule, msg: "refused by the " + rule}
}

// sendIn is a message an agent (or a person) sends.
type sendIn struct {
	Body     string          `json:"body"`
	ThreadID string          `json:"thread_id,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
}

// agentSend checks the pair may write, from the cache, and publishes.
func (s *Server) agentSend(ctx context.Context, k accessKey, in sendIn) (messaging.Message, uint64, error) {
	a, err := s.access.Get(ctx, k.agent, k.ws)
	switch {
	case errors.Is(err, agentauth.ErrUnauthenticated):
		return messaging.Message{}, 0, errUnauthenticated
	case err != nil:
		return messaging.Message{}, 0, err
	case a.Refused != "":
		return messaging.Message{}, 0, refused(a.Refused)
	case !a.Write:
		return messaging.Message{}, 0, refused(a.WriteRule)
	}
	m, err := messaging.NewMessage(a.OrgID, a.WorkspaceID,
		messaging.Author{Kind: "agent", ID: a.AgentID, Label: a.AgentLabel}, in.Body, in.Payload, in.ThreadID, s.now())
	if err != nil {
		return messaging.Message{}, 0, &agentRefusal{status: http.StatusBadRequest, code: "invalid", msg: err.Error()}
	}
	pctx, cancel := context.WithTimeout(ctx, agentPublishTimeout)
	defer cancel()
	seq, _, err := s.hub.Publish(pctx, m)
	return m, seq, err
}

// POST /agent/v1/messages: send without holding a socket.
func (s *Server) handleAgentSend(w http.ResponseWriter, r *http.Request) {
	_, k, ok := s.authAgent(w, r)
	if !ok {
		return
	}
	var in sendIn
	if err := readJSONMax(w, r, &in, agentMaxHTTPBody); err != nil {
		writeError(w, http.StatusBadRequest, "invalid", err.Error())
		return
	}
	m, seq, err := s.agentSend(r.Context(), k, in)
	if err != nil {
		s.writeSendError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"message": m, "seq": seq})
}

func (s *Server) writeSendError(w http.ResponseWriter, err error) {
	var ref *agentRefusal
	if errors.As(err, &ref) {
		writeRefusal(w, ref)
		return
	}
	s.log.Error("agent send failed", "err", err)
	writeError(w, http.StatusServiceUnavailable, "unavailable", "send failed; try again")
}

// GET /agent/v1/me: who the tokens belong to and what they may do.
func (s *Server) handleAgentMe(w http.ResponseWriter, r *http.Request) {
	a, _, ok := s.authAgent(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, agentReady(a, 0))
}

type agentReadyJSON struct {
	Op        string `json:"op,omitempty"`
	Agent     idName `json:"agent"`
	Workspace idName `json:"workspace"`
	Read      bool   `json:"read"`
	Write     bool   `json:"write"`
	// ResumeFrom is the first stream sequence this connection may deliver:
	// everything before it was acknowledged.
	ResumeFrom uint64 `json:"resume_from,omitempty"`
}

type idName struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func agentReady(a store.AgentAccess, from uint64) agentReadyJSON {
	return agentReadyJSON{
		Agent: idName{a.AgentID, a.AgentLabel}, Workspace: idName{a.WorkspaceID, a.WorkspaceName},
		Read: a.Read, Write: a.Write, ResumeFrom: from,
	}
}

/* ---------------------------------------------------------------------- */
/* The agent socket                                                        */
/* ---------------------------------------------------------------------- */

// Frames an agent sends:
//
//	{"op":"send","id":"c1","body":"…","thread_id":"msg_…","payload":{…}}
//	{"op":"ack","seq":42}        everything delivered up to 42 is handled
//	{"op":"ping","id":"p1"}
//
// Frames the server sends:
//
//	{"op":"ready","agent":{…},"workspace":{…},"read":true,"write":true,"resume_from":40}
//	{"op":"msg","seq":42,"message":{…}}
//	{"op":"sent","id":"c1","seq":43,"message":{…}}
//	{"op":"pong","id":"p1"}
//	{"op":"error","id":"c1","error":"forbidden","rule":"membership","detail":"…"}
type agentIn struct {
	Op string `json:"op"`
	ID string `json:"id,omitempty"`
	sendIn
	Seq uint64 `json:"seq,omitempty"`
}

type agentOut struct {
	Op      string             `json:"op"`
	ID      string             `json:"id,omitempty"`
	Seq     uint64             `json:"seq,omitempty"`
	Message *messaging.Message `json:"message,omitempty"`
	Error   string             `json:"error,omitempty"`
	Rule    string             `json:"rule,omitempty"`
	Detail  string             `json:"detail,omitempty"`
}

// agentConn is one live agent socket.
type agentConn struct {
	srv    *Server
	key    accessKey
	access store.AgentAccess // as it was on connect
	conn   *websocket.Conn
	out    chan []byte
	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{} // closed once the connection is fully torn down
	// stopping is closed by shut: the handler stops delivering at once,
	// without waiting for the agent to answer the close handshake.
	stopping chan struct{}

	mu          sync.Mutex
	closeCode   websocket.StatusCode
	closeReason string
	expiry      *time.Timer // re-checks when a token stops working
}

// shut ends the connection with code and reason; the first call wins.
// It sends a close frame, so the agent learns why. (Cancelling a read's
// context would drop the socket without one.)
func (c *agentConn) shut(code websocket.StatusCode, reason string) {
	c.mu.Lock()
	first := c.closeCode == 0
	if first {
		c.closeCode, c.closeReason = code, reason
	}
	c.mu.Unlock()
	if first {
		close(c.stopping)
		go c.conn.Close(code, reason)
	}
}

func (c *agentConn) send(frame []byte) {
	select {
	case c.out <- frame:
	default:
		c.shut(websocket.StatusPolicyViolation, "slow consumer")
	}
}

func (c *agentConn) sendJSON(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		c.srv.log.Warn("encode agent frame failed", "err", err)
		return
	}
	c.send(b)
}

func (c *agentConn) sendErr(id string, err error) {
	var ref *agentRefusal
	if errors.As(err, &ref) {
		c.sendJSON(agentOut{Op: "error", ID: id, Error: ref.code, Rule: ref.rule, Detail: ref.msg})
		return
	}
	c.srv.log.Error("agent send failed", "err", err)
	c.sendJSON(agentOut{Op: "error", ID: id, Error: "unavailable", Detail: "send failed; try again"})
}

// recheck re-reads the pair's access (from the cache, which a change has
// just invalidated) and ends the connection if it no longer stands.
func (c *agentConn) recheck() {
	ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
	defer cancel()
	a, err := c.srv.access.Get(ctx, c.key.agent, c.key.ws)
	switch {
	case errors.Is(err, agentauth.ErrUnauthenticated):
		c.shut(closeUnauthenticated, "token revoked or expired")
	case err != nil:
		// The database is unreachable: keep the connection on the access it had.
	case a.Refused != "":
		c.shut(closeForbidden, "refused by the "+a.Refused)
	case !a.Read && !a.Write:
		c.shut(closeForbidden, "no read or write access")
	case a.Read != c.access.Read:
		c.shut(closeReconnect, "access changed; reconnect")
	default:
		c.armExpiry(a)
	}
}

// armExpiry re-checks the connection the moment a token it uses stops
// working, such as an old token at the end of its grace period, rather
// than at the next periodic re-check.
func (c *agentConn) armExpiry(a store.AgentAccess) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.expiry != nil {
		c.expiry.Stop()
		c.expiry = nil
	}
	if a.ExpiresAt == nil || c.closeCode != 0 {
		return
	}
	c.expiry = time.AfterFunc(max(time.Until(*a.ExpiresAt), 0)+10*time.Millisecond, c.recheck)
}

// agentRegistry holds this node's live agent sockets, one per membership.
type agentRegistry struct {
	mu    sync.Mutex
	conns map[string]*agentConn // by membership ID
}

// claim registers c and returns the connection it replaces, if any.
func (r *agentRegistry) claim(c *agentConn) *agentConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	old := r.conns[c.access.MembershipID]
	r.conns[c.access.MembershipID] = c
	return old
}

func (r *agentRegistry) release(c *agentConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conns[c.access.MembershipID] == c {
		delete(r.conns, c.access.MembershipID)
	}
}

func (r *agentRegistry) all() []*agentConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*agentConn, 0, len(r.conns))
	for _, c := range r.conns {
		out = append(out, c)
	}
	return out
}

func (r *agentRegistry) online(membershipID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.conns[membershipID]
	return ok
}

// GET /agent/v1/ws
func (s *Server) handleAgentWS(w http.ResponseWriter, r *http.Request) {
	a, k, ok := s.authAgent(w, r)
	if !ok {
		return
	}
	if !a.Read && !a.Write {
		writeRefusal(w, refused(a.ReadRule))
		return
	}
	// Agents authenticate with tokens in headers, which a browser page
	// cannot set, and no cookie is read here: any Origin is fine.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(agentMaxFrame)

	ctx, cancel := context.WithCancel(context.Background())
	c := &agentConn{
		srv: s, key: k, access: a, conn: conn, out: make(chan []byte, agentSendQueue),
		ctx: ctx, cancel: cancel, done: make(chan struct{}), stopping: make(chan struct{}),
	}
	if old := s.agents.claim(c); old != nil {
		old.shut(closeReplaced, "replaced by a newer connection")
		select {
		case <-old.done:
		case <-time.After(agentReplaceWait):
		}
	}
	defer close(c.done)
	defer s.agents.release(c)
	defer cancel()

	go c.writeLoop()
	c.armExpiry(a)
	defer c.armExpiry(store.AgentAccess{})

	ready := make(chan struct{})
	var feed *messaging.Feed
	if a.Read {
		feed, err = s.hub.Subscribe(ctx, a.MembershipID, a.WorkspaceID, a.AddedAt,
			func(seq uint64, data []byte) {
				<-ready
				frame := make([]byte, 0, len(data)+40)
				frame = append(frame, `{"op":"msg","seq":`...)
				frame = strconv.AppendUint(frame, seq, 10)
				frame = append(frame, `,"message":`...)
				frame = append(frame, data...)
				frame = append(frame, '}')
				c.send(frame)
			},
			func(seq uint64) {
				s.hub.PublishEvent(a.WorkspaceID, messaging.Event{Kind: "ack", AgentID: a.AgentID, Seq: seq})
			})
		if err != nil {
			s.log.Error("agent subscribe failed", "membership", a.MembershipID, "err", err)
			close(ready)
			conn.Close(websocket.StatusInternalError, "subscribe failed")
			return
		}
	}
	from := uint64(0)
	if feed != nil {
		from = feed.From
	}
	hello := agentReady(a, from)
	hello.Op = "ready"
	c.sendJSON(hello)
	close(ready)

	online, offline := true, false
	s.hub.PublishEvent(a.WorkspaceID, messaging.Event{Kind: "presence", AgentID: a.AgentID, Online: &online})
	defer s.hub.PublishEvent(a.WorkspaceID, messaging.Event{Kind: "presence", AgentID: a.AgentID, Online: &offline})

	go func() {
		t := time.NewTicker(agentRecheckEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.recheck()
			}
		}
	}()

	readErr := make(chan error, 1)
	go func() { readErr <- c.readLoop(feed) }()
	select {
	case err = <-readErr:
	case <-c.stopping:
	}
	cancel()
	if feed != nil {
		feed.Stop()
	}
	c.mu.Lock()
	shut := c.closeCode != 0
	c.mu.Unlock()
	switch {
	case shut:
		// shut's close handshake is under way.
	case websocket.CloseStatus(err) != -1:
		conn.Close(websocket.StatusNormalClosure, "")
	default:
		conn.CloseNow()
	}
}

func (c *agentConn) writeLoop() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case frame := <-c.out:
			wctx, cancel := context.WithTimeout(c.ctx, wsWriteTimeout)
			err := c.conn.Write(wctx, websocket.MessageText, frame)
			cancel()
			if err != nil {
				c.conn.CloseNow() // ends the read loop
				return
			}
		}
	}
}

// readLoop runs until the socket closes. Its reads take no deadline: a
// shut or a failed write closes the socket, which ends the read.
func (c *agentConn) readLoop(feed *messaging.Feed) error {
	for {
		typ, raw, err := c.conn.Read(context.Background())
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			c.sendJSON(agentOut{Op: "error", Error: "invalid", Detail: "send JSON text frames"})
			continue
		}
		var in agentIn
		if err := json.Unmarshal(raw, &in); err != nil {
			c.sendJSON(agentOut{Op: "error", Error: "invalid", Detail: "invalid JSON"})
			continue
		}
		switch in.Op {
		case "send":
			m, seq, err := c.srv.agentSend(c.ctx, c.key, in.sendIn)
			if err != nil {
				c.sendErr(in.ID, err)
				continue
			}
			c.sendJSON(agentOut{Op: "sent", ID: in.ID, Seq: seq, Message: &m})
		case "ack":
			if feed == nil || !feed.Ack(in.Seq) {
				c.sendJSON(agentOut{Op: "error", ID: in.ID, Seq: in.Seq, Error: "invalid", Detail: "no delivered, unacknowledged message has that seq"})
			}
		case "ping":
			c.sendJSON(agentOut{Op: "pong", ID: in.ID})
		default:
			c.sendJSON(agentOut{Op: "error", ID: in.ID, Error: "invalid", Detail: "unknown op"})
		}
	}
}

/* ---------------------------------------------------------------------- */
/* Access changes                                                          */
/* ---------------------------------------------------------------------- */

// accessChange names what changed; empty fields match nothing. UserID
// names a person whose access changed: it re-checks their browser
// sockets' watches, and matches no agent.
type accessChange struct {
	Origin       string `json:"origin"` // the node that made the change, which applied it already
	AgentID      string `json:"agent_id,omitempty"`
	MembershipID string `json:"membership_id,omitempty"`
	WorkspaceID  string `json:"workspace_id,omitempty"`
	UserID       string `json:"user_id,omitempty"`
}

func (ch accessChange) matches(a store.AgentAccess) bool {
	return (ch.AgentID != "" && ch.AgentID == a.AgentID) ||
		(ch.MembershipID != "" && ch.MembershipID == a.MembershipID) ||
		(ch.WorkspaceID != "" && ch.WorkspaceID == a.WorkspaceID)
}

// AccessChanged drops this node's cached answers for the change before it
// returns, so the next request here sees it, then tells every other node
// to do the same. Each re-checks the live connections affected. Anything
// that changes agent tokens, memberships, read/write grants, blocklists or
// agent filters must call it after committing.
func (s *Server) AccessChanged(agentID, membershipID, workspaceID string) {
	s.publishAccessChange(accessChange{Origin: s.nodeID, AgentID: agentID, MembershipID: membershipID, WorkspaceID: workspaceID})
}

// UserAccessChanged re-checks, on every node, what a person's browser
// sockets are watching: anything they may no longer see stops at once.
// Removing someone from a workspace or the org, suspending them or taking
// away their org admin role must call it after committing.
func (s *Server) UserAccessChanged(userID string) {
	s.publishAccessChange(accessChange{Origin: s.nodeID, UserID: userID})
}

func (s *Server) publishAccessChange(ch accessChange) {
	s.applyAccessChange(ch)
	data, _ := json.Marshal(ch)
	if err := s.bus.Conn().Publish(bus.AccessChangedSubject, data); err != nil {
		s.log.Error("publish access change failed; other nodes catch up on their refresh", "err", err)
	}
}

func (s *Server) applyAccessChange(ch accessChange) {
	if ch.AgentID != "" || ch.MembershipID != "" || ch.WorkspaceID != "" {
		s.access.Invalidate(ch.matches)
		for _, c := range s.agents.all() {
			if ch.matches(c.access) {
				go c.recheck()
			}
		}
	}
	for _, c := range s.browsers.all() {
		if (ch.UserID != "" && c.user == ch.UserID) || (ch.WorkspaceID != "" && c.watching(ch.WorkspaceID)) {
			go c.recheckWatches(c.ctx)
		}
	}
}

func (s *Server) subscribeAccessChanges() error {
	_, err := s.bus.Conn().Subscribe(bus.AccessChangedSubject, func(m *nats.Msg) {
		var ch accessChange
		if json.Unmarshal(m.Data, &ch) == nil && ch.Origin != s.nodeID {
			s.applyAccessChange(ch)
		}
	})
	return err
}

// CloseAgentConnections ends every agent socket, for shutdown. Agents
// reconnect (to this node once it is back, or another) and resume.
func (s *Server) CloseAgentConnections() {
	for _, c := range s.agents.all() {
		c.shut(websocket.StatusGoingAway, "server shutting down")
	}
}
