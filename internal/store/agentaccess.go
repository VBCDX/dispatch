package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
)

// Agent credentials. An agent presents two tokens: its agent token
// (agent_profiles) and one workspace token per membership
// (membership_access). Only the SHA-256 of each is stored, hex encoded, with
// the prefix and last four characters for display.

// Token prefixes, as in the mock.
const (
	AgentTokenPrefix     = "dsp_agent_"
	WorkspaceTokenPrefix = "dsp_ws_"
)

// IssuedToken is a token's stored digest: never the token itself.
type IssuedToken struct {
	Hash   string // SHA-256, hex
	Prefix string
	Last4  string
}

// TokenGrace is how long a rotated token keeps working, so a running agent
// can switch to the new one. Revoking ends it at once.
const TokenGrace = 10 * time.Minute

// matchedToken is one stored credential as LookupAgentAccess reads it.
type matchedToken struct {
	current                             string
	currentExp, previousExp, graceUntil sql.NullInt64
}

// validUntil reports whether hash is usable at nowMs and when it stops
// being so (invalid when it never does): the current token until its own
// expiry, the previous one until the earlier of its expiry and the end of
// its grace period.
func (t matchedToken) validUntil(hash string, nowMs int64) (sql.NullInt64, bool) {
	until := t.currentExp
	if hash != t.current {
		if !t.graceUntil.Valid {
			return sql.NullInt64{}, false
		}
		until = t.graceUntil
		if t.previousExp.Valid && t.previousExp.Int64 < until.Int64 {
			until = t.previousExp
		}
	}
	return until, !until.Valid || until.Int64 > nowMs
}

// Access-ladder rules, in the order the mock's README checks them. The
// first that fails decides the outcome and is named in the refusal.
const (
	RuleAgentToken         = "agent token"
	RuleAgentBlocksWS      = "agent workspace blocklist"
	RuleWorkspaceBlocklist = "workspace agent blocklist"
	RuleWorkspaceToken     = "workspace token"
	RuleMembership         = "membership"
	RuleAgentFilter        = "agent filter"
)

// AgentAccess is everything the agent message path needs to know about one
// (agent token, workspace token) pair. It is loaded once and cached in
// memory; the send and deliver path never reads it from SQL.
type AgentAccess struct {
	OrgID         string
	AgentID       string
	AgentLabel    string
	WorkspaceID   string
	WorkspaceName string
	MembershipID  string
	AddedAt       time.Time
	// Refused names the first ladder rule that refuses the pair outright
	// (blocklists); empty when the pair may connect.
	Refused string
	// Read and Write are the membership's grants after the agent's own
	// filters: both must allow.
	Read, Write bool
	// ReadRule and WriteRule name the rule that turned Read or Write off.
	ReadRule, WriteRule string
	// ExpiresAt is the earliest token expiry, if any.
	ExpiresAt *time.Time
}

