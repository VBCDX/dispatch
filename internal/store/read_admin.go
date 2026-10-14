package store

import "context"

// Read queries for the People, Agents and Members screens that the
// management writes (write.go) go with.

// CountUserWorkspaces returns how many active workspaces each person in
// the org is a member of. People with none are absent.
func (s *Store) CountUserWorkspaces(ctx context.Context, orgID string) (map[string]int, error) {
	out := map[string]int{}
	err := s.queryRows(ctx, `SELECT m.member_id, COUNT(*) FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
		 WHERE m.org_id = ? AND m.member_kind = 'user' AND w.status = 'active'
		 GROUP BY m.member_id`, []any{orgID}, func(r rowScanner) error {
		var id string
		var n int
		err := r.Scan(&id, &n)
		out[id] = n
		return err
	})
	return out, err
}

// ListPendingInvitations returns an org's pending invitations, keyed by
// invitation ID.
func (s *Store) ListPendingInvitations(ctx context.Context, orgID string) (map[string]Invitation, error) {
	out := map[string]Invitation{}
	err := s.queryRows(ctx, `SELECT id, org_id, email, role, status, invited_at, invited_by_kind, invited_by_id, expires_at
		  FROM invitations WHERE org_id = ? AND status = 'pending'`, []any{orgID}, func(r rowScanner) error {
		var inv Invitation
		var at, exp int64
		if err := r.Scan(&inv.ID, &inv.OrgID, &inv.Email, &inv.Role, &inv.Status, &at, &inv.InvitedBy.Kind, &inv.InvitedBy.ID, &exp); err != nil {
			return err
		}
		inv.InvitedAt, inv.ExpiresAt = fromMillis(at), fromMillis(exp)
		out[inv.ID] = inv
		return nil
	})
	return out, err
}

// InvitationIDs returns the invitation each invited membership came from,
// keyed by user ID.
func (s *Store) InvitationIDs(ctx context.Context, orgID string) (map[string]string, error) {
	out := map[string]string{}
	err := s.queryRows(ctx, `SELECT user_id, invitation_id FROM org_memberships WHERE org_id = ? AND invitation_id IS NOT NULL`,
		[]any{orgID}, func(r rowScanner) error {
			var u, inv string
			err := r.Scan(&u, &inv)
			out[u] = inv
			return err
		})
	return out, err
}

// ListAgentMemberships returns every agent membership in the org's active
// workspaces, keyed by agent ID, each agent's by workspace name.
func (s *Store) ListAgentMemberships(ctx context.Context, orgID string) (map[string][]WorkspaceMember, error) {
	out := map[string][]WorkspaceMember{}
	err := s.queryRows(ctx, "SELECT "+memberCols+memberFrom+
		` JOIN workspaces w ON w.id = m.workspace_id
		 WHERE m.org_id = ? AND m.member_kind = 'agent' AND w.status = 'active'
		 ORDER BY w.name, m.id`, []any{orgID}, func(r rowScanner) error {
		m, err := scanMember(r)
		out[m.Member.ID] = append(out[m.Member.ID], m)
		return err
	})
	return out, err
}
