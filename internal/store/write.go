package store

import (
	"cmp"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Workspace and people management: the writes behind the Workspaces,
// Members, Access and People screens. Each write runs in one transaction
// together with its audit row, so a change is never recorded without its
// audit or the other way round.
//
// Every write first locks the org row (SELECT … FOR UPDATE on Postgres;
// SQLite's BEGIN IMMEDIATE already serialises writers), so two admins
// acting at once can't, for example, both demote the last two Owners.
//
// The caller checks who may make a change; these methods check what the
// data must stay true to (the last active Owner, unique names, eligible
// members).

var (
	// ErrLastOwner refuses suspending, demoting or removing an org's last
	// active Owner: nobody could administer the org afterwards.
	ErrLastOwner = errors.New("store: the organization's last active Owner")
	// ErrState refuses a change the record's current state doesn't allow,
	// such as resuming someone who isn't suspended.
	ErrState = errors.New("store: not allowed in the current state")
)

// ValidationError is a write refused because of its input. Msg is safe to
// show to the person who made the request.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, args ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// Change is one field's before and after, as the audit row records it.
type Change struct {
	Field  string `json:"field"`
	Before any    `json:"before"`
	After  any    `json:"after"`
}

// Limits on what people type in.
const (
	MaxWorkspaceName    = 80
	MaxDescription      = 500
	MaxExpiryHours      = 24 * 365
	MaxRetentionDays    = 3650
	DefaultRetention    = 90 // days, as the mock's new workspaces
	defaultAuditDays    = 365
	invitationTTL       = 7 * 24 * time.Hour
	unissuedTokenPrefix = "unissued:"
)

/* ---------------------------------------------------------------------- */
/* Transaction helpers                                                     */
/* ---------------------------------------------------------------------- */

// lockOrg takes the per-org write lock and checks the org is active.
func (s *Store) lockOrg(ctx context.Context, tx *sql.Tx, orgID string) error {
	query := "SELECT status FROM orgs WHERE id = ?"
	if s.dialect == Postgres {
		query += " FOR UPDATE"
	}
	var status string
	err := tx.QueryRowContext(ctx, s.q(query), orgID).Scan(&status)
	if err != nil {
		return notFound(err)
	}
	if status != "active" {
		return ErrNotFound
	}
	return nil
}

// trackingCode is "trk_" and 8 lowercase alphanumerics, as the schema's
// trackingCode.
func trackingCode() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		panic(err)
	}
	b := []byte("trk_")
	for _, c := range buf {
		b = append(b, alphabet[int(c)%len(alphabet)])
	}
	return string(b)
}

// auditRow is one audit event to write. A shared row records shared facts
// only (Changes); a Dispatch row records Dispatch's own (Detail, as
// detail.kind "admin").
type auditRow struct {
	OrgID       string
	WorkspaceID string
	Shared      bool
	Type        string // admin when empty
	Severity    string // info when empty
	Subject     *AuditSubject
	Object      string
	Result      string // Done when empty
	Reason      string
	Changes     []Change
	CausationID string
}

func (s *Store) insertAudit(ctx context.Context, tx *sql.Tx, by Actor, now time.Time, e auditRow) (string, error) {
	var retention sql.NullInt64
	if err := tx.QueryRowContext(ctx, s.q("SELECT audit_retention_days FROM orgs WHERE id = ?"), e.OrgID).Scan(&retention); err != nil {
		return "", err
	}
	days := int64(defaultAuditDays)
	if retention.Valid && retention.Int64 > 0 {
		days = retention.Int64
	}
	severity, result, typ := e.Severity, e.Result, e.Type
	if typ == "" {
		typ = "admin"
	}
	if severity == "" {
		severity = "info"
	}
	if result == "" {
		result = "Done"
	}
	var changes, detail any
	if len(e.Changes) > 0 {
		b, err := json.Marshal(e.Changes)
		if err != nil {
			return "", err
		}
		if e.Shared {
			changes = string(b)
		} else {
			d, err := json.Marshal(map[string]any{"kind": "admin", "changes": e.Changes})
			if err != nil {
				return "", err
			}
			detail = string(d)
		}
	}
	var subKind, subID, subLabel any
	if e.Subject != nil {
		subKind, subID, subLabel = e.Subject.Kind, nullable(e.Subject.ID), e.Subject.Label
	}
	var viaKind, viaID, viaLabel any
	if by.Via != nil {
		viaKind, viaID, viaLabel = by.Via.Kind, nullable(by.Via.ID), by.Via.Label
	}
	id := NewID("ev")
	_, err := tx.ExecContext(ctx, s.q(`INSERT INTO audit_events (id, org_id, workspace_id, app, shared, type, severity, at,
		    actor_kind, actor_id, actor_label, actor_via_kind, actor_via_id, actor_via_label,
		    subject_kind, subject_id, subject_label, object, result, reason, trk, causation_id, changes, detail, expire_at)
		 VALUES (?, ?, ?, 'dispatch', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		id, e.OrgID, nullable(e.WorkspaceID), e.Shared, typ, severity, millis(now),
		by.Kind, nullable(by.ID), by.Label, viaKind, viaID, viaLabel,
		subKind, subID, subLabel, e.Object, result, nullable(e.Reason), trackingCode(), nullable(e.CausationID), changes, detail,
		millis(now.Add(time.Duration(days)*24*time.Hour)))
	return id, err
}

// principalLabel is a user's name (or email) or an agent's label, for
// audit text. Unknown principals read as their ID.
func (s *Store) principalLabel(ctx context.Context, tx *sql.Tx, orgID, kind, id string) string {
	var label string
	var err error
	switch kind {
	case "user":
		var name, email string
		err = tx.QueryRowContext(ctx, s.q("SELECT name, email FROM users WHERE id = ?"), id).Scan(&name, &email)
		label = name
		if label == "" {
			label = email
		}
	case "agent":
		err = tx.QueryRowContext(ctx, s.q("SELECT label FROM agents WHERE org_id = ? AND id = ?"), orgID, id).Scan(&label)
	}
	if err != nil || label == "" {
		return id
	}
	return label
}

func accessLabel(read, write bool) string {
	switch {
	case read && write:
		return "read + write"
	case read:
		return "read"
	case write:
		return "write"
	}
	return "none"
}

/* ---------------------------------------------------------------------- */
/* Workspaces                                                              */
/* ---------------------------------------------------------------------- */

// WorkspaceInput is a new workspace.
type WorkspaceInput struct {
	Name               string
	Description        string
	DefaultExpiryHours *int // nil: messages don't expire by default
	RetentionDays      int  // 0: DefaultRetention
}

// WorkspacePatch changes a workspace. Nil fields are left as they are; set
// SetExpiry to change DefaultExpiryHours (nil then means no expiry).
type WorkspacePatch struct {
	Name               *string
	Description        *string
	SetExpiry          bool
	DefaultExpiryHours *int
	RetentionDays      *int
}

func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", invalid("a workspace needs a name")
	case len([]rune(name)) > MaxWorkspaceName:
		return "", invalid("a workspace name is at most %d characters", MaxWorkspaceName)
	}
	return name, nil
}

func checkSettings(desc string, expiry *int, retention int) error {
	if len([]rune(desc)) > MaxDescription {
		return invalid("the description is at most %d characters", MaxDescription)
	}
	if expiry != nil && (*expiry < 1 || *expiry > MaxExpiryHours) {
		return invalid("default expiry must be between 1 and %d hours, or none", MaxExpiryHours)
	}
	if retention < 1 || retention > MaxRetentionDays {
		return invalid("retention must be between 1 and %d days", MaxRetentionDays)
	}
	return nil
}

// nameTaken reports whether another active workspace in the org has this
// name, ignoring case.
func (s *Store) nameTaken(ctx context.Context, tx *sql.Tx, orgID, name, except string) (bool, error) {
	var n int
	err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM workspaces
		 WHERE org_id = ? AND status = 'active' AND lower(name) = ? AND id <> ?`), orgID, strings.ToLower(name), except).Scan(&n)
	return n > 0, err
}

