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
| Exact-head CI | [PR #1610](https://github.com/alexj11324/Mikka/pull/1610): the initial head `faf51561db091550366dc61d8550ae6e98267a37` passed source checks and 11 independent workflows, but the main CI and Node 22 workflow failed. The follow-up corrects stale fixtures and the reported runtime regressions; the PR's current-head checks remain the release authority. |
| Cloud runtime unit fixtures | The initial CI exposed eight outdated SQL mocks; the updated task-lock and lifecycle receipts pass all 51 cloud-limits tests locally. |
| Claude missing-session fallback | Both Node 22 and the main daemon CI found premature gate revocation during ordinary fallback. A direct-adapter test reproduced it; the fixed resume and provider-failure files pass 21/21, including strict question-session refusal and actual child-exit confirmation. |
| Desktop continuation repository | The second CI passed DB shards 1/2/4 and daemon/Node 22, while three desktop-entry continuation cases exposed a dropped prior repository URL. The continuation now forwards the same admitted repository as the Coordinator/API paths; regression assertions require the original VM, device and repository. |
| Real E2B fault injection | Prepared `scripts/e2b/thread-lifecycle-acceptance.ts`; not yet run with the provider credential. |
| Claude subscription | Not run. Required model: `claude-haiku-5-5`. |
| Codex subscription | Not run. Required model: `gpt-6-luna`. |
| Production | Not deployed or accepted. Requires merged SHA, deployment READY, matching worker/template and the shared smoke account. |

The real-provider driver refuses deployed/remote database targets and a dirty
or mismatched source tree. Its nonallocating `--check` validates the target;
full execution uses one uniquely tagged disposable VM, verifies pause,
resume, timeout, stale epoch and kill behavior, and confirms cleanup. It
reports `subscriptionAcceptance: false` and makes no model calls.

The cloud Linux results above used a synchronized development worktree on
`d63b5e1b2e70baa368cf42ec6f9b13691571b6e0`; they are not exact-head release
evidence. The platform subsequently blocked the sandbox execution endpoint.
The final stop-order and lost-create PostgreSQL cases, and complete check
suite, therefore use the PR's Linux/PostgreSQL CI. The first CI run exposed
stale partial schemas and task-handoff fixtures, plus stopped-run admission
and daemon regressions. Each follow-up is verified on the new PR head; an
earlier successful job cannot stand in for that rerun. No blocked or unstarted
command is counted as passing.

### Remaining credential boundary

The connected deployment metadata is available, but the environment-list
connector truncates before the required E2B/smoke records. The supported
browser fallback reaches a Vercel sign-in wall. No new identity, production
environment mutation, private credential export or CI guard weakening has
been used to bypass that boundary. A supported authenticated session is
needed to complete the real-provider and shared-account acceptance.

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
