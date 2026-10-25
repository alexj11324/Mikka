# Daemon credential revocation (#178)

Candidate based on frozen integration #268 `a3294781eae74d824087c9c80bfc3f6093f196d7`.
The #207 owner implements this increment; this does not assign historical ownership of #178.
No merge, production deployment or issue closure is authorized by this document.

## Existing model and API

`device_tokens` is account-scoped, not bound one-to-one to a device. `enabled`
controls dispatch only. This change preserves that model. It does not revoke all
credentials of an account when one daemon credential is revoked.

- `GET /api/device-tokens`: current owner session; returns IDs, names and timestamps,
  never token values or hashes. Supports readback after a lost revoke response.
- `POST /api/device-tokens/:tokenId/revoke`: fresh owner session and same-origin
  browser request. Unknown/foreign ID returns 404. First commit records
  `revokedAt` and `revokedBy`; retries preserve these fields.
- Ordinary and group claim transactions record `agent_runs.deviceTokenId`.
- Revoke expires attributed live attempt leases, persists stop requests, and
  revokes their worker tokens in the same application database transaction.
- Re-enable, register, refresh heartbeat and daemon restart never clear
  `device_tokens.revokedAt`. Reconnecting requires another valid credential.

## Admission and integration boundary

`withDeviceAuthorization` scopes application database access to the authenticated
credential. Each SQL statement or explicit transaction acquires a shared token
lock on the SAME connection performing the work. Revocation takes the exclusive
lock. A lost connection rolls back its protected writes; no independent admission
connection or reconnect retry can permit a late commit. Events insert/status/tail
read share one transaction. A 5-second lock timeout fails the operation; readback
establishes an uncertain revoke outcome.

This is application-database fencing, not distributed atomicity across workspace
databases or external providers. The subscription route carries this scope into
its application queries. Existing Go run/lease checks cancel silent native streams
on their one-second polling interval and check before forwarding chunks. An
external request admitted before revoke may already have reached its provider;
unknown external effects are not automatically replayed.

First revoke appends `device.credential.revoked` through #259's existing audit
store in the same transaction as token, run and worker-token updates. Audit failure
rolls back all of them; repeated revoke returns the original receipt without an
additional event. Dependency: reviewed audit commit `1b39b709ce361b9643524aea983860e6de818ff6`.

For parent integration with #259/#264/#265, preserve the existing claim/heartbeat
business code and add the exported route wrapper. Compose the claim `onClaim`
callback with quota/policy/subscription/audit callbacks on the SAME transaction.
The group callback is optional and preserves callers that do not use daemon HTTP.
Do not overwrite parallel claim, heartbeat or Factory store implementations.

Daemon session rejection immediately revokes its active server leases and aborts
the group processor. Delayed replies from an older session cannot renew leases,
start a claimed attempt, or clear a new credential. Offline process termination
still depends on the existing 90-second lease/watchdog and OS cancellation.

## Explicit remaining acceptance gaps

This candidate is NOT sufficient to close #178 or authorize production rollout:

1. Older active attempts lack trustworthy credential attribution. The revoke
   receipt reports `unattributedActiveRuns`; it does not guess their owner-token
   association or terminate other credentials' work. A production migration/drain
   plan is required before claiming complete in-flight revocation.
2. The isolated daemon test uses the actual runtime/HTTP transport with quota
   access disabled and no provider or harness execution. It cannot prove that an
   actual running Codex/Claude process terminates within an SLA.
3. Production identity, frozen release, controlled fixture, redacted recording
   and PR video remain parent-coordinated; no production verification is claimed.

## Reproducible isolated checks

Apply all tracked migrations to a fresh loopback PostgreSQL database named
`mikka_e2e`; set BOTH database environment variables to that target. No production
credentials or inherited provider variables. Build the exact checkout, start its
Next server on loopback, then execute:

```
node --conditions=react-server --import ./scripts/daemon/server-only.mjs --import tsx scripts/daemon/revocation-faults.mjs
pnpm exec playwright test tests/e2e/device-revocation.spec.ts
pnpm --filter @mikka/daemon typecheck
```

The test uses synthetic signup sessions, actual registration/heartbeat/claim,
owner/nonowner/anonymous/Origin fences, 17 old-token endpoint checks, long poll,
worker token invalidation, sibling-token success, re-enable and actual daemon
restart. It retains database rows and daemon state. No DELETE/TRUNCATE/DROP or
fixture removal occurs. Test traces/screenshots are disabled to avoid publishing
cookies or tokens; the attached JSON contains only checks, environment and SHA.
A green test establishes only its listed checks, not the gaps above.

Additional retained-PG regression kills the protected writer while its INSERT is
blocked, commits revoke, and verifies zero chunks. An audit-failure trigger proves
full rollback, then successful/repeated revoke proves one verified chain event.
The targeted Go test `TestDaemonCredentialRevokeCancelsSilentNativeStream` uses
the actual broker, actual application revoke helper and a loopback TLS provider
fixture; it verifies cancellation and denied context/prepare after reinstantiation.
It is not a production provider or native CLI acceptance video.