func (s *Store) activeWorkspace(ctx context.Context, tx *sql.Tx, orgID, wsID string) (Workspace, error) {
	if err := s.materializeSettings(ctx, tx, orgID, wsID, time.Now()); err != nil {
		return Workspace{}, err
	}
	w, err := scanWorkspace(tx.QueryRowContext(ctx, s.q("SELECT "+workspaceCols+workspaceFrom+" WHERE w.org_id = ? AND w.id = ?"), orgID, wsID))
	if err != nil {
		return Workspace{}, notFound(err)
	}
	if w.Status != "active" {
		return Workspace{}, ErrNotFound
	}
	return w, nil
}

// ensureSettings creates the Dispatch settings row for a workspace that
// has none yet (one created outside Dispatch).
func (s *Store) ensureSettings(ctx context.Context, tx *sql.Tx, orgID, wsID string, now time.Time) error {
	_, err := tx.ExecContext(ctx, s.q(`INSERT INTO workspace_settings (id, org_id, retention_days, updated_at, rev)
		 VALUES (?, ?, ?, ?, 0) ON CONFLICT (id) DO NOTHING`), wsID, orgID, DefaultRetention, millis(now))
	return err
}

// materializeSettings creates the Dispatch settings row (ensureSettings
// semantics: DefaultRetention, rev 0) for a workspace that has none yet --
// the supported "created outside Dispatch" state. It only inserts for a
// workspace row that exists (INSERT ... SELECT FROM workspaces) and is
// idempotent (ON CONFLICT DO NOTHING), so every read path and every write
// pre-read can run it ahead of the scan; wsID == "" covers the whole org.
// Without it, the missing row failed scanWorkspace: a 500 for GetWorkspace,
// the entire org list, and every write that pre-reads via activeWorkspace.
func (s *Store) materializeSettings(ctx context.Context, ex execer, orgID, wsID string, now time.Time) error {
	query := `INSERT INTO workspace_settings (id, org_id, retention_days, updated_at, rev)
		SELECT w.id, w.org_id, ?, ?, 0 FROM workspaces w
		LEFT JOIN workspace_settings ws ON ws.id = w.id
		WHERE w.org_id = ? AND ws.id IS NULL`
	args := []any{DefaultRetention, millis(now), orgID}
	if wsID != "" {
		query += " AND w.id = ?"
		args = append(args, wsID)
	}
	query += " ON CONFLICT (id) DO NOTHING"
	_, err := ex.ExecContext(ctx, s.q(query), args...)
	return err
}

// CreateWorkspace creates a workspace in an org. A user creating it
// becomes its first admin. A name already used by an active workspace in
// the org (ignoring case) is ErrExists.
func (s *Store) CreateWorkspace(ctx context.Context, orgID string, by Actor, in WorkspaceInput, now time.Time) (Workspace, error) {
	name, err := cleanName(in.Name)
	if err != nil {
		return Workspace{}, err
	}
	desc := strings.TrimSpace(in.Description)
	retention := in.RetentionDays
	if retention == 0 {
		retention = DefaultRetention
	}
	if err := checkSettings(desc, in.DefaultExpiryHours, retention); err != nil {
		return Workspace{}, err
	}
	id := NewID("ws")
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		if taken, err := s.nameTaken(ctx, tx, orgID, name, ""); err != nil {
			return err
		} else if taken {
			return ErrExists
		}
		ms := millis(now)
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO workspaces (id, org_id, name, status, created_at, created_by_kind, created_by_id, updated_at, updated_by_kind, updated_by_id, rev)
			 VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 0)`),
			id, orgID, name, ms, by.Kind, by.ID, ms, by.Kind, by.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO workspace_settings (id, org_id, description, default_expiry_hours, retention_days,
			    updated_at, updated_by_kind, updated_by_id, updated_by_label, rev)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
			id, orgID, nullable(desc), in.DefaultExpiryHours, retention, ms, by.Kind, by.ID, by.Label); err != nil {
			return err
		}
		shared, err := s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: id, Shared: true,
			Subject: &AuditSubject{Kind: "workspace", ID: id, Label: name},
			Object:  "Created workspace " + name,
			Changes: []Change{{Field: "name", Before: nil, After: name}},
		})
		if err != nil {
			return err
		}
		if by.Kind != "user" {
			return nil
		}
		mid := NewID("wm")
		if err := s.insertMembership(ctx, tx, orgID, id, mid, "user", by.ID, WSRoleAdmin, true, true, by, now); err != nil {
			return err
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: id, Shared: true, CausationID: shared,
			Subject: &AuditSubject{Kind: "user", ID: by.ID, Label: by.Label},
			Object:  fmt.Sprintf("Added %s (user) to %s as admin", by.Label, name),
			Changes: []Change{{Field: "member", Before: nil, After: map[string]string{"kind": "user", "id": by.ID, "role": "workspace_admin"}}},
		})
		return err
	})
	if err != nil {
		return Workspace{}, err
	}
	return s.GetWorkspace(ctx, orgID, id)
}

// UpdateWorkspace changes an active workspace's name and Dispatch settings.
func (s *Store) UpdateWorkspace(ctx context.Context, orgID, wsID string, by Actor, p WorkspacePatch, now time.Time) (Workspace, error) {
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		name, desc, expiry, retention := w.Name, w.Description, w.DefaultExpiryHours, w.RetentionDays
		if retention == 0 {
			retention = DefaultRetention
		}
		if p.Name != nil {
			if name, err = cleanName(*p.Name); err != nil {
				return err
			}
		}
		if p.Description != nil {
			desc = strings.TrimSpace(*p.Description)
		}
		if p.SetExpiry {
			expiry = p.DefaultExpiryHours
		}
		if p.RetentionDays != nil {
			retention = *p.RetentionDays
		}
		if err := checkSettings(desc, expiry, retention); err != nil {
			return err
		}
		ms := millis(now)
		var causation string
		if name != w.Name {
			if taken, err := s.nameTaken(ctx, tx, orgID, name, wsID); err != nil {
				return err
			} else if taken {
				return ErrExists
			}
			if _, err := tx.ExecContext(ctx, s.q(`UPDATE workspaces SET name = ?, updated_at = ?, updated_by_kind = ?, updated_by_id = ?, rev = rev + 1
				 WHERE org_id = ? AND id = ?`), name, ms, by.Kind, by.ID, orgID, wsID); err != nil {
				return err
			}
			if causation, err = s.insertAudit(ctx, tx, by, now, auditRow{
				OrgID: orgID, WorkspaceID: wsID, Shared: true,
				Subject: &AuditSubject{Kind: "workspace", ID: wsID, Label: name},
				Object:  fmt.Sprintf("Renamed workspace %s to %s", w.Name, name),
				Changes: []Change{{Field: "name", Before: w.Name, After: name}},
			}); err != nil {
				return err
			}
		}
		var changes []Change
		if desc != w.Description {
			changes = append(changes, Change{Field: "description", Before: w.Description, After: desc})
		}
		if !sameIntPtr(expiry, w.DefaultExpiryHours) {
			changes = append(changes, Change{Field: "defaultExpiryHours", Before: w.DefaultExpiryHours, After: expiry})
		}
		if retention != w.RetentionDays {
			changes = append(changes, Change{Field: "retentionDays", Before: w.RetentionDays, After: retention})
		}
		if len(changes) == 0 {
			return nil
		}
		if err := s.ensureSettings(ctx, tx, orgID, wsID, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE workspace_settings SET description = ?, default_expiry_hours = ?, retention_days = ?,
			    updated_at = ?, updated_by_kind = ?, updated_by_id = ?, updated_by_label = ?, rev = rev + 1
			 WHERE org_id = ? AND id = ?`),
			nullable(desc), expiry, retention, ms, by.Kind, by.ID, by.Label, orgID, wsID); err != nil {
			return err
		}
		fields := make([]string, len(changes))
		for i, c := range changes {
			fields[i] = c.Field
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, CausationID: causation,
			Subject: &AuditSubject{Kind: "workspace", ID: wsID, Label: name},
			Object:  fmt.Sprintf("Changed %s settings · %s", name, strings.Join(fields, ", ")),
			Changes: changes,
		})
		return err
	})
	if err != nil {
		return Workspace{}, err
	}
	return s.GetWorkspace(ctx, orgID, wsID)
}

