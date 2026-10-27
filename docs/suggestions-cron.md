# GitHub webhook backfill

Cloudflare Worker `mikka-suggestions-cron` runs at `0 * * * *` (UTC) and calls
`GET https://app.aspectlylabs.com/mikka/api/cron/suggestions-reconcile` with
`Authorization: Bearer <CRON_SECRET>`. The endpoint handles GitHub webhook
redelivery; the Worker records only its path and HTTP status. A failed HTTP
request or network error rejects the scheduled run. Worker HTTP routes return
404, and `wrangler.jsonc` disables public Worker and version preview URLs.

## Deployment and credentials

Upload `cloudflare/suggestions-cron/src/index.mjs` as an ES module from the
reviewed commit using the authorized Cloudflare API credential. It has no
imports and needs no build. Apply the cron, `MIKKA_URL`, and observability
settings from `wrangler.jsonc` separately when uploading through the API.

The Worker needs only `MIKKA_URL` and the secret binding `CRON_SECRET`. Its
secret must match the production app's value in Infisical `prod:/vercel`.
Keep deployment credentials and secret values in Infisical; deliver the Worker
secret through a dedicated `prod:/cloudflare/suggestions-cron` Secret Sync.
Never put either value in source, local environment files, or logs.

The app reads `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` from the Vercel
environment synced from Infisical `prod:/github`. The receiving webhook at
`/mikka/api/webhooks/github` uses `GITHUB_WEBHOOK_SECRET` from the same source;
it must match the GitHub App's webhook secret. GitHub App credentials are not
Worker bindings.

## Acceptance boundary

GitHub's redelivery API returns 202 when it accepts the request. The receiving
Mikka webhook also returns 202 before asynchronous suggestion ingestion
finishes. Neither status proves a suggestion was saved. Verify the actual
GitHub delivery response and resulting ingestion separately, and inspect the
Cloudflare scheduled-run history for the hourly trigger.

Run the source-only Worker checks with:
`node --test cloudflare/suggestions-cron/src/index.test.mjs`.
