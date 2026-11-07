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
| Exact-head CI | [PR #1610](https://github.com/alexj11324/Mikka/pull/1610): the final head `fc17849c742563e3a9bc5ae54719563face90def` passed its checks, including the corrected DB/daemon/Node 22 regressions and GitGuardian. It merged as `4f0f68e971b2676a156a3cedd7bc97413afb2310`. The acceptance wiring follow-up needs its own current-head CI and real main-run evidence. |
| Cloud runtime unit fixtures | The initial CI exposed eight outdated SQL mocks; the updated task-lock and lifecycle receipts pass all 51 cloud-limits tests locally. |
| Claude missing-session fallback | Both Node 22 and the main daemon CI found premature gate revocation during ordinary fallback. A direct-adapter test reproduced it; the fixed resume and provider-failure files pass 21/21, including strict question-session refusal and actual child-exit confirmation. |
| Desktop continuation repository | The second CI passed DB shards 1/2/4 and daemon/Node 22, while three desktop-entry continuation cases exposed a dropped prior repository URL. The continuation now forwards the same admitted repository as the Coordinator/API paths; regression assertions require the original VM, device and repository. |
| Real E2B fault injection | Prepared `scripts/e2b/thread-lifecycle-acceptance.ts`; not yet run with the provider credential. |
| Claude subscription | The `4f0f68e9` candidate gate passed actual official Claude Code 2.1.305 / `claude-haiku-5-5`, including tool execution and the reply after it. The separate Task VM question/resume case has not run. |
| Codex subscription | The same release registered official Codex 0.166.0, but obtained no accepted execution receipt. The Task VM question/resume case has not run. Required model remains `gpt-6-luna`. |
| Production | [Web deployment run 42350707891](https://github.com/alexj11324/Mikka/actions/runs/42350707891) succeeded; deployment `dpl_DBRS1JzUmTdu7yuzq7pRBXZocCF6` is READY and the public version returned `4f0f68e971b2676a156a3cedd7bc97413afb2310`. [Main CI 42350707914](https://github.com/alexj11324/Mikka/actions/runs/42350707914) passed. Complete lifecycle acceptance remains pending. |

The real-provider driver refuses deployed/remote database targets and a dirty
or mismatched source tree. Its nonallocating `--check` validates the target;
full execution uses one uniquely tagged disposable VM, verifies pause,
resume, static timeout renewal, stale epoch and kill behavior, and confirms
cleanup. Provider-refusal and lost-response cases inject transport faults
around real RPCs. This driver does not wait for natural timeout expiry, run a
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
revocation, closed-task grace and safe retention (item 7), real-provider timeout
fault injection (item 8), and measured pause/retirement latency and idle compute
cost (section C). The reports' `pending` fields identify those original gaps;
this narrower flow does not establish them.

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
