package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Read queries for the screens. Every query is scoped to an organization
// (and a workspace where the screen is one), so a caller can't read across
// tenants by passing another org's IDs: a row in another org is
// ErrNotFound, exactly like a missing one.

// DefaultLimit caps list queries that take a limit of 0 or less.
const DefaultLimit = 100

// MaxLimit is the most rows one list call returns.
const MaxLimit = 500

func clampLimit(n int) int {
	switch {
	case n <= 0:
		return DefaultLimit
	case n > MaxLimit:
		return MaxLimit
	}
	return n
}

type rowScanner interface {
	Scan(dest ...any) error
}

func timePtr(n sql.NullInt64) *time.Time {
	if !n.Valid {
		return nil
	}
	t := fromMillis(n.Int64)
	return &t
}

func intPtr(n sql.NullInt64) *int {
	if !n.Valid {
		return nil
	}
	v := int(n.Int64)
	return &v
}

func principalPtr(kind, id sql.NullString) *Principal {
	if !kind.Valid {
		return nil
	}
	return &Principal{Kind: kind.String, ID: id.String}
}

// actorCols are the six flattened actorRef columns for prefix p.
func actorCols(p string) string {
	return fmt.Sprintf("%[1]s_kind, %[1]s_id, %[1]s_label, %[1]s_via_kind, %[1]s_via_id, %[1]s_via_label", p)
}

type actorScan struct{ kind, id, label, viaKind, viaID, viaLabel sql.NullString }

func (a *actorScan) dest() []any {
	return []any{&a.kind, &a.id, &a.label, &a.viaKind, &a.viaID, &a.viaLabel}
}

func (a *actorScan) actor() Actor {
	out := Actor{Kind: a.kind.String, ID: a.id.String, Label: a.label.String}
	if a.viaKind.Valid {
		out.Via = &ActorVia{Kind: a.viaKind.String, ID: a.viaID.String, Label: a.viaLabel.String}
	}
	return out
}

// credentialCols are the readable columns of a flattened credentialSet:
// prefixes, last fours and times, never the hashes.
func credentialCols(p string) string {
	return fmt.Sprintf("%[1]s_current_prefix, %[1]s_current_last4, %[1]s_current_issued_at, "+
		"%[1]s_previous_digest_prefix, %[1]s_previous_digest_last4, %[1]s_previous_digest_issued_at, "+
		"%[1]s_previous_grace_until, %[1]s_rotated_at", p)
}

type credentialScan struct {
	prefix, last4         sql.NullString
	issued                sql.NullInt64
	prevPrefix, prevLast4 sql.NullString
	prevIssued, until     sql.NullInt64
	rotated               sql.NullInt64
}

func (c *credentialScan) dest() []any {
	return []any{&c.prefix, &c.last4, &c.issued, &c.prevPrefix, &c.prevLast4, &c.prevIssued, &c.until, &c.rotated}
}

func (c *credentialScan) credential() *Credential {
	if !c.last4.Valid {
		return nil
	}
	out := &Credential{
		Current:   TokenInfo{Prefix: c.prefix.String, Last4: c.last4.String, IssuedAt: fromMillis(c.issued.Int64)},
		RotatedAt: timePtr(c.rotated),
	}
	if c.prevLast4.Valid {
		out.Previous = &TokenInfo{Prefix: c.prevPrefix.String, Last4: c.prevLast4.String, IssuedAt: fromMillis(c.prevIssued.Int64)}
		out.PreviousUntil = timePtr(c.until)
	}
	return out
}

func decodeJSON[T any](s sql.NullString) (T, error) {
	var v T
	if !s.Valid || s.String == "" {
		return v, nil
	}
	err := json.Unmarshal([]byte(s.String), &v)
	return v, err
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// placeholders returns "?, ?, ?" for n arguments.
func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?, ", n), ", ")
}

