-- The shared records from mocks/schema/shared (data-schema branch): the
-- suite tables both Keyhole and Dispatch read, and the auth service's
-- logical model. A mechanical translation, so Keyhole's port can share it:
--
--   * one table per collection, same name; _id becomes id (TEXT);
--   * camelCase fields become snake_case columns;
--   * small fixed objects are flattened, path joined by "_"
--     (createdBy {kind, id} -> created_by_kind, created_by_id;
--      actor {kind, id, label, via} -> actor_kind ... actor_via_label);
--   * arrays, free-form objects and union-typed objects (secretRef,
--     envelope) are jsonb; the migrator writes TEXT for jsonb on SQLite;
--   * Mongo partial unique indexes ({$exists: true}) are plain unique
--     indexes: SQL unique indexes already ignore NULLs;
--   * every instant is BIGINT Unix milliseconds, as in 0001;
--   * indexes and unique constraints follow shared/indexes.json, named
--     <table>_<index name>. TTL fields are plain indexed columns: deleting
--     expired rows is a job, not a database feature here.
--
-- users, identities and sessions already exist (0001, the sign-in
-- starter); they are altered in place to the shared model, not duplicated.

-- auth.users. email_lower is indexed but not unique: Dispatch links a
-- Zitadel sign-in by issuer and subject only, so a local account and a
-- Zitadel account may share an email.
ALTER TABLE users ADD COLUMN email_lower TEXT NOT NULL DEFAULT '';
UPDATE users SET email_lower = lower(email);
ALTER TABLE users ADD COLUMN email_verified_at BIGINT;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending'));
ALTER TABLE users ADD COLUMN lock_lock_id TEXT;
ALTER TABLE users ADD COLUMN lock_locked_at BIGINT;
ALTER TABLE users ADD COLUMN last_sign_in_at BIGINT;
ALTER TABLE users ADD COLUMN locale TEXT;
ALTER TABLE users ADD COLUMN erased_at BIGINT;
CREATE INDEX users_email ON users (email_lower);

-- auth.identities. The sign-in starter's issuer is the schema's
-- connection_id (the OIDC issuer URL; '' for a password), and its
-- provider 'local' is the schema's 'password'.
ALTER TABLE identities RENAME COLUMN issuer TO connection_id;
ALTER TABLE identities RENAME COLUMN created_at TO linked_at;
ALTER TABLE identities ADD COLUMN connection_org_id TEXT;
ALTER TABLE identities ADD COLUMN email_at_link TEXT;
UPDATE identities SET provider = 'password', connection_id = '' WHERE provider = 'local';

-- auth.sessions. Dispatch's sessions are browser sessions keyed by the
-- SHA-256 of the cookie (id_hash) rather than a ses_ ID, and keep the
-- sign-in starter's method, csrf_token and id_token_hint. The refresh
-- token family (CLI sessions) is ported as nullable columns so the table
-- matches the shared model; nothing writes them yet.
ALTER TABLE sessions ADD COLUMN client TEXT NOT NULL DEFAULT 'web:dispatch';
ALTER TABLE sessions ADD COLUMN device TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN place TEXT;
ALTER TABLE sessions ADD COLUMN amr jsonb;
ALTER TABLE sessions ADD COLUMN acr TEXT;
ALTER TABLE sessions ADD COLUMN active_org_id TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at BIGINT NOT NULL DEFAULT 0;
UPDATE sessions SET last_seen_at = created_at;
ALTER TABLE sessions ADD COLUMN idle_expires_at BIGINT;
ALTER TABLE sessions ADD COLUMN revoked_at BIGINT;
ALTER TABLE sessions ADD COLUMN revoked_by_kind TEXT;
ALTER TABLE sessions ADD COLUMN revoked_by_id TEXT;
ALTER TABLE sessions ADD COLUMN revoke_reason TEXT CHECK (revoke_reason IN ('signout', 'signout_everywhere', 'support_lock', 'refresh_reuse', 'user_erased', 'password_changed'));
ALTER TABLE sessions ADD COLUMN refresh_family_id TEXT;
ALTER TABLE sessions ADD COLUMN refresh_current_alg TEXT;
ALTER TABLE sessions ADD COLUMN refresh_current_hash TEXT;
ALTER TABLE sessions ADD COLUMN refresh_current_pepper_version INTEGER;
ALTER TABLE sessions ADD COLUMN refresh_current_prefix TEXT;
ALTER TABLE sessions ADD COLUMN refresh_current_last4 TEXT;
ALTER TABLE sessions ADD COLUMN refresh_current_issued_at BIGINT;
ALTER TABLE sessions ADD COLUMN refresh_current_expires_at BIGINT;
ALTER TABLE sessions ADD COLUMN refresh_rotated_at BIGINT;
ALTER TABLE sessions ADD COLUMN refresh_reuse_detected_at BIGINT;
CREATE UNIQUE INDEX sessions_refresh_hash ON sessions (refresh_current_hash);
CREATE INDEX sessions_user_live ON sessions (user_id, revoked_at, last_seen_at DESC);

