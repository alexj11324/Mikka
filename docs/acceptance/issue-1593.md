# Task VM lifecycle — issue #1593

This document records implementation evidence separately from real provider,
subscription and production acceptance. A green mock or database test does
not establish real E2B behavior. Issues #1593, #956 and #957 remain open until
the same-source production acceptance is complete.

## Scope and original evidence

- [#956](https://github.com/alexj11324/Mikka/issues/956): the original paused
  monitor returns `false`; `threadMachineAction('resume')` has no durable
  registration guarantee. This was a source finding, not a demonstrated
  production billing incident.
- [#957](https://github.com/alexj11324/Mikka/issues/957): the original monitor
  cap only calls the queued-only `pauseAtCap`, suppresses pause failures, and
  can miss a terminal transition on its last deadline wake. The issue's
  deterministic reproduction is the baseline evidence.
- [#1593](https://github.com/alexj11324/Mikka/issues/1593) owns the implementation
  and acceptance. No new polling loop, scheduler, paid model fallback or
  business review rule is introduced.

## Lifecycle contract

Each machine has a persisted deadline, operation metadata and epoch. The
existing deployment-owned run-recovery timer owns reconciliation. The
per-run Workflow may stop after handing off its final deadline; cancellation
or a missing Workflow response cannot remove the persisted owner.

| Boundary | Behavior |
| --- | --- |
| Dispatch / resume / adoption | Persist ownership before provider I/O and arm recovery; serialize simultaneous runs of one task. |
| Active execution | Static provider timeout renewal; no maintenance `connect`, no page/heartbeat-triggered wake. |
| Unclaimed compute | Pause at two minutes after bootstrap authority expires. |
| Native terminal completion | Finish publication/capture work and final checkpoint before the completion receipt. |
| Adjacent Factory stage | Keep the same compatible VM for at most 45 seconds; rotate epoch and revoke old tokens before transfer. |
| Immediate Owner continuation | Coordinator and desktop entry points retain the admitted repository. Reuse the same locked handoff before the pause timer runs, only after trusted native exit and with no active execution/bootstrap lease or pending lifecycle operation. |
| Monitor cap | Final state read and strict handoff at 12 hours; no swallowed pause/cap failure. |
| Execution budget | Twelve hours of compute per admitted run; stopped runs cannot self-renew. New admitted continuation runs have a new budget. |
| Stop without acknowledgement | Allow a 30-second finalization grace, then freeze and revoke; retain bytes and refuse automatic reuse without native-exit proof. |
| Closed task | Pause and retain for one hour; recheck task closure, epoch and exact final uploaded checkpoint before kill. |
| Open task after seven paused days | Keep the sole native/workspace state with `native_archive_unverified` unless a verified recovery archive exists. |
| Refused or lost provider response | Retain durable intent, reconcile static provider state and retry with bounded backoff. |
| Lost create response | Query exact workspace/run/operation metadata without connecting; commit recovered identity before pause/kill. Ambiguous or absent results cannot become a false cleanup receipt. |
| Pending kill | Keep the provider reference until confirmed killed/not found; the existing view shows reconciliation error rather than a false retired state. |

The 2-minute, 30-second, 45-second, 1-hour and 7-day values follow the issue's
default ranges. The provider retains its 15-minute timeout-to-pause fallback;
refreshes occur against concrete deadlines, using the existing timer.

### Retention limit

The repository's Git checkpoint does not archive all official Claude/Codex
native session files. No production snapshot-restore path currently proves
the original VM/SID question-continuation contract after destroying that VM.
Consequently, seven days alone does not authorize deleting an unfinished
task's only native state. This change deliberately reports the missing
archive proof and retains the paused VM. It does not claim to implement
archive → destroy → native-session restore.

## Verification ledger

All database runs use a disposable loopback PostgreSQL database ending in
`_e2e`, real migrations and the actual transaction/ownership code. Provider
spies in these tests are explicitly simulated. The cloud Linux sandbox uses
Node 24, pnpm 10.34.3 and PostgreSQL 17.

| Layer | Evidence / result |
| --- | --- |
| Baseline active-lease park | The original function calls pause while an execution lease is live; the new negative test rejects before provider I/O. |
| Baseline refused pause | The original function leaves no durable retry record; the new test requires committed intent/deadline. |
| Baseline Workflow cap | Deterministic tests fail on terminal-at-last-wake, active-at-cap and refused-pause behavior, then pass with final maintenance and durable handoff. |
| Baseline view truthfulness | Four new source tests fail when an ended row still owns a sandbox/bootstrap reference; the view now preserves reconciliation state. |
| Final checkpoint | Supervisor tests cover terminal paths, publication ordering, upload failure, stale heartbeat snapshots and unconfirmed native exit. |
| PostgreSQL ownership | The initial PR CI passed the task-machine ownership, stale epoch, stop/lost-create and archive-proof cases; its cloud-backend suite was 123/124 because a separate partial-schema fixture lacked `report`. New immediate-continuation/stop cases require the follow-up head's CI. |
| Workflow / policy | 63/63 deterministic clock/event/provider-boundary tests pass, covering bounded retries, retention, monitor ownership, stale observations, lost creation and no auto-wake. |
| Static policy / migrations | Full code lint and migration/factory checks pass; migration regression suite 55/55. UI policy and copy checks pass. |
| Daemon socket integration | Six relevant files, 109/109 passing in cloud Linux. The 46 subscription-resume fixtures require the existing non-root host guard; they use local fake CLI fixtures, not real subscriptions. |
| API / CLI | 78/78 API contract tests pass after regenerating the standard route manifest; actual local `/mikka/api/version` and `/mikka/sign-in` return HTTP 200, migrations and daemon CLI `--help` exit 0. |
| Exact-head CI | [PR #1610](https://github.com/alexj11324/Mikka/pull/1610) passed its exact-head checks and merged as `4f0f68e971b2676a156a3cedd7bc97413afb2310`. [PR #1628](https://github.com/alexj11324/Mikka/pull/1628) passed all eight exact-head workflows and merged as `f811448d805e7baa7b032fd6ae62d991f59966c8`; its [main CI](https://github.com/alexj11324/Mikka/actions/runs/42356253038) passed all 12 jobs. A later correction requires its own exact-head checks. |
| Cloud runtime unit fixtures | The initial CI exposed eight outdated SQL mocks; the updated task-lock and lifecycle receipts pass all 51 cloud-limits tests locally. |
| Claude missing-session fallback | Both Node 22 and the main daemon CI found premature gate revocation during ordinary fallback. A direct-adapter test reproduced it; the fixed resume and provider-failure files pass 21/21, including strict question-session refusal and actual child-exit confirmation. |
| Desktop continuation repository | The second CI passed DB shards 1/2/4 and daemon/Node 22, while three desktop-entry continuation cases exposed a dropped prior repository URL. The continuation now forwards the same admitted repository as the Coordinator/API paths; regression assertions require the original VM, device and repository. |
| Real E2B fault injection | On `f811448d`, [run 42360728689](https://github.com/alexj11324/Mikka/actions/runs/42360728689) passed all seven original provider/controller cases against isolated PostgreSQL and a real VM; cleanup confirmed the VM missing and database dropped. Refusal/lost-response faults were injected; a real SDK request deadline was not exercised. |
| Claude subscription | The `f811448d` candidate gate passed official Claude Code 2.1.305 / `claude-haiku-5-5`, including the native acknowledgement, a successful tool and reply after it. The separate Owner Task case stopped at preallocation HTTP 404. |
| Codex subscription | The same `f811448d` gate passed official Codex 0.166.0 / `gpt-6-luna` with the required execution proofs. The separate Owner Task case stopped at the same preallocation HTTP 404. |
| Production | [Web run 42356253062](https://github.com/alexj11324/Mikka/actions/runs/42356253062) and [runtime release 42356253078](https://github.com/alexj11324/Mikka/actions/runs/42356253078) succeeded. Runtime-refresh deployment `dpl_EKh8ATho1pPt7BaCeZzCnwhUqie8` is READY; at 09:41:01 UTC on 2026-11-07 the public version returned exact `f811448d805e7baa7b032fd6ae62d991f59966c8`. Complete lifecycle acceptance remains pending. |

The real-provider driver refuses deployed/remote database targets and a dirty
or mismatched source tree. Its nonallocating `--check` validates the target;
full execution uses one uniquely tagged disposable VM, verifies pause,
resume, static timeout renewal, stale epoch and kill behavior, and confirms
cleanup. Provider-refusal and lost-response cases inject transport faults
around real RPCs. The follow-up request-deadline case uses the actual SDK's
one-millisecond request deadline with no automatic retries, requires the
original native `TimeoutError`, and verifies durable backoff, no provider I/O
on an early replay, and normal same-VM renewal recovery. A request that beats
its deadline is inconclusive and cannot produce a passing receipt. This driver
does not wait for natural timeout expiry, run a
daemon, or execute a native subscription session; its report marks those
boundaries and makes no model calls.

The cloud Linux results above used a synchronized development worktree on
`d63b5e1b2e70baa368cf42ec6f9b13691571b6e0`; they are not exact-head release
evidence. The platform subsequently blocked the sandbox execution endpoint.
The final stop-order and lost-create PostgreSQL cases, and complete check
suite, therefore use the PR's Linux/PostgreSQL CI. The first CI run exposed
stale partial schemas and task-handoff fixtures, plus stopped-run admission
and daemon regressions. Each follow-up is verified on the new PR head; an
earlier successful job cannot stand in for that rerun. No blocked or unstarted
command is counted as passing.

### First production runtime release

[Release 42350707966](https://github.com/alexj11324/Mikka/actions/runs/42350707966)
validated the candidates' original files but failed the paired subscription
gate: Claude passed, Codex had no accepted execution receipt. Publication was
skipped. Cleanup confirmed all three candidate templates and the test
instances were removed, with no cleanup errors. This passing Claude receipt
does not make the deleted candidate publishable or prove Task VM continuity.

The failed diagnostic collapsed the startup failure into `startup_failed` and
did not retain a bound run. The follow-up preserves the actual startup phase,
closed error code and bounded HTTP status without publishing response bodies.
In the same deployment's acceptance window, a subscription Coordinator
`gpt-6-luna` call (`wrun_41M6TFAQKD0GV75GBGP21WNDMG`) was rejected before any
token or tool: the worker recorded HTTP 400 / `invalid_request_error`. This is
not evidence of quota exhaustion or a Codex CLI failure. The old artifact does
not directly bind that workflow to its failed candidate sample, so that final
correlation remains unproved. A separate 300-second stream timeout in the
window is not assigned to this call merely from timestamp proximity.

### Runtime publication and the first Owner attempt

On 2026-11-07, `f811448d805e7baa7b032fd6ae62d991f59966c8` completed
[release 42356253078, attempt 1](https://github.com/alexj11324/Mikka/actions/runs/42356253078).
Both accepted subscription receipts bind worker
`18d86efa6f4ed740bbc86f02db2f77eecc16cff6`, the exact source and candidate:

| Path | Template | Actual run |
| --- | --- | --- |
| Claude Code / `claude-haiku-5-5` | `g4eg9fzgm51gtgnuzvax` | `bec62916-7bb6-4a07-80d0-49f3c3347482` |
| Codex / `gpt-6-luna` | `bihq9h4vj8gehz7pfu9k` | `a9853441-177f-4d3f-b4da-a078a159f875` |

Release evidence artifact `13569215487` was independently downloaded and
verified against SHA-256
`bd3e6d73ba17de06da4ea9f50fe27a0d2d4f23fb8a76dead7e5514ee577ae7a4`.
Final cleanup artifact `13570185225` has SHA-256
`e1c3d98fb9bc1ff525cd65aa7cbe7a9e3b72e49fe5bf118c9db42ead988410d4`:
no remaining test sandboxes or cleanup errors; the three published templates
are retained for production and rollback. The current Codex receipt does not
identify which parameter caused the older 4f HTTP 400.

[Task evidence run 42360728689, attempt 1](https://github.com/alexj11324/Mikka/actions/runs/42360728689)
then authenticated the same release and Web source. At 09:42:02–09:42:12 UTC,
its provider layer passed `active-monitor`, `provider-refusal`,
`lost-pause-response`, `resume-monitor`, `stale-epoch`, `stop-idempotence` and
`end-idempotence`. The isolated fixture run was
`6eadc09c-37e4-46b0-9c39-51dcc197a6d5`, with official `codex` VM
`ipktoromeirrmaexw85e0`. Its receipt confirms `provider: confirmed_missing`
and `database: dropped`; it makes no daemon or subscription claim.

The normal Owner driver ran from 09:42:17.417 to 09:42:27.585 UTC and stopped
before allocating either Task. Both cases reported `startup_http_404`, with
successful account/workspace cleanup. The strict aggregate correctly failed.
Artifact `13569761286` was verified against SHA-256
`2189e85f9fb89409ebf0699500f4b8f6678cee8a77017e3f46e95d1c9a23cec4`.

The cause is a caller contract error: `workspace-secrets.getE2BKey` is an
exported server action but is absent from the browser RPC registry/schema.
The registered read-only capability action is
`workspace-secrets.getE2BKeyCapability`. Unknown RPC actions return 404 before
the key-status function runs, so this result says nothing about whether the
Owner has configured a personal E2B key. The correction calls the existing
capability action and verifies every literal Owner RPC against the real
registry and schemas; the new contract regression failed on the old caller.
Closed failure phases preserve where a preallocation or setup failure occurred
without exporting HTTP bodies or credential data.

### Second Owner attempt: real provider pass and shared-subscription refusal

[PR #1631](https://github.com/alexj11324/Mikka/pull/1631) passed all six
exact-head workflows and merged as
`e4494a3c8620d0ac8fe4cd885144a3f47be0252c`. Its
[main CI 42363131769](https://github.com/alexj11324/Mikka/actions/runs/42363131769)
passed all 12 jobs. [Web run 42363131663](https://github.com/alexj11324/Mikka/actions/runs/42363131663)
succeeded; deployment `dpl_2HY7JTyRWZrJ4TKudYa85xb1D6Bq` was READY and the
public version returned exact `e4494a3c` at 10:37:44 UTC on 2026-11-07.
The successful E2B release check `42363131705 / 1` found the worker unchanged
at `18d86efa6f4ed740bbc86f02db2f77eecc16cff6`; it reused the published runtime.
It did not build candidates or run new candidate subscription cases.

[Task evidence run 42363177678 / 1](https://github.com/alexj11324/Mikka/actions/runs/42363177678)
then bound the exact main, upstream attempt and public Web build. Artifact
`13570494196` contains all four reports; two independent downloads verified
the 4,563-byte ZIP against SHA-256
`e576acab17ba836b814bf56b4066b630d56fc6a413fd30497b4d2007b1de376b`.

At 10:37:46–10:37:58 UTC, the real-provider layer passed all eight ordered
cases, including `provider-request-deadline`. Its fixture run was
`043f4bd9-22e7-4bb7-830c-168b6abbf121`, VM `isdtm9nsqr5dtpiesklj7`, on the
official `codex` template. The deadline receipt records one `setTimeout`
request with `requestTimeoutMs: 1`, `retries: 0`, the native `TimeoutError`,
`earlyReplayIo: 0` and `recovered: true`. Cleanup confirmed the VM missing
and the isolated database dropped. This proves SDK deadline-to-controller
recovery, not natural timeout expiry or native subscription execution.

The Owner driver ran from 10:38:02.127 to 10:42:35.923 UTC. Its normal
capability read confirmed `configured: true` and `byoEnabled: true`; both
cases proved the intended fixed model and shared subscription binding.
Each created a real Task VM, but neither reached a native question:

| Path | Origin run | VM | Origin `finishedAt` UTC |
| --- | --- | --- | --- |
| Claude Code / `claude-haiku-5-5` | `6d125edd-5129-47e2-8034-2b316d99df68` | `ia39xpkfn9u93ach3zfxz` | 10:40:20.363 |
| Codex / `gpt-6-luna` | `80ea7d0a-1b94-4bb5-8082-846c704abe40` | `ip13i0ea3cg416s11egxp` | 10:42:27.560 |

Both reports stopped at `waiting_for_native_question` with
`lifecycle_unexpected_factory_attempt`. Read-only production queries, scoped
to those exact runs and their reported retries, found `stopReason: device_lost`,
no native session or worktree, and zero `run_chunks`. The two follow-ups have
`retryOf` pointing to their origins and `attempt: 2`; cleanup stopped them
before they started. Thus the driver error identifies the unexpected retry,
not the reason the original claim failed.

The initial leases expired without renewal. Server claim timing reached
`response_fence` in 5.147 and 5.316 seconds, so a 90-second credential-preparation
wait is not the explanation. The exact production bindings show the desktop
owner equals the run requester, while the shared subscription owner differs.
Both runs use the desktop template, have no repository remote, and have no
read-only mode or policy ceiling; the workspace computer permission is `allow`.
The response therefore carries a computer grant for the requester. The daemon's
old `credentialOwner()` instead returns the subscription payer and rejects this
grant before `supervisor.start()`. No journal/active entry is created, so the
daemon reports no run to renew; the existing recovery timer eventually records
`device_lost` and creates a retry. A regression through the real
`claimAndStart()` reproduces this pre-start rejection. The worker's later log
stream was not retained, so no exact worker exception line is claimed as a
production observation.

Independent review found the same payer/computer-owner comparison again in
`createHostedBotRunner()`, after credential preparation and before the local
computer grant and CLI spawn. Fixing only the daemon precheck would therefore
leave both shared-subscription desktop paths blocked. The native session
ledger and resume checks correctly bind to the subscription payer; those
checks must stay intact.

The same-source lifecycle evidence still establishes automatic failed-run
parking and final cleanup. Matching run/VM hashes and epoch 2 bind the events:

| Observation, UTC | Claude | Codex |
| --- | --- | --- |
| Run token revoked | 10:40:20.817 | 10:42:28.140 |
| `pause_requested` | 10:40:21.711 | 10:42:29.100 |
| Device token revoked | 10:40:21.718 | 10:42:29.107 |
| First provider `pause_ack` after commit | 10:40:22.020 | 10:42:29.453 |
| Reconcile `run_ended / pause_ack` | 10:40:22.051 | 10:42:29.486 |
| Explicit cleanup `kill_ack` | 10:40:24.910 | 10:42:32.500 |
| Independent provider missing confirmation | 10:40:26.711 | 10:42:34.276 |

Each origin had exactly one issued device token and one issued run token;
the scoped read-only queries found both revoked, with no unrevoked/unexpired
run tokens. The unstarted retries had no issued run tokens. These are database
revocation observations, not attempts to authenticate with the old secrets.
The `finishedAt` to first `pause_ack` confirmation bounds are **1.657 seconds**
and **1.893 seconds**. They include scheduling, provider response, database and
logging time; they do not identify E2B's exact internal transition instant.
The later explicit cleanup kills are not automatic idle-retirement timings.
The 121/113 compute-second values are cumulative database estimates, not idle
compute, provider bills or a measured before/after saving.

All three test VMs were independently confirmed missing. Owner cleanup also
restored the workspace and archived the created Profiles; task history remains.
The strict aggregate correctly failed with `providerIntegration: passed`,
`questionResume: incomplete` and `issueAcceptance: incomplete`. It cleared
only `provider_timeout_fault_injection`. Neither a native model execution nor
an original-session question continuation is claimed for these two failed runs.

The correction binds the server-issued computer grant to the requested run
and current device. An existing signed policy envelope additionally binds its
run, device and execution owner; the existing independent signature, issuer
and freshness verifier still runs before repository or adapter effects.
Older authenticated claims without an envelope keep their existing contract.
The broker reuses the same binding check for permission, desktop actions and
capture, with the existing active lease, shutdown, registration and display
fences. Hosted startup requires that broker and its policy-scoped grant,
without mistaking the subscription payer for the Task's computer owner. It
does not change credential routing, native-ledger scope, resume identity,
protocol fields or the no-per-tool-remote-check contract. This runtime change
requires new candidate conservation and both official subscription gates;
the earlier unchanged-worker proof cannot stand in for those gates.

### Checkpoint confirmation and automatic retirement

The item 7 audit found a separate concrete contract mismatch. The daemon
created `checkpoint.takenAt` from its device clock, while the authenticated
upload route persisted `clock_timestamp()` and returned only HTTP 204. The
terminal report retained the device timestamp. Both the lifecycle decision
and the final locked retirement guard correctly require the report to match
the uploaded row, so ordinary successful uploads could not establish that
proof. Existing daemon fixtures kept the supplied time; existing database
retirement fixtures supplied equal times manually. Neither exercised the
actual upload-to-retirement boundary.

The upload now returns a strict optional `{ runId, takenAt }` receipt from
the same admitted database write. New workers bind final checkpoint evidence
to that server timestamp; a confirmed native exit precedes the final upload,
so its safe-point observation uses the same acknowledged time. Old workers
ignore the new successful JSON body. A new worker receiving an old HTTP 204
retains the workspace but cannot certify an archive for automatic retirement.
The server upload clock, final-write ordering, exact checkpoint match, task
closure, epoch and ownership guards stay authoritative. No tolerance window,
data migration or client-supplied retirement timestamp is introduced.

The legacy empty-acknowledgement case failed against the old supervisor and
passed after the change. The two complete terminal-checkpoint/HTTP test files
pass 52/52 locally; protocol tests pass 24/24. The new PostgreSQL cases consume
the real POST receipt, persist completion, park and run the actual controller
and end guard. They require a current receipt to permit retirement, reject a
replaced receipt or no receipt, and preserve the uploaded bytes and history.
These database cases require the follow-up head's CI; they were not executed
against a local database in this interactive environment.

The guarded provider driver also strengthens `end-idempotence`. Its same
single disposable VM contains a known Git base and a real changed file. The
file must survive actual pause/resume, and its actual Git diff goes through
the authenticated checkpoint handler in the isolated database. The runner
reconstructs the base and recovers the saved bytes independently before and
after the VM is killed. Only fixture `pausedAt` deadlines advance: an open
task after seven days, a closed task inside its one-hour grace, and a closed
task without final archive proof must all retain the VM. A valid receipt then
allows the real controller to call fenced automatic end; repeated end must
not kill twice, and task/run/checkpoint history must remain unchanged.
The result carries a closed `retirement` receipt, and aggregation rejects
missing restore, retention-refusal, token-revocation, kill or history evidence.
The one-hour and seven-day clocks start at `lifecycle.pausedAt`, not at the
time the Task is closed. This is a controlled clock/provider test with no
native session; it does not claim a natural seven-day wait or replace Owner
subscription acceptance. Its real-provider result is still pending execution
on the follow-up merge source.

Item 6 gains a separate controlled PostgreSQL case for external PR waiting:
the actual lifecycle/park path pauses a terminal producer while Factory waits
for approval; the normal publication and merged-event writers complete the
Task and deliver committed live invalidations without starting compute.
Duplicate events cannot create another run or provider action. Provider and
live transports are explicit fixtures. Existing signed-webhook admission and
the full adjacent-stage Factory dispatch/handoff tests provide the other
controlled boundaries. The new joint database case also awaits exact-head CI.

### Main-only acceptance delivery

The interactive environment could not obtain E2B/shared-account credentials,
and the Vercel sign-in was cancelled. The follow-up uses the existing main
runner's Infisical workload identity; it needs no new identity, interactive
login, private credential export or production configuration change.

`Task VM question-resume evidence` runs after `E2B additive runtime
release` completes successfully. Its first job has no OIDC permission. Before
checkout it verifies the actual fixed workflow path/ID, repository, original
`push` or `workflow_dispatch` event, main branch, immutable source and current
run attempt through GitHub metadata. It checks out that exact SHA and selects
only lifecycle/acceptance changes in the main merge's first-parent diff, or
a release whose `validate / build` job actually succeeded. Unrelated merges
with unchanged runtime skip active acceptance.

Inside the shared smoke-account serial queue, the second job repeats the
main/attempt checks and uses the existing Web-deploy verifier to prove the
exact successful build, upload and public source version before credentials.
It reads only `prod:/vercel` `E2B_API_KEY` and, after provider cleanup,
`prod:/` `SMOKE_OWNER_EMAIL` / `SMOKE_OWNER_PASSWORD`. It does not read upstream
artifacts, accept a PR ref or allow an application-origin override.

The two evidence layers run in order:

1. `scripts/e2b/thread-lifecycle-acceptance.ts` runs against a disposable
   loopback PostgreSQL 17 `*_e2e` database and one uniquely owned official
   `codex` VM. Its result is actual provider/controller integration with
   injected transport faults, within the narrower scope above. A case failure
   can proceed to the independent subscription cases only when the driver's
   cleanup has completed. Missing or failed cleanup blocks new allocations.
2. `scripts/acceptance/thread-lifecycle.mjs` uses the normal shared Owner
   session at `https://app.aspectlylabs.com`, in the shared team workspace.
   It runs the official Claude Code `claude-haiku-5-5` and official Codex
   `gpt-6-luna` cases independently, checking question/answer continuation and
   the same VM/native-session evidence. Cleanup uses normal Owner Stop/end
   APIs for this run's cases, including when the source changes during a case.

Closed JSON evidence is written only under
`$RUNNER_TEMP/thread-lifecycle-acceptance/` and retained as the workflow's
seven-day evidence artifact. The provider and Owner reports remain separate;
the aggregate's `providerIntegration` and `questionResume` pass only when the
provider step and both fixed-model question/resume cases have their required
evidence and confirmed cleanup on the same source. Missing provider identity,
credentials, pause evidence or cleanup remains a nonzero failure; it is never
an excluded requirement. No raw SDK/model/HTTP logs, credential values or
session cookies are included. Offline guard tests run in the ordinary PR CI;
those tests establish the wiring's refusal behavior, not live acceptance.

A green evidence run covers this limited question → pause → original VM/SID
resume → native report/marker flow. Every summary still records
`issueAcceptance: incomplete`. The remaining issue criteria require separate
evidence for external waiting and adjacent-stage continuity (item 6), terminal
revocation, closed-task grace and safe retention (item 7), and measured
pause/retirement latency and idle compute cost (section C). The aggregate only
clears the real-provider timeout fault pending item when the same-source
provider step, all eight ordered cases, actual SDK deadline/recovery receipt
and cleanup succeed. The older seven-case report cannot clear that item.
The separate Owner report makes no provider-fault claim. The reports' `pending`
fields identify the original gaps this narrower flow does not establish.

The native report and its trusted uploaded checkpoint can establish the
delivery boundary in item 5. This driver stops at its second real Owner decision
because the normal task API cannot fix future independent coding stages to the
authorized small models. Final Factory submission, completion of every later
stage, a downloaded Markdown file and waiting for natural timeout expiry are
outside this driver's scope. They are not additional issue closure requirements.
The new Bot uses the existing shared small-model preference for ordinary
Coordinator turns. Coding evidence comes from the Task producer and
continuation, with explicit fixed Profiles and real subscription receipts.
An actual coding-model substitution invalidates that case; ordinary background
turns retain the existing Coordinator protocol.

## Results that must still be measured

Record real run/VM IDs, UTC transition times, provider state, native SID
continuity, token revocation and final cleanup for each official subscription.
Measure terminal-to-provider-pause latency and idle compute seconds on the
same source. No production cost savings or latency numbers are claimed by
the deterministic tests.

The Owner driver now preserves `terminal.origin` and `terminal.continuation`
from the exact `runId` in the already-read normal Owner thread's attempts.
Each record includes the actual `finishedAt` when present; a missing or invalid
timestamp remains null and does not add a new question/resume gate. A chain's
latest completion time is never substituted for another attempt's completion.
Provider observations retain `requestedAt` separately and take `observedAt`
after the response or error arrives. That response time is a confirmation
bound, not the provider's exact physical transition instant.

Combine a valid attempt completion time with the matching server
`thread_machine_lifecycle` `pause_ack` / `kill_ack`, run/VM hash and epoch when
measuring confirmation latency. The report's Factory task hash differs from
the server event's issue hash. A cumulative `computeSeconds` estimate includes
productive work; it is not automatically idle compute or an actual bill.
The first `f811448d` Owner attempt allocated no Task, so it provides no native
terminal-to-pause timing or production cost comparison.

## Review and rollback

The migration is additive. Old rows become due for reconciliation; historical
ended rows with no provider or bootstrap reference remain inactive. Rollback
can leave the additive columns in place. Existing task data, artifacts and
native sessions are retained. Any provider kill is irreversible and is gated
by the explicit end path or closed-task archive proof.

Two existing Chinese error strings used wording rejected by the repository's
copy check on the starting `main`. Their minimal wording correction removes
that unrelated baseline gate failure; it changes no runtime behavior.

Do not close the linked issues or treat this ledger as production acceptance
until the missing provider, subscription, deployment and cleanup evidence is
attached.
