# Task review terminal — #1723

This implementation connects the cloud task terminal shipped by public PR #1754 and hosted UI PR #39. The browser talks to the task review API; it never selects a sandbox, port, repository, or operating-system path.

## HTTP contract

| Request | Result |
| --- | --- |
| `GET /api/tasks/:id/review/terminal`, accepting `text/event-stream` | SSE `event: output` with `{ "text": string }`, then `event: ended` with `{ "exitCode": number \| null }` after confirmed process cleanup. The first output frame is an empty string so the shipped hook becomes live immediately. |
| `POST /api/tasks/:id/review/terminal/input` with `{ "data": string }` | `204`. Optional UUID `requestId` provides at-most-once input when API clients retry; the shipped hook never automatically retries input. `X-Terminal-Request-Id` reports the chosen ID. |
| `POST /api/tasks/:id/review/terminal/resize` with `{ "cols": number, "rows": number }` | `204`; the actual PTY receives `TIOCSWINSZ`. |
| `DELETE /api/tasks/:id/review/terminal` | `204` only after durable revocation and the matching gateway's cleanup acknowledgement. A pending cleanup returns `503` and remains scheduled for reconciliation. |

Missing or unsupported terminal integration returns `404`; an accessible task owned by another member returns `403`; a reclaimed or changed execution binding returns `409`. An active Agent returns `423 terminal_already_controlled`, because it has not yielded physical checkout ownership. Other malformed, oversized and rate-limited input returns `400`, `413` and `429`. Every response is private and uncached. Unknown upstream diagnostics are reduced to registered error codes.

The cloud terminal is available after the current Agent has actually exited and the daemon has finished repository writes. A terminal status in the database alone is insufficient. An ordinary completed/failed run can retain its sandbox for review; its original VM may be resumed under a fresh review lease. Stopped/cancelled runs are revoked and return `409`. Opening a new review on a quota-parked run also remains `409` in this batch. The terminal does not pause an active native process, dispatch another Agent, mint a replacement device execution token, or create a new VM.

Local-machine remote terminals remain unsupported in this batch and return `404`. That part of the original issue remains open; a passing cloud acceptance must not be reported as completion of the local-machine target.

## Authority and execution handoff

`review-authority.ts` supplies the current human owner, membership, task visibility, latest run, repository binding, claim provenance, physical worktree, sandbox, machine epoch and operation. The API requires the same frozen workspace, admitted workspace, machine workspace and device-token workspace. Input rechecks current task authority and reads only an existing lease; it cannot create a PTY. No database query runs per stdout chunk or native Agent command.

The opening sequence is:

1. Resolve current task authority; reject an unsupported device or an Agent without verified native exit.
2. Under the shared authority transaction, create or reuse the original absolute review lease.
3. If parked, resume only the same sandbox after a machine/lease compare-and-set; check authority again afterwards.
4. Prepare the root gateway and authenticate its version/boot nonce using a fresh HMAC challenge.
5. Recheck authority and the exact lease under transaction locks; sign the one-use request against the already captured gateway boot.
6. After commit, send that exact signed request. Do not refresh the boot nonce or sign again after the transaction.

The daemon acquires a kernel `flock` before repository preparation, native prewarming, or execution. It retains the lock through verification, publishing and cleanup. Only confirmed native exit produces an idle receipt. The terminal takes the same fixed inode for the full PTY lifetime; a competing Agent waits. A missing control helper, lost lock, unsupported version or unconfirmed exit fails closed. Runtime refresh also takes this lock before stopping or replacing an idle worker.

`/run/mikka-review-control` is root owned and not writable by the execution user, so that user cannot unlink or replace the lock inode. The version marker is root owned and read only. The daemon's receipt itself is writable by its execution user; it is **not a root-authenticated native-exit proof**. Server-side claim-bound native-exit evidence is required independently.