func sameIntPtr(a, b *int) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// DeleteWorkspace soft-deletes an active workspace: it drops out of every
// list, its agents' workspace tokens are revoked, and its audit rows keep
// resolving its name.
func (s *Store) DeleteWorkspace(ctx context.Context, orgID, wsID string, by Actor, now time.Time) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		ms := millis(now)
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE workspaces SET status = 'deleted', deleted_at = ?, deleted_by_kind = ?, deleted_by_id = ?,
			    updated_at = ?, updated_by_kind = ?, updated_by_id = ?, rev = rev + 1
			 WHERE org_id = ? AND id = ?`), ms, by.Kind, by.ID, ms, by.Kind, by.ID, orgID, wsID); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, s.q(`UPDATE membership_access SET token_revoked_at = ?, updated_at = ?, rev = rev + 1
			 WHERE org_id = ? AND workspace_id = ? AND member_kind = 'agent' AND token_revoked_at IS NULL`), ms, ms, orgID, wsID)
		if err != nil {
			return err
		}
		revoked, err := res.RowsAffected()
		if err != nil {
			return err
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Shared: true, Severity: "warn",
			Subject: &AuditSubject{Kind: "workspace", ID: wsID, Label: w.Name},
			Object:  "Deleted workspace " + w.Name,
			Result:  fmt.Sprintf("Deleted · audit kept · %d workspace tokens revoked", revoked),
			Changes: []Change{{Field: "status", Before: "active", After: "deleted"}},
		})
		return err
	})
}

/* ---------------------------------------------------------------------- */
/* Workspace members                                                       */
/* ---------------------------------------------------------------------- */

// Workspace roles, as the shared schema has them.
const (
	WSRoleMember = "member"
	WSRoleAdmin  = "workspace_admin"
)

// MemberInput adds a user or agent to a workspace. Write implies read; a
// user always reads.
type MemberInput struct {
	Kind  string // user or agent
	ID    string
	Role  string // member or workspace_admin
	Read  bool
	Write bool
}

// MemberPatch changes a membership. Nil fields are left as they are.
type MemberPatch struct {
	Role  *string
	Read  *bool
	Write *bool
}

// insertMembership writes the shared membership row and its access row. An
// agent's access row gets an unusable placeholder token: the schema wants
// a token hash on every agent membership, and issuing the real workspace
// token is the Connect tab's job. No token can hash to "unissued:…".
func (s *Store) insertMembership(ctx context.Context, tx *sql.Tx, orgID, wsID, id, kind, memberID, role string, read, write bool, by Actor, now time.Time) error {
	ms := millis(now)
	sharedRole := role
	if kind == "agent" {
		sharedRole = WSRoleMember
	}
	var delKind, delID, delAt any
	if role == WSRoleAdmin && by.ID != memberID {
		delKind, delID, delAt = by.Kind, by.ID, ms
	}
	if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO workspace_memberships (id, org_id, workspace_id, member_kind, member_id, role,
		    added_at, added_by_kind, added_by_id, delegated_by_kind, delegated_by_id, delegated_at, updated_at, rev)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
		id, orgID, wsID, kind, memberID, sharedRole, ms, by.Kind, by.ID, delKind, delID, delAt, ms); err != nil {
		if isUniqueViolation(err) {
			return ErrExists
		}
		return err
	}
	if kind == "user" {
		_, err := tx.ExecContext(ctx, s.q(`INSERT INTO membership_access (id, org_id, workspace_id, member_kind, member_id, read, write,
			    updated_at, updated_by_kind, updated_by_id, updated_by_label, rev)
			 VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, 0)`),
			id, orgID, wsID, memberID, true, write, ms, by.Kind, by.ID, by.Label)
		return err
	}
	_, err := tx.ExecContext(ctx, s.q(`INSERT INTO membership_access (id, org_id, workspace_id, member_kind, member_id, read, write,
		    agent_role, delegated_by_kind, delegated_by_id, token_current_alg, token_current_hash, token_delivery,
		    updated_at, updated_by_kind, updated_by_id, updated_by_label, rev)
		 VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, 'sha256', ?, 'shown_once', ?, ?, ?, ?, 0)`),
		id, orgID, wsID, memberID, read || write, write, role, delKind, delID, unissuedTokenPrefix+id, ms, by.Kind, by.ID, by.Label)
	return err
}

func isUniqueViolation(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "unique") || strings.Contains(msg, "duplicate key")
}

// eligibleMember checks a principal may join a workspace in the org: a
// user with an active or invited org membership, or an agent of the org
// that isn't revoked or retired.
func (s *Store) eligibleMember(ctx context.Context, tx *sql.Tx, orgID, kind, id string) error {
	switch kind {
	case "user":
		var status string
		err := tx.QueryRowContext(ctx, s.q("SELECT status FROM org_memberships WHERE org_id = ? AND user_id = ?"), orgID, id).Scan(&status)
		if errors.Is(err, sql.ErrNoRows) {
			return invalid("that person isn't in this organization")
		}
		if err != nil {
			return err
		}
		if status == "suspended" {
			return invalid("that person is suspended in this organization")
		}
	case "agent":
		var status string
		var retired sql.NullInt64
		err := tx.QueryRowContext(ctx, s.q(`SELECT p.status, g.retired_at FROM agents g JOIN agent_profiles p ON p.id = g.id
			 WHERE g.org_id = ? AND g.id = ?`), orgID, id).Scan(&status, &retired)
		if errors.Is(err, sql.ErrNoRows) {
			return invalid("that agent isn't in this organization")
		}
		if err != nil {
			return err
		}
		if status == "revoked" || retired.Valid {
			return invalid("that agent is revoked")
		}
	default:
		return invalid("a member is a user or an agent")
	}
	return nil
}

// AddWorkspaceMember adds a user or agent to an active workspace. A
// principal who is already a member is ErrExists.
func (s *Store) AddWorkspaceMember(ctx context.Context, orgID, wsID string, by Actor, in MemberInput, now time.Time) (WorkspaceMember, error) {
	if in.Role == "" {
		in.Role = WSRoleMember
	}
	if in.Role != WSRoleMember && in.Role != WSRoleAdmin {
		return WorkspaceMember{}, invalid("role must be member or workspace_admin")
	}
	read := in.Read || in.Write || in.Kind == "user"
	id := NewID("wm")
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		if err := s.eligibleMember(ctx, tx, orgID, in.Kind, in.ID); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM workspace_memberships
			 WHERE org_id = ? AND workspace_id = ? AND member_kind = ? AND member_id = ?`), orgID, wsID, in.Kind, in.ID).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return ErrExists
		}
		if err := s.insertMembership(ctx, tx, orgID, wsID, id, in.Kind, in.ID, in.Role, read, in.Write, by, now); err != nil {
			return err
		}
		label := s.principalLabel(ctx, tx, orgID, in.Kind, in.ID)
		role := "member"
		if in.Role == WSRoleAdmin {
			role = "admin"
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Shared: true,
			Subject: &AuditSubject{Kind: in.Kind, ID: in.ID, Label: label},
			Object:  fmt.Sprintf("Added %s (%s) to %s as %s (%s)", label, in.Kind, w.Name, role, accessLabel(read, in.Write)),
			Changes: []Change{{Field: "member", Before: nil, After: map[string]string{"kind": in.Kind, "id": in.ID, "role": in.Role}}},
		})
		return err
	})
	if err != nil {
		return WorkspaceMember{}, err
	}
	return s.GetWorkspaceMember(ctx, orgID, wsID, id)
}

