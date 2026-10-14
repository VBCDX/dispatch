package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/VBCDX/dispatch/internal/messaging"
	"github.com/VBCDX/dispatch/internal/store"
)

// The web app's side of messaging, under /api/v1/ with a browser session:
// a workspace's message history and posting to it, and the Connect tab's
// agent enrollment and token management. These read SQL to authorize the
// person; the agent path (agent.go) does not.

func (s *Server) routesMessages(mux *http.ServeMux) {
	const ws = "/api/v1/orgs/{org}/workspaces/{ws}"
	mux.HandleFunc("GET "+ws+"/messages", s.requireSession(s.handleListMessages))
	mux.HandleFunc("POST "+ws+"/messages", s.requireSession(s.handlePostMessage))
	mux.HandleFunc("GET "+ws+"/agents", s.requireSession(s.handleListWorkspaceAgents))
	mux.HandleFunc("POST "+ws+"/agents", s.requireSession(s.handleEnrollAgent))
	mux.HandleFunc("POST "+ws+"/agents/{agent}/token/rotate", s.requireSession(s.handleRotateWorkspaceToken))
	mux.HandleFunc("POST "+ws+"/agents/{agent}/token/revoke", s.requireSession(s.handleRevokeWorkspaceToken))
	mux.HandleFunc("POST /api/v1/orgs/{org}/agents/{agent}/token/rotate", s.requireSession(s.handleRotateAgentToken))
	mux.HandleFunc("POST /api/v1/orgs/{org}/agents/{agent}/revoke", s.requireSession(s.handleRevokeAgent))
}

// loadWorkspace resolves {org} and {ws} for the caller, writing a 404 (or
// 500) and returning false unless they can see the workspace.
func (s *Server) loadWorkspace(w http.ResponseWriter, r *http.Request) (orgView, store.Workspace, bool) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return v, store.Workspace{}, false
	}
	ws, err := s.store.GetWorkspace(r.Context(), v.orgID, r.PathValue("ws"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && (ws.Status != statusActive || !v.canSee(ws.ID))) {
		writeError(w, http.StatusNotFound, "not_found", "no such workspace")
		return v, store.Workspace{}, false
	}
	if err != nil {
		s.internalError(w, "get workspace", err)
		return v, store.Workspace{}, false
	}
	return v, ws, true
}

// userCanSeeWorkspace applies the read API's rule outside a request: an
// active member of an active org who is an org admin or a member of the
// active workspace.
func (s *Server) userCanSeeWorkspace(ctx context.Context, userID, orgID, wsID string) (bool, error) {
	if orgID == "" || wsID == "" {
		return false, nil
	}
	m, err := s.store.GetOrgMembership(ctx, orgID, userID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && m.Status != statusActive) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	o, err := s.store.GetOrg(ctx, orgID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && o.Status != statusActive) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	ws, err := s.store.GetWorkspace(ctx, orgID, wsID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && ws.Status != statusActive) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if m.Role == store.RoleOwner || m.Role == store.RoleUserAdmin {
		return true, nil
	}
	mine, err := s.store.ListMemberships(ctx, orgID, "user", userID)
	if err != nil {
		return false, err
	}
	for _, wm := range mine {
		if wm.WorkspaceID == wsID {
			return true, nil
		}
	}
	return false, nil
}

type messageJSON struct {
	ID        string           `json:"id"`
	Author    messaging.Author `json:"author"`
	Body      string           `json:"body"`
	Payload   json.RawMessage  `json:"payload,omitempty"`
	ThreadID  string           `json:"thread_id,omitempty"`
	CreatedAt time.Time        `json:"created_at"`
	Seq       uint64           `json:"seq,omitempty"`
}

