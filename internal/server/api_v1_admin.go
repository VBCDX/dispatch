package server

import (
	"cmp"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/VBCDX/dispatch/internal/store"
)

// Workspace and people management under /api/v1/: workspaces, their
// members, access and audit; the org's people and agents; the org audit.
//
// Every write needs the session's CSRF token (requireSession checks it)
// and is checked against the caller's role in the org on the server. A
// write the caller may not make is 403 when they can see the resource and
// 404 when they can't, so a forbidden ID reads like a missing one.

func (s *Server) routesV1Admin(mux *http.ServeMux) {
	const org, ws = "/api/v1/orgs/{org}", "/api/v1/orgs/{org}/workspaces/{ws}"
	mux.HandleFunc("POST "+org+"/workspaces", s.requireSession(s.handleCreateWorkspace))
	mux.HandleFunc("PATCH "+ws, s.requireSession(s.handleUpdateWorkspace))
	mux.HandleFunc("DELETE "+ws, s.requireSession(s.handleDeleteWorkspace))

	mux.HandleFunc("GET "+ws+"/members", s.requireSession(s.handleListMembers))
	mux.HandleFunc("POST "+ws+"/members", s.requireSession(s.handleAddMember))
	mux.HandleFunc("PATCH "+ws+"/members/{member}", s.requireSession(s.handleUpdateMember))
	mux.HandleFunc("DELETE "+ws+"/members/{member}", s.requireSession(s.handleRemoveMember))

	mux.HandleFunc("GET "+ws+"/access", s.requireSession(s.handleGetAccess))
	mux.HandleFunc("GET "+ws+"/access/check", s.requireSession(s.handleCheckAccess))
	mux.HandleFunc("PUT "+ws+"/access/blocklist/{agent}", s.requireSession(s.handleBlock))
	mux.HandleFunc("DELETE "+ws+"/access/blocklist/{agent}", s.requireSession(s.handleBlock))

	mux.HandleFunc("GET "+ws+"/audit", s.requireSession(s.handleWorkspaceAudit))
	mux.HandleFunc("GET "+org+"/audit", s.requireSession(s.handleOrgAudit))

	mux.HandleFunc("GET "+org+"/people", s.requireSession(s.handleListPeople))
	mux.HandleFunc("POST "+org+"/invitations", s.requireSession(s.handleInvite))
	mux.HandleFunc("POST /api/v1/invitations/preview", s.requireSession(s.handleInvitationPreview))
	mux.HandleFunc("POST /api/v1/invitations/accept", s.requireSession(s.handleAcceptInvitation))
	mux.HandleFunc("PATCH "+org+"/people/{user}", s.requireSession(s.handleSetOrgRole))
	mux.HandleFunc("DELETE "+org+"/people/{user}", s.requireSession(s.handleRemovePerson))
	mux.HandleFunc("POST "+org+"/people/{user}/suspend", s.requireSession(s.handleSuspend))
	mux.HandleFunc("POST "+org+"/people/{user}/resume", s.requireSession(s.handleSuspend))

	mux.HandleFunc("GET "+org+"/agents", s.requireSession(s.handleListAgents))
	mux.HandleFunc("GET "+org+"/agents/{agent}", s.requireSession(s.handleGetAgent))
}

/* ---------------------------------------------------------------------- */
/* Shared helpers                                                          */
/* ---------------------------------------------------------------------- */

// actor is the signed-in person, as audit rows record them.
func actor(r *http.Request) store.Actor {
	u := fromContext(r.Context()).user
	label := u.Name
	if label == "" {
		label = u.Email
	}
	return store.Actor{Kind: "user", ID: u.ID, Label: label}
}

func (v orgView) canAdmin(wsID string) bool {
	return v.orgAdmin || v.roles[wsID] == roleWorkspaceAdmin
}

func forbidden(w http.ResponseWriter, msg string) {
	writeError(w, http.StatusForbidden, "forbidden", msg)
}

// storeError maps a store error from a write to its response.
func (s *Server) storeError(w http.ResponseWriter, what string, err error) {
	var ve *store.ValidationError
	switch {
	case errors.As(err, &ve):
		writeError(w, http.StatusBadRequest, "invalid", ve.Msg)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "no such "+what)
	case errors.Is(err, store.ErrExists):
		writeError(w, http.StatusConflict, "exists", "that "+what+" already exists")
	case errors.Is(err, store.ErrLastOwner):
		writeError(w, http.StatusConflict, "last_owner", "the organization needs at least one active Owner")
	case errors.Is(err, store.ErrState):
		writeError(w, http.StatusConflict, "conflict", "not possible in the current state")
	default:
		s.internalError(w, what, err)
	}
}

// decodeBody reads a JSON body, writing a 400 when it doesn't parse.
func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := readJSON(w, r, v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid", "bad request body: "+err.Error())
		return false
	}
	return true
}

// visibleWorkspace loads the {ws} path value: 404 unless it is active and
// the caller can see it.
func (s *Server) visibleWorkspace(w http.ResponseWriter, r *http.Request, v orgView) (store.Workspace, bool) {
	ws, err := s.store.GetWorkspace(r.Context(), v.orgID, r.PathValue("ws"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && (ws.Status != statusActive || !v.canSee(ws.ID))) {
		writeError(w, http.StatusNotFound, "not_found", "no such workspace")
		return store.Workspace{}, false
	}
	if err != nil {
		s.internalError(w, "get workspace", err)
		return store.Workspace{}, false
	}
	return ws, true
}

// adminWorkspace is visibleWorkspace plus a 403 unless the caller
// administers it.
func (s *Server) adminWorkspace(w http.ResponseWriter, r *http.Request) (orgView, store.Workspace, bool) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return v, store.Workspace{}, false
	}
	ws, ok := s.visibleWorkspace(w, r, v)
	if !ok {
		return v, ws, false
	}
	if !v.canAdmin(ws.ID) {
		forbidden(w, "only this workspace's admins can do that")
		return v, ws, false
	}
	return v, ws, true
}

