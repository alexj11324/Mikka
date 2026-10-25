# Credential cleanup scheduler preparation (not deployed)

Base: frozen PR250 e690c9370fa5fc83d050921e48d84a8437ee1272. The 17 approved SQL migrations are already applied to production; do not rerun or roll them back to solve deployment configuration.

Read-only evidence2026-10-25: existing mikka-linear-sync Worker has scheduled handler, daily04:00UTC cron, Hyperdrive and CRON_SECRET. Existing preview Worker has minute cron and a separate Hyperdrive. No Cloudflare queues exist. Both are labelled standard usage; billing subscriptions GET returned403, so actual plan/headroom/spend cannot be certified. No billing retry or permission expansion was attempted. Existing Infisical prod/cloudflare and prod/vercel CRON_SECRET values compare equal in memory; no values were logged or copied.

This preparatory patch adds default-off CREDENTIAL_CLEANUP_ENABLED=1 handling for minute scheduled events. The destination is fixed to the existing production app origin and cleanup route; it cannot be selected through requests or environment URLs. Redirects are rejected, calls timeout after20s, provider bodies/errors are not logged, and only valid bounded checked counts are accepted. There is one attempt per tick; the next minute retries persistent cleanup tombstones. This does not promise exactly-once provider cleanup or automatic retry delivery by Cloudflare. Existing daily Linear behavior and default-off preview minute behavior remain unchanged. Do not enable on the preview Worker: its existing staging secret must never be sent to production.

No wrangler schedules, deployed Worker bindings, Vercel cron configuration, credentials or permissions are changed. This commit alone does NOT unblock production deployment.

## Cleanup contract and missing runtime configuration

The application broker sweeps up to100 rows ordered by updated_at, checks live run/session/device/lease authority, fences interrupted submitting/using actions, retries cleanupPending tombstones and retains references on errors. Provider delete can be attempted repeatedly; tombstones repair late writes. Per-request advisory locking serializes cleanup. The dedicated browser runner has a5s in-process sweep but is not an idle serverless scheduler replacement. Worker should call the app cleanup endpoint rather than receiving vault credentials, database credentials or browser ownership.

Full production Vercel metadata read returned33 variables and no MIKKA_CREDENTIAL_* entries. The cleanup runtime requires vault token/project/environment/path (and app/workspace DB configuration); absent vault token causes credential_configuration_missing503 even with admission disabled. A timer alone does not fix this. No new token, policy, secret or vault permission may be created as part of this patch.

## Reviewed cutover still required

1. Parent identifies already-authorized credential runtime/vault configuration and confirms exact existing preview app target and staging trust boundary for independent acceptance. If it needs new credentials or permissions, obtain exact approval first. Do not send the current secret to an unapproved host.
2. Verify budget/headroom through an authorized owner;403 billing access is not evidence of free/unlimited usage. One minute timer is1440 invocations/day,43200 in30days, plus Vercel function/database/vault work.
3. Independently review candidate, run full remote CI and actual scheduled Worker -> authenticated deployed Next -> real database/vault failure/retry/expiry/cleanup evidence. Local HTTP fixture tests do not substitute for this.
4. Prepare a separate reviewed cutover change retaining the existing04:00 Linear recovery, enabling the existing production Worker minute event, and removing only the equivalent Vercel cleanup cron after the replacement is verified. Never silently reduce cadence, expose an unauthenticated trigger, auto-enable preview, or buy a plan.
5. A shared Worker rollout changes a live Linear service; preserve existing secret/Hyperdrive bindings and test webhook/Linear regression. Monitor actual cron events and sustained cleanup backlog; schedule metadata alone is not execution proof.

Current tests:8 passed,0skip including actual loopback HTTP transport and existing Linear webhook/auth tests; lint passed. The scheduled routing test uses an injected transport; no actual Cloudflare event or vault operation executed. No production deployment, main merge or source PR change.
