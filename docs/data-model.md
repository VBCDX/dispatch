# Data model

Dispatch keeps its records in one SQL database, either Postgres or SQLite. The tables come from the storage schema in `mocks/schema/` on the `data-schema` branch, and the migrations live in `internal/store/migrations/`:

| Migration | What it holds |
|---|---|
| `0001_init.sql` | The sign-in starter's `users`, `identities` and `sessions` |
| `0002_shared.sql` | The shared suite records from `mocks/schema/shared/`: orgs, workspaces, workspace memberships, agents, audit events, outbox, applied events. It also adds the auth model: org memberships, invitations, MFA factors, support locks and suspensions. `users`, `identities` and `sessions` are altered in place to match it. |
| `0003_dispatch.sql` | Dispatch's own records from `mocks/schema/dispatch/`, plus one table added for the screens (`notification_preferences`) |

The agent message path doesn't touch these tables. Sending and delivering run on embedded NATS, and permission checks run from memory. SQL is the record behind history, search, receipts and configuration.

## How the schema was translated

The rules are mechanical, so that Keyhole's port of `mocks/schema/shared/` (VBCDX/keyhole) produces the same shared tables:

- **Names.** Each Mongo collection becomes a table with the same name. `_id` becomes `id`, a text column holding the prefixed public ID (`org_acme`, `ws_rel`). Field names become snake_case.
- **Timestamps.** Every instant is a `BIGINT` of Unix milliseconds, as in `0001`. Instants inside JSON columns (webhook attempts, for example) are Unix milliseconds too.
- **Fixed-field objects are flattened**, joining the path with `_` (`fire.delivery.mode` → `fire_delivery_mode`). The shared types always flatten the same way:
  - `principalRef` → `_kind`, `_id`
  - `actorRef` → `_kind`, `_id`, `_label`, `_via_kind`, `_via_id`, `_via_label`
  - `tokenDigest` → `_alg`, `_hash`, `_pepper_version`, `_prefix`, `_last4`, `_issued_at`, `_expires_at`
  - `credentialSet` → `_current_*`, `_previous_digest_*`, `_previous_grace_until`, `_rotated_at`, `_rotated_by_*`, `_grace_seconds`, `_grace_ended_early_at`, `_rotation_count`
- **JSON columns.** Arrays of objects, unions (a `oneOf` of different shapes, such as `secretRef` and `localEndpoint`) and free-form JSON are `jsonb` on Postgres and `TEXT` on SQLite.
- **Element-indexed arrays become child tables.** Where `indexes.json` indexes an array element by element (a Mongo multikey index), the array becomes a child table, so that index can still exist:
  - `messages.tags` → `message_tags`
  - `workspace_settings.agentBlocklist` → `workspace_settings_agent_blocklist`
  - `agent_profiles.filters.agentBlocklist` → `agent_profiles_agent_blocklist`
- **Indexes.** Indexes and unique constraints follow each `indexes.json`, named `<table>_<index name>`. A Mongo partial unique index (`$exists: true`) becomes a plain unique index, since SQL unique indexes already ignore NULLs. TTL fields (`deleteAt`, `expireAt`, `destroyAt`) are plain indexed columns: deleting expired rows is a job, not a database feature here.
- **Left out on purpose:**
  - **Mongo text indexes.** Full-text search is not built yet.
  - **GridFS overflow for blobs** (`message_blobs.gridFsId`) is gone: `data` always holds the content.
  - **The Redis key-spaces and cache notes** (`redis.md`, `cache.md`) are not data in SQL.
- **The suite and Dispatch audit rows share one table**, `audit_events`. `shared = true` marks a suite row, and a CHECK enforces the schema's rule that a shared row has no `detail` or `link` and is `admin` or `support`.

### How the original sign-in tables were merged