-- auth.mfa_factors
CREATE TABLE mfa_factors (
    id                     TEXT PRIMARY KEY,
    user_id                TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type                   TEXT NOT NULL CHECK (type IN ('totp', 'webauthn', 'recovery_codes')),
    label                  TEXT,
    totp_secret_ref        jsonb,
    totp_digits            INTEGER,
    totp_period_seconds    INTEGER,
    webauthn_credential_id TEXT,
    webauthn_public_key    TEXT,
    webauthn_sign_count    INTEGER,
    webauthn_aaguid        TEXT,
    webauthn_transports    jsonb,
    recovery_codes         jsonb,
    created_at             BIGINT NOT NULL,
    last_used_at           BIGINT,
    disabled_at            BIGINT
);
CREATE INDEX mfa_factors_user_type ON mfa_factors (user_id, type);
CREATE UNIQUE INDEX mfa_factors_webauthn_cred ON mfa_factors (webauthn_credential_id);

-- suite.orgs
CREATE TABLE orgs (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    status               TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
    audit_retention_days INTEGER,
    created_at           BIGINT NOT NULL,
    created_by_kind      TEXT NOT NULL,
    created_by_id        TEXT NOT NULL,
    updated_at           BIGINT NOT NULL,
    updated_by_kind      TEXT,
    updated_by_id        TEXT,
    deleted_at           BIGINT,
    deleted_by_kind      TEXT,
    deleted_by_id        TEXT,
    rev                  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX orgs_status ON orgs (status, id);

-- auth.org_memberships
CREATE TABLE org_memberships (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES orgs (id),
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('Owner', 'userAdmin', 'user')),
    status          TEXT NOT NULL CHECK (status IN ('active', 'invited', 'suspended')),
    suspended_from  TEXT CHECK (suspended_from IN ('active', 'invited')),
    suspension_id   TEXT,
    invitation_id   TEXT,
    joined_at       BIGINT,
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    updated_by_kind TEXT,
    updated_by_id   TEXT,
    rev             INTEGER NOT NULL DEFAULT 0,
    CHECK (status <> 'suspended' OR (suspended_from IS NOT NULL AND suspension_id IS NOT NULL))
);
CREATE UNIQUE INDEX org_memberships_org_user ON org_memberships (org_id, user_id);
CREATE INDEX org_memberships_user_orgs ON org_memberships (user_id, status);
CREATE INDEX org_memberships_org_role_status ON org_memberships (org_id, role, status);

-- auth.invitations
CREATE TABLE invitations (
    id                   TEXT PRIMARY KEY,
    org_id               TEXT NOT NULL REFERENCES orgs (id),
    email                TEXT NOT NULL,
    email_lower          TEXT NOT NULL,
    role                 TEXT NOT NULL CHECK (role IN ('Owner', 'userAdmin', 'user')),
    workspace_grants     jsonb NOT NULL,
    extensions           jsonb,
    token_alg            TEXT NOT NULL,
    token_hash           TEXT NOT NULL,
    token_pepper_version INTEGER,
    token_prefix         TEXT NOT NULL,
    token_last4          TEXT NOT NULL,
    token_issued_at      BIGINT NOT NULL,
    token_expires_at     BIGINT,
    status               TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
    invited_at           BIGINT NOT NULL,
    invited_by_kind      TEXT NOT NULL,
    invited_by_id        TEXT NOT NULL,
    resends              jsonb,
    expires_at           BIGINT NOT NULL,
    accepted_at          BIGINT,
    accepted_user_id     TEXT,
    revoked_at           BIGINT,
    revoked_by_kind      TEXT,
    revoked_by_id        TEXT
);
CREATE UNIQUE INDEX invitations_token_hash ON invitations (token_hash);
CREATE INDEX invitations_org_status_exp ON invitations (org_id, status, expires_at);
CREATE INDEX invitations_email_status ON invitations (email_lower, status);

