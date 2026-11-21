# Conversation schedules (#179)

The existing Coordinator and Bot chat tools create, list/history, update,
pause/resume and cancel workspace schedules. The 自动化 page manages the same
schedules through `app/actions/automations.ts` (see § Automations below).
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

`schedule_history` accepts `batches: {}` to list webhook windows for a single
schedule. The creator and workspace owners or administrators can read batch IDs,
request counts, creation and due times. A batch can be collecting requests,
queued for a run, or cancelled. Its occurrence status is reported separately. Optional `batches.status`,
`batches.limit` and `batches.cursor` filter and page these windows. Pass
`nextCursor` back unchanged for the next page. Individual webhook requests
with batching off do not have a window. This view omits bodies and request
keys. Omit `batches` to read ordinary occurrence history.
A creator or Workspace administrator reading a stored Task result also needs
current content access to that Task. Deleting the Task hides its snapshot
while the occurrence keeps its status and timestamps. Restoring the Task
makes the snapshot available again to readers who retain access.

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
Scheduling does not grant external write, approval, credential or additional
scheduling permissions; `dispatch_task` dispatches only as its creator could. Already-started read/provider requests cannot
be retracted; cancellation blocks subsequent tool authority and result publication.

No new default-off feature flag, scheduler service, provider, identity or paid
resource is introduced. Model tasks require the already-configured Coordinator
runtime and its current model/connection admission. Model inference, connected
provider reads and budget/resource admission still need the issue's fixed-version
runtime acceptance; a mocked model response is not that evidence.

## Automations (v1, 2026-11-15)

Decision [2026-11-15-1337](../design/decisions/2026-11-15-1337-automations-v1.md).

- **Page commands.** The 自动化 page's server actions call `executeScheduleCommand`
  with `{ direct: true }` as the signed-in person, in the workspace they have open,
  with that workspace's Coordinator as the schedule's chat (run reports go there).
  A direct request has no source chat event: `source_event_id` is null and its
  request key lives in `request_origin='page'` (a database check allows a null
  source only there). A Bot acting for the person (`actingContext`) cannot use
  these actions; chat tools still require the person's message. List, history,
  pause, cancel, update and resume keep the rules above.
- **`dispatch_task`** (`botId` or null for the Coordinator, `prompt`, optional
  `title`, `destination`, `profileId`) runs as its creator. At each run the host
  records the creator's user message to that Bot with the same
  `create_and_dispatch` task command the 新建任务 form sends, keyed by the
  occurrence ID (`submissionId` and task `requestId`), creates the Task through
  `createIssueFromRequest`, and wakes the creator's chats; the Bot dispatches it
  with the existing Machine, Profile, approval and resource checks. A retried run
  finds the same event and Task. The event carries `payload.schedule`, and the Bot
  is told the request came from the person's automation; it grants no approval.
- **Re-authorization.** Create, update, resume, 立即运行 and every run check that
  the creator is still an active member, the Bot is still theirs, unarchived and in
  the workspace, its repository is still installed there, a picked computer is
  still theirs and enabled, a picked Agent profile still exists and is enabled,
  and task creation is on. A failed check at run time fails the occurrence with
  its code (`scheduleBotUnavailable`, `scheduleRepositoryUnavailable`, …) and
  reports it; nothing is skipped silently. Tasks made this way are ordinary tasks:
  their access and Secret exposure follow the task rules, unlike `agent_read`,
  which stays read-only.
- **`manual` timing** has no next time; the schedule stays `active` with a null
  `next_at` and runs only through 立即运行. Resuming it returns to `active`.
- **`run_now`** (`scheduleId`, `version`, `requestId`): creator or owner/admin;
  only an active schedule. It inserts one `pending` occurrence due now with an
  operation ID derived from the schedule and request, so a repeated request returns
  the first occurrence. It refuses with `scheduleConcurrencyLimit` when waiting and
  running occurrences already reach `maxConcurrent`; execution re-applies the
  limit as for any slot.
- **Live updates.** Commands, materialized slots and reports publish
  `schedule_list` for the workspace; the page reads only on that signal.

Not in v1: GitHub, Slack and Linear event triggers, per-automation webhook URLs,
templates, run-count and spend limits, and Slack posting options.

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

## Event triggers (2026-11-15)

For GitHub PR and review deliveries the editor can restrict `events[].pullAuthors` to up to 20 PR openers. The webhook matches the PR's own author independently of the sender or reviewer. The optional Project selector searches matching logins on the most recently updated 50 pull requests in the event's single selected repository. Suggestions require current Project access, the workspace's repository policy, and the person's authorized GitHub repository. The Project choice applies only to suggestions.

Decision [2026-11-15-1704](../design/decisions/2026-11-15-1704-automation-github-triggers.md).

