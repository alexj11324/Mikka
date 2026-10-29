# Linear two-way sync

The integration maps one Linear team to one Mikka account. New issues and changes to already linked issues sync in both directions. The Neon inbox records signed webhook deliveries before responding; an outbox trigger captures app edits in the same transaction as the issue or collaboration write. The Mikka app and OAuth callback remain on Vercel; a Cloudflare Worker receives Linear webhooks and drains the durable inbox and outbox through Hyperdrive.

## Global PostHog switch

`mikka-linear-sync` is a **boolean global flag** in the existing US PostHog
project. Every backend evaluates it against the same distinct ID,
`mikka-linear-sync-service`, rather than a user or team. Configure a boolean
flag with a 100% rollout and no person, group or runtime-only targeting when
enabling; leave it inactive to pause all sync. The settings page reads this
same server decision, so browser SDK overrides cannot enable backend work.

Both Vercel and each Linear Worker must have `NEXT_PUBLIC_POSTHOG_KEY` from
that same existing project. It is the public ingestion token already used by
the app, not a management credential. Do not add a personal API key to the
app or Worker. Missing configuration/flag, non-boolean variants, HTTP errors,
evaluation errors, quota limits and a two-second timeout all read off. Values
are cached for at most 30 seconds per running instance, including failures;
expired true values are never reused during an outage. No flag timer runs in
the background and flag evaluation never opens a database connection.

When paused:

- Next and Cloudflare validate webhook signatures, then return `503` with
  `Retry-After: 60` before inserting an inbox row or ingesting suggestions.
  Unsupported event types retain their existing `200` response. Linear's
  retry retention is finite: pausing does not promise an indefinite archive
  of events that arrive while paused, including OAuth revocations.
- Protected crons return `{ inbox: 0, outbox: 0, disabled: true }`; the
  Cloudflare schedule exits before loading its database runtime. Dispatch
  callbacks and all worker entry points check the same flag.
- The suggestions recovery cron skips its Linear inbox scan and notification
  replay; a delayed Linear connection briefing exits before database/provider
  reads. This switch does not pause the other suggestion sources.
- Each worker checks again **before every claim**. A job already claimed
  completes its normal processing and bookkeeping; disabling does not turn
  it into a failure, reset attempts, mark waiting jobs done or cancel it
  between a remote write and its local checkpoint. Long jobs may therefore
  finish after the local flag cache expires. Observe in-flight work separately.
- OAuth start/callback, team enablement, team discovery and manual retries
  cannot start new work. An explicit user pause or disconnect remains
  available under its existing ownership checks.
- Settings show `Sync paused`. They do not read the session/integration
  tables or run a polling loop while globally off. Connected, actively
  syncing settings poll without overlap while visible; paused/disconnected
  settings stop polling. Remounting or focusing the page rechecks global
  availability, allowing a later PostHog enablement to be discovered.

Connections, team settings, inbox/outbox rows, links and audit history are
preserved. Existing database triggers still record app edits durably in the
same transaction; pausing does not discard edits or suppress the app's own
ordinary database writes. On re-enable, queued and stale processing jobs
resume through normal dispatch/recovery cron; failed jobs retain their
existing explicit retry flow. There is no bulk remote backfill on resume.

Operational verification must record the flag state and deployed SHA for
Vercel production, the unique Preview, each existing Linear Worker and the
old `feat/linear-bidirectional-sync` Preview separately. Old immutable
deployments do not gain this check when main changes. A disabled setting on
new code does not establish that an old Preview or unrelated database caller
has stopped, or that Neon will suspend. Do not suspend/delete Neon resources
as part of operating this switch.

Official evaluation API: https://posthog.com/docs/api/flags.

## Linear OAuth app

Create a Linear OAuth application and configure its callback URL as:

```text
https://app.aspectlylabs.com/mikka/api/integrations/linear/callback
```

Register `http://localhost:3014/mikka/api/integrations/linear/callback` for local development.

Configure an application webhook that sends `Issue`, `Comment`, and `OAuthAuthorization` events to:

```text
https://linear-sync.aspectlylabs.com/mikka/api/webhooks/linear
```

