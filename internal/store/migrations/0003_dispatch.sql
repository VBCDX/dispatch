-- Dispatch's own tables, from mocks/schema/dispatch (data-schema branch),
-- with the same translation rules as 0002_shared.sql:
--
--   * one table per collection, same name; _id becomes id (TEXT);
--   * camelCase becomes snake_case; objects with fixed fields are
--     flattened, path joined by "_" (fire.delivery.mode ->
--     fire_delivery_mode). The shared types always flatten the same way:
--       principalRef  -> <f>_kind, <f>_id
--       actorRef      -> <f>_kind, <f>_id, <f>_label,
--                        <f>_via_kind, <f>_via_id, <f>_via_label
--       tokenDigest   -> <f>_alg, <f>_hash, <f>_pepper_version, <f>_prefix,
--                        <f>_last4, <f>_issued_at, <f>_expires_at
--       credentialSet -> <f>_current_<tokenDigest>,
--                        <f>_previous_digest_<tokenDigest>,
--                        <f>_previous_grace_until, <f>_rotated_at,
--                        <f>_rotated_by_kind, <f>_rotated_by_id,
--                        <f>_grace_seconds, <f>_grace_ended_early_at,
--                        <f>_rotation_count
--   * arrays of objects, unions (oneOf/anyOf of different shapes) and
--     free-form JSON are jsonb (TEXT on SQLite);
--   * an array that indexes.json indexes element by element (a Mongo
--     multikey index) becomes a child table, so the index still exists:
--     messages.tags, workspace_settings.agentBlocklist and
--     agent_profiles.filters.agentBlocklist;
--   * instants are BIGINT Unix milliseconds;
--   * indexes are named <table>_<index name> from dispatch/indexes.json.
--     Text indexes are left to the search issue, and TTL fields are plain
--     indexed columns that a cleanup job reads.
--
-- Nothing here is on the message send or deliver path: that runs on
-- embedded NATS. These tables are the record behind history, search,
-- receipts and configuration.

-- Dispatch-only audit rows share the audit_events table from 0002
-- (shared = false); this is the one extra index dispatch/indexes.json has.
CREATE INDEX audit_events_org_type_at ON audit_events (org_id, type, at DESC);

-- dispatch.org_settings (id = org id)
CREATE TABLE org_settings (
    id                                TEXT PRIMARY KEY REFERENCES orgs (id),
    notifications_webhook_failing     BOOLEAN,
    notifications_blocked_attempt     BOOLEAN,
    notifications_message_expiring    BOOLEAN,
    notifications_agent_offline       BOOLEAN,
    notifications_member_added        BOOLEAN,
    default_grace_seconds             INTEGER CHECK (default_grace_seconds BETWEEN 0 AND 86400),
    updated_at                        BIGINT NOT NULL,
    updated_by_kind                   TEXT,
    updated_by_id                     TEXT
);

-- Not in mocks/schema: per-person notification choices ("Notify me when"
-- on My Settings). The schema only has org-wide notifications in
-- org_settings, which stay as the org's defaults; a person's own row,
-- when present, wins. Found by the screen review (docs/data-model.md).
CREATE TABLE notification_preferences (
    org_id           TEXT NOT NULL REFERENCES orgs (id),
    user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    webhook_failing  BOOLEAN NOT NULL,
    blocked_attempt  BOOLEAN NOT NULL,
    message_expiring BOOLEAN NOT NULL,
    agent_offline    BOOLEAN NOT NULL,
    member_added     BOOLEAN NOT NULL,
    updated_at       BIGINT NOT NULL,
    PRIMARY KEY (org_id, user_id)
);

-- dispatch.workspace_settings (id = workspace id)
CREATE TABLE workspace_settings (
    id                   TEXT PRIMARY KEY REFERENCES workspaces (id),
    org_id               TEXT NOT NULL REFERENCES orgs (id),
    description          TEXT,
    default_expiry_hours INTEGER,
    retention_days       INTEGER NOT NULL,
    updated_at           BIGINT NOT NULL,
    updated_by_kind      TEXT,
    updated_by_id        TEXT,
    updated_by_label     TEXT,
    updated_by_via_kind  TEXT,
    updated_by_via_id    TEXT,
    updated_by_via_label TEXT,
    rev                  INTEGER NOT NULL DEFAULT 0
);