-- auth.support_locks
CREATE TABLE support_locks (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status          TEXT NOT NULL CHECK (status IN ('active', 'lifted')),
    locked_at       BIGINT NOT NULL,
    locked_by_kind  TEXT NOT NULL,
    locked_by_id    TEXT NOT NULL,
    reason          TEXT NOT NULL,
    unlock_requests jsonb,
    lifted_at       BIGINT,
    lifted_by_kind  TEXT,
    lifted_by_id    TEXT
);
CREATE INDEX support_locks_user_status ON support_locks (user_id, status);

-- auth.suspensions
CREATE TABLE suspensions (
    id                TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL REFERENCES orgs (id),
    user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    membership_id     TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('active', 'ended')),
    suspended_at      BIGINT NOT NULL,
    suspended_by_kind TEXT NOT NULL,
    suspended_by_id   TEXT NOT NULL,
    reason            TEXT,
    previous_status   TEXT NOT NULL CHECK (previous_status IN ('active', 'invited')),
    resumed_at        BIGINT,
    resumed_by_kind   TEXT,
    resumed_by_id     TEXT
);
CREATE INDEX suspensions_org_user_at ON suspensions (org_id, user_id, suspended_at DESC);

-- suite.workspaces
CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES orgs (id),
    name            TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
    created_at      BIGINT NOT NULL,
    created_by_kind TEXT NOT NULL,
    created_by_id   TEXT NOT NULL,
    updated_at      BIGINT NOT NULL,
    updated_by_kind TEXT,
    updated_by_id   TEXT,
    deleted_at      BIGINT,
    deleted_by_kind TEXT,
    deleted_by_id   TEXT,
    rev             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX workspaces_org_status_name ON workspaces (org_id, status, name);

-- suite.workspace_memberships. An agent's shared role is always member;
-- Dispatch's agent workspace admin lives in membership_access.
CREATE TABLE workspace_memberships (
    id                TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL REFERENCES orgs (id),
    workspace_id      TEXT NOT NULL REFERENCES workspaces (id),
    member_kind       TEXT NOT NULL CHECK (member_kind IN ('user', 'agent')),
    member_id         TEXT NOT NULL,
    role              TEXT NOT NULL CHECK (role IN ('member', 'workspace_admin')),
    added_at          BIGINT NOT NULL,
    added_by_kind     TEXT NOT NULL,
    added_by_id       TEXT NOT NULL,
    delegated_by_kind TEXT,
    delegated_by_id   TEXT,
    delegated_at      BIGINT,
    updated_at        BIGINT NOT NULL,
    rev               INTEGER NOT NULL DEFAULT 0,
    CHECK (member_kind <> 'agent' OR role = 'member')
);
CREATE UNIQUE INDEX workspace_memberships_org_ws_member ON workspace_memberships (org_id, workspace_id, member_kind, member_id);
CREATE INDEX workspace_memberships_org_member ON workspace_memberships (org_id, member_kind, member_id);
CREATE INDEX workspace_memberships_org_ws_role ON workspace_memberships (org_id, workspace_id, role);