The OAuth flow uses PKCE, binds its state to the initiating browser and signed-in Mikka account, and requests `read,write,issues:create,comments:create`; the webhook is configured on the OAuth app, so the integration does not request Linear's broad `admin` scope. Copy the OAuth client ID, client secret, and webhook signing secret into the hosting environment.

## Environment

Set these server-only environment variables in the Mikka app and the Linear sync Worker as indicated, and configure the Worker binding:

| Variable | Purpose |
| --- | --- |
| `LINEAR_CLIENT_ID` | OAuth application client ID; set in both deployments |
| `LINEAR_CLIENT_SECRET` | OAuth code and refresh-token exchange; set in both deployments |
| `LINEAR_TOKEN_ENCRYPTION_KEY` | 32 random bytes encoded as 64 hex characters; encrypts OAuth tokens stored in Neon; set in both deployments |
| `LINEAR_WEBHOOK_SECRET` | Linear OAuth application's webhook signing secret; set on the Worker |
| `CRON_SECRET` | Protects `/mikka/api/cron/linear-sync`; set on the Worker and app if Vercel Cron is also enabled |
| `LINEAR_REDIRECT_URL` | Optional exact callback URL override; required in Vercel Preview because preview requests must not store their OAuth state in Production |
| `HYPERDRIVE` binding | Cloudflare Hyperdrive connection to the same Neon branch used by the app |
| `NEXT_PUBLIC_POSTHOG_KEY` | Existing public PostHog project token; set in both deployments; missing means sync stays off |

Generate an encryption key with `openssl rand -hex 32`. Never commit the generated value. Environments sharing the same Neon branch must share the same `LINEAR_TOKEN_ENCRYPTION_KEY`; production can use its own key because it uses a separate Neon branch.

The suggestions schedules (daily briefings and the webhook backfill) run on a separate Worker; see [suggestions schedules](suggestions-cron.md).

`cloudflare/linear-sync/wrangler.jsonc` binds the Worker to `linear-sync.aspectlylabs.com` and runs its recovery sweep daily at 04:00 UTC. Before deployment, create a Hyperdrive configuration for the target Neon branch, add its ID as the `HYPERDRIVE` binding, and set the Worker secrets above. For local development, the Worker uses its own request-scoped PostgreSQL pool and closes it after each webhook, batch, or scheduled run. Issue writes on Vercel and webhook receipts on Cloudflare still dispatch durable work immediately; the scheduled sweep recovers work interrupted by deployments, timeouts, or provider errors.

## Synced data

- Title, description, status, priority, assignee, labels, and due date.
- Issue comments and replies; Mikka comment authors are assigned by the authenticated collaboration writer and pinned to their local comment mapping. Their connected Linear account is used when it is linked to the same organization. Otherwise the issue owner's connection is used.
- Existing app issues are not bulk imported when a team is connected. Editing an older issue queues it for sync. An older Linear issue is copied into Mikka when Linear sends an update for it.
- Deleting an issue on either side does not delete the other copy. A removed Linear issue remains in Mikka and is marked as remotely removed.

Mikka `review` shares Linear's `started` category with `doing`; `duplicate` shares `canceled` with `canceled`. The sync preserves those app-only distinctions on webhook echoes. Linear states with unknown categories do not change the Mikka status. Assignees map by email and must be the Mikka issue owner or a member of that issue. Linear supports more than Mikka's 12 labels; issues with more than 12 labels stop with a visible sync error instead of silently dropping labels.

## Neon schema

Sync tables and triggers are part of `drizzle/0004_linear_sync.sql`, `drizzle/0005_linear_sync_retry_and_comment_keys.sql`, `drizzle/0006_linear_comment_authorship.sql`, and `drizzle/0007_linear_description_snapshot.sql`. They use the Mikka issue database through `MIKKA_DATABASE_URL`, with `ORVILO_DATABASE_URL` as a legacy fallback. `scripts/apply-sql.mjs` converts a Neon pooled URL to its direct endpoint for migration and prints the database and branch before applying a SQL file. The local migration target is the isolated `dev-local` branch; production is not changed by local development.
