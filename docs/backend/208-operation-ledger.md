# #208 operation ledger foundation

Candidate only, based on main 8f8484ff3bf9a55f5c759d7e2316ab90c5fb854f.
Refs #208, #177. Does not close either issue.

## Scope and integration contract

`createOperationLedger(pool, authorize)` uses the existing application's PostgreSQL
pool when a trusted backend consumer supplies it. No production consumer is wired
in this increment. No routes, provider adapters, Factory store, daemon or UI change.
The authorization callback is mandatory; it must validate current owner/workspace
access, approval scope/expiry/revocation, candidate, account and attempt using the
transaction. Ledger row locks precede authorization locks consistently. Consumers
must use that same ordering when modifying both domains.

Persist a logical operation UUID in the originating intent before dispatch; carry it
across retryOf chains and worker restarts. Never derive it from runId plus action,
never let model-generated fresh proposals silently replace it. The caller, not this
library, owns that intent persistence and propagation. Operation UUID is globally
unique and owner/workspace-bound. Immutable binding includes account, provider,
approval, target, candidate SHA and SHA256 of canonical provider payload. Callers
must use one canonical payload encoding. Raw payloads are not stored here.

Reserve and claim commit separately; only reserved can be claimed. A claim returns
a private attempt token and a stable provider key. Pass the key only to providers
whose documented semantics support it. All executing/uncertain/failed/succeeded
records reject new claims, including new run UUIDs. There is deliberately no TTL
reclaim or blind replay. A crash before sending can therefore require manual review.

Settle accepts a matching executing token; failed is only for definitive no-effect
results. Timeouts/disconnects are uncertain. Receipt writeback failure leaves executing.
Reconcile is trusted read-only lookup and can store safe provider object ID plus
evidence digest; missing/negative lookup stays uncertain, because in-flight requests
may still complete. It never sends. Lookup throws roll back without claiming success.
Use bounded provider timeouts: reconciliation holds a row lock during lookup.

Authorization is rechecked at each ledger transaction, but the claim's locks end
before provider invocation. This foundation does NOT enforce revocation/lease fencing
in that interval, cannot retract in-flight effects, and does not claim exactly-once.
The integrating execution boundary must enforce current authority and document the
provider's in-flight limits. Receipts are historical facts, not new authorization.

## Deduplication against existing work

- #196 fb9c273: dispatch/run creation dedupe, untouched.
- #197 605bf086: Factory task/attempt/candidate store, untouched.
- #203 2df53547: existing approval and publication reservation, untouched. Reuses
  its pattern of durable pre-effect reservation and uncertainty; publication callers
  must retain that reservation, not stack a second competing execution authority.
- #204 ba06c194 (merged): pending_actions CAS, untouched. #177 owner must integrate
  proposal identity, approved payload, account binding and result mapping explicitly.

## Evidence and remaining gates

Local cloud Linux, disposable loopback PG17 and synthetic HTTP only. Tests retain
ledger rows; no test record cleanup is performed. The test fault trigger is disabled
after injection, but its function remains. No real mail/payment/push/provider effect.

Covered: migration application twice, ten reservation/claim races, binding conflicts,
owner/workspace rejection, callback denial and stale run, token rejection, retry key
stability, uncertain negative lookup, real HTTP effect plus real SQL trigger writeback
failure, fresh pool recovery/readback with one HTTP write, terminal overwrite rejection.
Authorization in these tests is a synthetic callback, not actual auth/approval rows.
Fresh pool recovery is not a killed/restarted worker-process test.

Not run/blocked: actual Mikka HTTP/auth wiring, real approval expiration/revocation
transactions, killed worker process, old-worker execution after partition, real provider
readback/guarantee matrix, true run retry propagation, combined #177/#194 acceptance.
No approved real provider target was supplied; these gates remain blocked. No Preview
or production deployment is requested. Existing credential CI job is skipped only for
this candidate branch to respect synthetic-only authorization; ordinary checks remain.
