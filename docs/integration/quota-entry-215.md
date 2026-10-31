# Existing execution gates and the remaining web throttle (#215)

This source audit uses main `78eb5523f48859f83ee271eb5dc9f035044a353b`
and the focused web-rate increment. It follows active backend callers; it does
not introduce a new quota platform or new limits for the user's local machine.

| Normal entry | Existing enforcement |
| --- | --- |
| Hosted chat/Coordinator/Bot, durable model snapshots, compaction, evaluations, profile extraction, action titles and visual planning | `hostedModel` checks current positive balance and claims the existing workspace execution slot before every actual SDK generate/stream, including subsequent tool steps. It settles only the actual receipt. |
| Decisions used by triage, group routing, attention and visual/evaluation judgments | `invokeDecision` requires server-owned billing scope and shares `HostedUsageStore` admission/settlement. A missing scope refuses execution; the older documented unscoped exemption no longer applies. |
| Managed subscription model/native calls | `SubscriptionService` rechecks binding, membership, current connection/revision, capability and provider quota before use. Subscription-only usage does not debit Mikka hosted credit. |
| BYO thread machines | Existing owner/workspace active-machine limits and rolling monthly compute limit apply before provisioning. These are the existing BYO limits, not a platform money reservation. |
| Firecrawl search/read-page tools | The same existing 10 requests per user per rolling minute is now enforced across worker instances with the existing PostgreSQL `rateLimit` table. Search and scrape share it. |
| Own-device CLI execution | Existing run ownership, policy, approval and lease guards remain. Own-device/provider subscription usage is not charged against Mikka's hosted balance. |

The funds contract is unchanged: a currently positive net balance admits the
call; no cost estimate, financial hold or prepayment is required. An executing
call can finish beyond that balance, and its actual recorded debt blocks the
next call until a top-up restores positive net balance. Execution slots are not
money reservations. Unknown cost remains unknown and requires an authoritative
receipt before settlement, rather than being guessed free or silently retried.

The confirmed normal gap was the Firecrawl service's process-local counter.
Twenty fresh service instances could concurrently deliver twenty provider
requests despite its existing ten-per-user limit (occurrence 10 × impact 5).
The production factory now uses the existing transaction wrapper and a short
per-user advisory lock before provider I/O. Its separate hashed web namespace
stores at most ten current request records per user. Expired records for that
same user are recycled; authentication counters are untouched. Local counters
remain an early rejection, and cached results retain their previous no-provider,
no-new-request-count semantics. An unavailable database refuses the operation
before provider I/O. Existing `rate_limited` degradation and no automatic web
provider retry remain unchanged. There is no new table, billing change, UI or
configurable workspace/global quota.

Verification uses the retained isolated PostgreSQL17 target at loopback55599,
a nonce-owned schema copied from the actual `rateLimit` table, the production
web-service factory and Firecrawl adapter, and real loopback HTTP. Before the
change all twenty competing cold instances reached HTTP; afterwards ten reach
HTTP and ten are refused. The same run checks the exported search/scrape paths,
cache behavior, another user's independent budget, expiry/recreated-worker use,
and database-unavailable refusal without another provider request. The fixture
cleans only its own schema. Source tests retain provider/cache unit boundaries;
the new PG/service test is registered in the mandatory `test:abuse-db` inventory.
Raw before/after evidence is `/tmp/mikka-web-rate-{before,after}.log`.

No additional bypass of the listed existing backend gates was demonstrated by
this focused audit. This is code and isolated integration evidence, not live
provider-cost reconciliation, real provider 429/recovery acceptance or a new
production rollout. Those remaining #215 evidence requirements and the historical
unknown production receipt are not marked completed by this increment.