- **Definition.** A `dispatch_task` definition may carry `events`: 1–20 GitHub
  triggers `{ source: 'github', event, repositories, branches?, labels?, runWhen? }`.
  Events are those the GitHub App already subscribes to; `push` and `workflow_run`
  are not offered. Each repository is a workspace key (`v2/github.com/<owner>/<name>`)
  and must be usable in the workspace at create, update and resume, and again when
  an event arrives (`AutomationSeams.repository`).
- **Fan-out.** `dispatchVerifiedGitHubWebhook` maps a verified delivery to automation
  events (`lib/schedules/github-events.ts`; a `Bot` sender maps to none) and calls
  `fireGitHubAutomations` before GitHub is acknowledged. A failure answers 503 so the
  delivery is retried. Each active automation whose trigger takes an event gets at
  most one occurrence per delivery: its operation ID derives from the automation and
  the delivery ID (or a body hash when GitHub sent none), so a redelivery adds
  nothing. The occurrence stores the event and the indexes of the triggers that took
  it in `schedule_occurrences.trigger`. At `maxConcurrent` the event is recorded as
  `skipped` with `concurrencyLimit` and not reported to the chat.
- **Conditions.** Before the dispatch, the run goes ahead when one taking trigger has
  no `runWhen` or one of their conditions holds, judged by the Decision model for the
  creator (`AutomationSeams.runWhen`, billed like their other judgments). A miss is
  `skipped` with `runWhenNotMet` and not reported; no answer is the retryable
  `scheduleRunWhenUnavailable`, never a silent pass.
- **The request.** The dispatched user message is the automation's prompt followed by
  a `<github_event>` block of plain fields. The event's `payload.schedule.event` marks
  it, and eve's context tells the Bot the block is GitHub's data, not the person's
  instruction.
- **Cost.** One indexed read per PR, issue, comment, review or check delivery
  (`user_schedules_event_triggers`); `tests/github-webhook-statements.db.test.ts`
  carries it in each budget.


## Limits and usage (2026-11-15)

Decision [2026-11-15-1730](../design/decisions/2026-11-15-1730-automation-limits-usage.md).

- **`maxRunsPerDay`** counts `pending`, `running`, `succeeded` and `failed` runs created
  since local midnight in the definition's time zone. `execute` skips a timed or retried
  run past it (`dailyRunLimit`, reported like other skips), `fireEvents` records an event
  past it as a quiet skip, and `run_now` refuses with `scheduleDailyRunLimit`.
- **`usage`** command (`automationUsage` action): per local day, newest first, for up to
  90 days (default 14): `runs`, `skipped`, `tasks` (runs that created a task) and
  `costMicroUsd`, the sum of `hosted_usage."costMicroUsd"` whose `usageRunId` is a run of
  a task the automation created or added to (each task once), on the day it was spent; a
  day with spend and no runs is listed too. Cost is null for a member who is neither the
  creator nor an owner/admin.
- **Auto-pause.** When a run fails terminally with an authority code
  (`scheduleWorkspaceAccessDenied`, `scheduleOwnerUnavailable`,
  `scheduleConversationUnavailable`, `scheduleBotUnavailable`,
  `scheduleRepositoryUnavailable`, `scheduleDeviceUnavailable`,
  `scheduleProfileUnavailable`), the same transaction pauses the automation, stores the
  code in `user_schedules.disabled_reason`, bumps its version and cancels its other
  waiting runs without chat reports. `resume` re-checks authority and clears the reason;
  a person's own pause stores none.

## Each run: a new task or the same task (2026-11-15)

Decision [2026-11-15-1810](../design/decisions/2026-11-15-1810-automation-each-run.md).

- `eachRun: 'new_task' | 'same_task'` (default `new_task`) on a `dispatch_task` definition. With
  `same_task`, the first run that creates a task for the current creator (its result has
  `eventId` and `requestedBy` = the creator) is the standing task. Each later run sends the prompt (plus any event block) to that task's latest run
  of the creator with `sendThreadMessage(owner, runId, text, 'user', occurrenceId)`: a
  message if the thread is working, a continuation if it ended; the occurrence ID is the
  request ID, so a retry sends once. Its result is
  `{ id, title, status, identifier, runId, continued: true }` with no `eventId`.
- No run of the creator on the task yet: `scheduleStandingTaskNotStarted` (503, retried).
  The task gone from the workspace: `scheduleStandingTaskUnavailable` (403), which
  auto-pauses like a lost authority.

## 接手: take over (2026-11-15)

Decision [2026-11-15-1840](../design/decisions/2026-11-15-1840-automation-take-over.md).

- Command `{ action: 'take_over', scheduleId, version }`; page action `takeOverAutomation`
  (RPC `automations.takeOverAutomation`). Only on a workspace automation, only by an owner
  or admin (`scheduleAdminRequired`); on one's own it returns the row unchanged.