-- workspace_settings.agentBlocklist: agents that may never act in the workspace.
CREATE TABLE workspace_settings_agent_blocklist (
    workspace_id TEXT NOT NULL REFERENCES workspace_settings (id) ON DELETE CASCADE,
    org_id       TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    PRIMARY KEY (workspace_id, agent_id)
);
CREATE INDEX workspace_settings_org_blocklist ON workspace_settings_agent_blocklist (org_id, agent_id);

-- dispatch.agent_profiles (id = agent id)
CREATE TABLE agent_profiles (
    id                                  TEXT PRIMARY KEY REFERENCES agents (id),
    org_id                              TEXT NOT NULL REFERENCES orgs (id),
    status                              TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
    description                         TEXT,
    token_current_alg                   TEXT NOT NULL CHECK (token_current_alg IN ('sha256', 'argon2id')),
    token_current_hash                  TEXT NOT NULL,
    token_current_pepper_version        INTEGER,
    token_current_prefix                TEXT NOT NULL,
    token_current_last4                 TEXT NOT NULL,
    token_current_issued_at             BIGINT NOT NULL,
    token_current_expires_at            BIGINT,
    token_previous_digest_alg           TEXT,
    token_previous_digest_hash          TEXT,
    token_previous_digest_pepper_version INTEGER,
    token_previous_digest_prefix        TEXT,
    token_previous_digest_last4         TEXT,
    token_previous_digest_issued_at     BIGINT,
    token_previous_digest_expires_at    BIGINT,
    token_previous_grace_until          BIGINT,
    token_rotated_at                    BIGINT,
    token_rotated_by_kind               TEXT,
    token_rotated_by_id                 TEXT,
    token_grace_seconds                 INTEGER,
    token_grace_ended_early_at          BIGINT,
    token_rotation_count                INTEGER,
    token_delivery                      TEXT CHECK (token_delivery IN ('shown_once', 'sidecar')),
    sidecar_id                          TEXT,
    filters_read                        BOOLEAN NOT NULL,
    filters_write                       BOOLEAN NOT NULL,
    filters_workspace_blocklist         jsonb NOT NULL,
    client_name                         TEXT,
    client_version                      TEXT,
    client_via                          TEXT CHECK (client_via IN ('MCP', 'REST')),
    client_at                           BIGINT,
    last_transport_via                  TEXT CHECK (last_transport_via IN ('MCP', 'REST')),
    last_transport_at                   BIGINT,
    last_seen_at                        BIGINT,
    config_format                       TEXT,
    suspended_at                        BIGINT,
    revoked_at                          BIGINT,
    created_at                          BIGINT NOT NULL,
    updated_at                          BIGINT NOT NULL,
    rev                                 INTEGER NOT NULL DEFAULT 0,
    CHECK ((token_previous_digest_hash IS NULL) = (token_previous_grace_until IS NULL))
);
CREATE UNIQUE INDEX agent_profiles_token_hash ON agent_profiles (token_current_hash);
CREATE UNIQUE INDEX agent_profiles_token_hash_prev ON agent_profiles (token_previous_digest_hash);
CREATE INDEX agent_profiles_org_status ON agent_profiles (org_id, status);

-- agent_profiles.filters.agentBlocklist: authors whose messages the agent never receives.
CREATE TABLE agent_profiles_agent_blocklist (
    agent_profile_id TEXT NOT NULL REFERENCES agent_profiles (id) ON DELETE CASCADE,
    org_id           TEXT NOT NULL,
    agent_id         TEXT NOT NULL,
    PRIMARY KEY (agent_profile_id, agent_id)
);
CREATE INDEX agent_profiles_org_agent_blocklist ON agent_profiles_agent_blocklist (org_id, agent_id);

