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

`withDeviceAuthorization` wraps ordinary daemon HTTP handlers. Body receipt occurs
before admission. A dedicated pool holds a shared credential row lock while the
handler completes; revoke takes the exclusive lock before mutating its state.
This avoids consuming all application pool connections with waiting admissions.
Long polling holds the lock only for each read and rechecks approximately every
second. Operations already admitted may complete before revoke commits; operations
admitted after that commit fail. A 5-second lock timeout can make a revoke fail;
readback, not an optimistic client response, establishes the outcome.

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
2. The protected BYOS subscription route is deliberately not rewritten. Its
   initial authentication refuses revoked credentials, but its already admitted
   refresh/external-operation race needs coordination with its owner.
3. The admission connection and handler transactions are separate connections.
   Loss of the admission connection releases its row lock; rejecting the HTTP
   response does NOT roll back independent handler commits. Do not claim atomic
   revocation under connection-loss faults. Closing this boundary requires
   transaction-local credential checks in the affected write services.
4. `revokedAt`/`revokedBy` provide authoritative idempotent operation state, but
   integration into #259's tenant audit export is outstanding; no duplicate audit
   framework is introduced here.
5. The isolated daemon test uses the actual runtime/HTTP transport with quota
   access disabled and no provider or harness execution. It cannot prove that an
   actual running Codex/Claude process terminates within an SLA.
6. Production identity, frozen release, controlled fixture, redacted recording
   and PR video remain parent-coordinated; no production verification is claimed.

## Reproducible isolated checks

Apply all tracked migrations to a fresh loopback PostgreSQL database named
`mikka_e2e`; set BOTH database environment variables to that target. No production
credentials or inherited provider variables. Build the exact checkout, start its
Next server on loopback, then execute:

```
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
