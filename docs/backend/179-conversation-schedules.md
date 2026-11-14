# Conversation schedules (#179)

The existing Coordinator and Bot chat tools create, list/history, update,
pause/resume and cancel workspace schedules. No management UI is added.
The seven tool IDs are `schedule_create`, `schedule_list`, `schedule_history`,
`schedule_update`, `schedule_pause`, `schedule_resume`, `schedule_cancel`.
Mutations require the host's current user-message event, never a model-supplied
owner, Bot, workspace or source identity. Creation uses the SDK tool-call ID as
its request key; replay after commit returns the same definition and schedule.

New schedules belong to the current workspace (`visibility='workspace'`,
non-null `workspace_id`). Active workspace members may list, read history,
pause and cancel them. Only the creator or an `owner`/`admin` member may update
or resume; an ordinary member gets `scheduleAdminRequired`. Legacy rows keep
`visibility='owner'` and remain visible and mutable only to their
`owner_id`/`bot_id`. A workspace member's result still publishes to the
schedule creator's original chat. If its Bot is deleted, `bot_id` becomes null
and the result falls back to the creator's Coordinator chat.

`schedule_list` returns up to 100 visible schedules by default. Pass an integer
`limit` from 1 through 100 to request a smaller page. Pass a non-null
`nextCursor` back unchanged as `cursor` to continue. Pages are ordered by
creation time and schedule ID, newest first. Each read checks the current
workspace membership and conversation visibility.

Request deduplication uses a frozen internal `request_origin` rather than the
mutable `bot_id`. Two Bots can use the same SDK tool-call ID; removing either
Bot preserves its schedule without merging their request keys. The internal
origin is omitted from tool responses. Current authorization and result routing
continue to use `bot_id` and the existing workspace checks.

The migration preserves all existing schedule fields. A row whose Bot has
already become null gets `retained:<schedule-id>` because its original Bot
cannot be recovered. New null-origin database writes use `coordinator`.
Creation still requires a Workspace; retaining a request key grants no Bot,
Workspace or result-reading authority.

The clock supports explicit UTC-offset one-shot times, intervals anchored at an
explicit future start, daily IANA local times, and five-field cron expressions
(minute hour day-of-month month day-of-week) in the definition's IANA timezone.
Cron rejects macros, seconds, `L`, `W`, `#` and `?`; `JUL` and `WED` remain
valid names. Missing DST wall times skip that date; repeated wall times require
an explicit earlier/later choice. Cron uses the pinned `cron-parser` behavior in
the requested IANA zone. Paused slots never catch up. For an unexpected outage,
`skip` or `catch_up_once` and the accepted lateness are recorded in the
definition. One sweep coalesces an interval backlog into at most one due slot
per schedule.

`maxConcurrent` is optional in the definition (1-5, default 1). It is enforced
when an occurrence executes, under the schedule row lock, by counting only
running occurrences that started earlier. A later slot above the limit becomes
`skipped` with `error='concurrencyLimit'`, reports once and does not queue.
Misfire skips keep `error='misfireSkipped'`. Scheduled reads still create no
`agent_runs` row.

`GET /api/cron/schedules` uses the existing `CRON_SECRET`. Its numeric result
contains `materialized` and `executed`. Due work starts from persisted events
and durable timers. The Worker calls `/api/cron/reconcile` every 15 minutes as
the safety sweep. The schedules route remains available for an authenticated
manual invocation. See [suggestions schedules](../suggestions-cron.md).
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

## Historical local evidence

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