-- dispatch.membership_access (id = workspace membership id). A human
-- always reads and has no token or agent role; an agent always has both.
-- Reading off means writing off.
CREATE TABLE membership_access (
    id                                   TEXT PRIMARY KEY REFERENCES workspace_memberships (id) ON DELETE CASCADE,
    org_id                               TEXT NOT NULL REFERENCES orgs (id),
    workspace_id                         TEXT NOT NULL REFERENCES workspaces (id),
    member_kind                          TEXT NOT NULL CHECK (member_kind IN ('user', 'agent')),
    member_id                            TEXT NOT NULL,
    read                                 BOOLEAN NOT NULL,
    write                                BOOLEAN NOT NULL,
    agent_role                           TEXT CHECK (agent_role IN ('member', 'workspace_admin')),
    delegated_by_kind                    TEXT,
    delegated_by_id                      TEXT,
    token_current_alg                    TEXT CHECK (token_current_alg IN ('sha256', 'argon2id')),
    token_current_hash                   TEXT,
    token_current_pepper_version         INTEGER,
    token_current_prefix                 TEXT,
    token_current_last4                  TEXT,
    token_current_issued_at              BIGINT,
    token_current_expires_at             BIGINT,
    token_previous_digest_alg            TEXT,
    token_previous_digest_hash           TEXT,
    token_previous_digest_pepper_version INTEGER,
    token_previous_digest_prefix         TEXT,
    token_previous_digest_last4          TEXT,
    token_previous_digest_issued_at      BIGINT,
    token_previous_digest_expires_at     BIGINT,
    token_previous_grace_until           BIGINT,
    token_rotated_at                     BIGINT,
    token_rotated_by_kind                TEXT,
    token_rotated_by_id                  TEXT,
    token_grace_seconds                  INTEGER,
    token_grace_ended_early_at           BIGINT,
    token_rotation_count                 INTEGER,
    token_revoked_at                     BIGINT,
    token_delivery                       TEXT CHECK (token_delivery IN ('shown_once', 'sidecar')),
    sidecar_id                           TEXT,
    updated_at                           BIGINT NOT NULL,
    updated_by_kind                      TEXT,
    updated_by_id                        TEXT,
    updated_by_label                     TEXT,
    updated_by_via_kind                  TEXT,
    updated_by_via_id                    TEXT,
    updated_by_via_label                 TEXT,
    rev                                  INTEGER NOT NULL DEFAULT 0,
    CHECK (read OR NOT write),
    CHECK (member_kind <> 'user' OR (read AND token_current_hash IS NULL AND agent_role IS NULL)),
    CHECK (member_kind <> 'agent' OR (token_current_hash IS NOT NULL AND agent_role IS NOT NULL AND token_delivery IS NOT NULL))
);
CREATE UNIQUE INDEX membership_access_token_hash ON membership_access (token_current_hash);
CREATE UNIQUE INDEX membership_access_token_hash_prev ON membership_access (token_previous_digest_hash);
CREATE INDEX membership_access_org_ws ON membership_access (org_id, workspace_id);
CREATE INDEX membership_access_org_member ON membership_access (org_id, member_id);

