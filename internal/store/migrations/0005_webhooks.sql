-- Workspace webhooks and listeners (issue 16). The webhooks table from 0003
-- holds the mock's per-message fire hooks and listeners; these are the
-- workspace-level ones the Webhooks tab manages: outgoing webhooks that
-- receive the workspace's messages, and listeners that outside systems post
-- messages to. Signing secrets are stored sealed (the server needs them to
-- sign and verify), never in plain text.

-- An outgoing webhook. Filters choose which messages it receives.
CREATE TABLE workspace_webhooks (
    id                  TEXT PRIMARY KEY,
    org_id              TEXT NOT NULL REFERENCES orgs (id),
    workspace_id        TEXT NOT NULL REFERENCES workspaces (id),
    name                TEXT NOT NULL,
    url                 TEXT NOT NULL,
    filter_author_kinds jsonb NOT NULL,
    filter_author_ids   jsonb,
    filter_threads      TEXT NOT NULL CHECK (filter_threads IN ('all', 'roots', 'replies')),
    filter_contains     TEXT,
    secret_sealed       TEXT NOT NULL,
    secret_last4        TEXT NOT NULL,
    secret_rotated_at   BIGINT NOT NULL,
    paused              BOOLEAN NOT NULL,
    created_at          BIGINT NOT NULL,
    created_by_kind     TEXT NOT NULL,
    created_by_id       TEXT,
    created_by_label    TEXT NOT NULL,
    updated_at          BIGINT NOT NULL
);
CREATE INDEX workspace_webhooks_org_ws ON workspace_webhooks (org_id, workspace_id, created_at);

-- One message's delivery to one webhook, updated after every attempt.
CREATE TABLE webhook_deliveries (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    webhook_id      TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    seq             BIGINT NOT NULL,
    state           TEXT NOT NULL CHECK (state IN ('retrying', 'delivered', 'dead', 'dropped')),
    attempt_count   INTEGER NOT NULL,
    attempts        jsonb NOT NULL,
    next_attempt_at BIGINT,
    created_at      BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    delete_at       BIGINT NOT NULL
);
CREATE INDEX webhook_deliveries_org_ws_updated ON webhook_deliveries (org_id, workspace_id, updated_at DESC);
CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries (webhook_id, updated_at DESC);
CREATE INDEX webhook_deliveries_ttl_delete_at ON webhook_deliveries (delete_at);

-- A dead letter keeps the exact payload that failed, so it can be
-- redelivered byte for byte, and which delivery it ended.
ALTER TABLE webhook_dead_letters ADD COLUMN delivery_id TEXT;
ALTER TABLE webhook_dead_letters ADD COLUMN body TEXT;
ALTER TABLE webhook_dead_letters ADD COLUMN seq BIGINT;

-- An incoming listener: a URL outside systems post signed messages to.
CREATE TABLE workspace_listeners (
    id                TEXT PRIMARY KEY,
    org_id            TEXT NOT NULL REFERENCES orgs (id),
    workspace_id      TEXT NOT NULL REFERENCES workspaces (id),
    name              TEXT NOT NULL,
    secret_sealed     TEXT NOT NULL,
    secret_last4      TEXT NOT NULL,
    secret_rotated_at BIGINT NOT NULL,
    paused            BOOLEAN NOT NULL,
    call_count        BIGINT NOT NULL,
    last_call_at      BIGINT,
    created_at        BIGINT NOT NULL,
    created_by_kind   TEXT NOT NULL,
    created_by_id     TEXT,
    created_by_label  TEXT NOT NULL,
    updated_at        BIGINT NOT NULL
);
CREATE INDEX workspace_listeners_org_ws ON workspace_listeners (org_id, workspace_id, created_at);

-- Every call to a workspace listener (the address is PII). listener_calls
-- from 0003 references the per-message webhooks table, so it can't hold
-- these.
CREATE TABLE workspace_listener_calls (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    listener_id  TEXT NOT NULL,
    at           BIGINT NOT NULL,
    status       INTEGER NOT NULL,
    from_ip      TEXT NOT NULL,
    bytes        BIGINT NOT NULL,
    message_id   TEXT,
    trk          TEXT NOT NULL,
    summary      TEXT,
    delete_at    BIGINT NOT NULL
);
CREATE INDEX workspace_listener_calls_org_listener_at ON workspace_listener_calls (org_id, listener_id, at DESC);
CREATE INDEX workspace_listener_calls_ttl_delete_at ON workspace_listener_calls (delete_at);