The guarantees cover normal operation, contention, crash, disconnect and lost-control paths. They do not establish hostile-process isolation between arbitrary processes sharing the same Unix UID on one VM. Such a process can attempt to change that user's receipt or signal its control helper. The VM is the execution authority boundary; this change does not claim absolute same-UID secret isolation or introduce a new root process broker.

## Revocation, retention and data handling

The persistent review lease is tied to the task/run/owner/workspace/device/repository, machine epoch/operation, and the particular browser session or workspace PAT. Reconnect does not extend its absolute expiry. Shared lifecycle hooks revoke it on stop, task/owner/workspace changes, membership changes, credential revocation, machine change or a newer run. The gateway receives the exact revoked lease IDs and records tombstones before acknowledging cleanup, so a delayed open cannot resurrect a revoked shell. Explicit IDs affect only the corresponding terminal; another transport's lease is not closed accidentally.

A paused VM cannot be resumed by input or revocation. A provider-confirmed destroyed VM is a close acknowledgement. A provider-confirmed paused VM can be acknowledged without waking it only after every affected lease's absolute expiry. Every input, output, attach and queued-frame delivery checks wall time independently of event-loop timers, because pausing a VM freezes those timers. A missing health response from a running VM is not proof of cleanup.

The root gateway forks a real PTY and drops to the task's existing execution user. The shell uses the actual run worktree and a clean environment, retaining native HOME and PATH. It does not inherit application keys or gateway signing material. Root-only gateway files contain only the instance-derived key; the application's authentication secret is never copied to the sandbox.

Stdout and input are not written to a transcript, database, outbox, command log or request body log. The gateway keeps a bounded in-memory history. A natural shell exit drains final output, kills and reaps the complete descendant tree (including `setsid` descendants), and tombstones the lease before sending `ended`. Revocation and expiry discard queued output before acknowledging closure. A failed cleanup retains the execution lock.

| Bound | Value |
| --- | --- |
| Absolute review capability lifetime | At most 5 minutes, or remaining browser/PAT lifetime if shorter |
| Additional gateway hard lifetime ceiling | 15 minutes; it cannot extend the shorter review lease |
| No-input timeout | 120 seconds |
| Detached stream grace | 30 seconds |
| Concurrent PTYs / readers | One / one per sandbox; a reconnect replaces the previous reader |
| Scrollback | At most 256 KiB in memory |
| Single input | 16 KiB UTF-8 |
| Input rate | 64 KiB/s |
| Output rate / total | 128 KiB/s with a 256 KiB burst / 16 MiB |
| HTTP connections / queued output frames | 16 / 32 per reader |

## Verification and evidence

Run Node contract and authority-order tests with:

```sh
node --experimental-test-module-mocks --import ./tests/support/server-only.mjs --import tsx --test \
  lib/coding-workspace/terminal/wire.test.ts \
  lib/coding-workspace/terminal/http.test.ts \
  lib/coding-workspace/terminal/runtime.test.ts
pnpm --filter @mikka/daemon exec vitest run \
  src/runs/workspace-control.test.ts src/runs/supervisor.test.ts
```

Run actual TCP, non-root shell, process cleanup and PTY tests in an isolated Linux root environment with a mapped `nobody` user:

```sh
MIKKA_REQUIRE_REAL_PTY=1 python3 scripts/e2b/terminal-gateway.test.py
python3 packages/daemon/scripts/refresh-cloud-worker.test.py
```

`CI` or either required-real-PTY flag makes a missing Linux/root environment fail instead of silently skipping the PTY suite. A restricted runner mapping only UID/GID 0 cannot run the real-shell fixture; `fchown` errors or denied sockets are failed checks, not acceptance evidence.

The suites exercise actual `pwd`, Git status, a shell test command, terminal resize, Ctrl+C, exit code 7, reconnect, bounded real stdout, at-most-once input, execution contention, `setsid` cleanup, idle/detach deadlines and paused-wall-clock expiry. Node tests cover exact frontend events/statuses, cross-site refusal, payload bounds, committed grant ordering, scope/revoke races, pending close, authenticated gateway health, no implicit input resume and closed error diagnostics. Supervisor tests retain ownership until actual finishing cleanup and release acknowledgement.