-- dispatch.messages. The body is inline up to 64 KiB, else a blob with an
-- inline preview; the payload likewise. The author is a member (user or
-- agent) or a listener, which also records the caller's address.
CREATE TABLE messages (
    id                          TEXT PRIMARY KEY,
    org_id                      TEXT NOT NULL REFERENCES orgs (id),
    workspace_id                TEXT NOT NULL REFERENCES workspaces (id),
    author_kind                 TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'listener')),
    author_id                   TEXT NOT NULL,
    author_from                 TEXT,
    body_storage                TEXT NOT NULL CHECK (body_storage IN ('inline', 'blob')),
    body_text                   TEXT,
    body_blob_id                TEXT,
    body_bytes                  BIGINT,
    body_preview                TEXT,
    body_sha256                 TEXT,
    payload_storage             TEXT CHECK (payload_storage IN ('inline', 'blob')),
    payload_json                jsonb,
    payload_blob_id             TEXT,
    payload_bytes               BIGINT,
    audience_mode               TEXT NOT NULL CHECK (audience_mode IN ('all', 'only', 'except')),
    audience_agent_ids          jsonb,
    parent_id                   TEXT,
    thread_root_id              TEXT,
    created_at                  BIGINT NOT NULL,
    expires_at                  BIGINT,
    expired_early_at            BIGINT,
    expired_early_by_kind       TEXT,
    expired_early_by_id         TEXT,
    expired_early_by_label      TEXT,
    expired_early_by_via_kind   TEXT,
    expired_early_by_via_id     TEXT,
    expired_early_by_via_label  TEXT,
    trk                         TEXT NOT NULL,
    sent_via_channel            TEXT CHECK (sent_via_channel IN ('api_console', 'sidecar')),
    sent_via_user_id            TEXT,
    sent_via_sidecar_id         TEXT,
    webhook_id                  TEXT,
    stream_entry_id             TEXT,
    receipt_counts_targets      INTEGER,
    receipt_counts_queued       INTEGER,
    receipt_counts_held         INTEGER,
    receipt_counts_delivered    INTEGER,
    receipt_counts_read         INTEGER,
    receipt_counts_acked        INTEGER,
    receipt_counts_filtered     INTEGER,
    receipt_counts_never_delivered INTEGER,
    delete_at                   BIGINT NOT NULL,
    CHECK (author_kind <> 'listener' OR author_from IS NOT NULL),
    CHECK (body_storage <> 'inline' OR body_text IS NOT NULL),
    CHECK (body_storage <> 'blob' OR (body_blob_id IS NOT NULL AND body_bytes IS NOT NULL AND body_preview IS NOT NULL)),
    CHECK (audience_mode = 'all' OR audience_agent_ids IS NOT NULL)
);
CREATE INDEX messages_org_ws_created ON messages (org_id, workspace_id, created_at DESC);
CREATE INDEX messages_org_ws_thread ON messages (org_id, workspace_id, thread_root_id, created_at);
CREATE INDEX messages_org_author ON messages (org_id, author_kind, author_id, created_at DESC);
CREATE INDEX messages_org_expires ON messages (org_id, expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX messages_ttl_delete_at ON messages (delete_at);

-- messages.tags, one row per tag, carrying the message's created_at so the
-- org_ws_tags index can page a tag's messages newest first.
CREATE TABLE message_tags (
    message_id   TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    org_id       TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    tag          TEXT NOT NULL,
    created_at   BIGINT NOT NULL,
    PRIMARY KEY (message_id, tag)
);
CREATE INDEX message_tags_org_ws_tags ON message_tags (org_id, workspace_id, tag, created_at DESC);

-- dispatch.message_blobs. Mongo's GridFS overflow (gridFsId) is not
-- ported: data always holds the (base64) content here.
CREATE TABLE message_blobs (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    message_id   TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    part         TEXT NOT NULL CHECK (part IN ('body', 'payload')),
    content_type TEXT NOT NULL CHECK (content_type IN ('text/plain; charset=utf-8', 'application/json')),
    encoding     TEXT NOT NULL CHECK (encoding IN ('gzip', 'identity')),
    bytes        BIGINT NOT NULL,
    stored_bytes BIGINT,
    sha256       TEXT NOT NULL,
    data         TEXT NOT NULL,
    created_at   BIGINT NOT NULL,
    delete_at    BIGINT NOT NULL
);
CREATE INDEX message_blobs_org_message ON message_blobs (org_id, message_id);
CREATE INDEX message_blobs_ttl_delete_at ON message_blobs (delete_at);

-- dispatch.receipts: one per (message, targeted agent); id = <messageId>:<agentId>.
CREATE TABLE receipts (
    id                          TEXT PRIMARY KEY,
    org_id                      TEXT NOT NULL,
    workspace_id                TEXT NOT NULL,
    message_id                  TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    agent_id                    TEXT NOT NULL,
    state                       TEXT NOT NULL CHECK (state IN ('queued', 'held', 'delivered', 'read', 'acked', 'filtered', 'never_delivered')),
    delivered_at                BIGINT,
    read_at                     BIGINT,
    ack_at                      BIGINT,
    delivered_via_transport     TEXT CHECK (delivered_via_transport IN ('mcp', 'rest', 'sse', 'sidecar')),
    delivered_via_connection_id TEXT,
    delivered_via_sidecar_id    TEXT,
    held_rule                   TEXT,
    held_cause                  TEXT CHECK (held_cause IN ('suspended', 'membership read off', 'turned reading off')),
    held_at                     BIGINT,
    filtered_rule               TEXT,
    filtered_cause              TEXT,
    filtered_at                 BIGINT,
    filtered_after_send         BOOLEAN,
    removed_at                  BIGINT,
    removed_reason              TEXT,
    removed_final               BOOLEAN,
    removed_cause               TEXT,
    created_at                  BIGINT NOT NULL,
    updated_at                  BIGINT NOT NULL,
    delete_at                   BIGINT NOT NULL,
    UNIQUE (message_id, agent_id),
    CHECK (state <> 'filtered' OR (filtered_rule IS NOT NULL AND filtered_cause IS NOT NULL AND filtered_at IS NOT NULL AND filtered_after_send IS NOT NULL)),
    CHECK (state <> 'held' OR (held_rule IS NOT NULL AND held_cause IS NOT NULL AND held_at IS NOT NULL)),
    CHECK (state NOT IN ('delivered', 'read', 'acked') OR delivered_at IS NOT NULL)
);
CREATE INDEX receipts_org_agent_state ON receipts (org_id, agent_id, state, created_at);
CREATE INDEX receipts_org_ws_agent_state ON receipts (org_id, workspace_id, agent_id, state);
CREATE INDEX receipts_org_message ON receipts (org_id, message_id);
CREATE INDEX receipts_ttl_delete_at ON receipts (delete_at);

-- dispatch.threads: one per root message (id = root message id).
CREATE TABLE threads (
    id            TEXT PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    org_id        TEXT NOT NULL,
    workspace_id  TEXT NOT NULL,
    reply_count   INTEGER NOT NULL,
    last_reply_at BIGINT,
    participants  jsonb NOT NULL,
    updated_at    BIGINT NOT NULL,
    delete_at     BIGINT NOT NULL
);
CREATE INDEX threads_org_ws_last ON threads (org_id, workspace_id, last_reply_at DESC);
CREATE INDEX threads_ttl_delete_at ON threads (delete_at);

-- dispatch.tags: per-workspace tag index (id = <workspaceId>:<tag>).
CREATE TABLE tags (
    id            TEXT PRIMARY KEY,
    org_id        TEXT NOT NULL,
    workspace_id  TEXT NOT NULL REFERENCES workspaces (id),
    tag           TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    last_used_at  BIGINT NOT NULL,
    UNIQUE (workspace_id, tag)
);
CREATE INDEX tags_org_ws_used ON tags (org_id, workspace_id, last_used_at DESC);

-- dispatch.context_notes and their immutable history.
CREATE TABLE context_notes (
    id                   TEXT PRIMARY KEY,
    org_id               TEXT NOT NULL REFERENCES orgs (id),
    workspace_id         TEXT NOT NULL REFERENCES workspaces (id),
    title                TEXT NOT NULL,
    body                 TEXT NOT NULL,
    tags                 jsonb NOT NULL,
    version              INTEGER NOT NULL,
    created_at           BIGINT NOT NULL,
    created_by_kind      TEXT NOT NULL,
    created_by_id        TEXT,
    created_by_label     TEXT NOT NULL,
    created_by_via_kind  TEXT,
    created_by_via_id    TEXT,
    created_by_via_label TEXT,
    updated_at           BIGINT NOT NULL,
    updated_by_kind      TEXT NOT NULL,
    updated_by_id        TEXT,
    updated_by_label     TEXT NOT NULL,
    updated_by_via_kind  TEXT,
    updated_by_via_id    TEXT,
    updated_by_via_label TEXT,
    deleted_at           BIGINT
);
CREATE INDEX context_notes_org_ws_updated ON context_notes (org_id, workspace_id, updated_at DESC);

CREATE TABLE context_note_versions (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    note_id      TEXT NOT NULL REFERENCES context_notes (id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    tags         jsonb,
    at           BIGINT NOT NULL,
    by_kind      TEXT NOT NULL,
    by_id        TEXT,
    by_label     TEXT NOT NULL,
    by_via_kind  TEXT,
    by_via_id    TEXT,
    by_via_label TEXT
);
CREATE UNIQUE INDEX context_note_versions_org_note_version ON context_note_versions (org_id, note_id, version DESC);

-- dispatch.sidecars: a local process bound to one agent.
CREATE TABLE sidecars (
    id                                        TEXT PRIMARY KEY,
    org_id                                    TEXT NOT NULL REFERENCES orgs (id),
    agent_id                                  TEXT NOT NULL REFERENCES agents (id),
    name                                      TEXT NOT NULL,
    status                                    TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    enrollment_enrollment_token_id            TEXT NOT NULL,
    enrollment_enrolled_at                    BIGINT NOT NULL,
    enrollment_token_created_by_kind          TEXT NOT NULL,
    enrollment_token_created_by_id            TEXT NOT NULL,
    enrollment_from_ip                        TEXT,
    enrollment_public_key                     TEXT,
    enrollment_client_cert_fingerprint        TEXT,
    credential_current_alg                    TEXT NOT NULL CHECK (credential_current_alg IN ('sha256', 'argon2id')),
    credential_current_hash                   TEXT NOT NULL,
    credential_current_pepper_version         INTEGER,
    credential_current_prefix                 TEXT NOT NULL,
    credential_current_last4                  TEXT NOT NULL,
    credential_current_issued_at              BIGINT NOT NULL,
    credential_current_expires_at             BIGINT,
    credential_previous_digest_alg            TEXT,
    credential_previous_digest_hash           TEXT,
    credential_previous_digest_pepper_version INTEGER,
    credential_previous_digest_prefix         TEXT,
    credential_previous_digest_last4          TEXT,
    credential_previous_digest_issued_at      BIGINT,
    credential_previous_digest_expires_at     BIGINT,
    credential_previous_grace_until           BIGINT,
    credential_rotated_at                     BIGINT,
    credential_rotated_by_kind                TEXT,
    credential_rotated_by_id                  TEXT,
    credential_grace_seconds                  INTEGER,
    credential_grace_ended_early_at           BIGINT,
    credential_rotation_count                 INTEGER,
    local                                     jsonb NOT NULL,
    held_tokens                               jsonb,
    pull_messages_enabled                     BOOLEAN NOT NULL,
    pull_messages_cursor                      jsonb,
    pull_webhooks_enabled                     BOOLEAN NOT NULL,
    pull_webhooks_allowed_targets             jsonb,
    pull_webhooks_cursor                      jsonb,
    install_method                            TEXT,
    install_os                                TEXT,
    install_arch                              TEXT,
    install_host                              TEXT,
    install_service_manager                   TEXT,
    install_version                           TEXT,
    health_status                             TEXT NOT NULL CHECK (health_status IN ('healthy', 'degraded', 'offline')),
    health_last_seen_at                       BIGINT,
    health_ip                                 TEXT,
    health_missed_heartbeats                  INTEGER,
    health_reported_version                   TEXT,
    health_config_version                     INTEGER,
    health_cache_entries                      INTEGER,
    health_cache_hit_ratio                    DOUBLE PRECISION,
    health_cache_stale_served24h              INTEGER,
    health_cache_last_flush_at                BIGINT,
    cache_policy_mode                         TEXT NOT NULL CHECK (cache_policy_mode IN ('off', 'memory', 'disk')),
    cache_policy_key_protection               TEXT CHECK (cache_policy_key_protection IN ('process_memory', 'tpm', 'cloud_kms')),
    cache_policy_kms_key_ref                  TEXT,
    cache_policy_default_ttl_seconds          INTEGER,
    cache_policy_pinned_ttl_seconds           INTEGER,
    cache_policy_stale_if_error_seconds       INTEGER,
    cache_policy_max_staleness_seconds        INTEGER,
    cache_policy_negative_caching             BOOLEAN,
    cache_policy_max_entries                  INTEGER,
    created_at                                BIGINT NOT NULL,
    created_by_kind                           TEXT NOT NULL,
    created_by_id                             TEXT NOT NULL,
    updated_at                                BIGINT NOT NULL,
    revoked_at                                BIGINT,
    revoked_by_kind                           TEXT,
    revoked_by_id                             TEXT,
    rev                                       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX sidecars_credential_hash ON sidecars (credential_current_hash);
CREATE UNIQUE INDEX sidecars_credential_hash_prev ON sidecars (credential_previous_digest_hash);
CREATE INDEX sidecars_org_agent_status ON sidecars (org_id, agent_id, status);

-- dispatch.enrollment_tokens: single-use dsp_enr_ tokens for a sidecar.
CREATE TABLE enrollment_tokens (
    id                                  TEXT PRIMARY KEY,
    org_id                              TEXT NOT NULL REFERENCES orgs (id),
    app                                 TEXT NOT NULL CHECK (app = 'dispatch'),
    component_kind                      TEXT NOT NULL CHECK (component_kind = 'dispatch_sidecar'),
    token_alg                           TEXT NOT NULL,
    token_hash                          TEXT NOT NULL,
    token_pepper_version                INTEGER,
    token_prefix                        TEXT NOT NULL,
    token_last4                         TEXT NOT NULL,
    token_issued_at                     BIGINT NOT NULL,
    token_expires_at                    BIGINT,
    status                              TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'expired', 'revoked')),
    created_at                          BIGINT NOT NULL,
    created_by_kind                     TEXT NOT NULL,
    created_by_id                       TEXT NOT NULL,
    expires_at                          BIGINT NOT NULL,
    consumed_at                         BIGINT,
    consumed_from_ip                    TEXT,
    consumed_by_component_id            TEXT,
    revoked_at                          BIGINT,
    revoked_by_kind                     TEXT,
    revoked_by_id                       TEXT,
    delete_at                           BIGINT,
    intent_name                         TEXT NOT NULL,
    intent_agent_id                     TEXT NOT NULL,
    intent_local                        jsonb NOT NULL,
    intent_pull_webhooks                BOOLEAN,
    intent_allowed_targets              jsonb,
    intent_cache_policy_mode            TEXT CHECK (intent_cache_policy_mode IN ('off', 'memory', 'disk')),
    intent_cache_policy_key_protection  TEXT CHECK (intent_cache_policy_key_protection IN ('process_memory', 'tpm', 'cloud_kms')),
    intent_cache_policy_kms_key_ref     TEXT,
    intent_cache_policy_default_ttl_seconds    INTEGER,
    intent_cache_policy_pinned_ttl_seconds     INTEGER,
    intent_cache_policy_stale_if_error_seconds INTEGER,
    intent_cache_policy_max_staleness_seconds  INTEGER,
    intent_cache_policy_negative_caching       BOOLEAN,
    intent_cache_policy_max_entries            INTEGER
);
CREATE UNIQUE INDEX enrollment_tokens_token_hash ON enrollment_tokens (token_hash);
CREATE INDEX enrollment_tokens_org_status_exp ON enrollment_tokens (org_id, status, expires_at);
CREATE INDEX enrollment_tokens_ttl_delete_at ON enrollment_tokens (delete_at);

-- dispatch.webhooks: a message's fire hook or its listener, never both.
CREATE TABLE webhooks (
    id                            TEXT PRIMARY KEY,
    org_id                        TEXT NOT NULL REFERENCES orgs (id),
    workspace_id                  TEXT NOT NULL,
    message_id                    TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    mode                          TEXT NOT NULL CHECK (mode IN ('fire', 'listen')),
    fire_url                      TEXT,
    fire_trigger                  TEXT CHECK (fire_trigger IN ('send', 'all-read', 'all-ack')),
    fire_auth_user                TEXT,
    fire_auth_password            jsonb,
    fire_delivery_mode            TEXT CHECK (fire_delivery_mode IN ('push', 'sidecar_pull')),
    fire_delivery_sidecar_id      TEXT,
    fire_state                    TEXT CHECK (fire_state IN ('waiting', 'retrying', 'delivered', 'gave_up', 'no_targets', 'expired', 'target_lost')),
    fire_fired_at                 BIGINT,
    fire_next_attempt_at          BIGINT,
    fire_attempt_count            INTEGER,
    fire_attempts                 jsonb,
    fire_outcome_at               BIGINT,
    fire_dropped                  jsonb,
    listen_listener_id            TEXT,
    listen_url                    TEXT,
    listen_user                   TEXT,
    listen_password_alg           TEXT,
    listen_password_hash          TEXT,
    listen_password_pepper_version INTEGER,
    listen_password_prefix        TEXT,
    listen_password_last4         TEXT,
    listen_password_issued_at     BIGINT,
    listen_password_expires_at    BIGINT,
    listen_password_rotated_at    BIGINT,
    listen_state                  TEXT CHECK (listen_state IN ('open', 'closed')),
    listen_call_count             INTEGER,
    listen_last_call_at           BIGINT,
    created_at                    BIGINT NOT NULL,
    created_by_kind               TEXT NOT NULL,
    created_by_id                 TEXT,
    created_by_label              TEXT NOT NULL,
    created_by_via_kind           TEXT,
    created_by_via_id             TEXT,
    created_by_via_label          TEXT,
    updated_at                    BIGINT NOT NULL,
    expires_at                    BIGINT,
    delete_at                     BIGINT,
    CHECK (mode <> 'fire' OR (fire_url IS NOT NULL AND fire_trigger IS NOT NULL AND fire_delivery_mode IS NOT NULL
                              AND fire_state IS NOT NULL AND fire_attempt_count IS NOT NULL AND listen_listener_id IS NULL)),
    CHECK (mode <> 'listen' OR (listen_listener_id IS NOT NULL AND listen_url IS NOT NULL AND listen_user IS NOT NULL
                                AND listen_password_hash IS NOT NULL AND listen_state IS NOT NULL AND expires_at IS NOT NULL
                                AND fire_url IS NULL))
);
CREATE UNIQUE INDEX webhooks_org_message ON webhooks (org_id, message_id);
CREATE UNIQUE INDEX webhooks_listener ON webhooks (listen_listener_id);
CREATE INDEX webhooks_org_fire_due ON webhooks (org_id, fire_state, fire_next_attempt_at) WHERE fire_state IN ('waiting', 'retrying');
CREATE INDEX webhooks_sidecar_pull ON webhooks (fire_delivery_sidecar_id, fire_state) WHERE fire_delivery_mode = 'sidecar_pull';
CREATE INDEX webhooks_ttl_delete_at ON webhooks (delete_at);

-- dispatch.listener_calls: every call to a listener URL (the IP is PII).
CREATE TABLE listener_calls (
    id                  TEXT PRIMARY KEY,
    org_id              TEXT NOT NULL,
    workspace_id        TEXT NOT NULL,
    webhook_id          TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
    listener_id         TEXT NOT NULL,
    message_id          TEXT NOT NULL,
    at                  BIGINT NOT NULL,
    status              INTEGER NOT NULL CHECK (status IN (202, 401, 410, 413, 429)),
    from_ip             TEXT NOT NULL,
    bytes               BIGINT NOT NULL,
    appended_message_id TEXT,
    trk                 TEXT NOT NULL,
    summary             TEXT,
    delete_at           BIGINT NOT NULL
);
CREATE INDEX listener_calls_org_listener_at ON listener_calls (org_id, listener_id, at DESC);
CREATE INDEX listener_calls_ttl_delete_at ON listener_calls (delete_at);

-- dispatch.webhook_dead_letters: fire hooks that gave up, replayable until
-- the message expires.
CREATE TABLE webhook_dead_letters (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    webhook_id   TEXT NOT NULL,
    message_id   TEXT NOT NULL,
    url          TEXT NOT NULL,
    trigger      TEXT NOT NULL CHECK (trigger IN ('send', 'all-read', 'all-ack')),
    attempts     jsonb NOT NULL,
    reason       TEXT NOT NULL CHECK (reason IN ('gave_up', 'sidecar_unavailable')),
    dead_at      BIGINT NOT NULL,
    replays      jsonb,
    delete_at    BIGINT NOT NULL
);
CREATE INDEX webhook_dead_letters_org_ws_dead ON webhook_dead_letters (org_id, workspace_id, dead_at DESC);
CREATE INDEX webhook_dead_letters_ttl_delete_at ON webhook_dead_letters (delete_at);

-- dispatch.sealed_secrets: outbound basic-auth passwords, envelope-encrypted.
CREATE TABLE sealed_secrets (
    id                   TEXT PRIMARY KEY,
    org_id               TEXT NOT NULL,
    purpose              TEXT NOT NULL CHECK (purpose = 'webhook_basic_auth'),
    owner_kind           TEXT NOT NULL CHECK (owner_kind = 'webhook'),
    owner_id             TEXT NOT NULL,
    envelope             jsonb NOT NULL,
    created_at           BIGINT NOT NULL,
    created_by_kind      TEXT NOT NULL,
    created_by_id        TEXT,
    created_by_label     TEXT NOT NULL,
    created_by_via_kind  TEXT,
    created_by_via_id    TEXT,
    created_by_via_label TEXT,
    destroy_at           BIGINT NOT NULL
);
CREATE INDEX sealed_secrets_org_owner ON sealed_secrets (org_id, owner_id);
CREATE INDEX sealed_secrets_ttl_destroy_at ON sealed_secrets (destroy_at);