-- suite.agents
CREATE TABLE agents (
    id               TEXT PRIMARY KEY,
    org_id           TEXT NOT NULL REFERENCES orgs (id),
    label            TEXT NOT NULL,
    label_lower      TEXT NOT NULL,
    created_at       BIGINT NOT NULL,
    created_by_kind  TEXT NOT NULL,
    created_by_id    TEXT NOT NULL,
    created_by_label TEXT,
    updated_at       BIGINT NOT NULL,
    retired_at       BIGINT,
    retired_by_kind  TEXT,
    retired_by_id    TEXT,
    rev              INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX agents_org_label ON agents (org_id, label_lower);
CREATE INDEX agents_org_created ON agents (org_id, created_at DESC);

-- suite.audit_events and <app>.audit_events in one table: shared rows
-- (shared = true) and this app's own rows (shared = false). A shared row
-- never carries app detail or a link, and is admin or support.
CREATE TABLE audit_events (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL,
    workspace_id    TEXT,
    app             TEXT NOT NULL CHECK (app IN ('keyhole', 'dispatch', 'auth', 'suite')),
    shared          BOOLEAN NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('admin', 'support', 'request', 'blocked', 'error', 'connection', 'verification', 'message', 'receipt', 'webhook', 'access', 'context')),
    severity        TEXT NOT NULL CHECK (severity IN ('ok', 'blocked', 'warn', 'info')),
    at              BIGINT NOT NULL,
    actor_kind      TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'support', 'system', 'connector', 'sidecar', 'listener')),
    actor_id        TEXT,
    actor_label     TEXT NOT NULL,
    actor_via_kind  TEXT,
    actor_via_id    TEXT,
    actor_via_label TEXT,
    subject_kind    TEXT,
    subject_id      TEXT,
    subject_label   TEXT,
    object          TEXT NOT NULL,
    result          TEXT NOT NULL,
    reason          TEXT,
    trk             TEXT NOT NULL,
    correlation_id  TEXT,
    causation_id    TEXT,
    changes         jsonb,
    detail          jsonb,
    link_label      TEXT,
    link_to         TEXT,
    expire_at       BIGINT NOT NULL,
    CHECK (NOT shared OR (detail IS NULL AND link_label IS NULL AND link_to IS NULL AND type IN ('admin', 'support')))
);
CREATE INDEX audit_events_org_at ON audit_events (org_id, at DESC);
CREATE INDEX audit_events_org_ws_at ON audit_events (org_id, workspace_id, at DESC);
CREATE INDEX audit_events_org_actor_at ON audit_events (org_id, actor_id, at DESC);
CREATE INDEX audit_events_org_subject_at ON audit_events (org_id, subject_id, at DESC);
CREATE INDEX audit_events_org_trk ON audit_events (org_id, trk);
CREATE INDEX audit_events_org_causation ON audit_events (org_id, causation_id) WHERE causation_id IS NOT NULL;
CREATE INDEX audit_events_ttl_expire_at ON audit_events (expire_at);

-- suite.outbox
CREATE TABLE outbox (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    schema_version  INTEGER NOT NULL CHECK (schema_version = 1),
    org_id          TEXT NOT NULL,
    workspace_id    TEXT,
    aggregate_kind  TEXT NOT NULL CHECK (aggregate_kind IN ('org', 'org_membership', 'user', 'workspace', 'workspace_membership', 'agent')),
    aggregate_id    TEXT NOT NULL,
    aggregate_rev   INTEGER NOT NULL,
    origin_app      TEXT NOT NULL CHECK (origin_app IN ('keyhole', 'dispatch', 'auth', 'suite')),
    actor_kind      TEXT NOT NULL,
    actor_id        TEXT,
    actor_label     TEXT NOT NULL,
    actor_via_kind  TEXT,
    actor_via_id    TEXT,
    actor_via_label TEXT,
    occurred_at     BIGINT NOT NULL,
    trk             TEXT NOT NULL,
    correlation_id  TEXT,
    audit_event_id  TEXT,
    refusal         BOOLEAN NOT NULL DEFAULT FALSE,
    payload         jsonb NOT NULL,
    published_at    BIGINT,
    delete_at       BIGINT
);
CREATE INDEX outbox_published_order ON outbox (published_at, id);
CREATE INDEX outbox_org_aggregate ON outbox (org_id, aggregate_id, id);
CREATE INDEX outbox_ttl_delete_at ON outbox (delete_at);

-- suite.outbox_consumers
CREATE TABLE outbox_consumers (
    id            TEXT PRIMARY KEY,
    resume_token  jsonb NOT NULL,
    last_event_id TEXT,
    last_event_at BIGINT,
    updated_at    BIGINT NOT NULL
);

-- <app>.applied_events: projector idempotency.
CREATE TABLE applied_events (
    id         TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL,
    type       TEXT NOT NULL,
    applied_at BIGINT NOT NULL,
    delete_at  BIGINT NOT NULL
);
CREATE INDEX applied_events_ttl_delete_at ON applied_events (delete_at);
