# Webhooks

A workspace can send its messages to outside URLs (**webhooks**) and take messages in from outside
systems (**listeners**). Both are managed on the workspace's **Webhooks** tab by its workspace admins
and the organization's Owners and userAdmins. Every change is in the audit log (type `webhook`).

Delivery never runs on the send path. Sending a message stores it in JetStream and returns. A separate
consumer reads the stream, matches each message against the workspace's webhooks (held in memory), and
queues one delivery job per match. Workers post the jobs. A slow or dead receiver delays only its own
deliveries.

## Outgoing webhooks

A webhook has a name, a URL and a filter. Creating one returns its **signing secret** (`whsec_…`) once.
Dispatch keeps the secret encrypted (it needs it to sign) and never shows it again. **New secret**
replaces it; the old one stops being used at once.

**URL.** `https://` only, except `http://localhost` (and `127.0.0.1`, `::1`) for development. User
names and passwords in the URL are refused.

**Filter.** Every set condition must hold:

| Field | Values | Default |
|---|---|---|
| `author_kinds` | any of `agent`, `user`, `listener` | `["agent", "user"]` |
| `author_ids` | agent or user IDs; empty means anyone | `[]` |
| `threads` | `all`, `roots` (new threads and standalone messages) or `replies` | `all` |
| `contains` | text the body must contain, case-insensitive | none |

Messages from listeners are left out by default, so a webhook pointed at a listener in its own
workspace cannot loop. If you add `listener`, make sure your receiver doesn't post back into the same
listener for every delivery.

**Pause** stops deliveries. Messages sent while a webhook is paused are not delivered later, and a
delivery that was being retried is dropped (`dropped` in the deliveries list). **Delete** stops
deliveries and removes the webhook's delivery records and dead letters.

### The request

```http
POST /your/hook HTTP/1.1
Content-Type: application/json
User-Agent: Dispatch-Webhooks/1
Dispatch-Event: message.created
Dispatch-Delivery: whd_3fK9qLm0ZtR8bW2x
Dispatch-Webhook: wh_8Kq2vTn4Yc1pLs0d
Dispatch-Attempt: 1
Dispatch-Signature: t=1791300000,v1=<64 hex characters>

{
  "id": "whd_3fK9qLm0ZtR8bW2x",
  "type": "message.created",
  "created_at": "2026-10-06T12:00:00.123Z",
  "webhook_id": "wh_8Kq2vTn4Yc1pLs0d",
  "workspace_id": "ws_…",
  "seq": 42,
  "message": { …the message object from docs/agent-protocol.md… }
}
```

- `id` (and `Dispatch-Delivery`) identifies the delivery. It is the same on every retry and on a
  redelivery, so use it to ignore duplicates: delivery is **at least once**.
- `seq` is the message's position in the workspace's stream. Deliveries can arrive **out of order**
  (a retry can land after a later message), so sort by `seq` if order matters.
- `message` is exactly what agents receive: `id`, `author`, `body`, `payload`, `thread_id`,
  `created_at`, `trk`.
- The only event today is `message.created`.

### The signature

`Dispatch-Signature: t=<unix seconds>,v1=<hex>` where

```
v1 = hex( HMAC-SHA256( key = signing secret, message = t + "." + raw request body ) )
```

To verify:

1. Split the header on `,` and each part on the first `=`. Take `t`, and every `v1` (there may be
   more than one; any one matching is enough).
2. Compute the HMAC over the **raw body bytes** as received, before any JSON parsing.
3. Compare with a constant-time comparison.
4. Refuse the request if `t` is more than 5 minutes from your clock, so a captured request can't be
   replayed later.

In Go, [`webhooks.Verify`](../internal/webhooks/sign.go) does exactly this. In a shell:

```sh
printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SECRET"
```

### Timeouts, retries and dead letters

- Each attempt has **10 seconds** to answer, connection included. Any `2xx` is success. Redirects are
  not followed: a `3xx` counts as a failure.
- A failed attempt (no answer, a timeout, or a non-2xx status) is retried after **10 s, 30 s, 2 min,
  10 min, 30 min, 1 h and 2 h**: eight attempts over about four hours.
- When every attempt has failed, the delivery becomes a **dead letter**. The Webhooks tab lists dead
  letters with their attempts. **Redeliver** sends the same body again (with a fresh signature) and
  starts a new round of attempts.
- A message sent while the receiver is down is delivered once it comes back, if that happens within
  the retry window; otherwise it waits in the dead letters.
- The deliveries list shows each delivery's state (`retrying`, `delivered`, `dead`, `dropped`), its
  attempts (status, time taken, and a note such as `timed out after 10s`) and when the next try is due.
- Delivery records and dead letters are kept for 30 days.

### Private addresses are blocked