- `owner_id` and `bot_id` become the actor's (their chat gets the reports), `source_event_id`
  becomes NULL (a page command), version + 1. Pending and running occurrences are cancelled
  with `scheduleChanged` and reported to the previous creator's chat.
- An active automation, or one the host paused (`disabled_reason` set), is checked with the
  new creator's authority. Passing: active (an auto-paused one resumes). A lost-authority
  code: paused with that code as `disabled_reason`, so they can change it and resume. A
  person's pause stays.
- `list` rows carry `can_take_over` (workspace row, someone else's, reader not a member).
- `same_task`: the standing task is matched by `result.requestedBy`, so after 接手 the new
  creator's next run makes their own task.

## Webhook (2026-11-15)

Decision [2026-11-15-1830](../design/decisions/2026-11-15-1830-automation-webhook.md).

- Definition `webhook: { batchMinutes: 0..60 }` (dispatch_task only). Command
  `{ action: 'webhook_key', scheduleId, version }` (page only, `scheduleWebhookPageOnly`
  from a chat; creator or owner/admin) returns `{ schedule, key }` once; `key` is
  `mwh_` + 32 random bytes base64url, stored as `user_schedules.webhook_key_hash`
  (SHA-256, unique). `list` rows carry `webhook_key_set`. Page action
  `automationWebhookKey`, RPC `automations.automationWebhookKey`.
- `POST /api/webhooks/automations/<key>` (`lib/schedules/webhook-route.ts`): body ≤ 64 KB
  UTF-8 text, CRLF normalised; `Idempotency-Key` or `X-Request-Id` (printable, ≤ 200) is
  the request ID. `ScheduleStore.receiveWebhook` under the schedule row lock:
  - unknown, off, cancelled or completed: 404 `scheduleNotFound`; paused: 409 `scheduleNotActive`;
  - a request ID already in this automation's runs: `duplicate`;
  - `batchMinutes > 0` and a pending, unclaimed run of this version still gathering
    (`next_retry_at` in the future) under 50 requests and 256 KB: appended (`batched`);
  - otherwise a new occurrence due `now + batchMinutes` (`queued`), or `skipped` with
    `concurrencyLimit` / `dailyRunLimit` and no chat report.
- The signed-in automation actions `flushAutomationBatch` and `cancelAutomationBatch`
  (also available through Desktop RPC) take `scheduleId`, `batchId` and the schedule
  `version`. The creator or a workspace owner/admin can close the collecting window.
  Flush makes its existing occurrence due and wakes the scheduler. Dispatch still
  checks the creator's authority and run limits. Cancel keeps its count and times,
  removes the request bodies and hashes sender request IDs for redelivery checks.
  A repeat of the same action on that batch returns its prior result. An opposing
  action or a window already closed by time or capacity returns a conflict.
- The occurrence's `trigger` is `{ webhook: { requests: [{ at, body, key? }] } }`; history
  blanks it for members as it does GitHub triggers. The dispatch appends
  `describeWebhook(requests)` and marks the submission `schedule.webhook: true`, which
  eve's context names as data from whoever called the URL.
- `scrubString` masks `mwh_…` in exported traces.

## Linear triggers (2026-11-15)

Decision [2026-11-15-1930](../design/decisions/2026-11-15-1930-automation-linear-triggers.md).

- `events[]` may hold `{ source: 'linear', event, teams (1–20 Linear team IDs), labels?, runWhen? }`;
  events `issue_created`, `issue_status_changed` (`updatedFrom.stateId`), `issue_label_added`
  (labels not in `updatedFrom.labelIds`; `labels` match the added ones), `issue_assigned`
  (`updatedFrom.assigneeId`, now assigned), `comment_created`. An actor whose `type` is not
  `user` yields no event (`lib/schedules/linear-events.ts`).
- `permission` asks the `linearTeams(owner)` seam (the person's own Linear connection's teams;
  null without one → `scheduleLinearUnavailable` 403, an authority loss; Linear unreachable →
  `scheduleLinearUnreachable` 503, retried). Page action `automationLinearTeams`. On focus, the label filter reads `automationLinearLabels` with the shown workspace and the signed-in person’s own Linear connection. Suggestions include workspace-wide labels and labels for the selected teams. Comma-separated names can also be typed when suggestions are unavailable.
- `fireLinearAutomations(deliveryId, payload)` → `ScheduleStore.fireLinearEvents`: candidates are
  active automations with a matching Linear trigger whose creator has an unrevoked
  `linear_connections` row for the event's organization; then the shared `queueEvent`
  (operation `event:linear:<delivery>`, caps and concurrency as GitHub's).
- Receivers: `app/api/webhooks/linear/route.ts` calls it after the signature check and before
  the sync kill switch (503 on failure); `app/api/webhooks/linear/automations/route.ts` takes
  the Linear Worker's forward (`LINEAR_AUTOMATIONS_FORWARD_URL`, Linear's own headers and body,
  signature checked again). The submission carries `schedule.linear: true`.

## Slack triggers (2026-11-15)

Decision [2026-11-15-2010](../design/decisions/2026-11-15-2010-automation-slack-triggers.md).

- `events[]` may hold `{ source: 'slack', event: 'message' | 'mention' | 'reaction_added', channels (1–20 IDs), authors?, reactions?, runWhen? }`.
  A message or `app_mention` with no `bot_id`/`bot_profile` and no subtype (or `thread_broadcast`), or a
  `reaction_added` on a message, by a user (`lib/schedules/slack-events.ts`).
- An optional list of up to 20 member IDs filters events by the Slack author as well as the channel. The editor accepts IDs directly and reads a page of active human members when the current installation already has `users:read`.
- `permission` asks the `slackChannels(owner, workspace)` seam: the workspace's installation of `SLACK_APP_ID` the
  creator is a member of, its bot token's `conversations.list` (`lib/slack/automation-channels.ts`); null →
  `scheduleSlackUnavailable` 403 (authority loss), Slack unreachable → `scheduleSlackUnreachable` 503. Page action
  `automationSlackChannels`.
- `fireSlackAutomations(payload)` → `ScheduleStore.fireSlackEvents`: candidates join `mikka_slack_installations`
  (workspace, app, team, not revoking) and `mikka_slack_members` (the creator); operation `event:slack:<team>:<event_id>`.
- Eve's Slack channel forwards signed `event_callback`s to `SLACK_AUTOMATIONS_FORWARD_URL` (Slack's body and
  `x-slack-*` headers, 1.5 s timeout, failures logged); `/api/webhooks/slack/automations` checks the signature and
  `api_app_id` again. The submission carries `schedule.slack: true`.