Before production completion, attach immutable candidate SHA and Git-linked CI runs, real isolated PG authority/lifecycle results, official Claude Code `claude-haiku-5-5` and Codex `gpt-6-luna` runtime checks, deployment READY/served SHA, and sanitized production API requests/responses to #1723. A local test or mocked provider result is not production evidence. The queue and runtime release must finish before the backend deploy; frontend owners merge their own PRs separately.

### Production API/CLI driver

`scripts/acceptance/task-review-terminal.mjs` exports `verifyExistingTaskTerminal` and `verifyTerminalRefusal`. Importing it performs no requests. It accepts an existing normal cookie client plus explicit task/run/workspace/owner/build IDs; it creates no identity, Bot, profile, dispatch, provider session or VM. Opening the terminal can resume that run's own retained VM under the reviewed lifecycle policy. Its only shell commands are bounded acceptance commands: `pwd`, Git status, a read-only Bash assertion, `stty`, an interrupted `sleep`, a shell counter and `exit 7`.

The helper checks the served build before and after, verifies the approved smoke identity and selected workspace, and requires a normally succeeded/failed cloud run. It checks empty-first-output SSE readiness, exact run/owner/session metadata, real repository working directory, resize, Ctrl+C, at-most-once input, reconnect with the same absolute lease and shell state, exit code and EOF. It always attempts an explicit terminal DELETE after admission. `passed_for_requested_scope` is deliberately separate from completion of the entire issue; `remaining` lists separate peer, reclaimed and local-machine acceptance work. It never returns a transcript, email, cookie, owner identity or unfiltered server error.

The existing reusable entry points are:

| Need | Existing entry point | Boundary |
| --- | --- | --- |
| Normal sign-in and in-memory cookies | `createSessionClient`, `smokeAcceptanceAccount` in `scripts/acceptance/cloud-startup.mjs` | Credentials come from the already approved shared smoke account. No owner-account fallback. |
| Select the approved Acme team and restore the prior selection | `selectAcceptanceTeam`, `restoreAcceptanceWorkspace` in the same module | Selection verifies the existing authorized team administrator; it does not pick a team by display name or create membership. |
| Real official subscription execution | `runSubscriptionCase` / `runCloudStartup` in the same module | Use the normal cloud placement and exact small official models. Candidate-device template checks do not necessarily create a managed thread-machine binding. |
| Wait for an already dispatched run | `watchRun` in the same module | Existing authenticated live channel with deadline reads; no new polling. Require the exact latest run and `succeeded`/`failed`, not a stop/cancel state. |
| Close the owned disposable fixture | `cleanupCase` in the same module | Stops only its recorded runs, ends its machine, verifies the result, then deletes its recorded test issue. |

For an already retained, explicit fixture, the caller can compose the existing normal-session transport as follows. Supply IDs and credentials only through the authorized private process environment; never echo them. The caller must record deployment READY and verify that `MIKKA_EXPECTED_BUILD` is the approved served commit before executing this code.