// LookupAgentAccess resolves an agent token hash and a workspace token hash
// to the pair's access. ErrNotFound means either token is unknown, revoked,
// expired or retired, or the two belong to different agents: all of those
// are "not authenticated" to the caller.
func (s *Store) LookupAgentAccess(ctx context.Context, agentHash, wsHash string, now time.Time) (AgentAccess, error) {
	var a AgentAccess
	var agentStatus string
	var agentRetired, agentRevoked, wsRevoked sql.NullInt64
	var filtersRead, filtersWrite, mRead, mWrite bool
	var wsBlocklist sql.NullString
	var wsStatus, memberAgentID string
	var added int64
	var agentTok, wsTok matchedToken
	// Each token matches as the current one or, while its grace period
	// runs, the one it replaced.
	err := s.db.QueryRowContext(ctx, s.q(
		`SELECT p.id, p.org_id, a.label, p.status, p.revoked_at, a.retired_at,
		        p.token_current_hash, p.token_current_expires_at, p.token_previous_digest_expires_at, p.token_previous_grace_until,
		        p.filters_read, p.filters_write, p.filters_workspace_blocklist,
		        ma.id, ma.workspace_id, ma.member_id, ma.read, ma.write,
		        ma.token_current_hash, ma.token_current_expires_at, ma.token_previous_digest_expires_at, ma.token_previous_grace_until,
		        ma.token_revoked_at, w.name, w.status, wm.added_at
		   FROM agent_profiles p
		   JOIN agents a ON a.id = p.id
		   JOIN membership_access ma ON (ma.token_current_hash = ? OR ma.token_previous_digest_hash = ?) AND ma.member_kind = 'agent'
		   JOIN workspace_memberships wm ON wm.id = ma.id
		   JOIN workspaces w ON w.id = ma.workspace_id
		  WHERE p.token_current_hash = ? OR p.token_previous_digest_hash = ?`), wsHash, wsHash, agentHash, agentHash).
		Scan(&a.AgentID, &a.OrgID, &a.AgentLabel, &agentStatus, &agentRevoked, &agentRetired,
			&agentTok.current, &agentTok.currentExp, &agentTok.previousExp, &agentTok.graceUntil,
			&filtersRead, &filtersWrite, &wsBlocklist,
			&a.MembershipID, &a.WorkspaceID, &memberAgentID, &mRead, &mWrite,
			&wsTok.current, &wsTok.currentExp, &wsTok.previousExp, &wsTok.graceUntil,
			&wsRevoked, &a.WorkspaceName, &wsStatus, &added)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentAccess{}, ErrNotFound
	}
	if err != nil {
		return AgentAccess{}, err
	}
	nowMs := millis(now)
	agentExp, agentOK := agentTok.validUntil(agentHash, nowMs)
	wsExp, wsOK := wsTok.validUntil(wsHash, nowMs)
	if agentStatus != "active" || agentRevoked.Valid || agentRetired.Valid || !agentOK ||
		memberAgentID != a.AgentID || wsRevoked.Valid || !wsOK || wsStatus != "active" {
		return AgentAccess{}, ErrNotFound
	}
	a.AddedAt = fromMillis(added)
	for _, e := range []sql.NullInt64{agentExp, wsExp} {
		if e.Valid && (a.ExpiresAt == nil || fromMillis(e.Int64).Before(*a.ExpiresAt)) {
			t := fromMillis(e.Int64)
			a.ExpiresAt = &t
		}
	}

	var ownBlocklist []string
	if wsBlocklist.Valid && wsBlocklist.String != "" {
		if err := json.Unmarshal([]byte(wsBlocklist.String), &ownBlocklist); err != nil {
			return AgentAccess{}, err
		}
	}
	var blocked int
	if err := s.db.QueryRowContext(ctx, s.q(
		`SELECT COUNT(*) FROM workspace_settings_agent_blocklist WHERE workspace_id = ? AND agent_id = ?`),
		a.WorkspaceID, a.AgentID).Scan(&blocked); err != nil {
		return AgentAccess{}, err
	}
	switch {
	case slices.Contains(ownBlocklist, a.WorkspaceID):
		a.Refused = RuleAgentBlocksWS
	case blocked > 0:
		a.Refused = RuleWorkspaceBlocklist
	}

	a.Read, a.Write = mRead && filtersRead, mWrite && filtersWrite
	switch {
	case !mRead:
		a.ReadRule = RuleMembership
	case !filtersRead:
		a.ReadRule = RuleAgentFilter
	}
	switch {
	case !mWrite:
		a.WriteRule = RuleMembership
	case !filtersWrite:
		a.WriteRule = RuleAgentFilter
	}
	return a, nil
}

// EnrollAgent is a request to give an agent a workspace token: a new agent
// (AgentID empty, Label set) or an existing one in the same org. A new agent
// also gets its agent token.
type EnrollAgent struct {
	OrgID        string
	WorkspaceID  string
	AgentID      string // existing agent; empty to register a new one
	Label        string // new agent's name
	Description  string
	AgentToken   *IssuedToken // required for a new agent, ignored otherwise
	WSToken      IssuedToken
	By           Actor // the person doing it
	Now          time.Time
	AuditRetDays int
}

// Enrolled is what EnrollAgent created.
type Enrolled struct {
	AgentID      string
	AgentLabel   string
	MembershipID string
	NewAgent     bool
}

// ErrConflict is returned when an action conflicts with the current state,
// such as adding an agent that is already a member.
var ErrConflict = errors.New("store: conflict")

