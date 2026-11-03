# Every dispatch is a Factory task

- Date: 2026-11-03
- Source: Alex, relayed by the coordinator session: every task goes through the
  Factory — execute, then independent review, then independent verification,
  then acceptance — and none of them may be skipped.
- Rule: —
- Replaces: the direct `queueRun` / `queueCloudRun` paths that
  `workflows/coordinator/steps.ts` (`dispatchRun`, `dispatchByRules`,
  `dispatchComputerThread`, `dispatchComputerTask`) and `lib/mcp/actions.ts`
  (`dispatchRun`) take today; the exemption in 8196fae1 (a new Factory task is
  admitted with no model).
- Status: direction and the six open questions decided by the coordinator session (2026-11-03 04:15 UTC); see Decisions.

## Where things stand

The Factory's contracts (docs/factory/192–195) are wired up and switched on in
production (`mikka-factory-routing`, `mikka-factory-lifecycle`), but only its
own entry points create a task: `intake_factory_request`, `route`, and
`dispatch_factory_task` → `createFactoryDispatch` → `queueFactoryRun`. The
Coordinator's `dispatch_run`, `dispatch_bot_computer` and the MCP client's
`dispatch_run` queue runs directly. Production `factory_tasks` and
`factory_attempts` have no rows, and the 62 runs of the past day all skipped
the Factory.

Three gaps follow from the code as it stands, and this design closes them:

1. **The Factory only queues local runs.** `queueFactoryRun` → `queueAdmittedRun`
   requires an Agent with a `kind='local'` device. Cloud runs (`queueCloudRun`)
   cannot be a Factory attempt today.
2. **Nothing dispatches review or verify.** After reconciliation passes execute
   it moves the task to `review/pending`, and someone has to call
   `dispatch_factory_task` with an Agent and a repository. Today that is the
   model, which is free not to.
3. **A Factory run has no model.** `factoryDispatchSchema` has no model;
   8196fae1 lets it through. Every other run requires one.

## The rule