## Posting runs to Slack (2026-11-15)

Decision [2026-11-15-2040](../design/decisions/2026-11-15-2040-automation-slack-posts.md).

- Definition `notify: { slack: { channel, locale: 'zh-CN' | 'en' } }` (dispatch_task only); `permission` checks the
  channel with the `slackChannels` seam like a Slack trigger's.
- After a run is recorded `succeeded`, or `failed` for good, `ScheduleStore.notice` claims it once
  (`schedule_occurrences.notified_at`, migration `20261115203000_schedule_notified`) and calls the `notify` seam:
  `postRunNotice` (`lib/slack/automation-notice.ts`) writes `AutomationSlack.*` in the saved locale (the task as a
  link to `<app>/?issue=<id>`, a failure as its `Errors.*` copy) and `chat.postMessage`s with the installation's bot
  token. A failed post is logged and not retried; the run is unchanged.

## Cancel one queued run (#2060)

A creator or workspace owner/admin can cancel an individual queued run from its history row. The signed-in
`cancelAutomationRun` action names the schedule, its current version, and the occurrence. It locks the same
occurrence as the worker claim. Once claimed, an occurrence may already have dispatched a task, even if its
status subsequently returns to pending for a retry. Cancellation therefore accepts only pending runs with
zero attempts. Webhook collection windows use their batch action. The original chat receives one cancellation record. The schedule and other occurrences keep
their current state.

## Templates, pins, folders and tags (2026-11-15)

Decision [2026-11-15-2100](../design/decisions/2026-11-15-2100-automation-templates-organize.md).

- Templates are client-side drafts (`components/automations/automation-templates.ts`): `automation=new:<template>`
  opens the editor with the template's timing or trigger and the localized `Automations.templates.<key>` title and
  request. Nothing is stored until the person saves.
- Migration `20261115204500_schedule_organize`: `user_schedules.folder`, `user_schedules.tags text[]`, and
  `schedule_pins(user_id, schedule_id)`.
- Commands `{ action: 'pin', scheduleId, pinned }` (any reader; their own row in `schedule_pins`) and
  `{ action: 'organize', scheduleId, folder, tags }` (creator or owner/admin, `scheduleAdminRequired`; no version
  bump). `list` rows carry `folder`, `tags` and the reader's `pinned`. Page actions `pinAutomation`,
  `organizeAutomation`.


## Deleted automations (#2060)

The signed-in editor uses `deleteAutomation`. Deletion cancels pending and running occurrences, clears the next due time
and saves the prior active, paused or completed state in `user_schedules.status_before_delete`. The Deleted filter
uses the same paginated list with `deleted: true`. A creator or workspace admin/owner can use `restoreAutomation`
there. Both mutations require the displayed version and publish on `schedule_list`. Restoring an active automation
checks the creator's membership and execution permissions, then computes its next future slot. An elapsed one-time
schedule stays completed. Previously cancelled occurrences stay cancelled. The original `schedule_cancel` command
is terminal, including for rows created before this migration.