// GetWorkspaceMember loads one membership of a workspace.
func (s *Store) GetWorkspaceMember(ctx context.Context, orgID, wsID, membershipID string) (WorkspaceMember, error) {
	m, err := scanMember(s.db.QueryRowContext(ctx, s.q("SELECT "+memberCols+memberFrom+
		" WHERE m.org_id = ? AND m.workspace_id = ? AND m.id = ?"), orgID, wsID, membershipID))
	return m, notFound(err)
}

func (s *Store) memberInTx(ctx context.Context, tx *sql.Tx, orgID, wsID, membershipID string) (WorkspaceMember, error) {
	m, err := scanMember(tx.QueryRowContext(ctx, s.q("SELECT "+memberCols+memberFrom+
		" WHERE m.org_id = ? AND m.workspace_id = ? AND m.id = ?"), orgID, wsID, membershipID))
	return m, notFound(err)
}

// effectiveRole is member or workspace_admin: an agent's admin role lives
// in membership_access, a user's in the shared row.
func effectiveRole(m WorkspaceMember) string {
	if m.Member.Kind == "agent" {
		if m.AgentRole == WSRoleAdmin {
			return WSRoleAdmin
		}
		return WSRoleMember
	}
	return m.Role
}

// EffectiveRole is a membership's role, member or workspace_admin.
func (m WorkspaceMember) EffectiveRole() string { return effectiveRole(m) }

