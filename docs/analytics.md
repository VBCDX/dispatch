# Analytics — event contract, metrics and windows

Dispatch has optional, minimal GA4 instrumentation. This file is its
contract: which events are sent, what they may carry, and how the activation
and retention metrics are defined. The point is that any activation/retention
number cited from it can be traced to an event definition, a window and a
source.

## Source

- Analytics is **off by default**. An operator who wants it creates a GA4
  property with a web data stream for their Dispatch URL and sets that
  stream's measurement id.
- The measurement id: `GA_MEASUREMENT_ID` (server env), served to the web app
  through `GET /api/auth/config` (`ga_measurement_id`). Empty by default.
- If you run other apps in the same GA4 property, give each its own web data
  stream; the metric definitions below work per stream or across them.

## Events

| Event | Parameters | Fired when | Notes |
|---|---|---|---|
| `page_view` | `page_path` (normalized), `page_title` | once per app load | in-app route changes are not tracked; sessions/retention come from any event. Every hit also carries a sanitized `page_location` (origin + normalized path, no query/hash) and `page_referrer` (referrer origin only) — see Privacy |
| `login` | `method: 'zitadel' \| 'local'` | a sign-in this browser started completes | `zitadel` is single sign-on through the configured OpenID Connect provider (an explicit redirect or silent SSO), `local` the email-and-password form; a plain reload of an existing session does **not** count, and a failed attempt discards its pending marker. GA4 recommended event |
| `workspace_created` | — | a workspace was created (not renamed/edited) | name/description are user content and are never sent |
| `message_sent` | — | a person posted a message or reply | body, thread and ids are never sent |

Aggregate only: an allowlist in `web/src/analytics.ts` drops every parameter
key that is not listed above. Failures and sign-out send nothing.

## Metric definitions and windows

Computed in GA4 (Explorations / reports) over an explicitly stated window; an
audit citing a number must state **as-of date, window, and source property**.

| Metric | Definition | Window |
|---|---|---|
| Activated users (workspace) | distinct users with ≥1 `workspace_created` | any stated window (e.g. last 28 days) |
| Activated users (message) | distinct users with ≥1 `message_sent` | same window |
| Sign-ins completed | distinct users with ≥1 `login` | same window |
| 7-day return | users active on day D (any event) with ≥1 event in D+1…D+7 | rolling; cite as-of |
| 28-day return | same with D+1…D+28 | rolling; cite as-of |
| Returning users | GA4 standard `returning users` (a session whose user had a prior session) | GA4 default date range; cite as-of |

"Distinct users" is GA4's client-id–based count; it counts browsers, not
verified people. With single sign-on, sign-up itself happens at the identity
provider and is not observable from Dispatch; the Dispatch-side activation funnel starts at
`login`.

**Activation is a completed supported task** — `workspace_created` or
`message_sent` — **not** a sign-in or a return visit. The "Activated
users" metrics above are the activation numbers; sign-in/return metrics are
secondary.

## Privacy rules (invariant)

- **Never sent:** emails, names, user/org/workspace/agent ids, tokens or
  secrets, message bodies, payloads, or any page content. The module enforces
  an allowlist of caller parameter keys (`method`, `page_path`, `page_title`);
  everything else is dropped before leaving the page.
- **GA4 auto-collected parameters are overridden on every hit.** gtag.js
  otherwise attaches `page_location` (the full current URL) and
  `page_referrer`; both are set explicitly per event: `page_location` to the
  origin + normalized path (no query, no hash) and `page_referrer` to the
  referrer's origin only. A query string — an OIDC `code`/`state`, an invite
  token — therefore cannot reach GA4 even if it is present in the address bar.
- Page paths are normalized: opaque id segments (uuid, long hex, number, or the
  app's `<prefix>_<base62>` ids such as `ws_…`/`ag_…`/`wm_…`) become `:id`, so
  tenant/workspace ids do not reach GA4.
- Google signals and ad personalization are disabled at tag config.
- GA4 sets its own `_ga` cookies while enabled; no other cookie is touched.
  That is the client identifier the retention metrics are computed from.
- With `GA_MEASUREMENT_ID` unset: no script loads, no cookie is set, no network
  call happens and the CSP stays strict. Server tests assert both the empty
  config response and the strict CSP.
- CSP: `script-src`/`connect-src`/`img-src` gain only the GA4 hosts
  (`www.googletagmanager.com`, `*.google-analytics.com`,
  `*.analytics.google.com`), and only when a measurement id is configured.

## Turning it on

1. In GA4, create a property (or use an existing one) and add a web data
   stream for your Dispatch URL. Note its measurement id, `G-XXXXXXXXXX`.
2. Set `GA_MEASUREMENT_ID=G-XXXXXXXXXX` in Dispatch's environment (for
   `docker compose`, in `.env`) and restart Dispatch. No rebuild and no code
   change.
3. Unset it and restart to switch analytics off.