```js
import { createSessionClient, smokeAcceptanceAccount, selectAcceptanceTeam,
  restoreAcceptanceWorkspace } from './scripts/acceptance/cloud-startup.mjs'
import { verifyExistingTaskTerminal, terminalAcceptanceFailure } from './scripts/acceptance/task-review-terminal.mjs'

const client = createSessionClient('https://app.aspectlylabs.com')
let ownerId, originalWorkspaceId, signedIn = false
try {
  const account = smokeAcceptanceAccount(process.env)
  await client.json('/api/auth/sign-in/email', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account),
  })
  signedIn = true
  ownerId = (await client.json('/api/auth/get-session')).user.id
  const scope = await selectAcceptanceTeam(client, { ownerId }, id => { originalWorkspaceId = id })
  const evidence = await verifyExistingTaskTerminal({ client, ownerId, workspaceId: scope.workspaceId,
    taskId: process.env.MIKKA_REVIEW_TASK_ID, runId: process.env.MIKKA_REVIEW_RUN_ID,
    expectedBuild: process.env.MIKKA_EXPECTED_BUILD })
  // Only this closed report is publishable; keep cookies and raw API/SSE data private.
  console.log(JSON.stringify(evidence))
  if (evidence.status !== 'passed_for_requested_scope') process.exitCode = 1
} catch (error) {
  console.error(JSON.stringify(terminalAcceptanceFailure(error))); process.exitCode = 1
} finally {
  try {
    if (ownerId && originalWorkspaceId) await restoreAcceptanceWorkspace(client, ownerId, originalWorkspaceId)
  } catch (error) {
    console.error(JSON.stringify(terminalAcceptanceFailure(error))); process.exitCode = 1
  }
  try { if (signedIn) await client.json('/api/auth/sign-out', { method: 'POST' }) }
  catch (error) { console.error(JSON.stringify(terminalAcceptanceFailure(error))); process.exitCode = 1 }
  finally { client.clear() }
}
```

Run a saved caller with Node 24 and `--import tsx`. An API error does not authorize switching identities, changing a model, refreshing a live runtime, or creating a replacement VM. Keep any failed fixture's exact task/run and closed failure metadata for root-cause analysis.

For a fresh official Native check, insert this helper **after the exact normal cloud run has actually completed and before `cleanupCase`**. The existing driver always calls `cleanupCase` in `finally`; a run ID recovered from an old completed acceptance report generally points to an ended VM or deleted task. Its normal cloud execution watch also does not always require terminal state. Do not report a historical native result as a current terminal positive, and do not replace actual completion with `stopRun` because stopped/cancelled runs must return 409.

Pass an already authorized teammate cookie client as `peerClient` to exercise GET and empty POST input returning `403 not_owner_terminal`. Pass a different already known workspace ID as `otherWorkspaceId` to exercise header-scoped `403 review_scope_denied` without changing the owner's selected workspace. Missing peer credentials remain an explicit untested item. A pure UI workspace switch is a separate lifecycle behavior; these negative requests alone do not establish revocation of an already opened stream.

For reclaimed evidence, end **only the acceptance driver's owned disposable machine** with its existing thread-machine action, confirm the result and readback, then call `verifyTerminalRefusal({ client, taskId, status: 409, codes: ['review_machine_gone'] })` before deleting the issue. A 404 after deleting the task is not reclaimed-sandbox evidence. For a pre-existing local fixture, expect `404 terminal_unsupported`; that proves the documented unsupported branch, not local-terminal functionality.

Do not use `pnpm test:local-loop` as a generic offline gate for this change. Its `scripts/dev-local/acceptance.mjs` setup still seeds and requires a real DeepSeek key, including the cloud item, and its normal scenarios call a real model. `scripts/ops/production-mobile-daemon.mjs` avoids model calls but enrolls and removes a new device, so it is not a read-only substitute. For isolated HTTP/daemon coverage, use the real-PG authority/session tests, actual root-Linux PTY/refresh suites, and an explicit normal-session API caller against the isolated deployment. Keep that result separate from production acceptance.

The driver-specific fail-closed/redaction tests run with:

```sh
node --import tsx --test scripts/acceptance/task-review-terminal.test.mjs
```

### Normal product Task driver