- **`users`** gains the shared columns: `email_lower`, `status`, the lock summary, `last_sign_in_at`, `locale` and `erased_at`. `email_lower` is indexed but **not unique**, unlike the schema's auth service. Dispatch links a single sign-on (OpenID Connect) sign-in by issuer and subject only, never by email, so a local account and an SSO account may share an email.
- **`identities`** renames `issuer` to `connection_id` and `created_at` to `linked_at`. A local account's provider becomes `password` with `connection_id` set to `''`, and the migration rewrites existing rows. An SSO account stays `oidc`, with the issuer URL as `connection_id`.
- **`sessions`** keeps the starter's key, the SHA-256 of the cookie (`id_hash`), along with `method`, `csrf_token` and `id_token_hint`. It gains the shared session columns (`client`, `device`, `ip`, `last_seen_at`, revocation, and the refresh-token family for CLI sessions). Nothing writes the refresh-token columns yet.
- **New IDs are schema-style**: a prefix and 16 base62 characters (`u_…`, `idn_…`). Users created by the original sign-in tables (`0001_init.sql`) keep their UUIDs.

## Screens and their tables

There is one section for each route in the mock (`mocks/v1`, on `main`). Each one names the tables that feed the screen and anything the screen needs that the tables can't supply.

"Presence" below means whether an agent is connected right now. It is kept in memory from the NATS connections, as Redis would have done in the schema. It is never stored in SQL: `agent_profiles.last_seen_at` is written back now and then, for "last seen".

### Workspaces (`/workspaces`)

- **Rows:** `workspaces` where `status = 'active'` (index `org_status_name`), joined to `workspace_settings` for the description.
- **Members** (humans · agents): `workspace_memberships` by `member_kind`. The "N blocked" count comes from `workspace_settings_agent_blocklist`.
- **Messages · 24 h:** `messages` by `(org_id, workspace_id, created_at)`.
- **Waiting on agents:** unexpired `messages` whose `receipt_counts_acked` is below `receipt_counts_targets` minus `receipt_counts_filtered`. `receipts` gives the exact numbers.
- **Webhooks:** `webhooks` joined to unexpired messages.
- **Your role:** your `workspace_memberships.role`. With no row, an org Owner or userAdmin is a default admin, derived from `org_memberships` and never stored.
- **Online agents:** presence (not SQL).
- **Gaps:** none.

### Workspace detail (`/workspaces/:id/…`)

- **Header:** `workspaces`, plus `workspace_settings.description`, the member count and online agents (presence). "Delete" sets `workspaces.status = 'deleted'` with `deleted_at` and `deleted_by_*`, so audit rows still resolve the name, as "Release train (deleted)".

#### Messages

- **Messages:** `messages` by `(org_id, workspace_id, created_at DESC)`. Threads come from `parent_id` / `thread_root_id` (index `org_ws_thread`), and the reply count and last reply from `threads`.
- **Tags:** `message_tags`, filtered by `org_ws_tags`. Tag suggestions come from `tags`.
- **Author:** `author_kind` / `author_id` (`user`, `agent` or `listener`, plus `author_from` for a listener). Names come from `users` or `agents`. "Sent from the API console" is `sent_via_channel = 'api_console'` with `sent_via_user_id`.
- **Audience:** `audience_mode` and `audience_agent_ids`.
- **Receipts** for each agent: `receipts`, with state, delivered/read/ack times, the held or filtered rule and cause, and the "access removed after delivery" note (`removed_*`). The filters "Waiting on an ack" and "Not read by everyone" use the `receipt_counts_*` snapshot; "Mine" uses `author_kind = 'user' AND author_id = me` (`org_author`).
- **Body:** `body_text`, or `body_preview` plus a `message_blobs` row when it is over 64 KiB. The payload is `payload_json` or a blob.
- **Expiry:** `expires_at`, and `expired_early_*` when someone ended it.
- **Default expiry** for the composer: `workspace_settings.default_expiry_hours`.
- **Gaps:** none in the schema. Message bodies are capped at 32 KiB (`MaxBodyBytes` in `internal/messaging`), so every body is stored inline in `body_text` and nothing reads or writes `message_blobs` yet.

#### Members

- **Rows:** `workspace_memberships` (role, `added_*`, `delegated_*`) joined to `membership_access` (read/write, `agent_role`, token last four, previous token and grace).
- **Names:** `users` / `agents`. "Delegated by" resolves `delegated_by_id` against `users` or `agents`, because the schema stores no label there. After an erasure the pseudonymised name shows, as in audit.
- **Last seen:** `agent_profiles.last_seen_at`.
- **Gaps:** none.