type agentMemberJSON struct {
	AgentID        string     `json:"agent_id"`
	Label          string     `json:"label"`
	Status         string     `json:"status"`
	Read           bool       `json:"read"`
	Write          bool       `json:"write"`
	TokenPrefix    string     `json:"token_prefix"`
	TokenLast4     string     `json:"token_last4"`
	TokenIssuedAt  time.Time  `json:"token_issued_at"`
	TokenRevokedAt *time.Time `json:"token_revoked_at"`
	AddedAt        time.Time  `json:"added_at"`
	Online         bool       `json:"online"`
	// AckedSeq is the last stream sequence the agent acknowledged in this
	// workspace: every message with seq <= AckedSeq is acknowledged.
	AckedSeq uint64 `json:"acked_seq"`
}

func (s *Server) agentMembers(ctx context.Context, orgID, wsID string) ([]agentMemberJSON, error) {
	ms, err := s.store.ListAgentMembers(ctx, orgID, wsID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(ms))
	for _, m := range ms {
		ids = append(ids, m.MembershipID)
	}
	floors := s.hub.AckFloors(ctx, ids)
	out := make([]agentMemberJSON, 0, len(ms))
	for _, m := range ms {
		out = append(out, agentMemberJSON{
			AgentID: m.AgentID, Label: m.Label, Status: m.AgentStatus, Read: m.Read, Write: m.Write,
			TokenPrefix: m.TokenPrefix, TokenLast4: m.TokenLast4, TokenIssuedAt: m.TokenIssuedAt,
			TokenRevokedAt: m.TokenRevokedAt, AddedAt: m.AddedAt,
			Online: s.agents.online(m.MembershipID), AckedSeq: floors[m.MembershipID],
		})
	}
	return out, nil
}

// GET .../messages?limit=&before=: newest first, replies included.
func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.loadWorkspace(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	f := store.MessageFilter{Limit: 100}
	if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil {
		f.Limit = n
	}
	if b := r.URL.Query().Get("before"); b != "" {
		t, err := time.Parse(time.RFC3339Nano, b)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid", "before must be an RFC 3339 time")
			return
		}
		// before_id (optional) is the cursor's tie-break: pass the last row's
		// id together with its created_at so rows sharing that timestamp are
		// not skipped at a page boundary.
		f.Before = &store.Cursor{At: t, ID: r.URL.Query().Get("before_id")}
	}
	msgs, err := s.store.ListMessages(ctx, v.orgID, ws.ID, f)
	if err != nil {
		s.internalError(w, "list messages", err)
		return
	}
	labels, err := s.authorLabels(ctx, v.orgID)
	if err != nil {
		s.internalError(w, "author names", err)
		return
	}
	out := make([]messageJSON, 0, len(msgs))
	for _, m := range msgs {
		body := m.Body.Text
		if m.Body.Storage == "blob" {
			body = m.Body.Preview
		}
		label := labels[m.Author.Kind+":"+m.Author.ID]
		if label == "" && m.Author.Kind == "listener" {
			label = "listener"
		}
		out = append(out, messageJSON{
			ID: m.ID, Author: messaging.Author{Kind: m.Author.Kind, ID: m.Author.ID, Label: label},
			Body: body, Payload: m.Payload, ThreadID: m.ThreadRootID, CreatedAt: m.CreatedAt, Seq: m.StreamSeq,
		})
	}
	agents, err := s.agentMembers(ctx, v.orgID, ws.ID)
	if err != nil {
		s.internalError(w, "list agents", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"messages": out, "agents": agents,
		"can_post": v.orgAdmin || v.write[ws.ID], "can_admin": v.canAdmin(ws.ID),
	})
}

// authorLabels maps "user:<id>", "agent:<id>" and "listener:<id>" to display names.
func (s *Server) authorLabels(ctx context.Context, orgID string) (map[string]string, error) {
	out := map[string]string{}
	people, err := s.store.ListOrgMembers(ctx, orgID)
	if err != nil {
		return nil, err
	}
	for _, p := range people {
		out["user:"+p.UserID] = p.Name
	}
	agents, err := s.store.ListAgents(ctx, orgID)
	if err != nil {
		return nil, err
	}
	for _, a := range agents {
		out["agent:"+a.ID] = a.Label
	}
	listeners, err := s.store.ListenerNames(ctx, orgID)
	if err != nil {
		return nil, err
	}
	for id, name := range listeners {
		out["listener:"+id] = name
	}
	return out, nil
}

