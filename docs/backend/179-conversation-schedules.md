# Conversation schedules (#179)

The existing Coordinator and Bot chat tools create, list/history, update,
pause/resume and cancel owner-scoped schedules. No management UI is added.
The seven tool IDs are `schedule_create`, `schedule_list`, `schedule_history`,
`schedule_update`, `schedule_pause`, `schedule_resume`, `schedule_cancel`.
Mutations require the host's current user-message event, never a model-supplied
owner, Bot, workspace or source identity. Creation uses the SDK tool-call ID as
its request key; replay after commit returns the same definition and schedule.

The clock supports explicit UTC-offset one-shot times, intervals anchored at an
explicit future start, and daily IANA local times. Missing DST wall times skip
that date; repeated wall times require an explicit earlier/later choice.
Paused slots never catch up. For an unexpected outage, `skip` or
`catch_up_once` and the accepted lateness are recorded in the definition. One
sweep coalesces an interval backlog into at most one due slot per schedule.

`GET /api/cron/schedules` uses the existing `CRON_SECRET`. Its numeric result
contains `materialized` and `executed`; the existing minute Worker calls it.
The occurrence's stable operation ID, row locks, immutable skip decision and
bounded lease protect concurrent scans, restarts and mutation races. Operational
failures retry up to three attempts. Failed reports have a persisted fair retry
queue, so a revoked chat cannot monopolize publication. The same transaction
commits a terminal outcome and one deterministic result in its original chat.

Reminders and authorized issue snapshots execute in PostgreSQL. An `agent_read`
occurrence commits one linked Coordinator inbox event before waking the existing
runtime. `takeInbox` isolates that event and hydrates the private fence from its
occurrence join. The lease token never enters a model message or tool schema.
Both the API model runtime and native relay use the existing model loop with a
host-filtered read catalog intersected with the user's stored allowed actions
and the execution's frozen grant. Each business read rechecks the occurrence;
native calls also retain their real holder/turn/call fence. Completion publishes
through the occurrence's CAS instead of the ordinary chat append path.
Scheduling does not grant external write, approval, credential, dispatch or
additional scheduling permissions. Already-started read/provider requests cannot
be retracted; cancellation blocks subsequent tool authority and result publication.

No new default-off feature flag, scheduler service, provider, identity or paid
resource is introduced. Model tasks require the already-configured Coordinator
runtime and its current model/connection admission. Model inference, connected
provider reads and budget/resource admission still need the issue's fixed-version
runtime acceptance; a mocked model response is not that evidence.

## Local evidence

Base `be539ca3`, plus shared read-catalog scaffolding `fe8e2041`. All changes are
isolated in `/workspace/mikka-old-schedule179`. PG17 uses a newly created
`mikka_old179_e2e` on loopback port 55599; 146 tracked migrations and Better Auth
schema bootstrap passed. Existing databases and migration ledgers were retained.

- Schedule PG regression: 11 passed, zero skipped. Ten-way creation/scans,
  real child-process SIGKILL/recovery, two repeat slots, pause/update/resume,
  ten cancel/execute races, owner/workspace revocation, stale model scope,
  retry exhaustion, and skip preservation after injected report failure.
- The actual Coordinator inbox/store was exercised against that PostgreSQL
  target. The actual cron handler executed a real-time reminder over a loopback
  HTTP adapter. This adapter test is not a built Next/model conversation claim.
- Clock, cron auth, business-scope and real workflow-entry tests use explicit
  model/native IO substitutes: 14 passed, zero skipped.
- Existing Coordinator/native tool/Agent Kit regression: 84 passed, zero skipped.
- Root TypeScript and targeted lint passed.

Logs: `/tmp/mikka-old179-setup.log`, `/tmp/mikka-old179-store-db-final.log`,
`/tmp/mikka-old179-source-final.log`,
`/tmp/mikka-old179-coordinator-regression-1.log`,
`/tmp/mikka-old179-typecheck-final.log`.

The parent must still run the combined Next/automatic-account acceptance and
Git-linked CI on its final integration head. No live model/provider, production
migration/Worker deployment, real external write or final issue closure is claimed.
