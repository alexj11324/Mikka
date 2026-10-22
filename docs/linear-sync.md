# Linear two-way sync

The integration maps one Linear team to one Mikka account. New issues and changes to already linked issues sync in both directions. The Neon inbox records signed webhook deliveries before responding; an outbox trigger captures app edits in the same transaction as the issue or collaboration write. Request handlers attempt a sync immediately after responding, and Vercel Cron retries queued work.

## Linear OAuth app

Create a Linear OAuth application and configure its callback URL as:

```text
https://app.aspectlylabs.com/mikka/api/integrations/linear/callback
```

Register `http://localhost:3014/mikka/api/integrations/linear/callback` for local development.

Configure an application webhook that sends `Issue`, `Comment`, and `OAuthAuthorization` events to:

```text
https://app.aspectlylabs.com/mikka/api/webhooks/linear
```

The OAuth flow uses PKCE, binds its state to the initiating browser and signed-in Mikka account, and requests `read,write,issues:create,comments:create`; the webhook is configured on the OAuth app, so the integration does not request Linear's broad `admin` scope. Copy the OAuth client ID, client secret, and webhook signing secret into the hosting environment.

## Environment

Set these server-only environment variables:

| Variable | Purpose |
| --- | --- |
| `LINEAR_CLIENT_ID` | OAuth application client ID |
| `LINEAR_CLIENT_SECRET` | OAuth code and refresh-token exchange |
| `LINEAR_TOKEN_ENCRYPTION_KEY` | 32 random bytes encoded as 64 hex characters; encrypts OAuth tokens stored in Neon |
| `LINEAR_WEBHOOK_SECRET` | Linear OAuth application's webhook signing secret |
| `CRON_SECRET` | Protects `/mikka/api/cron/linear-sync`; Vercel sends it in the bearer authorization header |
| `LINEAR_REDIRECT_URL` | Optional exact callback URL override; required in Vercel Preview because preview requests must not store their OAuth state in Production |

Generate an encryption key with `openssl rand -hex 32`. Never commit the generated value. Environments sharing the same Neon branch must share the same `LINEAR_TOKEN_ENCRYPTION_KEY`; production can use its own key because it uses a separate Neon branch.

Vercel Cron runs only on Production deployments at `/mikka/api/cron/linear-sync`. Hobby projects support daily schedules; the checked-in schedule is therefore a daily recovery sweep. Issue writes and webhook receipts also dispatch their durable queue items after the response, so normal sync does not wait for that sweep. The sweep recovers work interrupted by deployments, timeouts, or provider errors.

## Synced data

- Title, description, status, priority, assignee, labels, and due date.
- Issue comments and replies; Mikka comment authors are assigned by the authenticated collaboration writer and pinned to their local comment mapping. Their connected Linear account is used when it is linked to the same organization. Otherwise the issue owner's connection is used.
- Existing app issues are not bulk imported when a team is connected. Editing an older issue queues it for sync. An older Linear issue is copied into Mikka when Linear sends an update for it.
- Deleting an issue on either side does not delete the other copy. A removed Linear issue remains in Mikka and is marked as remotely removed.

Mikka `review` shares Linear's `started` category with `doing`; `duplicate` shares `canceled` with `canceled`. The sync preserves those app-only distinctions on webhook echoes. Linear states with unknown categories do not change the Mikka status. Assignees map by email and must be the Mikka issue owner or a member of that issue. Linear supports more than Mikka's 12 labels; issues with more than 12 labels stop with a visible sync error instead of silently dropping labels.

## Neon schema

Sync tables and triggers are part of `drizzle/0004_linear_sync.sql`, `drizzle/0005_linear_sync_retry_and_comment_keys.sql`, `drizzle/0006_linear_comment_authorship.sql`, and `drizzle/0007_linear_description_snapshot.sql`. They use the Mikka issue database through `MIKKA_DATABASE_URL`, with `ORVILO_DATABASE_URL` as a legacy fallback. `scripts/apply-sql.mjs` converts a Neon pooled URL to its direct endpoint for migration and prints the database and branch before applying a SQL file. The local migration target is the isolated `dev-local` branch; production is not changed by local development.