// POST .../messages: a person posts to the workspace (or a thread).
func (s *Server) handlePostMessage(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.loadWorkspace(w, r)
	if !ok {
		return
	}
	if !v.orgAdmin && !v.write[ws.ID] {
		writeError(w, http.StatusForbidden, "forbidden", "you can read this workspace but not post to it")
		return
	}
	var in sendIn
	if err := readJSONMax(w, r, &in, agentMaxHTTPBody); err != nil {
		writeError(w, http.StatusBadRequest, "invalid", err.Error())
		return
	}
	u := fromContext(r.Context()).user
	m, err := messaging.NewMessage(v.orgID, ws.ID, messaging.Author{Kind: "user", ID: u.ID, Label: u.Name},
		in.Body, in.Payload, in.ThreadID, s.now())
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), agentPublishTimeout)
	defer cancel()
	seq, _, err := s.hub.Publish(ctx, m)
	if err != nil {
		s.log.Error("publish failed", "err", err)
		writeError(w, http.StatusServiceUnavailable, "unavailable", "send failed; try again")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"message": m, "seq": seq})
}

// GET .../agents: the Connect tab's agent members.
func (s *Server) handleListWorkspaceAgents(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.loadWorkspace(w, r)
	if !ok {
		return
	}
	agents, err := s.agentMembers(r.Context(), v.orgID, ws.ID)
	if err != nil {
		s.internalError(w, "list agents", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": agents, "can_admin": v.canAdmin(ws.ID), "server_url": s.cfg.PublicURL.String()})
}

type enrollIn struct {
	AgentID     string `json:"agent_id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// connectJSON is the one-time answer carrying plaintext tokens.
type connectJSON struct {
	Agent          idName `json:"agent"`
	Workspace      idName `json:"workspace"`
	AgentToken     string `json:"agent_token,omitempty"`
	WorkspaceToken string `json:"workspace_token,omitempty"`
	ServerURL      string `json:"server_url"`
	// OldTokenValidUntil is set on a rotation whose old token keeps
	// working for a while (store.TokenGrace).
	OldTokenValidUntil *time.Time `json:"old_token_valid_until,omitempty"`
}

// POST .../agents: register a new agent (label) or add an existing one
// (agent_id) and issue its workspace token. Tokens are returned once.
func (s *Server) handleEnrollAgent(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.loadWorkspace(w, r)
	if !ok {
		return
	}
	if !v.canAdmin(ws.ID) {
		writeError(w, http.StatusForbidden, "forbidden", "only workspace admins and organization admins can connect agents")
		return
	}
	var in enrollIn
	if err := readJSON(w, r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid", err.Error())
		return
	}
	in.Label = strings.TrimSpace(in.Label)
	e := store.EnrollAgent{
		OrgID: v.orgID, WorkspaceID: ws.ID, AgentID: in.AgentID, Label: in.Label,
		Description: strings.TrimSpace(in.Description), By: actor(r), Now: s.now(),
	}
	out := connectJSON{Workspace: idName{ws.ID, ws.Name}, ServerURL: s.cfg.PublicURL.String()}
	switch {
	case (in.AgentID == "") == (in.Label == ""):
		writeError(w, http.StatusBadRequest, "invalid", "give either label (a new agent) or agent_id (an existing one)")
		return
	case in.AgentID == "" && !validAgentLabel(in.Label):
		writeError(w, http.StatusBadRequest, "invalid", "label must be 1 to 64 letters, digits, spaces, '.', '_' or '-'")
		return
	case in.AgentID == "":
		out.AgentToken = newToken(store.AgentTokenPrefix)
		t := issued(out.AgentToken, store.AgentTokenPrefix)
		e.AgentToken = &t
	}
	out.WorkspaceToken = newToken(store.WorkspaceTokenPrefix)
	e.WSToken = issued(out.WorkspaceToken, store.WorkspaceTokenPrefix)
	res, err := s.store.EnrollAgentInWorkspace(r.Context(), e)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "no such agent")
		return
	case errors.Is(err, store.ErrExists):
		writeError(w, http.StatusConflict, "exists", "an agent with that name already exists; add it by agent_id")
		return
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "member", "that agent is already a member; rotate its workspace token instead")
		return
	case err != nil:
		s.internalError(w, "enroll agent", err)
		return
	}
	out.Agent = idName{res.AgentID, res.AgentLabel}
	writeJSON(w, http.StatusCreated, out)
}

func validAgentLabel(l string) bool {
	if l == "" || len(l) > 64 {
		return false
	}
	for _, c := range l {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune(" ._-", c)) {
			return false
		}
	}
	return true
}

func (s *Server) handleRotateWorkspaceToken(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.loadWorkspace(w, r)
	if !ok {
		return
	}
	if !v.canAdmin(ws.ID) {
		writeError(w, http.StatusForbidden, "forbidden", "only workspace admins and organization admins can rotate tokens")
		return
	}
	agentID := r.PathValue("agent")
	tok := newToken(store.WorkspaceTokenPrefix)
	mid, graceUntil, err := s.store.RotateWorkspaceToken(r.Context(), v.orgID, ws.ID, agentID, issued(tok, store.WorkspaceTokenPrefix), actor(r), s.now(), 0)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "that agent is not a member of this workspace")
		return
	}
	if err != nil {
		s.internalError(w, "rotate token", err)
		return
	}
	// A socket on the old token stays up until its grace period ends.
	s.AccessChanged("", mid, "")
	writeJSON(w, http.StatusOK, connectJSON{
		Agent: idName{ID: agentID}, Workspace: idName{ws.ID, ws.Name}, WorkspaceToken: tok, ServerURL: s.cfg.PublicURL.String(),
		OldTokenValidUntil: graceUntil,
	})
}

func (s *Server) handleRevokeWorkspaceToken(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.loadWorkspace(w, r)
	if !ok {
		return
	}
	if !v.canAdmin(ws.ID) {
		writeError(w, http.StatusForbidden, "forbidden", "only workspace admins and organization admins can revoke tokens")
		return
	}
	mid, err := s.store.RevokeWorkspaceToken(r.Context(), v.orgID, ws.ID, r.PathValue("agent"), actor(r), s.now(), 0)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "that agent is not a member of this workspace")
		return
	}
	if err != nil {
		s.internalError(w, "revoke token", err)
		return
	}
	s.AccessChanged("", mid, "")
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

// POST .../agents/{agent}/token/rotate: org Owners and userAdmins only,
// because the agent token works in every workspace the agent is in.
func (s *Server) handleRotateAgentToken(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	if !v.orgAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "only organization Owners and user admins can rotate an agent token")
		return
	}
	agentID := r.PathValue("agent")
	tok := newToken(store.AgentTokenPrefix)
	graceUntil, err := s.store.RotateAgentToken(r.Context(), v.orgID, agentID, issued(tok, store.AgentTokenPrefix), actor(r), s.now(), 0)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "no such active agent")
		return
	}
	if err != nil {
		s.internalError(w, "rotate agent token", err)
		return
	}
	s.AccessChanged(agentID, "", "")
	writeJSON(w, http.StatusOK, map[string]any{"agent": idName{ID: agentID}, "agent_token": tok, "old_token_valid_until": graceUntil})
}

// POST .../agents/{agent}/revoke: the agent's token stops working
// everywhere, and its live connections close.
func (s *Server) handleRevokeAgent(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	if !v.orgAdmin {
		writeError(w, http.StatusForbidden, "forbidden", "only organization Owners and user admins can revoke an agent")
		return
	}
	agentID := r.PathValue("agent")
	err := s.store.RevokeAgent(r.Context(), v.orgID, agentID, actor(r), s.now(), 0)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "no such agent")
		return
	}
	if err != nil {
		s.internalError(w, "revoke agent", err)
		return
	}
	s.AccessChanged(agentID, "", "")
	writeJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}