// UpdateWorkspaceMember changes a membership's role or its read and write
// access. Turning write on turns read on; turning read off turns write
// off; a user always reads.
func (s *Store) UpdateWorkspaceMember(ctx context.Context, orgID, wsID, membershipID string, by Actor, p MemberPatch, now time.Time) (WorkspaceMember, error) {
	if p.Role != nil && *p.Role != WSRoleMember && *p.Role != WSRoleAdmin {
		return WorkspaceMember{}, invalid("role must be member or workspace_admin")
	}
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		m, err := s.memberInTx(ctx, tx, orgID, wsID, membershipID)
		if err != nil {
			return err
		}
		label := s.principalLabel(ctx, tx, orgID, m.Member.Kind, m.Member.ID)
		subject := &AuditSubject{Kind: m.Member.Kind, ID: m.Member.ID, Label: label}
		ms := millis(now)
		user := m.Member.Kind == "user"
		if was := effectiveRole(m); p.Role != nil && *p.Role != was {
			promote := *p.Role == WSRoleAdmin
			var fallback []wsRef
			if user && !promote {
				if fallback, err = s.soleAdminOf(ctx, tx, orgID, m.Member.ID, wsID); err != nil {
					return err
				}
			}
			var delKind, delID, delAt any
			if promote {
				delKind, delID, delAt = by.Kind, by.ID, ms
			}
			if user {
				_, err = tx.ExecContext(ctx, s.q(`UPDATE workspace_memberships SET role = ?, delegated_by_kind = ?, delegated_by_id = ?, delegated_at = ?,
					    updated_at = ?, rev = rev + 1 WHERE id = ?`), *p.Role, delKind, delID, delAt, ms, m.ID)
			} else {
				if _, err = tx.ExecContext(ctx, s.q(`UPDATE workspace_memberships SET delegated_by_kind = ?, delegated_by_id = ?, delegated_at = ?,
					    updated_at = ? WHERE id = ?`), delKind, delID, delAt, ms, m.ID); err != nil {
					return err
				}
				_, err = tx.ExecContext(ctx, s.q(`UPDATE membership_access SET agent_role = ?, delegated_by_kind = ?, delegated_by_id = ?,
					    updated_at = ?, updated_by_kind = ?, updated_by_id = ?, updated_by_label = ?, rev = rev + 1 WHERE id = ?`),
					*p.Role, delKind, delID, ms, by.Kind, by.ID, by.Label, m.ID)
			}
			if err != nil {
				return err
			}
			object := fmt.Sprintf("Removed admin on %s from %s", w.Name, label)
			if promote {
				object = fmt.Sprintf("Delegated admin on %s to %s (%s)", w.Name, label, m.Member.Kind)
			}
			// A user's role is a shared fact; an agent's admin is Dispatch's own.
			if _, err := s.insertAudit(ctx, tx, by, now, auditRow{
				OrgID: orgID, WorkspaceID: wsID, Shared: user, Subject: subject, Object: object,
				Changes: []Change{{Field: "role", Before: was, After: *p.Role}},
			}); err != nil {
				return err
			}
			if err := s.auditDefaultAdmins(ctx, tx, by, now, orgID, fallback); err != nil {
				return err
			}
		}
		read, write := m.Read, m.Write
		if p.Read != nil {
			read = *p.Read
		}
		if p.Write != nil {
			write = *p.Write
		}
		if p.Write != nil && write {
			read = true
		}
		if p.Read != nil && !read {
			write = false
		}
		if user {
			read = true
		}
		if read == m.Read && write == m.Write {
			return nil
		}
		res, err := tx.ExecContext(ctx, s.q(`UPDATE membership_access SET read = ?, write = ?,
			    updated_at = ?, updated_by_kind = ?, updated_by_id = ?, updated_by_label = ?, rev = rev + 1 WHERE id = ?`),
			read, write, ms, by.Kind, by.ID, by.Label, m.ID)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil {
			return err
		} else if n == 0 && user {
			// A user added outside Dispatch has no access row yet.
			if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO membership_access (id, org_id, workspace_id, member_kind, member_id, read, write,
				    updated_at, updated_by_kind, updated_by_id, updated_by_label, rev)
				 VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, 0)`),
				m.ID, orgID, wsID, m.Member.ID, true, write, ms, by.Kind, by.ID, by.Label); err != nil {
				return err
			}
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Subject: subject,
			Object:  fmt.Sprintf("Changed %s's access in %s → %s", label, w.Name, accessLabel(read, write)),
			Changes: []Change{{Field: "access", Before: accessLabel(m.Read, m.Write), After: accessLabel(read, write)}},
		})
		return err
	})
	if err != nil {
		return WorkspaceMember{}, err
	}
	return s.GetWorkspaceMember(ctx, orgID, wsID, membershipID)
}

// RemoveWorkspaceMember removes a membership and returns it. An agent's
// workspace token goes with it. Its messages, receipts and audit rows
// stay.
func (s *Store) RemoveWorkspaceMember(ctx context.Context, orgID, wsID, membershipID string, by Actor, now time.Time) (WorkspaceMember, error) {
	var removed WorkspaceMember
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		m, err := s.memberInTx(ctx, tx, orgID, wsID, membershipID)
		if err != nil {
			return err
		}
		removed = m
		var fallback []wsRef
		if m.Member.Kind == "user" {
			if fallback, err = s.soleAdminOf(ctx, tx, orgID, m.Member.ID, wsID); err != nil {
				return err
			}
		}
		if err := s.deleteMembership(ctx, tx, m.ID); err != nil {
			return err
		}
		label := s.principalLabel(ctx, tx, orgID, m.Member.Kind, m.Member.ID)
		object := fmt.Sprintf("Removed %s from %s", label, w.Name)
		if m.Member.Kind == "agent" {
			object += " — its workspace token stops working now"
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Shared: true,
			Subject: &AuditSubject{Kind: m.Member.Kind, ID: m.Member.ID, Label: label},
			Object:  object,
			Changes: []Change{{Field: "member", Before: map[string]string{"kind": m.Member.Kind, "id": m.Member.ID, "role": effectiveRole(m)}, After: nil}},
		})
		if err != nil {
			return err
		}
		return s.auditDefaultAdmins(ctx, tx, by, now, orgID, fallback)
	})
	return removed, err
}

/* ---------------------------------------------------------------------- */
/* Default admins                                                          */
/* ---------------------------------------------------------------------- */

// A workspace's named human admins are its active people with the
// workspace_admin role. With none, the org's active Owners and userAdmins
// are its default admins. Agent admins never count.

// wsRef is a workspace's ID and name.
type wsRef struct{ ID, Name string }

// soleAdminOf lists the active workspaces where userID is the only active
// named human admin (only wsID, when set): the ones that fall back to the
// default admins if that person stops being one.
func (s *Store) soleAdminOf(ctx context.Context, tx *sql.Tx, orgID, userID, wsID string) ([]wsRef, error) {
	query := `SELECT w.id, w.name FROM workspace_memberships wm
		   JOIN workspaces w ON w.id = wm.workspace_id AND w.status = 'active'
		   JOIN org_memberships om ON om.org_id = wm.org_id AND om.user_id = wm.member_id AND om.status = 'active'
		  WHERE wm.org_id = ? AND wm.member_kind = 'user' AND wm.member_id = ? AND wm.role = 'workspace_admin'
		    AND NOT EXISTS (SELECT 1 FROM workspace_memberships o
		                      JOIN org_memberships oo ON oo.org_id = o.org_id AND oo.user_id = o.member_id AND oo.status = 'active'
		                     WHERE o.org_id = wm.org_id AND o.workspace_id = wm.workspace_id AND o.member_kind = 'user'
		                       AND o.role = 'workspace_admin' AND o.member_id <> wm.member_id)`
	args := []any{orgID, userID}
	if wsID != "" {
		query += " AND w.id = ?"
		args = append(args, wsID)
	}
	rows, err := tx.QueryContext(ctx, s.q(query+" ORDER BY w.name"), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []wsRef
	for rows.Next() {
		var w wsRef
		if err := rows.Scan(&w.ID, &w.Name); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// auditDefaultAdmins records that each workspace in wss lost its last
// named human admin and fell back to the default admins, as the mock does.
func (s *Store) auditDefaultAdmins(ctx context.Context, tx *sql.Tx, by Actor, now time.Time, orgID string, wss []wsRef) error {
	if len(wss) == 0 {
		return nil
	}
	rows, err := tx.QueryContext(ctx, s.q(`SELECT u.name, u.email FROM org_memberships om JOIN users u ON u.id = om.user_id
		 WHERE om.org_id = ? AND om.status = 'active' AND om.role IN ('Owner', 'userAdmin') ORDER BY u.name, u.email`), orgID)
	if err != nil {
		return err
	}
	var names []string
	for rows.Next() {
		var name, email string
		if err := rows.Scan(&name, &email); err != nil {
			rows.Close()
			return err
		}
		names = append(names, cmp.Or(name, email))
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	list := cmp.Or(strings.Join(names, ", "), "none")
	for _, w := range wss {
		if _, err := s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: w.ID,
			Object:  fmt.Sprintf("%s has no explicit human admin — default admins: %s (org Owners/userAdmins)", w.Name, list),
			Result:  "Default admins",
			Reason:  "Every workspace has at least one human admin. Agent admins keep their role but never replace the human admin.",
			Changes: []Change{{Field: "explicitHumanAdmins", Before: "yes", After: "none — default admins " + list}},
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) deleteMembership(ctx context.Context, tx *sql.Tx, id string) error {
	if _, err := tx.ExecContext(ctx, s.q("DELETE FROM membership_access WHERE id = ?"), id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, s.q("DELETE FROM workspace_memberships WHERE id = ?"), id)
	return err
}

/* ---------------------------------------------------------------------- */
/* Workspace blocklist                                                     */
/* ---------------------------------------------------------------------- */

// SetWorkspaceBlock puts an agent of the org on a workspace's blocklist
// (blocked true) or takes it off. Doing what is already done changes
// nothing and writes no audit row; it reports whether anything changed.
func (s *Store) SetWorkspaceBlock(ctx context.Context, orgID, wsID, agentID string, blocked bool, by Actor, now time.Time) (bool, error) {
	var changed bool
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		w, err := s.activeWorkspace(ctx, tx, orgID, wsID)
		if err != nil {
			return err
		}
		var res sql.Result
		if blocked {
			var one int
			err := tx.QueryRowContext(ctx, s.q("SELECT 1 FROM agents WHERE org_id = ? AND id = ?"), orgID, agentID).Scan(&one)
			if errors.Is(err, sql.ErrNoRows) {
				return invalid("that agent isn't in this organization")
			}
			if err != nil {
				return err
			}
			if err := s.ensureSettings(ctx, tx, orgID, wsID, now); err != nil {
				return err
			}
			res, err = tx.ExecContext(ctx, s.q(`INSERT INTO workspace_settings_agent_blocklist (workspace_id, org_id, agent_id)
				 VALUES (?, ?, ?) ON CONFLICT (workspace_id, agent_id) DO NOTHING`), wsID, orgID, agentID)
			if err != nil {
				return err
			}
		} else {
			res, err = tx.ExecContext(ctx, s.q(`DELETE FROM workspace_settings_agent_blocklist
				 WHERE org_id = ? AND workspace_id = ? AND agent_id = ?`), orgID, wsID, agentID)
			if err != nil {
				return err
			}
		}
		n, err := res.RowsAffected()
		if err != nil || n == 0 {
			return err
		}
		changed = true
		label := s.principalLabel(ctx, tx, orgID, "agent", agentID)
		object := fmt.Sprintf("Added %s to %s blocklist", label, w.Name)
		severity := "warn"
		if !blocked {
			object, severity = fmt.Sprintf("Removed %s from %s blocklist", label, w.Name), "info"
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, WorkspaceID: wsID, Severity: severity,
			Subject: &AuditSubject{Kind: "agent", ID: agentID, Label: label},
			Object:  object,
			Changes: []Change{{Field: "agentBlocklist", Before: !blocked, After: blocked}},
		})
		return err
	})
	return changed, err
}

/* ---------------------------------------------------------------------- */
/* People                                                                  */
/* ---------------------------------------------------------------------- */

func (s *Store) orgMemberInTx(ctx context.Context, tx *sql.Tx, orgID, userID string) (OrgMember, error) {
	var om OrgMember
	m, err := scanOrgMembership(tx.QueryRowContext(ctx, s.q(`SELECT `+orgMembershipCols+`, u.name, u.email, u.status
		  FROM org_memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?`), orgID, userID),
		&om.Name, &om.Email, &om.UserStatus)
	if err != nil {
		return OrgMember{}, notFound(err)
	}
	om.OrgMembership = m
	return om, nil
}

func memberLabel(m OrgMember) string {
	if m.Name != "" {
		return m.Name
	}
	return m.Email
}

// lastActiveOwner reports whether m is the org's only active Owner.
func (s *Store) lastActiveOwner(ctx context.Context, tx *sql.Tx, m OrgMember) (bool, error) {
	if m.Role != RoleOwner || m.Status != "active" {
		return false, nil
	}
	var n int
	err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM org_memberships WHERE org_id = ? AND role = 'Owner' AND status = 'active'`), m.OrgID).Scan(&n)
	return n <= 1, err
}