#### Access

- **The ladder** is the access check shown step by step. It reads, in order:
  - `agent_profiles` (status, token, `filters_*`);
  - `agent_profiles.filters_workspace_blocklist`;
  - `workspace_settings_agent_blocklist`;
  - `membership_access` (token, `token_revoked_at`, read/write/admin);
  - the recipient's `agent_profiles_agent_blocklist`.
- **Gaps:** none.

#### Webhooks

- **Rows:** `webhooks` for the workspace's messages.
  - A fire hook shows `fire_url`, `fire_trigger`, `fire_auth_user`, `fire_state`, `fire_attempts` (JSON), `fire_next_attempt_at`, `fire_outcome_at` and `fire_dropped`.
  - A listener shows `listen_url`, `listen_user`, `listen_password_last4`, `listen_state` and `listen_call_count`, with `listener_calls` for its calls.
  - Dead letters come from `webhook_dead_letters`.
- **Basic-auth password:** only `fire_auth_password`, a sealed `secretRef`, is stored. The password itself is in `sealed_secrets`.
- **Gaps:** none.

#### Context

- **Notes:** `context_notes` by `(org_id, workspace_id, updated_at DESC)`: title, body, tags, version and `updated_by_label`.
- **History:** `context_note_versions`.
- **Gaps:** none. The mock keeps only `{version, by, at}` for older versions, so the demo seed copies the current title and body into them.

#### Connect

- **Config download:** the agent's ID and `agent_profiles.token_current_last4`, the workspace's ID and `membership_access.token_current_last4`. Plaintext tokens appear once, when issued or rotated, and are never stored. `agent_profiles.config_format` records the last format downloaded.
- **Gaps:** none.

#### Audit

- **Rows:** `audit_events` by `(org_id, workspace_id, at DESC)`, both shared and Dispatch rows.
  - "Via the API console" is `actor_via_kind = 'api_console'`.
  - `detail` is the structured JSON from `dispatch/audit_detail.schema.json`; the screen formats it as label/value pairs.
  - `link_label` / `link_to` is the "Open …" link.
- **Gaps:** none.

### Search (`/search`)

- **Messages:** `messages` (body, payload, ID, `trk`) and `message_tags`, limited to the caller's workspaces (`workspace_memberships`, or every workspace for an org admin).
  - "From agents / from humans" uses `author_kind`.
  - "Waiting on an ack" uses `receipt_counts_*` and `expires_at`.
- **Notes:** `context_notes` (title, body, tags).
- **Gaps:** full-text matching. Both tables can be scanned with `LIKE`, but a real text index (Postgres `tsvector` / SQLite FTS5) is not built yet.

### Agents (`/agents`) and agent detail (`/agents/:id`)

- **List:** `agents` joined to `agent_profiles`. That gives the label, `status`, `description`, the reported client (`client_*`) and `last_transport_*`. "Created by" is `agents.created_by_label`.
- **Online:** presence (not SQL); "last seen" is `agent_profiles.last_seen_at`.
- **Detail:**
  - **Token:** `token_current_last4`, and `token_previous_digest_last4` with `token_previous_grace_until` during a rotation.
  - **Filters:** `filters_read`, `filters_write`, `filters_workspace_blocklist` and `agent_profiles_agent_blocklist`.
  - **Workspaces:** `workspace_memberships` with `member_kind = 'agent'`, plus `membership_access`.
  - **Messages addressed to it:** `receipts` by `(org_id, agent_id, state, created_at)`.
  - **Activity:** `audit_events` where `actor_id` is the agent (`org_actor_at`).
  - **Sidecars:** `sidecars` by `(org_id, agent_id, status)`.
- **Gaps:** none.

### People (`/people`)

- **Rows:** `org_memberships` for the current org (role, `status`: active, invited or suspended, and `suspended_from`) joined to `users` (name, email).
  - Invited people are users with `status = 'pending'`, with an `invitations` row.
  - "Workspaces" counts `workspace_memberships` with `member_kind = 'user'`.