1. `dispatch_run` (Coordinator or MCP client) and `dispatch_bot_computer` never
   call `queueRun` or `queueCloudRun`. They **find or create the Factory task**
   for the work, then queue its **execute attempt** through
   `createFactoryDispatch`, in one transaction (queue, configure, freeze,
   `bind_run` and the receipt commit together, as #191 requires).
2. When an execute, review or verify attempt passes, reconciliation (already run
   on run completion and in `preparePrompt`) **dispatches the next stage itself**
   in the same transaction as the `advance`. The model is not asked; it cannot
   decline or skip it. `dispatch_factory_task` stays available for an explicit
   retry and is otherwise unneeded.
3. After verify passes, the task waits in `approval/pending`: the acceptance card
   (`components/workspace/factory-acceptance*.tsx`) shows the candidate, review,
   verification and evidence, and 验收并合并 is the person's action (#528). No
   agent and no host code passes acceptance.
4. The model for every Factory run is chosen in one place (below). No run, and
   no Factory run, is queued without one. 8196fae1 is reverted.
5. With the lifecycle switches off, `dispatch_run` refuses
   (`factoryLifecycleUnavailable`) rather than queue a run around the Factory.
   The switches stay as a stop control, not as a bypass (Decisions 1).

## The mapping

Terms: a **task** is a `factory_tasks` row (one per thread); an **attempt** is a
`factory_attempts` row (one per stage try); the **stage** is the task's current
stage. "Thread" is `lib/thread-dispatch.ts`'s: one task, one thread.

| Dispatch | Factory task | Attempt and stage | Run queued by |
| --- | --- | --- | --- |
| **New task** — `dispatch_run` on an issue with no thread | New task, `route` with `sourceEventId` = the person's message (`requestEventId`), straight to `execute/pending` (a clear request; clarify stays the intake tool's) | First execute attempt | Factory queue, placed by 运行位置 exactly as `dispatchByRules` places it today |
| **Continue, thread running** — more work while the run works | Same task | No new attempt: the text goes to the running run (`send_to_run`), as now | — |
| **Continue, thread ended** — task at `execute` failed/blocked | Same task | `retry` → a fresh execute attempt (existing action) | Factory queue, on the thread's own place, model and session (resumed where the thread ran, as now) |
| **Continue, thread ended** — task waiting in review/verify (failed/blocked) or monitor | Same task | `repair` → a fresh execute attempt, candidate cleared (existing action) | As above |
| **Continue while awaiting acceptance** — task in `approval/pending` | Same task | `repair` from `approval/pending` → fresh execute attempt, candidate cleared. **Additive contract change** (repair today accepts only review/verify/monitor) (Decisions 2) | As above |
| **Continue after acceptance** — task passed/merged | New task on the same issue; the new thread is the old thread's next run (same place, model, session) | First execute attempt | As above |
| **Change repository / explicit new thread** (`newThread` with the person's own words) | The current task is cancelled (`cancel`, which stops its live runs in the same transaction); a new task is routed from this message | First execute attempt | Factory queue, by 运行位置, for the named repository |
| **Cloud** (运行位置 云端, or `target: "cloud"`) | As the row above it says | As the row above it says | New Factory queue adapter `queueFactoryCloudRun`: today's `queueCloudRun` body taking the caller's transaction, plus thread machine and lifecycle start after commit |
| **Server / computer** (a named `deviceId`, or 本地 / fallback to a device) | As above | As above | Existing `queueFactoryRun` (local), with `pinnedDeviceId` and model passed through |
| **Screen work** — `dispatch_bot_computer` (desktop thread on the Bot's own machine) | As above, same task/thread rules | As above | `queueFactoryCloudRun` on the Bot's runtime |
| **MCP client `dispatch_run`** | As above; never a new thread (unchanged) | As above | Factory queue (local, the client names the Agent) |

Review and verify, for every row: a fresh run with its own run and session
(#193 independence), on the **same place** as the execute run (the same device,
or a fresh thread machine for a cloud candidate), on the candidate's exact SHA,
read-only, with the repository's frozen verify command. Their model is chosen
as for a new run (below). Their outcomes go through the existing
`reconcileFactoryCheck`; a failed check re-enters the existing capped repair
loop (`failIntoRepairLoop`), which dispatches the repair execute attempt the
same way.

### What the Factory queue needs

- **One queue, two adapters.** `FactoryQueue` gains a placement: `{ kind:
  'device', agentId, deviceRepoId, pinnedDeviceId? }` or `{ kind: 'cloud',
  botId, agentId, deviceRepoId }`, plus `model`. `factoryDispatchSchema`
  gains the same, all host-filled; the Coordinator's tool schema does not let
  the model supply them. The request key stays `factory:<attemptId>`.
- **Cloud review/verify.** `configureFactoryCheck` / `factoryCheckAssignment`
  accept a cloud device (its machine reports online through the thread machine,
  not `lastSeenAt`), and the cloud worker honours `kind='acceptance'` with the
  frozen read-only policy and `baseBranch` = SHA, as the daemon does.
- **Candidate from a cloud run.** Reconciliation reads `report.publish.commit`
  and the device repo's remote, as for a local run; a cloud run pushes to its
  task branch (`run_publications`), so its report carries the commit.
- **Source event.** A task's `sourceEventId` must be a personal `user_message`.
  `dispatch_run` already has the host-supplied `requestEventId`. An MCP client
  has none, so its request is recorded as one (Decisions 3).

## One place picks the model

`lib/computer/run-model.ts` becomes the only chooser, and the Factory dispatch
calls it on the host, never the model:

- **New task's execute attempt, review, verify:** by 优先使用的模型 for the
  placement — `chooseCloudRunModel` for a cloud run, `chooseLocalRunModel` for a
  device run. A model the person named (`model.model`, 「派给 Codex」) is passed
  as `asked`, as today.
- **A thread's next run** (continue, retry, repair, continuation, question
  answer): `latestThreadRunModel` — its own model and account. If that no longer
  serves, `threadModelUnavailable`, as today; never another model silently.
- **Rerun of a run** (`queueFactoryRun` with `sourceRunId`): the source run's
  model (`threadRunModel`), as 8196fae1 already does.
- `queueAdmittedRun` then requires a model for Factory/Skill callers too, and
  8196fae1's exemption is removed. The PG17 fixtures that tripped on it
  (factory-admission, issue-tool-calls' Factory path) get a personal workspace
  and an allowed model.

## What does not change

- One task, one thread; the thread keeps its repository; a new thread needs the
  person's explicit request; MCP clients never start one.
- A thread's next run goes where the thread ran, keeps its session, model and
  account, and keeps read-only.
- Placement (运行位置, the cloud-to-device fallback, machine-unavailable cards,
  repository resolution cards) is decided exactly as today, before the Factory
  dispatch; the Factory receives the decided placement.
- The run's reply still names `placement` from `runPlacement`.
- Acceptance is the person's merge (#528); agents never merge.

## Verification

On an isolated local `mikka_e2e` database with synthetic Acme-like data (a
person, a personal workspace, an allowed model, a local device with a repo and
a verify command, an issue and a `user_message`):

1. On current main: one Coordinator `dispatch_run` → `factory_tasks` and
   `factory_attempts` have 0 rows (the failing baseline).
2. On the branch: the same dispatch → one task, an execute attempt bound to the
   run; completing it with a SHA → review attempt and run dispatched by the host;
   then verify; then `approval/pending`, and the acceptance card renders with the
   candidate, review and verify evidence. Each of the four stages has its run
   record (approval's being the acceptance read).
3. Continue, retry, repair and new-thread cases keep their thread behaviour
   (existing thread-dispatch tests) and each lands on the expected attempt.

## Decisions

Decided by the coordinator session on 2026-11-03:

1. **Switch off.** With `mikka-factory-lifecycle` (or routing) off, `dispatch_run`
   and `dispatch_bot_computer` refuse with an explicit error
   (`factoryLifecycleUnavailable`). There is no fallback to the old direct path.
2. **Follow-up while awaiting acceptance.** `repair` is allowed from
   `approval/pending`: a fresh execute attempt, candidate cleared, revision
   bumped. This is an additive change to contract v1.
3. **MCP client source.** An MCP client's dispatch is recorded as a host
   `user_message` event in the person's Coordinator chat. That event is the
   task's `sourceEventId`.
4. **Work with no commit.** For a read-only investigation, or a desktop task on
   a repository with no remote, the candidate is the exact HEAD the run read.
   Review and verify judge the report and evidence, and acceptance is 验收
   without a merge. A desktop task with no repository at all gets a new
   candidate kind, a **no-repository deliverable**, added to the contract. It
   goes through the same review, verify and acceptance stages. None of this
   work stays outside the Factory.
5. **No verify command.** The person is not asked first. The verify agent infers
   the command from the repository (`package.json` scripts, `Makefile`, CI
   configuration) and records the command and its basis in the evidence, which
   the acceptance page shows. Only when nothing can be inferred does the task
   block with a card that asks the person once; the answer is stored on the
   repository and reused. No default is ever made up.
6. **`start_web_subagent`** is not included in this change. Its results are
   evidence a verify run may use.
