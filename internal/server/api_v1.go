package server

import (
	"errors"
	"net/http"
	"time"

	"github.com/VBCDX/dispatch/internal/store"
)

// The read API for the screens, under /api/v1/. Every route needs a
// session. Anything outside the caller's organizations is 404, never 403,
// so an ID from another organization reads exactly like one that doesn't
// exist.

const (
	statusActive       = "active"
	roleWorkspaceAdmin = "workspace_admin"
)

func (s *Server) routesV1(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/orgs", s.requireSession(s.handleListOrgs))
	mux.HandleFunc("GET /api/v1/orgs/{org}/workspaces", s.requireSession(s.handleListWorkspaces))
	mux.HandleFunc("GET /api/v1/orgs/{org}/workspaces/{ws}", s.requireSession(s.handleGetWorkspace))
	s.routesV1Admin(mux)
}

type orgJSON struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Role   string `json:"role"`   // Owner, userAdmin or user
	Status string `json:"status"` // the caller's status: active, invited or suspended
}

type workspaceJSON struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	Description        string    `json:"description"`
	DefaultExpiryHours *int      `json:"default_expiry_hours"`
	RetentionDays      int       `json:"retention_days"`
	BlockedAgents      int       `json:"blocked_agents"`
	CreatedAt          time.Time `json:"created_at"`
	Humans             int       `json:"humans"`
	Agents             int       `json:"agents"`
	Messages24h        int       `json:"messages_24h"`
	Waiting            int       `json:"waiting"`
	Webhooks           int       `json:"webhooks"`
	// MyRole is the caller's own membership role (member or
	// workspace_admin), or null when they have none and see the workspace
	// as an org Owner or userAdmin.
	MyRole   *string `json:"my_role"`
	CanAdmin bool    `json:"can_admin"`
}

func (s *Server) handleListOrgs(w http.ResponseWriter, r *http.Request) {
	a := fromContext(r.Context())
	orgs, err := s.store.ListUserOrgs(r.Context(), a.user.ID)
	if err != nil {
		s.internalError(w, "list orgs", err)
		return
	}
	out := make([]orgJSON, 0, len(orgs))
	for _, o := range orgs {
		out = append(out, orgJSON{ID: o.ID, Name: o.Name, Role: o.Role, Status: o.Status})
	}
	writeJSON(w, http.StatusOK, map[string]any{"orgs": out})
}

// orgView is what the caller may see in one organization.
type orgView struct {
	orgID    string
	role     string            // the caller's org role: Owner, userAdmin or user
	orgAdmin bool              // an active Owner or userAdmin: sees and administers every workspace
	roles    map[string]string // workspace ID to the caller's own membership role
	write    map[string]bool   // workspace ID to the caller's own membership write grant
}

func (v orgView) canSee(wsID string) bool {
	_, member := v.roles[wsID]
	return v.orgAdmin || member
}

// loadOrgView resolves the {org} path value for the caller. It writes a 404
// (or 500) and returns false unless the caller is an active member of an
// active organization.
func (s *Server) loadOrgView(w http.ResponseWriter, r *http.Request) (orgView, bool) {
	ctx, uid, orgID := r.Context(), fromContext(r.Context()).user.ID, r.PathValue("org")
	m, err := s.store.GetOrgMembership(ctx, orgID, uid)
	if err == nil && m.Status != statusActive {
		err = store.ErrNotFound
	}
	if err == nil {
		var o store.Org
		if o, err = s.store.GetOrg(ctx, orgID); err == nil && o.Status != statusActive {
			err = store.ErrNotFound
		}
	}
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "no such organization")
		return orgView{}, false
	}
	if err != nil {
		s.internalError(w, "load org", err)
		return orgView{}, false
	}
	mine, err := s.store.ListMemberships(ctx, orgID, "user", uid)
	if err != nil {
		s.internalError(w, "list memberships", err)
		return orgView{}, false
	}
	v := orgView{orgID: orgID, role: m.Role, orgAdmin: m.Role == store.RoleOwner || m.Role == store.RoleUserAdmin, roles: map[string]string{}, write: map[string]bool{}}
	for _, wm := range mine {
		v.roles[wm.WorkspaceID] = wm.Role
		v.write[wm.WorkspaceID] = wm.Write
	}
	return v, true
}

func (s *Server) workspaceJSON(v orgView, ws store.Workspace, st store.WorkspaceStats) workspaceJSON {
	out := workspaceJSON{
		ID: ws.ID, Name: ws.Name, Description: ws.Description,
		DefaultExpiryHours: ws.DefaultExpiryHours, RetentionDays: ws.RetentionDays,
		BlockedAgents: len(ws.AgentBlocklist), CreatedAt: ws.CreatedAt,
		Humans: st.Humans, Agents: st.Agents, Messages24h: st.Messages24h, Waiting: st.Waiting, Webhooks: st.Webhooks,
		CanAdmin: v.orgAdmin,
	}
	if role, ok := v.roles[ws.ID]; ok {
		out.MyRole = &role
		out.CanAdmin = out.CanAdmin || role == roleWorkspaceAdmin
	}
	return out
}

func (s *Server) handleListWorkspaces(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	all, err := s.store.ListWorkspaces(r.Context(), v.orgID, false)
	if err != nil {
		s.internalError(w, "list workspaces", err)
		return
	}
	stats, err := s.store.ListWorkspaceStats(r.Context(), v.orgID, s.now())
	if err != nil {
		s.internalError(w, "workspace stats", err)
		return
	}
	out := []workspaceJSON{}
	for _, ws := range all {
		if v.canSee(ws.ID) {
			out = append(out, s.workspaceJSON(v, ws, stats[ws.ID]))
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspaces": out})
}

func (s *Server) handleGetWorkspace(w http.ResponseWriter, r *http.Request) {
	v, ok := s.loadOrgView(w, r)
	if !ok {
		return
	}
	ws, err := s.store.GetWorkspace(r.Context(), v.orgID, r.PathValue("ws"))
	if errors.Is(err, store.ErrNotFound) || (err == nil && (ws.Status != statusActive || !v.canSee(ws.ID))) {
		writeError(w, http.StatusNotFound, "not_found", "no such workspace")
		return
	}
	if err != nil {
		s.internalError(w, "get workspace", err)
		return
	}
	stats, err := s.store.ListWorkspaceStats(r.Context(), v.orgID, s.now())
	if err != nil {
		s.internalError(w, "workspace stats", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspace": s.workspaceJSON(v, ws, stats[ws.ID])})
}

func (s *Server) internalError(w http.ResponseWriter, what string, err error) {
	s.log.Error(what+" failed", "err", err)
	writeError(w, http.StatusInternalServerError, "internal", what+" failed")
}
