# Conversation schedules backend (#179)

Status: draft; issue remains open. No management UI, production migration,
production cron registration, real email, provider credential use or paid resource
creation is authorized/performed by this change.

## Baseline and dependency audit

Frozen source baseline: PR #267, `470b3247ff12b50ba942ae93418ff4600c77edd5`,
based on main `a1610e7cb411b0b676b8365df63c93986f205cbf`. This is a stacked
candidate for the release owner, not an independent replacement for #267.

Read #179 and #176 in full, AGENTS.md and acceptance instructions. The workspace
`.agents` and `.codex` directories are empty and this checkout contains no
applicable `.agents/skills`; the embedded run-report Skill concerns daemon run
reports. Audited all 300 available PR records and current code for schedules,
wake, runtime and recovery. No #179 implementation owner was found. PR #252's
credential cleanup relay is unrelated to user schedules. #265 budgets, #264
policy and #259 audit are independent, ongoing work and are not overwritten.

#176 is open and the baseline's `wakeCoordinator` swallows delivery failure.
This candidate adds compensation metadata to the existing `coordinator_events`
inbox and a common runtime sweep for inbox wakes and user occurrences. It does
not create a second wake queue/event bus. **It does not complete #176**: delivered
inbox events whose workflow fails after `takeInbox`, actual Workflow SDK delivery,
exhaustion/replay and provider side-effect acceptance still require its owner and
integration checks. A deliveredAt marker is not proof of successful task effects.

## Implemented path

Existing Bot `/api/agent` and durable Coordinator expose create/list/history/
update/pause/resume/cancel tools. Owner identity and original message/turn are
server derived; actual user source is required for mutations. Coordinator multi-
workspace ambiguity fails closed. Authenticated `/api/schedules` shares the same
service for backend HTTP acceptance; it does not provide a new UI.

`user_schedules` stores the owner, workspace, original chat, source, immutable
creation request and versioned definition. `schedule_occurrences` stores a unique
(schedule, version, due time), operation ID, attempt, lease/fence, status, result,
error, delivery timestamp and execution timestamps. Both tables use the app DB;
current membership is checked through the existing workspace DB authority and
held across each execution. Issue visibility and chat ownership are rechecked.
No permission is inferred from peer messages or schedule prompts.

The common `/api/cron/runtime` route uses the existing cron bearer boundary.
The existing Worker's minute handler can relay to an **explicit** frozen HTTPS
origin with redirects forbidden; daily Linear and credential cleanup remain
distinct jobs. No cron expression is registered by this patch. Creation/resumption/
update fail closed unless `MIKKA_RUNTIME_SWEEP_ENABLED=1`; this must only be set
with a parent-approved runner. Cancellation, pause and reads remain available.

Reminder and issue snapshot effects, occurrence completion, original-chat result
and deduplicated Coordinator event commit in one PG transaction. Claiming commits
first; a killed worker's lease expires after 60 seconds. The next process reuses
the same operation/occurrence; stale fences cannot publish. Mutation and execution
serialize on the schedule row. Cancellation wins before execution or follows an
already committed result; it never claims to undo a completed action. Pausing
fences pending work. Updating cancels old unexecuted occurrences. Optimistic
versions reject lost updates. A failed result-report crash is recovered from the
occurrence itself after checking current membership; revoked owners receive no
private result until reauthorized.

`agent_read` runs the existing Bot model with only explicitly named read actions.
It requires `MIKKA_SCHEDULE_AGENT_ENABLED=1` plus the existing provider configuration;
it is disabled in isolated acceptance. Gmail/Calendar/Notion/Slack reads use the
current owner's existing connection checks on every call. There is no write,
approval, credential or recursive scheduling tool. Connection failures cannot be
reported as successful execution. Model reads may be retried after a crash; this
is not an exactly-once billing guarantee. External write scheduling remains
unsupported pending #207/#208 approval and effect-ledger integration. #265 must
admit/settle future scheduled model work before enabling it for a budgeted tenant.

## Time and failure contract

- Once: explicit offset/Z instant plus validated IANA zone; ambiguous abbreviations and past times reject.
- Interval: fixed UTC elapsed minutes, explicit future start; zone retained for
  user readback. Daily: local HH:mm, explicit earlier/later fold choice; missing
  local time skips that date. New York and Lord Howe transitions are tested.
- Timezone changes replace the definition and fence old pending occurrences.
- After downtime, `catch_up_once` coalesces missed slots into one persisted oldest
  due occurrence and computes the next future slot. `skip` records a skipped
  occurrence after explicit max lateness. No unbounded historical replay.
- Pause/resume chooses a future slot; paused slots are never caught up. A past
  one-shot becomes completed without an execution after resume.
- Retry only rolled-back reads: 30/60 seconds, at most 3 attempts; no external
  writes. Final errors are sanitized, persisted and returned to the original chat
  when current membership permits. No silent infinite retry.
- The minute runner's intended acceptance SLA is 90 seconds under available
  capacity; isolated manual HTTP scans predeclare 10 seconds. This is not a
  verified production SLA or capacity guarantee.

## Reproduction and remaining gates

Use a disposable cloud-Linux loopback PG database named `mikka_179`, apply tracked
migrations with BOTH target URLs pointing to that DB, then run:

```
pnpm test:schedules
SCHEDULE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55479/mikka_179 pnpm test:schedules:postgres
```

The PG suite uses actual tables, tool executors, concurrent workers, a real killed
child process, current membership rows and PG transaction fault injection. Clock
injection is constructor-local and unavailable over HTTP. Synthetic rows are
retained. The HTTP harness runs against an actual built Next service, uses only
synthetic Better Auth users/sessions in that disposable DB, restarts that service,
executes two recurring reminders in wall-clock time and reads the original Bot
chat through its existing history endpoint. It does not count as OAuth/model-chat
acceptance. Provider calls, arbitrary write tasks, parent-approved nonproduction
Preview/OAuth/model conversation and production verification remain outstanding.

Actual fixed-runtime evidence, raw recordings, process/DB/event IDs, retained failures and explicit remaining gates: [evidence/179](../evidence/179/README.md). Runtime code SHA is `9c5c67c717618ee77126a82b6d7aea61e1e2ce0c`. Keep #179 open.
