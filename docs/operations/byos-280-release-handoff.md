# BYOS 280 release handoff

This is a source candidate, not evidence of a completed hosted Claude run.
The integration merges main `666ae4604301454b634b10678e57dd12d16d7509`
without rewriting either source PR. Release owner controls deployment and grant binding;
the product executor controls the approved device and bounded run.

## Prevent implicit database writes

Set `MIGRATE=0` for a release whose migrations were separately authorized and applied.
The candidate fixes `scripts/migrate.mjs` to honor this explicit opt-out even with
`VERCEL_ENV=production`. The preceding implementation did not honor it. The default
production migration behavior remains unchanged. A regression runs the real script
with deliberately invalid database URLs and proves it exits without a connection.
Do not infer that the eight BYOS ledger entries also cover device-revocation or audit
migrations. Reconcile those separately before deploying their routes. The reported
Neon 401 is a stopped read, not permission to switch credentials or rerun migrations.

## Existing cleanup replacement, pending activation

Do not add a second cleanup service. Existing files:

- `cloudflare/linear-sync/src/credential-cleanup.ts`: fixed production HTTPS endpoint,
  existing cron bearer, no redirects, bounded response, timeout, no vault token.
- `cloudflare/linear-sync/src/index.ts`: minute cleanup opt-in while preserving Linear.
- `app/api/cron/credential-cleanup/route.ts`: authenticated application sweep.
- `lib/credentials/runtime.ts`: separate cleanup-only Universal Auth client.

The current candidate intentionally retains its Vercel minute cron until replacement
execution is demonstrated. It remains incompatible with Hobby deployment at this
checkpoint. Removing it alone would strand idle cleanup; copying the preview Worker
configuration would send a staging credential to production and is prohibited.

### Exact additional configuration needing approval

Recipient: existing Vercel `mikka` project
`prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH`, production server only. Reuse the existing admin
machine identity **only if its separate cleaner use is approved**:

- `MIKKA_CREDENTIAL_CLEANUP_AUTH=universal`
- `MIKKA_CREDENTIAL_CLEANUP_CLIENT_ID` and `MIKKA_CREDENTIAL_CLEANUP_CLIENT_SECRET`
- `MIKKA_CREDENTIAL_VAULT_ORIGIN=https://app.infisical.com`
- `MIKKA_CREDENTIAL_VAULT_PROJECT_ID=89850d6a-f020-4936-863e-df77380dfe40`
- `MIKKA_CREDENTIAL_VAULT_ENVIRONMENT=prod`
- `MIKKA_CREDENTIAL_VAULT_PATH=/credential-custody/production`

Confirm these variable names against the candidate runtime before applying. Preserve
existing database/application origin settings. Do not enable credential admission as
a side effect. This supplies ongoing vault read/delete capability to the trusted
application; an admin credential compromise reaches beyond the configured directory.
Application path restrictions do not narrow Infisical IAM. A local cache expiration
does not revoke the issuer's 30-day token. No identity creation or IAM expansion is
part of this plan. Actual deletion needs the approved product lifecycle scope; old
synthetic-record deletion approval is not reusable.

Recipient: existing production Cloudflare Worker `mikka-linear-sync`, not its preview.
Preserve all existing bindings and CRON_SECRET. Set `CREDENTIAL_CLEANUP_ENABLED=1` and
add minute schedule `* * * * *` while retaining daily `0 4 * * *`. No admin or vault
credential goes to this Worker. Verify its matching existing cron secret without
printing it. Expected schedule volume: 1,440 ticks/day, 43,200/30 days, plus application,
database and vault work. Billing/headroom is unverified; do not upgrade or incur new
paid resources without approval.

### Cutover order and failure handling

1. Approve and validate the above application configuration and exact directory.
2. Activate the existing Worker handler; verify authenticated real ticks, bounded
   sweep progress, durable failure retries, and preserved Linear operation. A local
   fixture or schedule metadata alone is not this evidence.
3. Only then remove the equivalent minute entry from `vercel.json`, preserving its
   daily Linear entry, and release the frozen application candidate through the
   single release owner. Avoid duplicate cleanup timers during cutover.
4. On failed activation retain the old configuration/source and do not claim cleanup
   availability. Do not silently downgrade cadence or expose a public cleanup route.

## Device and real run

Do not create the approved non-expiring user device credential until revocation is
live and verified. Keep it in the private cloud daemon state, never argv or logs.
Bind the existing Claude grant through the real authenticated Mikka owner/workspace
path; provider and Mikka account emails may differ. No new provider consent is needed.
Use one durable request-budget policy: at most two Claude requests, at most 256 output
tokens each. Unknown outcomes consume budget. A Mikka task must claim through the
project daemon/broker and return status/result. A direct CLI invocation is not acceptance.