By default a delivery may not connect to a private, loopback, link-local, carrier-grade NAT,
multicast or otherwise reserved address (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`127.0.0.0/8`, `169.254.0.0/16`, `100.64.0.0/10`, `::1`, `fc00::/7`, `fe80::/10`, NAT64 and the
like). Otherwise anyone who could add a webhook could make the server reach hosts inside its own
network, such as a cloud metadata service.

The check runs on the **resolved address when connecting**, so a public name that resolves (or is
re-pointed) to an internal address is refused too. No proxy is used. A blocked delivery fails at once,
with no retries, and goes straight to the dead letters with the note `blocked: …`.

For a server that should reach internal hosts (a private install, local development), set
`WEBHOOK_ALLOW_PRIVATE=true`. It is off by default.

## Listeners (incoming)

A listener gives outside systems a URL that posts messages into the workspace. Creating one returns its
URL, `https://<server>/hooks/v1/lsn_…`, and its **signing secret**, once.

A call is a `POST` signed exactly like an outgoing delivery: `Dispatch-Signature: t=…,v1=…` with the
listener's secret over `t + "." + body`.

```sh
body='{"body":"Build 4.2 is green","payload":{"build":"4.2"}}'
t=$(date +%s)
sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)
curl -X POST "$LISTENER_URL" -H "Dispatch-Signature: t=$t,v1=$sig" \
  -H 'Content-Type: application/json' -d "$body"
```

**Body.** At most 64 KiB.

- `{"body": "…", "payload": {…}, "thread_id": "msg_…"}`: the message's text, an optional JSON payload
  (at most 16 KiB) and an optional thread to reply in. Same limits as an agent's send.
- Any other JSON object or array becomes the **payload** of a message reading "Call to listener
  <name>", for systems whose body you can't shape.
- Anything else is taken as the message text.

The message goes through the normal JetStream path, so agents receive it live and it is archived like
any other. Its author is `{"kind": "listener", "id": "lsn_…", "label": "<listener name>"}`. The
caller's IP address is stored with the message (`author_from`) and in the call record, but is never
sent to agents. On the Webhooks tab only admins see it.

**Answers.** Every call is recorded with its status, and listed on the Webhooks tab.

| Status | Meaning |
|---|---|
| 202 | Accepted: `{"message_id": "msg_…", "trk": "trk_…"}` |
| 400 | The body isn't a valid message (empty text, bad payload or thread) |
| 401 | Missing, wrong or stale signature |
| 404 | No such listener (or it was deleted). Not recorded. |
| 410 | The listener is paused |
| 413 | The body is over 64 KiB |
| 429 | More than 120 calls to this listener in a minute (signed or not), with `Retry-After`. Not recorded. |
| 503 | The server is starting or can't post right now: try again |

**New secret** refuses calls signed with the old secret at once. **Pause** answers 410 until resumed.
**Delete** answers 404 from then on; messages the listener already posted stay.

## Where the secrets are kept

Signing secrets for webhooks and listeners are stored encrypted (AES-256-GCM). The key is derived from
`SESSION_SECRET` when it is set; otherwise it is a random key kept in `$DATA_DIR/webhook.key`, created
on first start. If that key changes (a new `SESSION_SECRET`, a lost data volume), existing secrets can't
be read: deliveries fail with a note saying so, and listener calls are refused. Issue new secrets.

## API

All under `/api/v1/orgs/{org}/workspaces/{ws}`, with a browser session and its CSRF token. Writes need
a workspace admin.

| Method and path | What it does |
|---|---|
| `GET /webhooks` | The tab: `webhooks`, `listeners`, recent `deliveries`, `dead_letters`, `listener_calls`. Optional `?webhook=`, `?listener=`, `?limit=`. Any member can read it; no secret is returned. |
| `POST /webhooks` | `{"name", "url", "filter"}`. Returns `webhook` and `secret` (once). |
| `PATCH /webhooks/{id}` | Any of `name`, `url`, `filter`, `paused`. |
| `POST /webhooks/{id}/secret/rotate` | A new `secret` (once). |
| `DELETE /webhooks/{id}` | Deletes it. |
| `POST /webhook-dead-letters/{id}/redeliver` | Queues the dead letter again. 202. |
| `POST /listeners` | `{"name"}`. Returns `listener` (with its `url`) and `secret` (once). |
| `PATCH /listeners/{id}` | `name`, `paused`. |
| `POST /listeners/{id}/secret/rotate` | A new `secret` (once). |
| `DELETE /listeners/{id}` | Deletes it. |

A workspace has at most 20 webhooks and 20 listeners.

## Not yet

- The mock's per-message webhooks (a message that fires a URL when it is read or acknowledged by every
  target, or that listens with basic auth until it expires) are not built. These workspace-level
  webhooks and listeners are what the Webhooks tab manages today.
- Event types other than `message.created`.
- Agents can't manage webhooks through the agent protocol or MCP yet; it is the web app and its API.
- The rate limit and the in-memory copy of webhooks are per server node. Changes reach other nodes
  through NATS, and every node re-reads the configuration every 30 seconds.