// Invitation is a pending invitation to an org, as the People screen
// shows it. The token is never read back.
type Invitation struct {
	ID        string
	OrgID     string
	Email     string
	Role      string
	Status    string
	InvitedAt time.Time
	InvitedBy Principal
	ExpiresAt time.Time
}

// InvitationTokenPrefix starts every invitation token, as in the mock.
const InvitationTokenPrefix = "dsp_inv_"

// InviteToOrg invites an email address to an org with a role. It creates
// a pending user, an invited org membership and a pending invitation whose
// token (its digest; the caller shows the token itself once) accepts it
// within 7 days (AcceptInvitation). No email is sent yet. An address
// already in the org is ErrExists.
func (s *Store) InviteToOrg(ctx context.Context, orgID, email, role string, token IssuedToken, by Actor, now time.Time) (OrgMember, error) {
	email = strings.TrimSpace(email)
	lower := strings.ToLower(email)
	if at := strings.LastIndexByte(lower, '@'); at < 1 || at == len(lower)-1 || strings.ContainsAny(lower, " \t\r\n<>,;") || len(lower) > 254 {
		return OrgMember{}, invalid("that isn't an email address")
	}
	if role != RoleOwner && role != RoleUserAdmin && role != RoleUser {
		return OrgMember{}, invalid("role must be Owner, userAdmin or user")
	}
	userID := NewID("u")
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM org_memberships m JOIN users u ON u.id = m.user_id
			 WHERE m.org_id = ? AND u.email_lower = ?`), orgID, lower).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return ErrExists
		}
		ms := millis(now)
		// Until they sign in, an invitee is named after their address.
		local := []rune(email[:strings.LastIndexByte(email, '@')])
		name := strings.ToUpper(string(local[:1])) + string(local[1:])
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO users (id, email, email_lower, name, status, created_at, updated_at)
			 VALUES (?, ?, ?, ?, 'pending', ?, ?)`), userID, email, lower, name, ms, ms); err != nil {
			return err
		}
		invID := NewID("inv")
		expires := millis(now.Add(invitationTTL))
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO invitations (id, org_id, email, email_lower, role, workspace_grants,
			    token_alg, token_hash, token_prefix, token_last4, token_issued_at, token_expires_at,
			    status, invited_at, invited_by_kind, invited_by_id, expires_at)
			 VALUES (?, ?, ?, ?, ?, '[]', 'sha256', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`),
			invID, orgID, email, lower, role, token.Hash, token.Prefix, token.Last4, ms, expires,
			ms, by.Kind, by.ID, expires); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO org_memberships (id, org_id, user_id, role, status, invitation_id, created_at, updated_at,
			    updated_by_kind, updated_by_id, rev)
			 VALUES (?, ?, ?, ?, 'invited', ?, ?, ?, ?, ?, 0)`),
			NewID("om"), orgID, userID, role, invID, ms, ms, by.Kind, by.ID); err != nil {
			return err
		}
		_, err := s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, Shared: true,
			Subject: &AuditSubject{Kind: "user", ID: userID, Label: email},
			Object:  fmt.Sprintf("Invited %s as %s", email, role),
			Result:  "Pending · invite link shown once · no email sent",
			Changes: []Change{{Field: "orgMembership", Before: nil, After: map[string]string{"role": role, "status": "invited"}}},
		})
		return err
	})
	if err != nil {
		return OrgMember{}, err
	}
	return s.orgMember(ctx, orgID, userID)
}