// EnrollAgentInWorkspace registers the agent if it is new, adds it to the
// workspace as a member with read and write, and stores the workspace
// token's digest. An existing agent that is already a member is ErrConflict
// (rotate its token instead); a missing or deleted workspace, or an agent
// from another org, is ErrNotFound; a taken label is ErrExists.
func (s *Store) EnrollAgentInWorkspace(ctx context.Context, e EnrollAgent) (Enrolled, error) {
	out := Enrolled{AgentID: e.AgentID, AgentLabel: e.Label}
	now := millis(e.Now)
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		var one int
		err := tx.QueryRowContext(ctx, s.q(`SELECT 1 FROM workspaces WHERE id = ? AND org_id = ? AND status = 'active'`),
			e.WorkspaceID, e.OrgID).Scan(&one)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if e.AgentID == "" {
			if e.AgentToken == nil {
				return errors.New("store: a new agent needs an agent token")
			}
			out.AgentID, out.NewAgent = NewID("ag"), true
			var taken int
			if err := tx.QueryRowContext(ctx, s.q(`SELECT COUNT(*) FROM agents WHERE org_id = ? AND label_lower = ?`),
				e.OrgID, strings.ToLower(e.Label)).Scan(&taken); err != nil {
				return err
			}
			if taken > 0 {
				return ErrExists
			}
			if _, err := tx.ExecContext(ctx, s.q(
				`INSERT INTO agents (id, org_id, label, label_lower, created_at, created_by_kind, created_by_id, created_by_label, updated_at, rev)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
				out.AgentID, e.OrgID, e.Label, strings.ToLower(e.Label), now, e.By.Kind, e.By.ID, e.By.Label, now); err != nil {
				return err
			}
			t := e.AgentToken
			if _, err := tx.ExecContext(ctx, s.q(
				`INSERT INTO agent_profiles (id, org_id, status, description, token_current_alg, token_current_hash,
				        token_current_prefix, token_current_last4, token_current_issued_at, token_delivery,
				        filters_read, filters_write, filters_workspace_blocklist, created_at, updated_at, rev)
				 VALUES (?, ?, 'active', ?, 'sha256', ?, ?, ?, ?, 'shown_once', ?, ?, '[]', ?, ?, 0)`),
				out.AgentID, e.OrgID, nullable(e.Description), t.Hash, t.Prefix, t.Last4, now, true, true, now, now); err != nil {
				return err
			}
		} else {
			err := tx.QueryRowContext(ctx, s.q(
				`SELECT a.label FROM agents a JOIN agent_profiles p ON p.id = a.id
				  WHERE a.id = ? AND a.org_id = ? AND a.retired_at IS NULL AND p.status <> 'revoked'`),
				e.AgentID, e.OrgID).Scan(&out.AgentLabel)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
			var member int
			if err := tx.QueryRowContext(ctx, s.q(
				`SELECT COUNT(*) FROM workspace_memberships WHERE org_id = ? AND workspace_id = ? AND member_kind = 'agent' AND member_id = ?`),
				e.OrgID, e.WorkspaceID, e.AgentID).Scan(&member); err != nil {
				return err
			}
			if member > 0 {
				return ErrConflict
			}
		}
		out.MembershipID = NewID("wm")
		if _, err := tx.ExecContext(ctx, s.q(
			`INSERT INTO workspace_memberships (id, org_id, workspace_id, member_kind, member_id, role, added_at, added_by_kind, added_by_id, updated_at, rev)
			 VALUES (?, ?, ?, 'agent', ?, 'member', ?, ?, ?, ?, 0)`),
			out.MembershipID, e.OrgID, e.WorkspaceID, out.AgentID, now, e.By.Kind, e.By.ID, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, s.q(
			`INSERT INTO membership_access (id, org_id, workspace_id, member_kind, member_id, read, write, agent_role,
			        token_current_alg, token_current_hash, token_current_prefix, token_current_last4, token_current_issued_at,
			        token_delivery, updated_at, updated_by_kind, updated_by_id, updated_by_label, rev)
			 VALUES (?, ?, ?, 'agent', ?, ?, ?, 'member', 'sha256', ?, ?, ?, ?, 'shown_once', ?, ?, ?, ?, 0)`),
			out.MembershipID, e.OrgID, e.WorkspaceID, out.AgentID, true, true,
			e.WSToken.Hash, e.WSToken.Prefix, e.WSToken.Last4, now, now, e.By.Kind, e.By.ID, e.By.Label); err != nil {
			return err
		}
		what := "Added agent " + out.AgentLabel + " and issued its workspace token"
		if out.NewAgent {
			what = "Registered agent " + out.AgentLabel + ", added it and issued its agent and workspace tokens"
		}
		return s.auditAccess(ctx, tx, e.OrgID, e.WorkspaceID, e.By, out.AgentID, out.AgentLabel, what, "Issued", e.Now, e.AuditRetDays)
	})
	if err != nil {
		return Enrolled{}, err
	}
	return out, nil
}

// RotateWorkspaceToken replaces an agent member's workspace token (and
// clears any revocation). The old token keeps working for TokenGrace,
// unless it was revoked or never issued; graceUntil says until when (nil
// when it stopped at once). A token still in its grace period from an
// earlier rotation stops now. It returns the membership ID; ErrNotFound if
// the agent is not a member.
func (s *Store) RotateWorkspaceToken(ctx context.Context, orgID, workspaceID, agentID string, t IssuedToken, by Actor, now time.Time, auditDays int) (mid string, graceUntil *time.Time, err error) {
	var label string
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		var old rotatedFrom
		var revoked sql.NullInt64
		err := tx.QueryRowContext(ctx, s.q(
			`SELECT ma.id, a.label, ma.token_current_alg, ma.token_current_hash, ma.token_current_pepper_version, ma.token_current_prefix,
			        ma.token_current_last4, ma.token_current_issued_at, ma.token_current_expires_at, ma.token_revoked_at
			   FROM membership_access ma JOIN agents a ON a.id = ma.member_id
			   JOIN workspaces w ON w.id = ma.workspace_id
			  WHERE ma.org_id = ? AND ma.workspace_id = ? AND ma.member_kind = 'agent' AND ma.member_id = ? AND w.status = 'active'`),
			orgID, workspaceID, agentID).Scan(&mid, &label, &old.alg, &old.hash, &old.pepper, &old.prefix,
			&old.last4, &old.issued, &old.expires, &revoked)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		prev := old.grace(now, !revoked.Valid)
		graceUntil = prev.until()
		ms := millis(now)
		if _, err := tx.ExecContext(ctx, s.q(
			`UPDATE membership_access SET token_current_alg = 'sha256', token_current_hash = ?, token_current_pepper_version = NULL,
			        token_current_prefix = ?, token_current_last4 = ?, token_current_issued_at = ?, token_current_expires_at = NULL,
			        token_previous_digest_alg = ?, token_previous_digest_hash = ?, token_previous_digest_pepper_version = ?,
			        token_previous_digest_prefix = ?, token_previous_digest_last4 = ?, token_previous_digest_issued_at = ?,
			        token_previous_digest_expires_at = ?, token_previous_grace_until = ?, token_grace_seconds = ?,
			        token_rotated_at = ?, token_rotated_by_kind = ?, token_rotated_by_id = ?,
			        token_rotation_count = COALESCE(token_rotation_count, 0) + 1, token_revoked_at = NULL,
			        token_delivery = 'shown_once', updated_at = ?, updated_by_kind = ?, updated_by_id = ?, updated_by_label = ?, rev = rev + 1
			  WHERE id = ?`),
			append(append([]any{t.Hash, t.Prefix, t.Last4, ms}, prev.args()...),
				ms, by.Kind, by.ID, ms, by.Kind, by.ID, by.Label, mid)...); err != nil {
			return err
		}
		return s.auditAccess(ctx, tx, orgID, workspaceID, by, agentID, label, "Rotated the workspace token of "+label, prev.result(), now, auditDays)
	})
	return mid, graceUntil, err
}

// rotatedFrom is the current token a rotation replaces.
type rotatedFrom struct {
	alg, hash, prefix, last4 sql.NullString
	pepper, issued, expires  sql.NullInt64
}

// previousToken is what a rotation stores as the previous token: nothing
// (zero value) when the old token stops at once.
type previousToken struct {
	from       rotatedFrom
	graceUntil int64
}

// grace keeps the old token for TokenGrace when keep is true and it is a
// real, unexpired token (not a placeholder from the Members tab).
func (o rotatedFrom) grace(now time.Time, keep bool) previousToken {
	nowMs := millis(now)
	if !keep || !o.hash.Valid || strings.HasPrefix(o.hash.String, unissuedTokenPrefix) || (o.expires.Valid && o.expires.Int64 <= nowMs) {
		return previousToken{}
	}
	return previousToken{from: o, graceUntil: millis(now.Add(TokenGrace))}
}

func (p previousToken) until() *time.Time {
	if p.graceUntil == 0 {
		return nil
	}
	t := fromMillis(p.graceUntil)
	return &t
}

// args are the values for the token_previous_* columns and
// token_grace_seconds, in that order.
func (p previousToken) args() []any {
	if p.graceUntil == 0 {
		return []any{nil, nil, nil, nil, nil, nil, nil, nil, nil}
	}
	f := p.from
	return []any{f.alg, f.hash, f.pepper, f.prefix, f.last4, f.issued, f.expires, p.graceUntil, int(TokenGrace.Seconds())}
}

func (p previousToken) result() string {
	if p.graceUntil == 0 {
		return "Rotated"
	}
	return "Rotated · old ••••" + p.from.last4.String + " works until " + fromMillis(p.graceUntil).Format("15:04 UTC")
}

// RevokeWorkspaceToken revokes an agent member's workspace token. The agent
// stays a member but cannot connect until the token is rotated. It returns
// the membership ID; ErrNotFound if the agent is not a member.
func (s *Store) RevokeWorkspaceToken(ctx context.Context, orgID, workspaceID, agentID string, by Actor, now time.Time, auditDays int) (string, error) {
	var mid, label string
	err := s.inTx(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, s.q(
			`SELECT ma.id, a.label FROM membership_access ma JOIN agents a ON a.id = ma.member_id
			  WHERE ma.org_id = ? AND ma.workspace_id = ? AND ma.member_kind = 'agent' AND ma.member_id = ?`),
			orgID, workspaceID, agentID).Scan(&mid, &label)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		ms := millis(now)
		if _, err := tx.ExecContext(ctx, s.q(
			`UPDATE membership_access SET token_revoked_at = COALESCE(token_revoked_at, ?), updated_at = ?,
			        updated_by_kind = ?, updated_by_id = ?, updated_by_label = ?, rev = rev + 1 WHERE id = ?`),
			ms, ms, by.Kind, by.ID, by.Label, mid); err != nil {
			return err
		}
		return s.auditAccess(ctx, tx, orgID, workspaceID, by, agentID, label, "Revoked the workspace token of "+label, "Revoked", now, auditDays)
	})
	return mid, err
}

// RotateAgentToken replaces an agent's own token. The old token keeps
// working for TokenGrace, until graceUntil; one still in its grace period
// from an earlier rotation stops now. A revoked or retired agent is
// ErrNotFound.
func (s *Store) RotateAgentToken(ctx context.Context, orgID, agentID string, t IssuedToken, by Actor, now time.Time, auditDays int) (graceUntil *time.Time, err error) {
	err = s.inTx(ctx, func(tx *sql.Tx) error {
		var label string
		var old rotatedFrom
		err := tx.QueryRowContext(ctx, s.q(
			`SELECT a.label, p.token_current_alg, p.token_current_hash, p.token_current_pepper_version, p.token_current_prefix,
			        p.token_current_last4, p.token_current_issued_at, p.token_current_expires_at
			   FROM agents a JOIN agent_profiles p ON p.id = a.id
			  WHERE a.id = ? AND a.org_id = ? AND a.retired_at IS NULL AND p.status <> 'revoked'`), agentID, orgID).
			Scan(&label, &old.alg, &old.hash, &old.pepper, &old.prefix, &old.last4, &old.issued, &old.expires)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		prev := old.grace(now, true)
		graceUntil = prev.until()
		ms := millis(now)
		if _, err := tx.ExecContext(ctx, s.q(
			`UPDATE agent_profiles SET token_current_alg = 'sha256', token_current_hash = ?, token_current_pepper_version = NULL,
			        token_current_prefix = ?, token_current_last4 = ?, token_current_issued_at = ?, token_current_expires_at = NULL,
			        token_previous_digest_alg = ?, token_previous_digest_hash = ?, token_previous_digest_pepper_version = ?,
			        token_previous_digest_prefix = ?, token_previous_digest_last4 = ?, token_previous_digest_issued_at = ?,
			        token_previous_digest_expires_at = ?, token_previous_grace_until = ?, token_grace_seconds = ?,
			        token_rotated_at = ?, token_rotated_by_kind = ?, token_rotated_by_id = ?,
			        token_rotation_count = COALESCE(token_rotation_count, 0) + 1, token_delivery = 'shown_once',
			        updated_at = ?, rev = rev + 1
			  WHERE id = ?`),
			append(append([]any{t.Hash, t.Prefix, t.Last4, ms}, prev.args()...),
				ms, by.Kind, by.ID, ms, agentID)...); err != nil {
			return err
		}
		return s.auditAccess(ctx, tx, orgID, "", by, agentID, label, "Rotated the agent token of "+label, prev.result(), now, auditDays)
	})
	return graceUntil, err
}

// RevokeAgent revokes an agent: its agent token stops working everywhere,
// for good. Revoking a revoked agent changes nothing. A missing agent is
// ErrNotFound.
func (s *Store) RevokeAgent(ctx context.Context, orgID, agentID string, by Actor, now time.Time, auditDays int) error {
	return s.inTx(ctx, func(tx *sql.Tx) error {
		var label, status string
		err := tx.QueryRowContext(ctx, s.q(
			`SELECT a.label, p.status FROM agents a JOIN agent_profiles p ON p.id = a.id WHERE a.id = ? AND a.org_id = ?`),
			agentID, orgID).Scan(&label, &status)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil || status == "revoked" {
			return err
		}
		ms := millis(now)
		if _, err := tx.ExecContext(ctx, s.q(
			`UPDATE agent_profiles SET status = 'revoked', revoked_at = ?, updated_at = ?, rev = rev + 1 WHERE id = ?`),
			ms, ms, agentID); err != nil {
			return err
		}
		return s.auditAccess(ctx, tx, orgID, "", by, agentID, label, "Revoked agent "+label, "Revoked", now, auditDays)
	})
}

// auditAccess records a token or access change as a Dispatch audit row.
func (s *Store) auditAccess(ctx context.Context, tx *sql.Tx, orgID, workspaceID string, by Actor, agentID, agentLabel, object, result string, now time.Time, days int) error {
	if days <= 0 {
		days = 365
	}
	at := millis(now)
	_, err := tx.ExecContext(ctx, s.q(
		`INSERT INTO audit_events (id, org_id, workspace_id, app, shared, type, severity, at, actor_kind, actor_id, actor_label,
		        subject_kind, subject_id, subject_label, object, result, trk, expire_at)
		 VALUES (?, ?, ?, 'dispatch', ?, 'access', 'info', ?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?)`),
		NewID("ev"), orgID, nullable(workspaceID), false, at, by.Kind, nullable(by.ID), by.Label,
		agentID, agentLabel, object, result, NewID("trk"), at+int64(days)*86_400_000)
	return err
}

// AgentMember is an agent's membership in one workspace, for the Connect tab.
type AgentMember struct {
	MembershipID   string
	AgentID        string
	Label          string
	AgentStatus    string
	Read, Write    bool
	TokenPrefix    string
	TokenLast4     string
	TokenIssuedAt  time.Time
	TokenRevokedAt *time.Time
	AddedAt        time.Time
}

// ListAgentMembers lists a workspace's agent members with their workspace
// token's display digits.
func (s *Store) ListAgentMembers(ctx context.Context, orgID, workspaceID string) ([]AgentMember, error) {
	var out []AgentMember
	err := s.queryRows(ctx,
		`SELECT ma.id, ma.member_id, a.label, COALESCE(p.status, 'active'), ma.read, ma.write,
		        COALESCE(ma.token_current_prefix, ''), COALESCE(ma.token_current_last4, ''), COALESCE(ma.token_current_issued_at, 0),
		        ma.token_revoked_at, wm.added_at
		   FROM membership_access ma
		   JOIN workspace_memberships wm ON wm.id = ma.id
		   JOIN agents a ON a.id = ma.member_id
		   LEFT JOIN agent_profiles p ON p.id = a.id
		  WHERE ma.org_id = ? AND ma.workspace_id = ? AND ma.member_kind = 'agent'
		  ORDER BY a.label_lower`, []any{orgID, workspaceID}, func(r rowScanner) error {
			var m AgentMember
			var issued, added int64
			var revoked sql.NullInt64
			if err := r.Scan(&m.MembershipID, &m.AgentID, &m.Label, &m.AgentStatus, &m.Read, &m.Write,
				&m.TokenPrefix, &m.TokenLast4, &issued, &revoked, &added); err != nil {
				return err
			}
			m.TokenIssuedAt, m.AddedAt, m.TokenRevokedAt = fromMillis(issued), fromMillis(added), timePtr(revoked)
			out = append(out, m)
			return nil
		})
	return out, err
}