For a fresh product acceptance, use the exclusive manual `workspace-review`
mode documented in the [workflow reference](../../.github/workflows/README.md#product-terminal-and-preview-acceptance).
`scripts/acceptance/coding-workspace.mjs` uses the normal shared-account cookie
client and creates one small repository Task per original official subscription.
It pins the served application, published worker/template evidence, every actual
Run's model and shared subscription, and the retained producer's own machine.
The number of observed execute/review/legacy-verify attempts is bounded; this is
not a promise of exactly two model calls or a hard spending cap.

The candidate's producing Run must have succeeded. A Factory review/verify Run,
`repo:none` deliverable, stopped read-only startup run or adopted/ended machine
cannot substitute for it. Creation explicitly binds the Task to the selected
stored workspace; it does not change Team membership or promote an already
bound Task. The existing terminal suite still verifies actual shell output,
resize, Ctrl+C, deduplicated input, reconnect, preserved expiry and exit code 7.

A second owner PTY installs the checked-in locked framework fixture: Vite for
Claude, Next for Codex. All uploads and commands use normal terminal input.
Each PTY retains its five-minute absolute lease; an install or probe that exceeds
it fails. Preview checks cover no-server 404, owner 400 responses to an arbitrary
URL, duplicate ports and arbitrary run/sandbox fields, discovery, denied raw
ports, one-use bootstrap, the isolated cookie, assets and a live HMR update.
Only the preview cookie is sent to that isolated origin.

Before normal machine end, native Git/gh validates the exact newly created
repository/PR/author/branch/candidate SHA/Task marker and one committed fixture
file, then closes that PR and deletes that branch. It does not export a token,
write the default branch, merge or force-push. Preview HTTP and active WebSockets
must still work after this cleanup. Only then does the driver request machine
end, verify ended state with cleared provider references, observe old HTTP/WS
capability refusal and request terminal GET/input and preview 409 before deleting
the Task. A lease expiring during this check cannot count as end revocation.

An existing visible non-owner Task supplies GET/input and preview 403 checks;
a second existing workspace supplies scope-denied checks. If either fixture is
missing, the report is incomplete. The report separately retains local-machine
support and two simultaneous actors on the same Task as untested boundaries.
The failure checkpoint preserves uncertain writes and precise resource IDs.
Normal `cleanupCase` and the workflow's exact-journal recovery stop only those
owned fixtures; unresolved publication or cleanup prevents another case.

Local source tests validate driver guards and failure handling. They do not
establish that a production Task, subscription, terminal or preview passed.
Attach the immutable CI/deployment/release IDs and the actual sanitized receipt
to #1723 and #1724 after executing the authorized production run.

## Merge risk and recovery

**Merge risk: high while integrated CI, Native runtime and production checks remain pending.**

**Alignment: good.** The shipped task API and SSE contract are retained. Active-Agent handoff is explicit and local-machine support is documented as incomplete.

**Impact: large.** The patch touches owner authorization, persistent capability leases, cloud worker execution ownership, process control and sandbox lifecycle. Closed tenant/owner checks, bounded credentials, native-exit proof, the execution fence and revoke tombstones are required mitigations, not optional follow-ups.

**Verification: incomplete until the recorded integrated evidence is attached.** Real PTY and isolated PG checks are necessary in addition to the Node contract tests. Existing workers without the new installed control fence remain unsupported until an owner-authorized idle runtime refresh or new approved runtime image provides it.

Gateway versions are exact immutable source hashes. An already running gateway with another hash returns `404`; this batch does not automatically replace its process. Worker refresh alone does not replace a gateway retained in the VM's memory. Reusing that VM across a later gateway code upgrade requires an explicitly authorized, safely idle gateway replacement, preserving the worktree. Until that replacement exists, a version mismatch must remain unavailable rather than bypassing the version check.

**Rollback cost: medium.** Revert through a PR and preserve additive lease rows until cleanup. Rollback of an idle worker removes the control version marker and refuses terminal admission to a legacy worker. The refresh execution lock prevents a runtime switch while an Agent or terminal owns the checkout. Do not delete user worktrees or revive an old device token to recover availability.

**Error detection: decent.** The API reports closed registered codes; pending remote cleanup remains in durable reconciliation, and unsupported worker/gateway versions return `404`. Log only request/status/closed diagnostic metadata. Review deployment health and actual terminal requests after rollout; never include typed commands, stdout or capabilities in telemetry or GitHub evidence.