func (s *Store) orgMember(ctx context.Context, orgID, userID string) (OrgMember, error) {
	var out OrgMember
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var err error
		out, err = s.orgMemberInTx(ctx, tx, orgID, userID)
		return err
	})
	return out, err
}

// SetOrgRole changes a person's org role. Demoting the last active Owner
// is ErrLastOwner.
func (s *Store) SetOrgRole(ctx context.Context, orgID, userID, role string, by Actor, now time.Time) (OrgMember, error) {
	if role != RoleOwner && role != RoleUserAdmin && role != RoleUser {
		return OrgMember{}, invalid("role must be Owner, userAdmin or user")
	}
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		m, err := s.orgMemberInTx(ctx, tx, orgID, userID)
		if err != nil {
			return err
		}
		if m.Role == role {
			return nil
		}
		if last, err := s.lastActiveOwner(ctx, tx, m); err != nil {
			return err
		} else if last {
			return ErrLastOwner
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE org_memberships SET role = ?, updated_at = ?, updated_by_kind = ?, updated_by_id = ?, rev = rev + 1
			 WHERE id = ?`), role, millis(now), by.Kind, by.ID, m.ID); err != nil {
			return err
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, Shared: true,
			Subject: &AuditSubject{Kind: "user", ID: userID, Label: memberLabel(m)},
			Object:  fmt.Sprintf("Changed %s's org role %s → %s", memberLabel(m), m.Role, role),
			Changes: []Change{{Field: "role", Before: m.Role, After: role}},
		})
		return err
	})
	if err != nil {
		return OrgMember{}, err
	}
	return s.orgMember(ctx, orgID, userID)
}

// SuspendOrgMember suspends a person in one org. Nothing they created or
// granted changes. Suspending the last active Owner is ErrLastOwner;
// suspending someone already suspended is ErrState.
func (s *Store) SuspendOrgMember(ctx context.Context, orgID, userID, reason string, by Actor, now time.Time) (OrgMember, error) {
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		m, err := s.orgMemberInTx(ctx, tx, orgID, userID)
		if err != nil {
			return err
		}
		if m.Status == "suspended" {
			return ErrState
		}
		if last, err := s.lastActiveOwner(ctx, tx, m); err != nil {
			return err
		} else if last {
			return ErrLastOwner
		}
		fallback, err := s.soleAdminOf(ctx, tx, orgID, userID, "")
		if err != nil {
			return err
		}
		ms := millis(now)
		sid := NewID("susp")
		if _, err := tx.ExecContext(ctx, s.q(`INSERT INTO suspensions (id, org_id, user_id, membership_id, status, suspended_at,
			    suspended_by_kind, suspended_by_id, reason, previous_status)
			 VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`), sid, orgID, userID, m.ID, ms, by.Kind, by.ID, nullable(reason), m.Status); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE org_memberships SET status = 'suspended', suspended_from = ?, suspension_id = ?,
			    updated_at = ?, updated_by_kind = ?, updated_by_id = ?, rev = rev + 1 WHERE id = ?`),
			m.Status, sid, ms, by.Kind, by.ID, m.ID); err != nil {
			return err
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, Shared: true, Severity: "warn",
			Subject: &AuditSubject{Kind: "user", ID: userID, Label: memberLabel(m)},
			Object:  "Suspended " + memberLabel(m),
			Result:  "Done · what they created or granted is unchanged",
			Changes: []Change{{Field: "status", Before: m.Status, After: "suspended"}},
		})
		if err != nil {
			return err
		}
		return s.auditDefaultAdmins(ctx, tx, by, now, orgID, fallback)
	})
	if err != nil {
		return OrgMember{}, err
	}
	return s.orgMember(ctx, orgID, userID)
}

// ResumeOrgMember ends a suspension: the person goes back to the status
// they had (an invitee stays invited). Resuming someone who isn't
// suspended is ErrState.
func (s *Store) ResumeOrgMember(ctx context.Context, orgID, userID string, by Actor, now time.Time) (OrgMember, error) {
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		m, err := s.orgMemberInTx(ctx, tx, orgID, userID)
		if err != nil {
			return err
		}
		if m.Status != "suspended" {
			return ErrState
		}
		back := m.SuspendedFrom
		if back == "" {
			back = "active"
		}
		ms := millis(now)
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE suspensions SET status = 'ended', resumed_at = ?, resumed_by_kind = ?, resumed_by_id = ?
			 WHERE org_id = ? AND user_id = ? AND status = 'active'`), ms, by.Kind, by.ID, orgID, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE org_memberships SET status = ?, suspended_from = NULL, suspension_id = NULL,
			    updated_at = ?, updated_by_kind = ?, updated_by_id = ?, rev = rev + 1 WHERE id = ?`),
			back, ms, by.Kind, by.ID, m.ID); err != nil {
			return err
		}
		result := "Done"
		if back == "invited" {
			result = "Back to invited — still has to accept"
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, Shared: true,
			Subject: &AuditSubject{Kind: "user", ID: userID, Label: memberLabel(m)},
			Object:  "Resumed " + memberLabel(m),
			Result:  result,
			Changes: []Change{{Field: "status", Before: "suspended", After: back}},
		})
		return err
	})
	if err != nil {
		return OrgMember{}, err
	}
	return s.orgMember(ctx, orgID, userID)
}

// RemoveOrgMember removes a person from an org: their org membership,
// their workspace memberships there, and a pending invitation. What they
// did stays. Removing the last active Owner is ErrLastOwner.
func (s *Store) RemoveOrgMember(ctx context.Context, orgID, userID string, by Actor, now time.Time) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		if err := s.lockOrg(ctx, tx, orgID); err != nil {
			return err
		}
		m, err := s.orgMemberInTx(ctx, tx, orgID, userID)
		if err != nil {
			return err
		}
		if last, err := s.lastActiveOwner(ctx, tx, m); err != nil {
			return err
		} else if last {
			return ErrLastOwner
		}
		fallback, err := s.soleAdminOf(ctx, tx, orgID, userID, "")
		if err != nil {
			return err
		}
		var ids []string
		rows, err := tx.QueryContext(ctx, s.q(`SELECT id FROM workspace_memberships WHERE org_id = ? AND member_kind = 'user' AND member_id = ?`), orgID, userID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range ids {
			if err := s.deleteMembership(ctx, tx, id); err != nil {
				return err
			}
		}
		ms := millis(now)
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE invitations SET status = 'revoked', revoked_at = ?, revoked_by_kind = ?, revoked_by_id = ?
			 WHERE org_id = ? AND status = 'pending' AND id = (SELECT invitation_id FROM org_memberships WHERE id = ?)`),
			ms, by.Kind, by.ID, orgID, m.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE suspensions SET status = 'ended', resumed_at = ?, resumed_by_kind = ?, resumed_by_id = ?
			 WHERE org_id = ? AND user_id = ? AND status = 'active'`), ms, by.Kind, by.ID, orgID, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q("DELETE FROM org_memberships WHERE id = ?"), m.ID); err != nil {
			return err
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: orgID, Shared: true, Severity: "warn",
			Subject: &AuditSubject{Kind: "user", ID: userID, Label: memberLabel(m)},
			Object:  "Removed " + memberLabel(m) + " from the organization",
			Result:  fmt.Sprintf("Done · %d workspace memberships removed", len(ids)),
			Changes: []Change{{Field: "orgMembership", Before: map[string]string{"role": m.Role, "status": m.Status}, After: nil}},
		})
		if err != nil {
			return err
		}
		return s.auditDefaultAdmins(ctx, tx, by, now, orgID, fallback)
	})
}