func (s *Store) queryRows(ctx context.Context, query string, args []any, each func(rowScanner) error) error {
	rows, err := s.db.QueryContext(ctx, s.q(query), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := each(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

/* ---------------------------------------------------------------------- */
/* Orgs and people                                                         */
/* ---------------------------------------------------------------------- */

const orgCols = `o.id, o.name, o.status, o.audit_retention_days, o.created_at, o.created_by_kind, o.created_by_id,
	o.updated_at, o.deleted_at, o.rev`

func scanOrg(r rowScanner, extra ...any) (Org, error) {
	var o Org
	var retention, deleted sql.NullInt64
	var created, updated int64
	dest := append([]any{&o.ID, &o.Name, &o.Status, &retention, &created, &o.CreatedBy.Kind, &o.CreatedBy.ID,
		&updated, &deleted, &o.Rev}, extra...)
	if err := r.Scan(dest...); err != nil {
		return Org{}, err
	}
	o.AuditRetentionDays, o.DeletedAt = intPtr(retention), timePtr(deleted)
	o.CreatedAt, o.UpdatedAt = fromMillis(created), fromMillis(updated)
	return o, nil
}

// GetOrg loads an organization.
func (s *Store) GetOrg(ctx context.Context, orgID string) (Org, error) {
	o, err := scanOrg(s.db.QueryRowContext(ctx, s.q("SELECT "+orgCols+" FROM orgs o WHERE o.id = ?"), orgID))
	return o, notFound(err)
}

// ListUserOrgs returns the orgs a user belongs to (any status, so the org
// switcher can mark suspended and invited ones), by name.
func (s *Store) ListUserOrgs(ctx context.Context, userID string) ([]UserOrg, error) {
	var out []UserOrg
	err := s.queryRows(ctx, `SELECT `+orgCols+`, m.role, m.status
		  FROM org_memberships m JOIN orgs o ON o.id = m.org_id
		 WHERE m.user_id = ? AND o.status = 'active'
		 ORDER BY o.name, o.id`, []any{userID}, func(r rowScanner) error {
		var uo UserOrg
		o, err := scanOrg(r, &uo.Role, &uo.Status)
		uo.Org = o
		out = append(out, uo)
		return err
	})
	return out, err
}

const orgMembershipCols = `m.id, m.org_id, m.user_id, m.role, m.status, m.suspended_from, m.joined_at, m.created_at`

func scanOrgMembership(r rowScanner, extra ...any) (OrgMembership, error) {
	var m OrgMembership
	var from sql.NullString
	var joined sql.NullInt64
	var created int64
	dest := append([]any{&m.ID, &m.OrgID, &m.UserID, &m.Role, &m.Status, &from, &joined, &created}, extra...)
	if err := r.Scan(dest...); err != nil {
		return OrgMembership{}, err
	}
	m.SuspendedFrom, m.JoinedAt, m.CreatedAt = from.String, timePtr(joined), fromMillis(created)
	return m, nil
}

// GetOrgMembership loads a user's membership in an org.
func (s *Store) GetOrgMembership(ctx context.Context, orgID, userID string) (OrgMembership, error) {
	m, err := scanOrgMembership(s.db.QueryRowContext(ctx, s.q(
		"SELECT "+orgMembershipCols+" FROM org_memberships m WHERE m.org_id = ? AND m.user_id = ?"), orgID, userID))
	return m, notFound(err)
}

// ListOrgMembers returns everyone in an org (active, invited and
// suspended) for the People screen, by name.
func (s *Store) ListOrgMembers(ctx context.Context, orgID string) ([]OrgMember, error) {
	var out []OrgMember
	err := s.queryRows(ctx, `SELECT `+orgMembershipCols+`, u.name, u.email, u.status
		  FROM org_memberships m JOIN users u ON u.id = m.user_id
		 WHERE m.org_id = ?
		 ORDER BY u.name, u.id`, []any{orgID}, func(r rowScanner) error {
		var om OrgMember
		m, err := scanOrgMembership(r, &om.Name, &om.Email, &om.UserStatus)
		om.OrgMembership = m
		out = append(out, om)
		return err
	})
	return out, err
}

// LastActive returns when each user last did something in the org: the
// newest audit row they are the actor of. Users with no rows are absent.
func (s *Store) LastActive(ctx context.Context, orgID string) (map[string]time.Time, error) {
	out := map[string]time.Time{}
	err := s.queryRows(ctx, `SELECT actor_id, MAX(at) FROM audit_events
		 WHERE org_id = ? AND actor_kind = 'user' AND actor_id IS NOT NULL
		 GROUP BY actor_id`, []any{orgID}, func(r rowScanner) error {
		var id string
		var at int64
		err := r.Scan(&id, &at)
		out[id] = fromMillis(at)
		return err
	})
	return out, err
}

// ListUserSessions returns a user's sessions that have neither expired nor
// been revoked, most recently seen first.
func (s *Store) ListUserSessions(ctx context.Context, userID string, now time.Time) ([]UserSession, error) {
	var out []UserSession
	err := s.queryRows(ctx, `SELECT method, client, device, place, created_at, last_seen_at, expires_at
		  FROM sessions WHERE user_id = ? AND expires_at > ? AND revoked_at IS NULL
		 ORDER BY last_seen_at DESC`, []any{userID, millis(now)}, func(r rowScanner) error {
		var us UserSession
		var device, place sql.NullString
		var created, seen, expires int64
		if err := r.Scan(&us.Method, &us.Client, &device, &place, &created, &seen, &expires); err != nil {
			return err
		}
		us.Device, us.Place = device.String, place.String
		us.CreatedAt, us.LastSeenAt, us.ExpiresAt = fromMillis(created), fromMillis(seen), fromMillis(expires)
		out = append(out, us)
		return nil
	})
	return out, err
}

/* ---------------------------------------------------------------------- */
/* Workspaces and memberships                                              */
/* ---------------------------------------------------------------------- */

const workspaceCols = `w.id, w.org_id, w.name, w.status, ws.description, ws.default_expiry_hours, ws.retention_days,
	w.created_at, w.created_by_kind, w.created_by_id, w.updated_at, w.deleted_at, w.deleted_by_kind, w.deleted_by_id, w.rev`

const workspaceFrom = ` FROM workspaces w LEFT JOIN workspace_settings ws ON ws.id = w.id`

func scanWorkspace(r rowScanner) (Workspace, error) {
	var w Workspace
	var desc, delKind, delID sql.NullString
	var expiry, retention, deleted sql.NullInt64
	var created, updated int64
	if err := r.Scan(&w.ID, &w.OrgID, &w.Name, &w.Status, &desc, &expiry, &retention,
		&created, &w.CreatedBy.Kind, &w.CreatedBy.ID, &updated, &deleted, &delKind, &delID, &w.Rev); err != nil {
		return Workspace{}, err
	}
	// workspace_settings.retention_days is NOT NULL. The read paths and the
	// write pre-read materialize the row first (materializeSettings covers the
	// supported "created outside Dispatch" state), so a NULL here is a genuine
	// data fault or a mid-read delete race. Report it instead of substituting
	// 0.
	if !retention.Valid {
		return Workspace{}, fmt.Errorf("store: workspace %s has no settings row", w.ID)
	}
	w.Description, w.DefaultExpiryHours, w.RetentionDays = desc.String, intPtr(expiry), int(retention.Int64)
	w.CreatedAt, w.UpdatedAt, w.DeletedAt, w.DeletedBy = fromMillis(created), fromMillis(updated), timePtr(deleted), principalPtr(delKind, delID)
	w.AgentBlocklist = []string{}
	return w, nil
}

// workspaceBlocklists fills AgentBlocklist for the given workspaces.
func (s *Store) workspaceBlocklists(ctx context.Context, orgID string, ws []Workspace) error {
	if len(ws) == 0 {
		return nil
	}
	idx := map[string]int{}
	args := []any{orgID}
	for i, w := range ws {
		idx[w.ID] = i
		args = append(args, w.ID)
	}
	return s.queryRows(ctx, `SELECT workspace_id, agent_id FROM workspace_settings_agent_blocklist
		 WHERE org_id = ? AND workspace_id IN (`+placeholders(len(ws))+`) ORDER BY agent_id`, args,
		func(r rowScanner) error {
			var wsID, agentID string
			if err := r.Scan(&wsID, &agentID); err != nil {
				return err
			}
			ws[idx[wsID]].AgentBlocklist = append(ws[idx[wsID]].AgentBlocklist, agentID)
			return nil
		})
}

// ListWorkspaces returns an org's workspaces by name. Deleted workspaces
// are included only when asked for (audit resolves their names).
func (s *Store) ListWorkspaces(ctx context.Context, orgID string, includeDeleted bool) ([]Workspace, error) {
	if err := s.materializeSettings(ctx, s.db, orgID, "", time.Now()); err != nil {
		return nil, err
	}
	query := "SELECT " + workspaceCols + workspaceFrom + " WHERE w.org_id = ?"
	if !includeDeleted {
		query += " AND w.status = 'active'"
	}
	var out []Workspace
	err := s.queryRows(ctx, query+" ORDER BY w.name, w.id", []any{orgID}, func(r rowScanner) error {
		w, err := scanWorkspace(r)
		out = append(out, w)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, s.workspaceBlocklists(ctx, orgID, out)
}

// GetWorkspace loads a workspace, deleted or not.
func (s *Store) GetWorkspace(ctx context.Context, orgID, workspaceID string) (Workspace, error) {
	if err := s.materializeSettings(ctx, s.db, orgID, workspaceID, time.Now()); err != nil {
		return Workspace{}, err
	}
	w, err := scanWorkspace(s.db.QueryRowContext(ctx, s.q(
		"SELECT "+workspaceCols+workspaceFrom+" WHERE w.org_id = ? AND w.id = ?"), orgID, workspaceID))
	if err != nil {
		return Workspace{}, notFound(err)
	}
	ws := []Workspace{w}
	err = s.workspaceBlocklists(ctx, orgID, ws)
	return ws[0], err
}

var memberCols = `m.id, m.org_id, m.workspace_id, m.member_kind, m.member_id, m.role, m.added_at, m.added_by_kind, m.added_by_id,
	m.delegated_by_kind, m.delegated_by_id, m.delegated_at,
	a.read, a.write, a.agent_role, a.delegated_by_kind, a.delegated_by_id, ` + prefixCols("a.", credentialCols("token")) +
	`, a.token_revoked_at, a.token_delivery`

const memberFrom = ` FROM workspace_memberships m LEFT JOIN membership_access a ON a.id = m.id`

// prefixCols qualifies each column in a comma-separated list.
func prefixCols(p, cols string) string {
	parts := strings.Split(cols, ",")
	for i, c := range parts {
		parts[i] = p + strings.TrimSpace(c)
	}
	return strings.Join(parts, ", ")
}

func scanMember(r rowScanner) (WorkspaceMember, error) {
	var m WorkspaceMember
	var delKind, delID, aDelKind, aDelID, agentRole, delivery sql.NullString
	var delAt, revoked sql.NullInt64
	var read, write sql.NullBool
	var added int64
	var cred credentialScan
	dest := append([]any{&m.ID, &m.OrgID, &m.WorkspaceID, &m.Member.Kind, &m.Member.ID, &m.Role, &added, &m.AddedBy.Kind, &m.AddedBy.ID,
		&delKind, &delID, &delAt, &read, &write, &agentRole, &aDelKind, &aDelID}, cred.dest()...)
	dest = append(dest, &revoked, &delivery)
	if err := r.Scan(dest...); err != nil {
		return WorkspaceMember{}, err
	}
	m.AddedAt, m.DelegatedAt = fromMillis(added), timePtr(delAt)
	// Agent admin is delegated in membership_access; human admin in the shared row.
	m.DelegatedBy = principalPtr(delKind, delID)
	if m.DelegatedBy == nil {
		m.DelegatedBy = principalPtr(aDelKind, aDelID)
	}
	// The access row is written and deleted with the membership. If it is
	// missing, a human keeps the human defaults (read and write), but an
	// agent gets nothing: never derive "can write" from an absent row.
	if read.Valid || write.Valid {
		m.Read, m.Write = read.Bool, write.Bool
	} else if m.Member.Kind == "user" {
		m.Read, m.Write = true, true
	}
	m.AgentRole, m.TokenDelivery = agentRole.String, delivery.String
	m.Token, m.TokenRevokedAt = cred.credential(), timePtr(revoked)
	return m, nil
}

// ListWorkspaceMembers returns a workspace's members: humans first, then
// agents, each in the order they were added.
func (s *Store) ListWorkspaceMembers(ctx context.Context, orgID, workspaceID string) ([]WorkspaceMember, error) {
	var out []WorkspaceMember
	err := s.queryRows(ctx, "SELECT "+memberCols+memberFrom+
		` WHERE m.org_id = ? AND m.workspace_id = ?
		 ORDER BY CASE m.member_kind WHEN 'user' THEN 0 ELSE 1 END, m.added_at, m.id`,
		[]any{orgID, workspaceID}, func(r rowScanner) error {
			m, err := scanMember(r)
			out = append(out, m)
			return err
		})
	return out, err
}

// ListMemberships returns every workspace membership of one user or agent
// in an org ("my workspaces", an agent's workspaces).
func (s *Store) ListMemberships(ctx context.Context, orgID, memberKind, memberID string) ([]WorkspaceMember, error) {
	var out []WorkspaceMember
	err := s.queryRows(ctx, "SELECT "+memberCols+memberFrom+
		` JOIN workspaces w ON w.id = m.workspace_id
		 WHERE m.org_id = ? AND m.member_kind = ? AND m.member_id = ? AND w.status = 'active'
		 ORDER BY w.name, m.id`,
		[]any{orgID, memberKind, memberID}, func(r rowScanner) error {
			m, err := scanMember(r)
			out = append(out, m)
			return err
		})
	return out, err
}

/* ---------------------------------------------------------------------- */
/* Agents                                                                  */
/* ---------------------------------------------------------------------- */

var agentCols = `g.id, g.org_id, g.label, g.created_at, g.created_by_kind, g.created_by_id, g.created_by_label, g.retired_at,
	p.status, p.description, ` + prefixCols("p.", credentialCols("token")) + `, p.token_delivery,
	p.filters_read, p.filters_write, p.filters_workspace_blocklist,
	p.client_name, p.client_version, p.client_via, p.client_at, p.last_transport_via, p.last_transport_at,
	p.last_seen_at, p.config_format, p.suspended_at, p.revoked_at`

const agentFrom = ` FROM agents g JOIN agent_profiles p ON p.id = g.id`

func scanAgent(r rowScanner) (Agent, error) {
	var a Agent
	var createdByLabel, desc, delivery, wsBlock, clientName, clientVersion, clientVia, transport, configFormat sql.NullString
	var retired, clientAt, transportAt, seen, suspended, revoked sql.NullInt64
	var created int64
	var cred credentialScan
	dest := append([]any{&a.ID, &a.OrgID, &a.Label, &created, &a.CreatedBy.Kind, &a.CreatedBy.ID, &createdByLabel, &retired,
		&a.Status, &desc}, cred.dest()...)
	dest = append(dest, &delivery, &a.Filters.Read, &a.Filters.Write, &wsBlock,
		&clientName, &clientVersion, &clientVia, &clientAt, &transport, &transportAt, &seen, &configFormat, &suspended, &revoked)
	if err := r.Scan(dest...); err != nil {
		return Agent{}, err
	}
	a.CreatedAt, a.CreatedByLabel, a.RetiredAt = fromMillis(created), createdByLabel.String, timePtr(retired)
	a.Description, a.TokenDelivery = desc.String, delivery.String
	if c := cred.credential(); c != nil {
		a.Token = *c
	}
	blocked, err := decodeJSON[[]string](wsBlock)
	if err != nil {
		return Agent{}, fmt.Errorf("store: agent %s workspace blocklist: %w", a.ID, err)
	}
	a.Filters.WorkspaceBlocklist = append([]string{}, blocked...)
	a.Filters.AgentBlocklist = []string{}
	if clientName.Valid {
		a.Client = &AgentClient{Name: clientName.String, Version: clientVersion.String, Via: clientVia.String, At: timePtr(clientAt)}
	}
	a.LastTransport, a.LastTransportAt, a.LastSeenAt = transport.String, timePtr(transportAt), timePtr(seen)
	a.ConfigFormat, a.SuspendedAt, a.RevokedAt = configFormat.String, timePtr(suspended), timePtr(revoked)
	return a, nil
}

func (s *Store) agentBlocklists(ctx context.Context, orgID string, as []Agent) error {
	if len(as) == 0 {
		return nil
	}
	idx := map[string]int{}
	args := []any{orgID}
	for i, a := range as {
		idx[a.ID] = i
		args = append(args, a.ID)
	}
	return s.queryRows(ctx, `SELECT agent_profile_id, agent_id FROM agent_profiles_agent_blocklist
		 WHERE org_id = ? AND agent_profile_id IN (`+placeholders(len(as))+`) ORDER BY agent_id`, args,
		func(r rowScanner) error {
			var owner, blocked string
			if err := r.Scan(&owner, &blocked); err != nil {
				return err
			}
			as[idx[owner]].Filters.AgentBlocklist = append(as[idx[owner]].Filters.AgentBlocklist, blocked)
			return nil
		})
}

// ListAgents returns an org's agents with their Dispatch profiles, by label.
func (s *Store) ListAgents(ctx context.Context, orgID string) ([]Agent, error) {
	var out []Agent
	err := s.queryRows(ctx, "SELECT "+agentCols+agentFrom+" WHERE g.org_id = ? ORDER BY g.label_lower, g.id",
		[]any{orgID}, func(r rowScanner) error {
			a, err := scanAgent(r)
			out = append(out, a)
			return err
		})
	if err != nil {
		return nil, err
	}
	return out, s.agentBlocklists(ctx, orgID, out)
}

// GetAgent loads one agent with its Dispatch profile.
func (s *Store) GetAgent(ctx context.Context, orgID, agentID string) (Agent, error) {
	a, err := scanAgent(s.db.QueryRowContext(ctx, s.q("SELECT "+agentCols+agentFrom+" WHERE g.org_id = ? AND g.id = ?"), orgID, agentID))
	if err != nil {
		return Agent{}, notFound(err)
	}
	as := []Agent{a}
	err = s.agentBlocklists(ctx, orgID, as)
	return as[0], err
}

// ListSidecars returns the sidecars bound to an agent, newest first.
func (s *Store) ListSidecars(ctx context.Context, orgID, agentID string) ([]Sidecar, error) {
	var out []Sidecar
	err := s.queryRows(ctx, `SELECT id, org_id, agent_id, name, status, `+credentialCols("credential")+`,
		       health_status, health_last_seen_at, health_reported_version, created_at, revoked_at
		  FROM sidecars WHERE org_id = ? AND agent_id = ? ORDER BY created_at DESC, id`,
		[]any{orgID, agentID}, func(r rowScanner) error {
			var sc Sidecar
			var cred credentialScan
			var seen, revoked sql.NullInt64
			var version sql.NullString
			var created int64
			dest := append([]any{&sc.ID, &sc.OrgID, &sc.AgentID, &sc.Name, &sc.Status}, cred.dest()...)
			dest = append(dest, &sc.HealthStatus, &seen, &version, &created, &revoked)
			if err := r.Scan(dest...); err != nil {
				return err
			}
			if c := cred.credential(); c != nil {
				sc.Credential = *c
			}
			sc.LastSeenAt, sc.Version, sc.CreatedAt, sc.RevokedAt = timePtr(seen), version.String, fromMillis(created), timePtr(revoked)
			out = append(out, sc)
			return nil
		})
	return out, err
}

/* ---------------------------------------------------------------------- */
/* Messages, receipts, threads, tags                                       */
/* ---------------------------------------------------------------------- */

// Cursor is a row's position in a list's sort order: the timestamp plus the
// ID tie-break. Paging with the full pair keeps rows that share a timestamp
// from being skipped at a page boundary.
type Cursor struct {
	At time.Time
	ID string
}

// MessageFilter narrows ListMessages. Zero values mean "any".
type MessageFilter struct {
	Tag          string
	ThreadRootID string  // a thread's replies
	RootsOnly    bool    // top-level messages only
	AuthorKind   string  // user, agent or listener
	AuthorID     string  // with AuthorKind
	Before       *Cursor // the last row of the previous page; older rows follow
	Limit        int
}

const messageCols = `m.id, m.org_id, m.workspace_id, m.author_kind, m.author_id, m.author_from,
	m.body_storage, m.body_text, m.body_blob_id, m.body_bytes, m.body_preview,
	m.payload_json, m.payload_blob_id, m.audience_mode, m.audience_agent_ids, m.parent_id, m.thread_root_id,
	m.created_at, m.expires_at, m.expired_early_at, m.trk, m.sent_via_channel, m.sent_via_user_id, m.sent_via_sidecar_id,
	m.webhook_id, m.receipt_counts_targets, m.receipt_counts_queued, m.receipt_counts_held, m.receipt_counts_delivered,
	m.receipt_counts_read, m.receipt_counts_acked, m.receipt_counts_filtered, m.receipt_counts_never_delivered,
	m.stream_entry_id`

func scanMessage(r rowScanner) (Message, error) {
	var m Message
	var from, text, blobID, preview, payload, payloadBlob, agentIDs, parent, root, trk, via, viaUser, viaSidecar, webhook sql.NullString
	var bytes, expires, expiredEarly sql.NullInt64
	var counts [8]sql.NullInt64
	var created int64
	dest := []any{&m.ID, &m.OrgID, &m.WorkspaceID, &m.Author.Kind, &m.Author.ID, &from,
		&m.Body.Storage, &text, &blobID, &bytes, &preview, &payload, &payloadBlob, &m.Audience.Mode, &agentIDs, &parent, &root,
		&created, &expires, &expiredEarly, &trk, &via, &viaUser, &viaSidecar, &webhook}
	for i := range counts {
		dest = append(dest, &counts[i])
	}
	var streamSeq sql.NullString
	dest = append(dest, &streamSeq)
	if err := r.Scan(dest...); err != nil {
		return Message{}, err
	}
	m.StreamSeq, _ = strconv.ParseUint(streamSeq.String, 10, 64)
	m.Author.From = from.String
	m.Body.Text, m.Body.BlobID, m.Body.Bytes, m.Body.Preview = text.String, blobID.String, bytes.Int64, preview.String
	if payload.Valid {
		m.Payload = json.RawMessage(payload.String)
	}
	m.PayloadBlobID = payloadBlob.String
	ids, err := decodeJSON[[]string](agentIDs)
	if err != nil {
		return Message{}, fmt.Errorf("store: message %s audience: %w", m.ID, err)
	}
	m.Audience.AgentIDs = ids
	m.ParentID, m.ThreadRootID, m.Trk, m.WebhookID = parent.String, root.String, trk.String, webhook.String
	m.CreatedAt, m.ExpiresAt, m.ExpiredEarly = fromMillis(created), timePtr(expires), timePtr(expiredEarly)
	m.SentVia = via.String
	if viaUser.Valid {
		m.SentViaID = viaUser.String
	} else {
		m.SentViaID = viaSidecar.String
	}
	c := &m.ReceiptCounts
	for i, p := range []*int{&c.Targets, &c.Queued, &c.Held, &c.Delivered, &c.Read, &c.Acked, &c.Filtered, &c.NeverDelivered} {
		*p = int(counts[i].Int64)
	}
	m.Tags = []string{}
	return m, nil
}

func (s *Store) messageTags(ctx context.Context, orgID string, ms []Message) error {
	if len(ms) == 0 {
		return nil
	}
	idx := map[string]int{}
	args := []any{orgID}
	for i, m := range ms {
		idx[m.ID] = i
		args = append(args, m.ID)
	}
	return s.queryRows(ctx, `SELECT message_id, tag FROM message_tags
		 WHERE org_id = ? AND message_id IN (`+placeholders(len(ms))+`) ORDER BY tag`, args,
		func(r rowScanner) error {
			var id, tag string
			if err := r.Scan(&id, &tag); err != nil {
				return err
			}
			ms[idx[id]].Tags = append(ms[idx[id]].Tags, tag)
			return nil
		})
}

// ListMessages returns a workspace's messages, newest first. A thread's
// replies (ThreadRootID) come oldest first, as a thread reads.
func (s *Store) ListMessages(ctx context.Context, orgID, workspaceID string, f MessageFilter) ([]Message, error) {
	query := "SELECT " + messageCols + " FROM messages m"
	args := []any{}
	if f.Tag != "" {
		query += " JOIN message_tags t ON t.message_id = m.id AND t.tag = ?"
		args = append(args, f.Tag)
	}
	query += " WHERE m.org_id = ? AND m.workspace_id = ?"
	args = append(args, orgID, workspaceID)
	order := " ORDER BY m.created_at DESC, m.id DESC"
	if f.ThreadRootID != "" {
		query += " AND m.thread_root_id = ?"
		args = append(args, f.ThreadRootID)
		order = " ORDER BY m.created_at, m.id"
	}
	if f.RootsOnly {
		query += " AND m.parent_id IS NULL"
	}
	if f.AuthorKind != "" {
		query += " AND m.author_kind = ?"
		args = append(args, f.AuthorKind)
		if f.AuthorID != "" {
			query += " AND m.author_id = ?"
			args = append(args, f.AuthorID)
		}
	}
	if f.Before != nil {
		if f.ThreadRootID != "" {
			// Replies (ThreadRootID) are listed oldest first, so the descending
			// Before predicate below would page backwards; refuse rather than
			// return silently wrong pages.
			return nil, fmt.Errorf("MessageFilter.Before is not supported with ThreadRootID")
		}
		query += " AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))"
		args = append(args, millis(f.Before.At), millis(f.Before.At), f.Before.ID)
	}
	query += order + fmt.Sprintf(" LIMIT %d", clampLimit(f.Limit))
	var out []Message
	err := s.queryRows(ctx, query, args, func(r rowScanner) error {
		m, err := scanMessage(r)
		out = append(out, m)
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, s.messageTags(ctx, orgID, out)
}

// GetMessage loads one message.
func (s *Store) GetMessage(ctx context.Context, orgID, messageID string) (Message, error) {
	m, err := scanMessage(s.db.QueryRowContext(ctx, s.q("SELECT "+messageCols+" FROM messages m WHERE m.org_id = ? AND m.id = ?"), orgID, messageID))
	if err != nil {
		return Message{}, notFound(err)
	}
	ms := []Message{m}
	err = s.messageTags(ctx, orgID, ms)
	return ms[0], err
}

const receiptCols = `id, org_id, workspace_id, message_id, agent_id, state, delivered_at, read_at, ack_at, delivered_via_transport,
	held_rule, held_cause, held_at, filtered_rule, filtered_cause, filtered_at, filtered_after_send,
	removed_at, removed_reason, removed_final, removed_cause, created_at, updated_at`

func scanReceipt(r rowScanner) (Receipt, error) {
	var x Receipt
	var via, heldRule, heldCause, fRule, fCause, rmReason, rmCause sql.NullString
	var delivered, read, ack, heldAt, fAt, rmAt sql.NullInt64
	var afterSend, rmFinal sql.NullBool
	var created, updated int64
	if err := r.Scan(&x.ID, &x.OrgID, &x.WorkspaceID, &x.MessageID, &x.AgentID, &x.State, &delivered, &read, &ack, &via,
		&heldRule, &heldCause, &heldAt, &fRule, &fCause, &fAt, &afterSend, &rmAt, &rmReason, &rmFinal, &rmCause, &created, &updated); err != nil {
		return Receipt{}, err
	}
	x.DeliveredAt, x.ReadAt, x.AckAt, x.DeliveredVia = timePtr(delivered), timePtr(read), timePtr(ack), via.String
	x.HeldRule, x.HeldCause, x.HeldAt = heldRule.String, heldCause.String, timePtr(heldAt)
	x.FilteredRule, x.FilteredCause, x.FilteredAt, x.FilteredAfterSend = fRule.String, fCause.String, timePtr(fAt), afterSend.Bool
	if rmAt.Valid {
		x.Removed = &ReceiptRemoved{At: fromMillis(rmAt.Int64), Reason: rmReason.String, Final: rmFinal.Bool, Cause: rmCause.String}
	}
	x.CreatedAt, x.UpdatedAt = fromMillis(created), fromMillis(updated)
	return x, nil
}

// ListReceipts returns a message's receipts, one per targeted agent.
func (s *Store) ListReceipts(ctx context.Context, orgID, messageID string) ([]Receipt, error) {
	var out []Receipt
	err := s.queryRows(ctx, "SELECT "+receiptCols+" FROM receipts WHERE org_id = ? AND message_id = ? ORDER BY agent_id",
		[]any{orgID, messageID}, func(r rowScanner) error {
			x, err := scanReceipt(r)
			out = append(out, x)
			return err
		})
	return out, err
}

// ListAgentReceipts returns the receipts of messages addressed to an
// agent, newest first.
func (s *Store) ListAgentReceipts(ctx context.Context, orgID, agentID string, limit int) ([]Receipt, error) {
	var out []Receipt
	err := s.queryRows(ctx, "SELECT "+receiptCols+" FROM receipts WHERE org_id = ? AND agent_id = ? ORDER BY created_at DESC, id"+
		fmt.Sprintf(" LIMIT %d", clampLimit(limit)), []any{orgID, agentID}, func(r rowScanner) error {
		x, err := scanReceipt(r)
		out = append(out, x)
		return err
	})
	return out, err
}

func scanThread(r rowScanner) (Thread, error) {
	var t Thread
	var last sql.NullInt64
	var participants sql.NullString
	var updated int64
	if err := r.Scan(&t.RootID, &t.OrgID, &t.WorkspaceID, &t.ReplyCount, &last, &participants, &updated); err != nil {
		return Thread{}, err
	}
	ps, err := decodeJSON[[]Author](participants)
	if err != nil {
		return Thread{}, fmt.Errorf("store: thread %s participants: %w", t.RootID, err)
	}
	t.LastReplyAt, t.Participants, t.UpdatedAt = timePtr(last), ps, fromMillis(updated)
	return t, nil
}

// ListThreads returns a workspace's thread summaries, latest reply first.
func (s *Store) ListThreads(ctx context.Context, orgID, workspaceID string) ([]Thread, error) {
	var out []Thread
	err := s.queryRows(ctx, `SELECT id, org_id, workspace_id, reply_count, last_reply_at, participants, updated_at
		  FROM threads WHERE org_id = ? AND workspace_id = ? ORDER BY last_reply_at DESC, id`,
		[]any{orgID, workspaceID}, func(r rowScanner) error {
			t, err := scanThread(r)
			out = append(out, t)
			return err
		})
	return out, err
}

// GetThread loads the thread summary for a root message.
func (s *Store) GetThread(ctx context.Context, orgID, rootID string) (Thread, error) {
	t, err := scanThread(s.db.QueryRowContext(ctx, s.q(`SELECT id, org_id, workspace_id, reply_count, last_reply_at, participants, updated_at
		  FROM threads WHERE org_id = ? AND id = ?`), orgID, rootID))
	return t, notFound(err)
}

// ListTags returns a workspace's tags, most recently used first.
func (s *Store) ListTags(ctx context.Context, orgID, workspaceID string) ([]Tag, error) {
	var out []Tag
	err := s.queryRows(ctx, `SELECT tag, message_count, last_used_at FROM tags
		 WHERE org_id = ? AND workspace_id = ? ORDER BY last_used_at DESC, tag`,
		[]any{orgID, workspaceID}, func(r rowScanner) error {
			var t Tag
			var used int64
			err := r.Scan(&t.Tag, &t.MessageCount, &used)
			t.LastUsedAt = fromMillis(used)
			out = append(out, t)
			return err
		})
	return out, err
}

/* ---------------------------------------------------------------------- */
/* Context notes                                                           */
/* ---------------------------------------------------------------------- */

var noteCols = `id, org_id, workspace_id, title, body, tags, version, created_at, ` + actorCols("created_by") +
	`, updated_at, ` + actorCols("updated_by") + `, deleted_at`

func scanNote(r rowScanner) (ContextNote, error) {
	var n ContextNote
	var tags sql.NullString
	var created, updated int64
	var deleted sql.NullInt64
	var cb, ub actorScan
	dest := append([]any{&n.ID, &n.OrgID, &n.WorkspaceID, &n.Title, &n.Body, &tags, &n.Version, &created}, cb.dest()...)
	dest = append(dest, &updated)
	dest = append(dest, ub.dest()...)
	dest = append(dest, &deleted)
	if err := r.Scan(dest...); err != nil {
		return ContextNote{}, err
	}
	ts, err := decodeJSON[[]string](tags)
	if err != nil {
		return ContextNote{}, fmt.Errorf("store: note %s tags: %w", n.ID, err)
	}
	n.Tags = append([]string{}, ts...)
	n.CreatedAt, n.CreatedBy, n.UpdatedAt, n.UpdatedBy, n.DeletedAt = fromMillis(created), cb.actor(), fromMillis(updated), ub.actor(), timePtr(deleted)
	return n, nil
}

// ListContextNotes returns a workspace's notes that aren't deleted,
// most recently updated first.
func (s *Store) ListContextNotes(ctx context.Context, orgID, workspaceID string) ([]ContextNote, error) {
	var out []ContextNote
	err := s.queryRows(ctx, "SELECT "+noteCols+` FROM context_notes
		 WHERE org_id = ? AND workspace_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id`,
		[]any{orgID, workspaceID}, func(r rowScanner) error {
			n, err := scanNote(r)
			out = append(out, n)
			return err
		})
	return out, err
}

// GetContextNote loads one note.
func (s *Store) GetContextNote(ctx context.Context, orgID, noteID string) (ContextNote, error) {
	n, err := scanNote(s.db.QueryRowContext(ctx, s.q("SELECT "+noteCols+" FROM context_notes WHERE org_id = ? AND id = ?"), orgID, noteID))
	return n, notFound(err)
}

// ListContextNoteVersions returns a note's history, newest version first.
func (s *Store) ListContextNoteVersions(ctx context.Context, orgID, noteID string) ([]ContextNoteVersion, error) {
	var out []ContextNoteVersion
	err := s.queryRows(ctx, "SELECT note_id, version, title, body, tags, at, "+actorCols("by")+
		" FROM context_note_versions WHERE org_id = ? AND note_id = ? ORDER BY version DESC",
		[]any{orgID, noteID}, func(r rowScanner) error {
			var v ContextNoteVersion
			var tags sql.NullString
			var at int64
			var by actorScan
			if err := r.Scan(append([]any{&v.NoteID, &v.Version, &v.Title, &v.Body, &tags, &at}, by.dest()...)...); err != nil {
				return err
			}
			ts, err := decodeJSON[[]string](tags)
			if err != nil {
				return err
			}
			v.Tags, v.At, v.By = append([]string{}, ts...), fromMillis(at), by.actor()
			out = append(out, v)
			return nil
		})
	return out, err
}

/* ---------------------------------------------------------------------- */
/* Webhooks                                                                */
/* ---------------------------------------------------------------------- */

var webhookCols = `id, org_id, workspace_id, message_id, mode,
	fire_url, fire_trigger, fire_auth_user, fire_auth_password IS NOT NULL, fire_delivery_mode, fire_delivery_sidecar_id,
	fire_state, fire_fired_at, fire_next_attempt_at, fire_attempt_count, fire_attempts, fire_outcome_at, fire_dropped,
	listen_listener_id, listen_url, listen_user, listen_password_prefix, listen_password_last4, listen_password_issued_at,
	listen_state, listen_call_count, listen_last_call_at,
	created_at, ` + actorCols("created_by") + `, updated_at, expires_at`

func scanWebhook(r rowScanner) (Webhook, error) {
	var h Webhook
	var url, trigger, user, mode, sidecar, state, attempts, dropped sql.NullString
	var hasPassword sql.NullBool
	var fired, next, outcome, count sql.NullInt64
	var lsn, lURL, lUser, lPrefix, lLast4, lState sql.NullString
	var lIssued, lCount, lLast sql.NullInt64
	var created, updated int64
	var expires sql.NullInt64
	var by actorScan
	dest := []any{&h.ID, &h.OrgID, &h.WorkspaceID, &h.MessageID, &h.Mode,
		&url, &trigger, &user, &hasPassword, &mode, &sidecar, &state, &fired, &next, &count, &attempts, &outcome, &dropped,
		&lsn, &lURL, &lUser, &lPrefix, &lLast4, &lIssued, &lState, &lCount, &lLast, &created}
	dest = append(dest, by.dest()...)
	dest = append(dest, &updated, &expires)
	if err := r.Scan(dest...); err != nil {
		return Webhook{}, err
	}
	h.CreatedAt, h.CreatedBy, h.UpdatedAt, h.ExpiresAt = fromMillis(created), by.actor(), fromMillis(updated), timePtr(expires)
	switch h.Mode {
	case "fire":
		at, err := decodeJSON[[]WebhookAttempt](attempts)
		if err != nil {
			return Webhook{}, fmt.Errorf("store: webhook %s attempts: %w", h.ID, err)
		}
		dr, err := decodeJSON[[]WebhookDropped](dropped)
		if err != nil {
			return Webhook{}, fmt.Errorf("store: webhook %s dropped: %w", h.ID, err)
		}
		h.Fire = &FireHook{
			URL: url.String, Trigger: trigger.String, AuthUser: user.String, HasPassword: hasPassword.Bool,
			DeliveryMode: mode.String, SidecarID: sidecar.String, State: state.String,
			FiredAt: timePtr(fired), NextAttemptAt: timePtr(next), AttemptCount: int(count.Int64),
			Attempts: at, OutcomeAt: timePtr(outcome), Dropped: dr,
		}
	case "listen":
		h.Listen = &Listener{
			ListenerID: lsn.String, URL: lURL.String, User: lUser.String,
			Password: TokenInfo{Prefix: lPrefix.String, Last4: lLast4.String, IssuedAt: fromMillis(lIssued.Int64)},
			State:    lState.String, CallCount: int(lCount.Int64), LastCallAt: timePtr(lLast),
		}
	}
	return h, nil
}

// ListWebhooks returns a workspace's webhooks, newest first.
func (s *Store) ListWebhooks(ctx context.Context, orgID, workspaceID string) ([]Webhook, error) {
	var out []Webhook
	err := s.queryRows(ctx, "SELECT "+webhookCols+" FROM webhooks WHERE org_id = ? AND workspace_id = ? ORDER BY created_at DESC, id",
		[]any{orgID, workspaceID}, func(r rowScanner) error {
			h, err := scanWebhook(r)
			out = append(out, h)
			return err
		})
	return out, err
}

// GetWebhook loads one webhook.
func (s *Store) GetWebhook(ctx context.Context, orgID, webhookID string) (Webhook, error) {
	h, err := scanWebhook(s.db.QueryRowContext(ctx, s.q("SELECT "+webhookCols+" FROM webhooks WHERE org_id = ? AND id = ?"), orgID, webhookID))
	return h, notFound(err)
}

// ListListenerCalls returns the calls to a listener, newest first.
func (s *Store) ListListenerCalls(ctx context.Context, orgID, listenerID string, limit int) ([]ListenerCall, error) {
	var out []ListenerCall
	err := s.queryRows(ctx, `SELECT id, webhook_id, listener_id, message_id, at, status, from_ip, bytes, appended_message_id, trk, summary
		  FROM listener_calls WHERE org_id = ? AND listener_id = ? ORDER BY at DESC, id`+fmt.Sprintf(" LIMIT %d", clampLimit(limit)),
		[]any{orgID, listenerID}, func(r rowScanner) error {
			var c ListenerCall
			var appended, summary sql.NullString
			var at int64
			if err := r.Scan(&c.ID, &c.WebhookID, &c.ListenerID, &c.MessageID, &at, &c.Status, &c.FromIP, &c.Bytes, &appended, &c.Trk, &summary); err != nil {
				return err
			}
			c.At, c.AppendedMessageID, c.Summary = fromMillis(at), appended.String, summary.String
			out = append(out, c)
			return nil
		})
	return out, err
}

// ListDeadLetters returns a workspace's dead letters, newest first.
func (s *Store) ListDeadLetters(ctx context.Context, orgID, workspaceID string) ([]DeadLetter, error) {
	var out []DeadLetter
	err := s.queryRows(ctx, `SELECT id, workspace_id, webhook_id, message_id, url, trigger, attempts, reason, dead_at
		  FROM webhook_dead_letters WHERE org_id = ? AND workspace_id = ? ORDER BY dead_at DESC, id`,
		[]any{orgID, workspaceID}, func(r rowScanner) error {
			var d DeadLetter
			var attempts sql.NullString
			var dead int64
			if err := r.Scan(&d.ID, &d.WorkspaceID, &d.WebhookID, &d.MessageID, &d.URL, &d.Trigger, &attempts, &d.Reason, &dead); err != nil {
				return err
			}
			at, err := decodeJSON[[]WebhookAttempt](attempts)
			d.Attempts, d.DeadAt = at, fromMillis(dead)
			out = append(out, d)
			return err
		})
	return out, err
}

/* ---------------------------------------------------------------------- */
/* Audit                                                                   */
/* ---------------------------------------------------------------------- */

// AuditFilter narrows ListAuditEvents. Zero values mean "any".
type AuditFilter struct {
	WorkspaceID string
	ActorID     string
	Type        string
	// VisibleWorkspaces, when not nil, limits rows to these workspaces plus
	// rows with no workspace: what a member who isn't an org admin sees.
	VisibleWorkspaces []string
	Before            *Cursor // the last row of the previous page; older rows follow
	Limit             int
}

var auditCols = `id, org_id, workspace_id, app, shared, type, severity, at, ` + actorCols("actor") +
	`, subject_kind, subject_id, subject_label, object, result, reason, trk, changes, detail, link_label, link_to`

// ListAuditEvents returns an org's audit rows, shared and Dispatch's own,
// newest first.
func (s *Store) ListAuditEvents(ctx context.Context, orgID string, f AuditFilter) ([]AuditEvent, error) {
	query := "SELECT " + auditCols + " FROM audit_events WHERE org_id = ?"
	args := []any{orgID}
	if f.WorkspaceID != "" {
		query += " AND workspace_id = ?"
		args = append(args, f.WorkspaceID)
	}
	if f.ActorID != "" {
		query += " AND actor_id = ?"
		args = append(args, f.ActorID)
	}
	if f.Type != "" {
		query += " AND type = ?"
		args = append(args, f.Type)
	}
	if f.VisibleWorkspaces != nil {
		if len(f.VisibleWorkspaces) == 0 {
			query += " AND workspace_id IS NULL"
		} else {
			query += " AND (workspace_id IS NULL OR workspace_id IN (" + placeholders(len(f.VisibleWorkspaces)) + "))"
			for _, id := range f.VisibleWorkspaces {
				args = append(args, id)
			}
		}
	}
	if f.Before != nil {
		query += " AND (at < ? OR (at = ? AND id < ?))"
		args = append(args, millis(f.Before.At), millis(f.Before.At), f.Before.ID)
	}
	query += " ORDER BY at DESC, id DESC" + fmt.Sprintf(" LIMIT %d", clampLimit(f.Limit))
	var out []AuditEvent
	err := s.queryRows(ctx, query, args, func(r rowScanner) error {
		var e AuditEvent
		var ws, subKind, subID, subLabel, reason, changes, detail, linkLabel, linkTo sql.NullString
		var at int64
		var actor actorScan
		dest := append([]any{&e.ID, &e.OrgID, &ws, &e.App, &e.Shared, &e.Type, &e.Severity, &at}, actor.dest()...)
		dest = append(dest, &subKind, &subID, &subLabel, &e.Object, &e.Result, &reason, &e.Trk, &changes, &detail, &linkLabel, &linkTo)
		if err := r.Scan(dest...); err != nil {
			return err
		}
		e.WorkspaceID, e.At, e.Actor, e.Reason = ws.String, fromMillis(at), actor.actor(), reason.String
		if subKind.Valid {
			e.Subject = &AuditSubject{Kind: subKind.String, ID: subID.String, Label: subLabel.String}
		}
		if changes.Valid {
			e.Changes = json.RawMessage(changes.String)
		}
		if detail.Valid {
			e.Detail = json.RawMessage(detail.String)
		}
		e.LinkLabel, e.LinkTo = linkLabel.String, linkTo.String
		out = append(out, e)
		return nil
	})
	return out, err
}

/* ---------------------------------------------------------------------- */
/* Settings                                                                */
/* ---------------------------------------------------------------------- */

// GetOrgSettings loads Dispatch's settings for an org. An org with no
// settings row yet gets every notification off.
func (s *Store) GetOrgSettings(ctx context.Context, orgID string) (OrgSettings, error) {
	if _, err := s.GetOrg(ctx, orgID); err != nil {
		return OrgSettings{}, err
	}
	st := OrgSettings{OrgID: orgID}
	var n [5]sql.NullBool
	var grace sql.NullInt64
	var updated int64
	err := s.db.QueryRowContext(ctx, s.q(`SELECT notifications_webhook_failing, notifications_blocked_attempt,
		       notifications_message_expiring, notifications_agent_offline, notifications_member_added,
		       default_grace_seconds, updated_at
		  FROM org_settings WHERE id = ?`), orgID).Scan(&n[0], &n[1], &n[2], &n[3], &n[4], &grace, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return st, nil
	}
	if err != nil {
		return OrgSettings{}, err
	}
	st.Notifications = Notifications{n[0].Bool, n[1].Bool, n[2].Bool, n[3].Bool, n[4].Bool}
	st.DefaultGraceSeconds, st.UpdatedAt = intPtr(grace), fromMillis(updated)
	return st, nil
}

// GetNotifications returns a person's "notify me when" switches in an org:
// their own choices if they have made any, else the org's defaults.
func (s *Store) GetNotifications(ctx context.Context, orgID, userID string) (Notifications, error) {
	var n Notifications
	err := s.db.QueryRowContext(ctx, s.q(`SELECT webhook_failing, blocked_attempt, message_expiring, agent_offline, member_added
		  FROM notification_preferences WHERE org_id = ? AND user_id = ?`), orgID, userID).
		Scan(&n.WebhookFailing, &n.BlockedAttempt, &n.MessageExpiring, &n.AgentOffline, &n.MemberAdded)
	if err == nil {
		return n, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Notifications{}, err
	}
	st, err := s.GetOrgSettings(ctx, orgID)
	return st.Notifications, err
}