- **Last active (this org):** the newest `audit_events.at` where `actor_kind = 'user'` and `actor_id` is the person (`org_actor_at`), as the schema's `collections.md` says.
- **Suspension history:** `suspensions`.
- **Gaps:** none in the schema. Pending invitations are read from `invitations`. `suspensions` is written on every suspend and resume, but no screen shows the history yet.

### Org audit (`/audit`)

- **Rows:** `audit_events` by `(org_id, at DESC)`.
  - Owners and userAdmins see every row, including those for deleted workspaces: their names resolve from soft-deleted `workspaces`.
  - Everyone else sees rows for their workspaces (`workspace_id` in their memberships) and rows with no workspace.
  - The type filter uses `org_type_at`.
- **Gaps:** none.

### Developers (`/developers`)

- **The endpoint reference** is static: it is the API description, not data.
- **"Try it"** lists the caller's `agents`, `workspaces`, `context_notes` and `messages` to fill in example requests, and takes an agent token and a workspace token the person pastes in.
- **Gaps:** none.

### Settings: me (`/settings/me`)

- **Profile:** `users` (name, email). "Signs in with SSO" or a password comes from `identities.provider`.
- **Active sessions:** `sessions` for the user that are neither expired nor revoked: `device`, `place`, `last_seen_at`. Sign-in doesn't record the device, user agent or IP yet, so these columns stay empty for now.
- **"Notify me when":** **added to the schema.** The screen holds each person's own choices, but the schema only has org-wide `notifications` in `org_settings`. `0003_dispatch.sql` adds `notification_preferences`, keyed by `(org_id, user_id)` with the same five switches. A person's row wins, and `org_settings` gives the default when there is none.

### Settings: account (`/settings/account`)

- **Organization name:** `orgs.name` (and `rev` for concurrent renames).
- **Gaps:** none. The identity and plan notes on the page are static text.

## Changes to the schema, in short

| Change | Why |
|---|---|
| Added `notification_preferences` (`org_id`, `user_id`, five switches) | My Settings shows per-person notification choices; the schema had only per-org ones |
| `users.email_lower` is not unique | Dispatch links sign-ins by issuer and subject, so two accounts may share an email (see above) |
| `sessions` keeps `id_hash`, `method`, `csrf_token` and `id_token_hint` | Dispatch's browser sessions, from the original sign-in tables |
| `message_blobs` without `gridFsId` | GridFS is Mongo-only |
| No text indexes | Full-text search is not built yet |

Keep `mocks/schema` in step with these changes. Its `shared/` folder is meant to be byte-for-byte the same in Dispatch and Keyhole, so the two auth notes apply to Keyhole's tables too.

## Demo data

`internal/seed/demo.json` is the mock's populated demo database (`populatedDB()` in `mocks/v1/src/lib/seed.ts`), converted to these tables. `scripts/seed-from-mock.mjs` regenerates it. It contains:

- two orgs: Acme Corp and Northwind Labs;
- five people, seven agents and four workspaces;
- the messages, receipts, webhooks, context notes and audit events.

The fixture differs from the mock in a few ways:

- **IDs use the schema's prefixes:** `agt_planner` becomes `ag_planner`, and `wks_rel` becomes `ws_rel`.
- **Times are relative.** The fixture stores each instant as an offset from the moment the seed runs, so the demo always looks recent.
- **Seeded tokens can't sign anything in.** Agent, workspace and listener tokens keep the mock's last four characters, but their stored hash is a placeholder that no real token matches. Rotate a token to get a working one.
- **Seeded people have no identities,** so nobody can sign in as them. Their sessions are display-only rows whose keys no cookie can produce.

`dispatch seed` loads the fixture. Each row is inserted only if its key is absent, so a second run changes nothing.

With `SEED_DEMO_DATA=true`, the server seeds an empty database (one with no organizations) at start-up. Anyone signing in for the first time joins Acme Corp as an Owner, so the screens have data:

- **"First time"** means `users.last_sign_in_at` is still empty. Accounts created before this migration have never had it set, so their next sign-in counts as their first.
- **A later sign-in never re-adds the membership,** even if someone removed it.