/* ---------------------------------------------------------------------- */
/* Accepting invitations                                                   */
/* ---------------------------------------------------------------------- */

// InvitationClosedError is an invitation that can no longer be accepted:
// accepted already, revoked, or expired. Its Status says which.
type InvitationClosedError struct{ Status string }

func (e *InvitationClosedError) Error() string { return "store: invitation " + e.Status }

// InvitationOffer is what an invitation link offers, for the page that
// asks whether to accept.
type InvitationOffer struct {
	ID        string
	OrgID     string
	OrgName   string
	Email     string
	Role      string
	InvitedBy string // a label
	ExpiresAt time.Time
}

// invitationByToken reads the invitation with this token digest.
// ErrNotFound when there is none; InvitationClosedError when it can't be
// accepted at now.
func (s *Store) invitationByToken(ctx context.Context, q queryer, tokenHash string, now time.Time) (InvitationOffer, string, error) {
	var o InvitationOffer
	var status, byKind, byID string
	var exp int64
	err := q.QueryRowContext(ctx, s.q(`SELECT i.id, i.org_id, o.name, i.email, i.role, i.status, i.invited_by_kind, i.invited_by_id, i.expires_at
		  FROM invitations i JOIN orgs o ON o.id = i.org_id AND o.status = 'active' WHERE i.token_hash = ?`), tokenHash).
		Scan(&o.ID, &o.OrgID, &o.OrgName, &o.Email, &o.Role, &status, &byKind, &byID, &exp)
	if err != nil {
		return o, "", notFound(err)
	}
	o.ExpiresAt = fromMillis(exp)
	switch {
	case status != "pending":
		return o, "", &InvitationClosedError{Status: status}
	case exp <= millis(now):
		return o, "", &InvitationClosedError{Status: "expired"}
	}
	return o, byKind + ":" + byID, nil
}

// InvitationByToken returns what the invitation with this token digest
// offers, if it can still be accepted.
func (s *Store) InvitationByToken(ctx context.Context, tokenHash string, now time.Time) (InvitationOffer, error) {
	var out InvitationOffer
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		o, by, err := s.invitationByToken(ctx, tx, tokenHash, now)
		if err != nil {
			return err
		}
		kind, id, _ := strings.Cut(by, ":")
		o.InvitedBy = s.principalLabel(ctx, tx, o.OrgID, kind, id)
		out = o
		return nil
	})
	return out, err
}

// AcceptInvitation makes userID an active member of the invitation's org
// with the invited role, whatever email or sign-in method that user has:
// the link is the proof. The invited membership (and anything granted to
// the invitee before they accepted) moves to userID, and the placeholder
// user created for the invitation goes. A link works once.
//
// It is ErrNotFound for an unknown token, InvitationClosedError when the
// invitation was accepted, revoked or has expired, ErrExists when userID
// is already in the org, and ErrState while the invitee is suspended.
func (s *Store) AcceptInvitation(ctx context.Context, tokenHash, userID string, now time.Time) (InvitationOffer, error) {
	var out InvitationOffer
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		o, _, err := s.invitationByToken(ctx, tx, tokenHash, now)
		if err != nil {
			return err
		}
		if err := s.lockOrg(ctx, tx, o.OrgID); err != nil {
			return err
		}
		// Read again under the org lock: a revoke or another accept may
		// have won the race.
		if o, _, err = s.invitationByToken(ctx, tx, tokenHash, now); err != nil {
			return err
		}
		var omID, invitee, status string
		err = tx.QueryRowContext(ctx, s.q(`SELECT id, user_id, status FROM org_memberships WHERE org_id = ? AND invitation_id = ?`),
			o.OrgID, o.ID).Scan(&omID, &invitee, &status)
		if errors.Is(err, sql.ErrNoRows) {
			return &InvitationClosedError{Status: "revoked"}
		}
		if err != nil {
			return err
		}
		if status != "invited" {
			return ErrState
		}
		if invitee != userID {
			var n int
			if err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM org_memberships WHERE org_id = ? AND user_id = ?`),
				o.OrgID, userID).Scan(&n); err != nil {
				return err
			}
			if n > 0 {
				return ErrExists
			}
		}
		ms := millis(now)
		by := Actor{Kind: "user", ID: userID, Label: s.principalLabel(ctx, tx, o.OrgID, "user", userID)}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE org_memberships SET user_id = ?, status = 'active', joined_at = ?, updated_at = ?,
			    updated_by_kind = 'user', updated_by_id = ?, rev = rev + 1 WHERE id = ?`), userID, ms, ms, userID, omID); err != nil {
			return err
		}
		if invitee != userID {
			for _, q := range []string{
				`UPDATE workspace_memberships SET member_id = ? WHERE org_id = ? AND member_kind = 'user' AND member_id = ?`,
				`UPDATE membership_access SET member_id = ? WHERE org_id = ? AND member_kind = 'user' AND member_id = ?`,
				`UPDATE suspensions SET user_id = ? WHERE org_id = ? AND user_id = ?`,
			} {
				if _, err := tx.ExecContext(ctx, s.q(q), userID, o.OrgID, invitee); err != nil {
					return err
				}
			}
			// The placeholder made for the invitation, unless it is in use.
			if _, err := tx.ExecContext(ctx, s.q(`DELETE FROM users WHERE id = ? AND status = 'pending'
				   AND NOT EXISTS (SELECT 1 FROM org_memberships WHERE user_id = ?)
				   AND NOT EXISTS (SELECT 1 FROM identities WHERE user_id = ?)`), invitee, invitee, invitee); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, s.q(`UPDATE invitations SET status = 'accepted', accepted_at = ?, accepted_user_id = ? WHERE id = ?`),
			ms, userID, o.ID); err != nil {
			return err
		}
		_, err = s.insertAudit(ctx, tx, by, now, auditRow{
			OrgID: o.OrgID, Shared: true,
			Subject: &AuditSubject{Kind: "user", ID: userID, Label: by.Label},
			Object:  fmt.Sprintf("%s accepted the invitation for %s and joined as %s", by.Label, o.Email, o.Role),
			Changes: []Change{{Field: "orgMembership", Before: map[string]string{"role": o.Role, "status": "invited"}, After: map[string]string{"role": o.Role, "status": "active"}}},
		})
		out = o
		return err
	})
	return out, err
}