func (s *Server) workspaceResponse(w http.ResponseWriter, r *http.Request, status int, v orgView, ws store.Workspace) {
	stats, err := s.store.ListWorkspaceStats(r.Context(), v.orgID, s.now())
	if err != nil {
		s.internalError(w, "workspace stats", err)
		return
	}
	writeJSON(w, status, map[string]any{"workspace": s.workspaceJSON(v, ws, stats[ws.ID])})
}

// optInt is a JSON field that can be absent, null or a number.
type optInt struct {
	Set bool
	V   *int
}

func (o *optInt) UnmarshalJSON(b []byte) error {
	o.Set = true
	return json.Unmarshal(b, &o.V)
}

type principalJSON struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Label string `json:"label"`
}

type tokenJSON struct {
	Prefix   string    `json:"prefix"`
	Last4    string    `json:"last4"`
	IssuedAt time.Time `json:"issued_at"`
}

type credentialJSON struct {
	Current       tokenJSON  `json:"current"`
	Previous      *tokenJSON `json:"previous"`
	PreviousUntil *time.Time `json:"previous_until"`
}

func credJSON(c *store.Credential) *credentialJSON {
	if c == nil {
		return nil
	}
	out := &credentialJSON{Current: tokenJSON{c.Current.Prefix, c.Current.Last4, c.Current.IssuedAt}, PreviousUntil: c.PreviousUntil}
	if c.Previous != nil {
		out.Previous = &tokenJSON{c.Previous.Prefix, c.Previous.Last4, c.Previous.IssuedAt}
	}
	return out
}

// names resolves user and agent IDs in one org to display labels.
type names struct {
	people map[string]store.OrgMember
	agents map[string]store.Agent
}

func (s *Server) loadNames(r *http.Request, orgID string) (names, error) {
	n := names{people: map[string]store.OrgMember{}, agents: map[string]store.Agent{}}
	people, err := s.store.ListOrgMembers(r.Context(), orgID)
	if err != nil {
		return n, err
	}
	for _, p := range people {
		n.people[p.UserID] = p
	}
	agents, err := s.store.ListAgents(r.Context(), orgID)
	if err != nil {
		return n, err
	}
	for _, a := range agents {
		n.agents[a.ID] = a
	}
	return n, nil
}

func (n names) label(p store.Principal) string {
	switch p.Kind {
	case "user":
		if m, ok := n.people[p.ID]; ok {
			if m.Name != "" {
				return m.Name
			}
			return m.Email
		}
	case "agent":
		if a, ok := n.agents[p.ID]; ok {
			return a.Label
		}
	}
	return p.ID
}

func (n names) principal(p *store.Principal) *principalJSON {
	if p == nil || p.Kind == "" {
		return nil
	}
	return &principalJSON{Kind: p.Kind, ID: p.ID, Label: n.label(*p)}
}

/* ---------------------------------------------------------------------- */
/* Workspaces                                                              */
/* ---------------------------------------------------------------------- */

type createWorkspaceRequest struct {
	Name               string `json:"name"`
	Description        string `json:"description"`
	DefaultExpiryHours *int   `json:"default_expiry_hours"`
	RetentionDays      int    `json:"retention_days"`
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	if !v.orgAdmin {
		forbidden(w, "only the organization's Owners and userAdmins can create workspaces")
		return
	}
	var req createWorkspaceRequest
	if !decodeBody(w, r, &req) {
		return
	}
	ws, err := s.store.CreateWorkspace(r.Context(), v.orgID, actor(r), store.WorkspaceInput{
		Name: req.Name, Description: req.Description, DefaultExpiryHours: req.DefaultExpiryHours, RetentionDays: req.RetentionDays,
	}, s.now())
	if err != nil {
		s.storeError(w, "workspace", err)
		return
	}
	v.roles[ws.ID] = roleWorkspaceAdmin
	s.workspaceResponse(w, r, http.StatusCreated, v, ws)
}

type updateWorkspaceRequest struct {
	Name               *string `json:"name"`
	Description        *string `json:"description"`
	DefaultExpiryHours optInt  `json:"default_expiry_hours"`
	RetentionDays      *int    `json:"retention_days"`
}

func (s *Server) handleUpdateWorkspace(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok {
		return
	}
	var req updateWorkspaceRequest
	if !decodeBody(w, r, &req) {
		return
	}
	ws, err := s.store.UpdateWorkspace(r.Context(), v.orgID, ws.ID, actor(r), store.WorkspacePatch{
		Name: req.Name, Description: req.Description,
		SetExpiry: req.DefaultExpiryHours.Set, DefaultExpiryHours: req.DefaultExpiryHours.V,
		RetentionDays: req.RetentionDays,
	}, s.now())
	if err != nil {
		s.storeError(w, "workspace", err)
		return
	}
	s.workspaceResponse(w, r, http.StatusOK, v, ws)
}

