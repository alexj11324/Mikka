# Coordinator wake recovery (#176)

An event can commit successfully while `start(coordinatorTurn)` fails or its
producer exits before making that call. Previously recovery waited for another
event. The committed `coordinator_events` row now also owns wake delivery.

## Delivery

The normal wake path and a one-minute sweep share one per-chat database claim.
An active Coordinator session or a live wake claim defers another start. The
claim updates `wakeAttempts`, `nextWakeAt`, and `wakeLeaseUntil` atomically.
Start/triage failures persist a safe error code and a delay of 1, 2, 4, 8, then
15 minutes. An accepted start keeps a two-minute lease; an event not consumed
by the workflow becomes eligible again afterwards. The existing workflow inbox
transaction and chat lease remain responsible for consuming messages once.

Eight unsuccessful delivery attempts exhaust the event. It remains in the
inbox, with `wakeAttempts = 8` and `wakeLastError = wake_exhausted`; the sweep
returns an `exhausted` count. It is not silently discarded. The current
`CRON_SECRET` authorizes `POST /mikka/api/cron/coordinator-wakes` with
`{"eventId":"<uuid>"}` to reset only an exhausted, unconsumed event. This does
not restore run authority or bypass the consumer's current policy checks.

An accepted enqueue is logged with its workflow run ID, event IDs and attempt;
it is not evidence that the workflow body loaded. If the inbox is still
undelivered after the existing two-minute startup lease, the chat shows an
unconfirmed start awaiting retry instead of an active-work spinner. Failed
wakes show pending retry; exhausted wakes show retries stopped. The original
message remains visible. Chat polling continues every ten seconds while idle,
so an independent retry can restore the reply without a reload. Bot-list
spinners use the same state projection. An active Coordinator session lease
always takes precedence; this check does not limit model-turn duration.

The independent producer is the existing `mikka-suggestions-cron` Worker. Its
new `* * * * *` schedule calls `/api/cron/coordinator-wakes`; existing briefing,
suggestion, and profile schedules are retained. The endpoint uses the existing
secret and no new identity, resource, model, or feature flag.

## Rollout and observations

Deploy the normal application migration before deploying the updated existing
Worker. There is no production migration or Worker deployment in this PR.
Without the Worker update, ordinary calls use durable backoff but an independent
sweep is not yet operational. Application build success alone does not prove
the production schedule is running.

At one-minute scheduling cadence, retry readiness is observed within the next
minute, plus runtime/transport latency. Three consecutive start failures use
1 + 2 + 4 minutes of backoff, with up to three additional one-minute scheduling
waits before the fourth attempt. This is an operational bound for a healthy
scheduler, not a claimed production SLO.

The PostgreSQL regression uses an isolated loopback `_e2e` database and the
production wake store/migration. It proves concurrent claims, persisted
three-failure recovery without a new event, actual child-process exit/recovery,
exhaustion/replay, owner/bot separation, active-session exclusion, delivered
and background exclusion, and stale-claim refusal. The cron handler tests use
synthetic calls behind its real bearer check. No real model or external action
executes in those tests.

This patch addresses wake delivery, not the separate lifecycle of model effects
after inbox consumption. In particular, it does not claim a live provider's
exactly-once external write, full original-chat result recovery after model
failure, or complete #176/#181 fixed-version runtime acceptance. Completion's
event/token transaction and existing effect-authorization checks are unchanged.

## Subsequent production activation

PR #607 merged at `0fd03d5885128ea000c940ee89f14b6a26130c91` and its matching
application deployment was verified READY with the tracked migrations applied.
The existing `mikka-suggestions-cron` Worker was deployed at 2026-10-31
06:56:50 UTC as version `2ad3aab0-240d-447e-95e9-b1750b959568`. Its single
`* * * * *` event preserves the existing UTC quarter-hour, hourly and half-hour
cadences inside the Worker, avoiding the account's trigger-count limit.

The real natural event at 07:07:20 UTC completed with `outcome:ok` and HTTP 200
from wakes, schedules, run recovery, account deletion, audit maintenance and
operational observations. Production operational rows were independently read
back at 07:06:22 and 07:07:20 UTC. This supersedes the earlier rollout status;
it proves delivery to the production handlers, not model consumption or a
provider business effect. No manual production tick was used as substitute
evidence. See the [deployment evidence on #176](https://github.com/alexj11324/Mikka/issues/176#issuecomment-6540437534).
