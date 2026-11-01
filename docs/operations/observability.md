# Operational signals and response

These are internal objectives, not a contractual SLA. Repository maintainers
own the alerts and response. Use the existing runtime JSON logs and durable
PostgreSQL queues rather than adding a second monitoring platform.

[Runtime request and CPU budgets](runtime-budgets.md) defines executable idle
budgets, native Vercel monitors, outcome coverage and deployment comparisons.

`lib/request-log.ts` writes a privacy-safe start and completion with one random
invocation ID and UTC timestamps. Only route templates, method, status,
duration, hashed user ID and error class are emitted. No body, URL parameters,
email, provider error text, cookie, authorization header or secret is logged.
The start remains when a handler dies; a completion means the route returned a
Response, not that a streamed conversation or external action finished.

| Signal | Window/denominator | Internal objective | Action |
| --- | --- | --- | --- |
| Login, chat and other API success | All starts 2–15 minutes old, including 4xx, 429, 5xx and missing/overdue completions | 99% responses below 400 within 120 seconds; p95 completed response latency ≤10 seconds | Inspect status classes, runtime/pool and dependencies; distinguish user input failures from service failures |
| Dispatch started | Every run created 2–15 minutes ago, including unstarted and failed runs | 99% started within 2 minutes | Check existing worker, lease and durable queue |
| Due work on time | Every execute occurrence due 2–15 minutes ago, including pending/running/failed occurrences; explicit skip decisions are excluded | 99% succeeded within 2 minutes of due time | Check scheduler/worker and provider result before replay |
| Wake backlog | Undelivered nonbackground events older than 5 minutes, including exhausted retries | Zero | Inspect existing bounded wake retry and its original authorization |
| Run worker absent | Preparing/running/finishing runs with lease expired over 2 minutes | Zero | Inspect daemon/worker heartbeat; preserve original run/attempt attribution |
| Provider/receipt uncertainty | Every uncertain operation; executing operations unchanged over 5 minutes | Zero | Reconcile provider receipt and operation ledger before retrying an external effect |
| Secret cleanup overdue | Unreferenced BYOS artifacts past notBefore by 5 minutes, not deleted | Zero | Inspect the existing cleanup worker; never copy secret names or values into the alert |
| Database unavailable | Read-only aggregate probe with bounded connection/query timeout | Zero failed probes | Check connectivity and saturation; do not infer that absent queue data is healthy |

The existing minute worker can call `GET /api/cron/ops-monitor` using its
existing `CRON_SECRET` bearer. It uses the existing main pool
(`MIKKA_DATABASE_URL`), persists aggregate observations and firing/resolved
transitions in `ops_monitor_observations`, and returns `notificationStatus`.
No extra variable is needed to collect database signals. The optional
`OPS_INTERNAL_ALERT_SINK` enables the explicitly restricted loopback sink;
unconfigured forwarding returns `not_configured` while DB collection keeps
running. The route never sends external notifications. It returns 503 when
the database/persistence or a configured sink fails, so the existing worker's
health logs can observe collector failure. Only a trusted database operator
or authenticated cron caller can read these global aggregate records. No
public user-facing monitoring API or tenant data is added.

`node scripts/ops/monitor.mjs <runtime-log.jsonl> <private-state.json>` reads the
explicit `OPS_DATABASE_URL` and `OPS_INTERNAL_ALERT_SINK`. Its database
transaction is read-only. A collector must supply actual log lines and invoke
this command once a minute, as a single writer for its private state file.
The sink is deliberately restricted to a literal loopback HTTP address;
existing infrastructure may receive that event locally and forward it through
its already approved notification channel. The existing minute worker owns the schedule; this command does not create
a second scheduled job or an external paging integration. Do not claim production
coverage until the collector, invocation, sink forwarding and owner are real
and have been tested. No traffic produces no success ratio, not a synthetic
100%; malformed/legacy lines without invocation timestamps cannot prove
coverage. Log collection completeness is an explicit deployment dependency.

Each event carries a fixed signal ID, observed time, aggregate value, owner,
runbook and actionable next step. Repeated firing is deduplicated for 30
minutes; recovery is sent once. Notification failure is visible in the CLI's
JSON and nonzero exit status and never advances the last successful send, so
the next invocation retries. Keep the state private and durable; losing it may
repeat an alert. A scheduler must also watch monitor process failure and stale
last-success time. A silent collector or dead scheduler cannot self-page.

Within five minutes of an alert, the maintainer records scope, impact, start
time, affected flow and severity. Choose an incident owner and inspect the
exact signal and current deployment. Keep uncertain external actions
quarantined and validate authorization before resuming them. Use the existing
worker recovery paths; do not blindly replay the queue. Record detection,
notification, acknowledgment, mitigation and recovery times, then verify the
same failed signal recovers. Escalate an unacknowledged critical alert after
five minutes through the existing approved channel; send stakeholder updates
on the established incident cadence. Never send external messages as part of
an unapproved drill. The repository's `.claude/skills/incident/SKILL.md` is the
response checklist; operational authorization still governs actions.

`scripts/ops/monitor.test.mjs` tests timeout/429 denominators and a real internal
HTTP sink's failure, retry, deduplication and recovery. The isolated drill in
[safe-recovery.md](safe-recovery.md) adds actual PostgreSQL stale wake, absent
worker, executing-effect and unavailable-DB signals. It does not claim a full
login→chat→run→provider acceptance flow, actual provider 429 injection,
production collection, on-call acknowledgment or an external paging test.