func (s *Server) handleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok {
		return
	}
	if err := s.store.DeleteWorkspace(r.Context(), v.orgID, ws.ID, actor(r), s.now()); err != nil {
		s.storeError(w, "workspace", err)
		return
	}
	s.AccessChanged("", "", ws.ID) // its agents' sockets close and its watchers stop
	if s.hooks != nil {
		s.hooks.Changed(r.Context()) // its webhooks and listeners stop
	}
	w.WriteHeader(http.StatusNoContent)
}

/* ---------------------------------------------------------------------- */
/* Members                                                                 */
/* ---------------------------------------------------------------------- */

type memberJSON struct {
	ID          string         `json:"id"` // the membership ID
	Kind        string         `json:"kind"`
	MemberID    string         `json:"member_id"`
	Name        string         `json:"name"`
	Email       string         `json:"email,omitempty"`      // users
	OrgRole     string         `json:"org_role,omitempty"`   // users
	OrgStatus   string         `json:"org_status,omitempty"` // users: active, invited or suspended
	Role        string         `json:"role"`                 // member or workspace_admin
	Read        bool           `json:"read"`
	Write       bool           `json:"write"`
	AddedAt     time.Time      `json:"added_at"`
	AddedBy     *principalJSON `json:"added_by"`
	DelegatedBy *principalJSON `json:"delegated_by"`
	// Agents only.
	AgentStatus  string          `json:"agent_status,omitempty"`
	LastSeenAt   *time.Time      `json:"last_seen_at,omitempty"`
	Client       *clientJSON     `json:"client,omitempty"`
	Token        *credentialJSON `json:"token,omitempty"`
	TokenRevoked bool            `json:"token_revoked,omitempty"`
}

type defaultAdminJSON struct {
	UserID  string `json:"user_id"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	OrgRole string `json:"org_role"`
}

func (n names) member(m store.WorkspaceMember) memberJSON {
	out := memberJSON{
		ID: m.ID, Kind: m.Member.Kind, MemberID: m.Member.ID, Name: n.label(m.Member),
		Role: m.EffectiveRole(), Read: m.Read, Write: m.Write, AddedAt: m.AddedAt,
		AddedBy: n.principal(&m.AddedBy), DelegatedBy: n.principal(m.DelegatedBy),
	}
	if m.Member.Kind == "user" {
		if p, ok := n.people[m.Member.ID]; ok {
			out.Email, out.OrgRole, out.OrgStatus = p.Email, p.Role, p.Status
		}
		return out
	}
	if a, ok := n.agents[m.Member.ID]; ok {
		out.AgentStatus, out.LastSeenAt, out.Client = a.Status, a.LastSeenAt, clientOf(a)
	}
	out.Token, out.TokenRevoked = credJSON(m.Token), m.TokenRevokedAt != nil
	return out
}

func (s *Server) handleListMembers(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	ws, ok := s.visibleWorkspace(w, r, v)
	if !ok {
		return
	}
	ms, err := s.store.ListWorkspaceMembers(r.Context(), v.orgID, ws.ID)
	if err != nil {
		s.internalError(w, "list members", err)
		return
	}
	n, err := s.loadNames(r, v.orgID)
	if err != nil {
		s.internalError(w, "load names", err)
		return
	}
	out := make([]memberJSON, 0, len(ms))
	explicitAdmin := false
	for _, m := range ms {
		out = append(out, n.member(m))
		if p, ok := n.people[m.Member.ID]; ok && m.Member.Kind == "user" && m.Role == store.WSRoleAdmin && p.Status == statusActive {
			explicitAdmin = true
		}
	}
	// With no active human admin of its own, the org's active Owners and
	// userAdmins administer the workspace by default.
	defaults := []defaultAdminJSON{}
	if !explicitAdmin {
		for _, p := range n.people {
			if p.Status == statusActive && (p.Role == store.RoleOwner || p.Role == store.RoleUserAdmin) {
				defaults = append(defaults, defaultAdminJSON{UserID: p.UserID, Name: p.Name, Email: p.Email, OrgRole: p.Role})
			}
		}
		slices.SortFunc(defaults, func(a, b defaultAdminJSON) int {
			return cmp.Or(cmp.Compare(a.Name, b.Name), cmp.Compare(a.UserID, b.UserID))
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": out, "default_admins": defaults, "can_admin": v.canAdmin(ws.ID)})
}

type addMemberRequest struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Role  string `json:"role"`
	Read  *bool  `json:"read"`
	Write *bool  `json:"write"`
}

func (s *Server) handleAddMember(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok {
		return
	}
	var req addMemberRequest
	if !decodeBody(w, r, &req) {
		return
	}
	in := store.MemberInput{Kind: req.Kind, ID: req.ID, Role: req.Role, Read: true, Write: true}
	if req.Read != nil {
		in.Read = *req.Read
	}
	if req.Write != nil {
		in.Write = *req.Write
	}
	m, err := s.store.AddWorkspaceMember(r.Context(), v.orgID, ws.ID, actor(r), in, s.now())
	if err != nil {
		s.storeError(w, "member", err)
		return
	}
	s.memberResponse(w, r, http.StatusCreated, v.orgID, m)
}

func (s *Server) memberResponse(w http.ResponseWriter, r *http.Request, status int, orgID string, m store.WorkspaceMember) {
	n, err := s.loadNames(r, orgID)
	if err != nil {
		s.internalError(w, "load names", err)
		return
	}
	writeJSON(w, status, map[string]any{"member": n.member(m)})
}

type updateMemberRequest struct {
	Role  *string `json:"role"`
	Read  *bool   `json:"read"`
	Write *bool   `json:"write"`
}

func (s *Server) handleUpdateMember(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok {
		return
	}
	var req updateMemberRequest
	if !decodeBody(w, r, &req) {
		return
	}
	m, err := s.store.UpdateWorkspaceMember(r.Context(), v.orgID, ws.ID, r.PathValue("member"), actor(r),
		store.MemberPatch{Role: req.Role, Read: req.Read, Write: req.Write}, s.now())
	if err != nil {
		s.storeError(w, "member", err)
		return
	}
	s.AccessChanged("", m.ID, "") // a connected agent picks up its new grants
	s.memberResponse(w, r, http.StatusOK, v.orgID, m)
}

func (s *Server) handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok {
		return
	}
	m, err := s.store.RemoveWorkspaceMember(r.Context(), v.orgID, ws.ID, r.PathValue("member"), actor(r), s.now())
	if err != nil {
		s.storeError(w, "member", err)
		return
	}
	if m.Member.Kind == "user" {
		s.UserAccessChanged(m.Member.ID) // a removed person stops watching
	} else {
		s.AccessChanged("", m.ID, "") // a removed agent is disconnected
	}
	w.WriteHeader(http.StatusNoContent)
}

/* ---------------------------------------------------------------------- */
/* Access                                                                  */
/* ---------------------------------------------------------------------- */

type agentRefJSON struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type agentFilterNoteJSON struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Member   bool     `json:"member"`
	BlocksWS bool     `json:"blocks_workspace"` // the agent blocks this workspace itself
	Read     bool     `json:"read"`             // its own read filter
	Write    bool     `json:"write"`            // its own write filter
	Blocks   []string `json:"blocks_authors"`   // labels of authors it never receives from
}

func (s *Server) handleGetAccess(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	ws, ok := s.visibleWorkspace(w, r, v)
	if !ok {
		return
	}
	agents, err := s.store.ListAgents(r.Context(), v.orgID)
	if err != nil {
		s.internalError(w, "list agents", err)
		return
	}
	ms, err := s.store.ListWorkspaceMembers(r.Context(), v.orgID, ws.ID)
	if err != nil {
		s.internalError(w, "list members", err)
		return
	}
	member := map[string]bool{}
	for _, m := range ms {
		if m.Member.Kind == "agent" {
			member[m.Member.ID] = true
		}
	}
	label := map[string]string{}
	all := make([]agentRefJSON, 0, len(agents))
	for _, a := range agents {
		label[a.ID] = a.Label
		all = append(all, agentRefJSON{a.ID, a.Label})
	}
	blocklist := make([]agentRefJSON, 0, len(ws.AgentBlocklist))
	for _, id := range ws.AgentBlocklist {
		blocklist = append(blocklist, agentRefJSON{id, orDefault(label[id], id)})
	}
	// Agent-side filters that touch this workspace: agents blocking it, and
	// members that narrowed themselves or block authors.
	notes := []agentFilterNoteJSON{}
	for _, a := range agents {
		blocks := slices.Contains(a.Filters.WorkspaceBlocklist, ws.ID)
		if !blocks && (!member[a.ID] || (a.Filters.Read && a.Filters.Write && len(a.Filters.AgentBlocklist) == 0)) {
			continue
		}
		n := agentFilterNoteJSON{ID: a.ID, Label: a.Label, Member: member[a.ID], BlocksWS: blocks, Read: a.Filters.Read, Write: a.Filters.Write, Blocks: []string{}}
		for _, b := range a.Filters.AgentBlocklist {
			n.Blocks = append(n.Blocks, orDefault(label[b], b))
		}
		notes = append(notes, n)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"blocklist": blocklist, "agent_filters": notes, "agents": all, "can_admin": v.canAdmin(ws.ID),
	})
}

func (s *Server) handleCheckAccess(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	ws, ok := s.visibleWorkspace(w, r, v)
	if !ok {
		return
	}
	op := r.URL.Query().Get("op")
	if op == "" {
		op = "read"
	}
	if op != "read" && op != "write" && op != "admin" {
		writeError(w, http.StatusBadRequest, "invalid", "op must be read, write or admin")
		return
	}
	var agent *store.Agent
	a, err := s.store.GetAgent(r.Context(), v.orgID, r.URL.Query().Get("agent"))
	switch {
	case err == nil:
		agent = &a
	case !errors.Is(err, store.ErrNotFound):
		s.internalError(w, "get agent", err)
		return
	}
	var membership *store.WorkspaceMember
	if agent != nil {
		ms, err := s.store.ListWorkspaceMembers(r.Context(), v.orgID, ws.ID)
		if err != nil {
			s.internalError(w, "list members", err)
			return
		}
		for i := range ms {
			if ms[i].Member.Kind == "agent" && ms[i].Member.ID == agent.ID {
				membership = &ms[i]
			}
		}
	}
	writeJSON(w, http.StatusOK, accessLadder(agent, ws, membership, op))
}

func (s *Server) handleBlock(w http.ResponseWriter, r *http.Request) {
	v, ws, ok := s.adminWorkspace(w, r)
	if !ok {
		return
	}
	blocked := r.Method == http.MethodPut
	changed, err := s.store.SetWorkspaceBlock(r.Context(), v.orgID, ws.ID, r.PathValue("agent"), blocked, actor(r), s.now())
	if err != nil {
		s.storeError(w, "agent", err)
		return
	}
	if changed {
		s.AccessChanged("", "", ws.ID) // a blocked agent is disconnected
	}
	writeJSON(w, http.StatusOK, map[string]any{"blocked": blocked, "changed": changed})
}

/* ---------------------------------------------------------------------- */
/* Audit                                                                   */
/* ---------------------------------------------------------------------- */

type auditWorkspaceJSON struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Deleted bool   `json:"deleted"`
}

type auditActorJSON struct {
	Kind  string         `json:"kind"`
	ID    string         `json:"id,omitempty"`
	Label string         `json:"label"`
	Via   *principalJSON `json:"via"`
}

type auditJSON struct {
	ID        string              `json:"id"`
	At        time.Time           `json:"at"`
	Workspace *auditWorkspaceJSON `json:"workspace"`
	Shared    bool                `json:"shared"`
	Type      string              `json:"type"`
	Severity  string              `json:"severity"`
	Actor     auditActorJSON      `json:"actor"`
	Subject   *principalJSON      `json:"subject"`
	Object    string              `json:"object"`
	Result    string              `json:"result"`
	Reason    string              `json:"reason,omitempty"`
	Trk       string              `json:"trk"`
	Changes   json.RawMessage     `json:"changes,omitempty"`
	Detail    json.RawMessage     `json:"detail,omitempty"`
	Link      *auditLinkJSON      `json:"link"`
}

type auditLinkJSON struct {
	Label string `json:"label"`
	To    string `json:"to"`
}

// auditQuery reads the filters common to both audit lists: type, actor,
// before (RFC 3339) and limit.
func auditQuery(w http.ResponseWriter, r *http.Request) (store.AuditFilter, bool) {
	q := r.URL.Query()
	f := store.AuditFilter{Type: q.Get("type"), ActorID: q.Get("actor"), Limit: 100}
	if b := q.Get("before"); b != "" {
		t, err := time.Parse(time.RFC3339Nano, b)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid", "before must be an RFC 3339 time")
			return f, false
		}
		// before_id (optional) is the cursor's tie-break; see api_messages.go.
		f.Before = &store.Cursor{At: t, ID: q.Get("before_id")}
	}
	if l := q.Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "invalid", "limit must be a positive number")
			return f, false
		}
		f.Limit = n
	}
	return f, true
}

func (s *Server) writeAudit(w http.ResponseWriter, r *http.Request, orgID string, f store.AuditFilter) {
	events, err := s.store.ListAuditEvents(r.Context(), orgID, f)
	if err != nil {
		s.internalError(w, "list audit", err)
		return
	}
	all, err := s.store.ListWorkspaces(r.Context(), orgID, true)
	if err != nil {
		s.internalError(w, "list workspaces", err)
		return
	}
	wsByID := map[string]store.Workspace{}
	for _, ws := range all {
		wsByID[ws.ID] = ws
	}
	out := make([]auditJSON, 0, len(events))
	for _, e := range events {
		j := auditJSON{
			ID: e.ID, At: e.At, Shared: e.Shared, Type: e.Type, Severity: e.Severity,
			Actor:  auditActorJSON{Kind: e.Actor.Kind, ID: e.Actor.ID, Label: e.Actor.Label},
			Object: e.Object, Result: e.Result, Reason: e.Reason, Trk: e.Trk, Changes: e.Changes, Detail: e.Detail,
		}
		if e.Actor.Via != nil {
			j.Actor.Via = &principalJSON{Kind: e.Actor.Via.Kind, ID: e.Actor.Via.ID, Label: e.Actor.Via.Label}
		}
		if e.Subject != nil {
			j.Subject = &principalJSON{Kind: e.Subject.Kind, ID: e.Subject.ID, Label: e.Subject.Label}
		}
		if e.WorkspaceID != "" {
			ws, known := wsByID[e.WorkspaceID]
			j.Workspace = &auditWorkspaceJSON{ID: e.WorkspaceID, Name: orDefault(ws.Name, e.WorkspaceID), Deleted: !known || ws.Status != statusActive}
		}
		if e.LinkTo != "" {
			j.Link = &auditLinkJSON{Label: e.LinkLabel, To: e.LinkTo}
		}
		out = append(out, j)
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": out})
}

func (s *Server) handleOrgAudit(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	f, ok := auditQuery(w, r)
	if !ok {
		return
	}
	if ws := r.URL.Query().Get("workspace"); ws != "" {
		f.WorkspaceID = ws
	}
	// Owners and userAdmins see every row, deleted workspaces included;
	// everyone else sees their workspaces' rows and rows with no workspace.
	if !v.orgAdmin {
		f.VisibleWorkspaces = []string{}
		for id := range v.roles {
			f.VisibleWorkspaces = append(f.VisibleWorkspaces, id)
		}
	}
	s.writeAudit(w, r, v.orgID, f)
}

func (s *Server) handleWorkspaceAudit(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	ws, ok := s.visibleWorkspace(w, r, v)
	if !ok {
		return
	}
	f, ok := auditQuery(w, r)
	if !ok {
		return
	}
	f.WorkspaceID = ws.ID
	s.writeAudit(w, r, v.orgID, f)
}

/* ---------------------------------------------------------------------- */
/* People                                                                  */
/* ---------------------------------------------------------------------- */

type invitationJSON struct {
	ID        string         `json:"id"`
	InvitedAt time.Time      `json:"invited_at"`
	InvitedBy *principalJSON `json:"invited_by"`
	ExpiresAt time.Time      `json:"expires_at"`
}

type personJSON struct {
	UserID        string          `json:"user_id"`
	MembershipID  string          `json:"membership_id"`
	Name          string          `json:"name"`
	Email         string          `json:"email"`
	Role          string          `json:"role"`
	Status        string          `json:"status"` // active, invited or suspended
	SuspendedFrom string          `json:"suspended_from,omitempty"`
	JoinedAt      *time.Time      `json:"joined_at"`
	LastActiveAt  *time.Time      `json:"last_active_at"`
	Workspaces    int             `json:"workspaces"`
	Invitation    *invitationJSON `json:"invitation"`
	CanManage     bool            `json:"can_manage"`
	IsMe          bool            `json:"is_me"`
}

// canManagePerson: only active Owners and userAdmins manage people, never
// themselves, and only Owners act on Owners.
func canManagePerson(v orgView, me string, target store.OrgMember) bool {
	return v.orgAdmin && target.UserID != me && (target.Role != store.RoleOwner || v.role == store.RoleOwner)
}

func (s *Server) handleListPeople(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	ctx, me := r.Context(), fromContext(r.Context()).user.ID
	people, err := s.store.ListOrgMembers(ctx, v.orgID)
	if err != nil {
		s.internalError(w, "list people", err)
		return
	}
	counts, err := s.store.CountUserWorkspaces(ctx, v.orgID)
	if err != nil {
		s.internalError(w, "count workspaces", err)
		return
	}
	active, err := s.store.LastActive(ctx, v.orgID)
	if err != nil {
		s.internalError(w, "last active", err)
		return
	}
	invites, err := s.store.ListPendingInvitations(ctx, v.orgID)
	if err != nil {
		s.internalError(w, "list invitations", err)
		return
	}
	inviteOf, err := s.store.InvitationIDs(ctx, v.orgID)
	if err != nil {
		s.internalError(w, "list invitations", err)
		return
	}
	n := names{people: map[string]store.OrgMember{}}
	for _, p := range people {
		n.people[p.UserID] = p
	}
	out := make([]personJSON, 0, len(people))
	for _, p := range people {
		j := personJSON{
			UserID: p.UserID, MembershipID: p.ID, Name: p.Name, Email: p.Email, Role: p.Role, Status: p.Status,
			SuspendedFrom: p.SuspendedFrom, JoinedAt: p.JoinedAt, Workspaces: counts[p.UserID],
			CanManage: canManagePerson(v, me, p), IsMe: p.UserID == me,
		}
		if t, ok := active[p.UserID]; ok {
			j.LastActiveAt = &t
		}
		if inv, ok := invites[inviteOf[p.UserID]]; ok {
			j.Invitation = &invitationJSON{ID: inv.ID, InvitedAt: inv.InvitedAt, InvitedBy: n.principal(&inv.InvitedBy), ExpiresAt: inv.ExpiresAt}
		}
		out = append(out, j)
	}
	writeJSON(w, http.StatusOK, map[string]any{"people": out, "can_invite": v.orgAdmin, "my_role": v.role})
}

type inviteRequest struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

func (s *Server) handleInvite(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	if !v.orgAdmin {
		forbidden(w, "only the organization's Owners and userAdmins can invite people")
		return
	}
	var req inviteRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if req.Role == "" {
		req.Role = store.RoleUser
	}
	if req.Role == store.RoleOwner && v.role != store.RoleOwner {
		forbidden(w, "only Owners can invite an Owner")
		return
	}
	tok := newToken(store.InvitationTokenPrefix)
	p, err := s.store.InviteToOrg(r.Context(), v.orgID, req.Email, req.Role, issued(tok, store.InvitationTokenPrefix), actor(r), s.now())
	if err != nil {
		s.storeError(w, "person", err)
		return
	}
	// The link is shown this once. The token sits in the fragment, so it
	// never reaches a server log; the web app posts it to accept.
	writeJSON(w, http.StatusCreated, map[string]any{
		"person": personJSON{
			UserID: p.UserID, MembershipID: p.ID, Name: p.Name, Email: p.Email, Role: p.Role, Status: p.Status, CanManage: true,
		},
		"invite_url": strings.TrimRight(s.cfg.PublicURL.String(), "/") + "/invite#" + tok,
	})
}

type invitationTokenRequest struct {
	Token string `json:"token"`
}

type invitationOfferJSON struct {
	Org       idName    `json:"org"`
	Email     string    `json:"email"`
	Role      string    `json:"role"`
	InvitedBy string    `json:"invited_by"`
	ExpiresAt time.Time `json:"expires_at"`
}

// invitationToken reads the body's invitation token and returns its
// digest; false (after a 404) for anything that isn't one.
func invitationToken(w http.ResponseWriter, r *http.Request) (string, bool) {
	var req invitationTokenRequest
	if !decodeBody(w, r, &req) {
		return "", false
	}
	if !strings.HasPrefix(req.Token, store.InvitationTokenPrefix) || len(req.Token) > 200 {
		writeError(w, http.StatusNotFound, "not_found", "no such invitation")
		return "", false
	}
	return hashToken(req.Token), true
}

// invitationError answers a refused invitation: 404 unknown, 410 accepted,
// revoked or expired, 409 when the caller is already in the org or the
// invitee is suspended.
func (s *Server) invitationError(w http.ResponseWriter, err error) {
	var closed *store.InvitationClosedError
	switch {
	case errors.As(err, &closed):
		writeError(w, http.StatusGone, "invitation_"+closed.Status, "this invitation was "+closed.Status+"; ask for a new one")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "no such invitation")
	case errors.Is(err, store.ErrExists):
		writeError(w, http.StatusConflict, "already_member", "you're already in this organization")
	case errors.Is(err, store.ErrState):
		writeError(w, http.StatusConflict, "suspended", "this invitation is suspended; ask the organization's admins")
	default:
		s.internalError(w, "invitation", err)
	}
}

func offerJSON(o store.InvitationOffer) invitationOfferJSON {
	return invitationOfferJSON{Org: idName{o.OrgID, o.OrgName}, Email: o.Email, Role: o.Role, InvitedBy: o.InvitedBy, ExpiresAt: o.ExpiresAt}
}

// POST /api/v1/invitations/preview: what an invite link offers, so the
// signed-in person can decide.
func (s *Server) handleInvitationPreview(w http.ResponseWriter, r *http.Request) {
	hash, ok := invitationToken(w, r)
	if !ok {
		return
	}
	o, err := s.store.InvitationByToken(r.Context(), hash, s.now())
	if err != nil {
		s.invitationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invitation": offerJSON(o)})
}

// POST /api/v1/invitations/accept: join the org with the invited role, as
// whoever is signed in, however they signed in. Single use.
func (s *Server) handleAcceptInvitation(w http.ResponseWriter, r *http.Request) {
	hash, ok := invitationToken(w, r)
	if !ok {
		return
	}
	o, err := s.store.AcceptInvitation(r.Context(), hash, fromContext(r.Context()).user.ID, s.now())
	if err != nil {
		s.invitationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invitation": offerJSON(o)})
}

// targetPerson loads the {user} path value's membership: 404 unless they
// are in the org, then 403 unless the caller may manage them.
func (s *Server) targetPerson(w http.ResponseWriter, r *http.Request) (orgView, store.OrgMember, bool) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return v, store.OrgMember{}, false
	}
	people, err := s.store.ListOrgMembers(r.Context(), v.orgID)
	if err != nil {
		s.internalError(w, "list people", err)
		return v, store.OrgMember{}, false
	}
	for _, p := range people {
		if p.UserID != r.PathValue("user") {
			continue
		}
		if !canManagePerson(v, fromContext(r.Context()).user.ID, p) {
			forbidden(w, "you can't change this person's access")
			return v, p, false
		}
		return v, p, true
	}
	writeError(w, http.StatusNotFound, "not_found", "no such person")
	return v, store.OrgMember{}, false
}

type setRoleRequest struct {
	Role string `json:"role"`
}

func (s *Server) handleSetOrgRole(w http.ResponseWriter, r *http.Request) {
	v, p, ok := s.targetPerson(w, r)
	if !ok {
		return
	}
	var req setRoleRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if req.Role == store.RoleOwner && v.role != store.RoleOwner {
		forbidden(w, "only Owners can make someone an Owner")
		return
	}
	if _, err := s.store.SetOrgRole(r.Context(), v.orgID, p.UserID, req.Role, actor(r), s.now()); err != nil {
		s.storeError(w, "person", err)
		return
	}
	s.UserAccessChanged(p.UserID) // a former org admin stops watching workspaces they aren't in
	w.WriteHeader(http.StatusNoContent)
}

type suspendRequest struct {
	Reason string `json:"reason"`
}

func (s *Server) handleSuspend(w http.ResponseWriter, r *http.Request) {
	v, p, ok := s.targetPerson(w, r)
	if !ok {
		return
	}
	var req suspendRequest
	if r.ContentLength != 0 && !decodeBody(w, r, &req) {
		return
	}
	var err error
	if strings.HasSuffix(r.URL.Path, "/resume") {
		_, err = s.store.ResumeOrgMember(r.Context(), v.orgID, p.UserID, actor(r), s.now())
	} else {
		_, err = s.store.SuspendOrgMember(r.Context(), v.orgID, p.UserID, req.Reason, actor(r), s.now())
	}
	if err != nil {
		s.storeError(w, "person", err)
		return
	}
	s.UserAccessChanged(p.UserID) // a suspended person stops watching
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRemovePerson(w http.ResponseWriter, r *http.Request) {
	v, p, ok := s.targetPerson(w, r)
	if !ok {
		return
	}
	if err := s.store.RemoveOrgMember(r.Context(), v.orgID, p.UserID, actor(r), s.now()); err != nil {
		s.storeError(w, "person", err)
		return
	}
	s.UserAccessChanged(p.UserID) // a removed person stops watching
	w.WriteHeader(http.StatusNoContent)
}

/* ---------------------------------------------------------------------- */
/* Agents                                                                  */
/* ---------------------------------------------------------------------- */

type clientJSON struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
	Via     string `json:"via"`
}

func clientOf(a store.Agent) *clientJSON {
	if a.Client == nil {
		return nil
	}
	return &clientJSON{Name: a.Client.Name, Version: a.Client.Version, Via: a.Client.Via}
}

type agentWorkspaceJSON struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Role  string `json:"role"`
	Read  bool   `json:"read"`
	Write bool   `json:"write"`
	// Blocked: the workspace's blocklist or the agent's own blocks it.
	Blocked bool `json:"blocked"`
}

type agentFiltersJSON struct {
	Read               bool           `json:"read"`
	Write              bool           `json:"write"`
	WorkspaceBlocklist []agentRefJSON `json:"workspace_blocklist"`
	AgentBlocklist     []agentRefJSON `json:"agent_blocklist"`
}

type agentJSON struct {
	ID             string               `json:"id"`
	Label          string               `json:"label"`
	Status         string               `json:"status"`
	Description    string               `json:"description"`
	Client         *clientJSON          `json:"client"`
	LastTransport  string               `json:"last_transport,omitempty"`
	LastSeenAt     *time.Time           `json:"last_seen_at"`
	CreatedAt      time.Time            `json:"created_at"`
	CreatedByLabel string               `json:"created_by_label"`
	Token          *credentialJSON      `json:"token"`
	Filters        agentFiltersJSON     `json:"filters"`
	Workspaces     []agentWorkspaceJSON `json:"workspaces"`
}

// agentJSON shows an agent with the workspaces of its the caller can see.
func (v orgView) agentJSON(a store.Agent, ms []store.WorkspaceMember, wsByID map[string]store.Workspace, agentLabel map[string]string) agentJSON {
	out := agentJSON{
		ID: a.ID, Label: a.Label, Status: a.Status, Description: a.Description, Client: clientOf(a),
		LastTransport: a.LastTransport, LastSeenAt: a.LastSeenAt, CreatedAt: a.CreatedAt, CreatedByLabel: a.CreatedByLabel,
		Filters:    agentFiltersJSON{Read: a.Filters.Read, Write: a.Filters.Write, WorkspaceBlocklist: []agentRefJSON{}, AgentBlocklist: []agentRefJSON{}},
		Workspaces: []agentWorkspaceJSON{},
	}
	if a.Token.Current.Last4 != "" {
		out.Token = credJSON(&a.Token)
	}
	for _, id := range a.Filters.WorkspaceBlocklist {
		if v.canSee(id) {
			out.Filters.WorkspaceBlocklist = append(out.Filters.WorkspaceBlocklist, agentRefJSON{id, orDefault(wsByID[id].Name, id)})
		}
	}
	for _, id := range a.Filters.AgentBlocklist {
		out.Filters.AgentBlocklist = append(out.Filters.AgentBlocklist, agentRefJSON{id, orDefault(agentLabel[id], id)})
	}
	for _, m := range ms {
		if !v.canSee(m.WorkspaceID) {
			continue
		}
		ws := wsByID[m.WorkspaceID]
		out.Workspaces = append(out.Workspaces, agentWorkspaceJSON{
			ID: ws.ID, Name: ws.Name, Role: m.EffectiveRole(), Read: m.Read, Write: m.Write,
			Blocked: slices.Contains(ws.AgentBlocklist, a.ID) || slices.Contains(a.Filters.WorkspaceBlocklist, ws.ID),
		})
	}
	return out
}

// agentContext loads what both agent screens need.
func (s *Server) agentContext(r *http.Request, orgID string) ([]store.Agent, map[string][]store.WorkspaceMember, map[string]store.Workspace, map[string]string, error) {
	agents, err := s.store.ListAgents(r.Context(), orgID)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	ms, err := s.store.ListAgentMemberships(r.Context(), orgID)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	all, err := s.store.ListWorkspaces(r.Context(), orgID, false)
	if err != nil {
		return nil, nil, nil, nil, err
	}
	wsByID := map[string]store.Workspace{}
	for _, ws := range all {
		wsByID[ws.ID] = ws
	}
	label := map[string]string{}
	for _, a := range agents {
		label[a.ID] = a.Label
	}
	return agents, ms, wsByID, label, nil
}

func (s *Server) handleListAgents(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	agents, ms, wsByID, label, err := s.agentContext(r, v.orgID)
	if err != nil {
		s.internalError(w, "list agents", err)
		return
	}
	out := make([]agentJSON, 0, len(agents))
	for _, a := range agents {
		out = append(out, v.agentJSON(a, ms[a.ID], wsByID, label))
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": out})
}

type sidecarJSON struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	Health     string     `json:"health"`
	LastSeenAt *time.Time `json:"last_seen_at"`
	Version    string     `json:"version,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}

func (s *Server) handleGetAgent(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	agents, ms, wsByID, label, err := s.agentContext(r, v.orgID)
	if err != nil {
		s.internalError(w, "list agents", err)
		return
	}
	var agent *store.Agent
	for i := range agents {
		if agents[i].ID == r.PathValue("agent") {
			agent = &agents[i]
		}
	}
	if agent == nil {
		writeError(w, http.StatusNotFound, "not_found", "no such agent")
		return
	}
	sidecars, err := s.store.ListSidecars(r.Context(), v.orgID, agent.ID)
	if err != nil {
		s.internalError(w, "list sidecars", err)
		return
	}
	scs := make([]sidecarJSON, 0, len(sidecars))
	for _, sc := range sidecars {
		scs = append(scs, sidecarJSON{sc.ID, sc.Name, sc.Status, sc.HealthStatus, sc.LastSeenAt, sc.Version, sc.CreatedAt})
	}
	writeJSON(w, http.StatusOK, map[string]any{"agent": v.agentJSON(*agent, ms[agent.ID], wsByID, label), "sidecars": scs})
}

/* ---------------------------------------------------------------------- */
/* Small helpers                                                           */
/* ---------------------------------------------------------------------- */

func orDefault(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
