# Cloud question continuation: configuration identity and execution placement

A normal owner answer to an official-subscription Codex question returned HTTP
409 in production. The question remained open and the transaction created no
continuation. Before answering, the original VM had successfully refreshed its
private Mikka runtime; direct before/after observations proved the original SID,
SDK history digest, worktree, committed 85-byte artifact and Git snapshot were
preserved. Runtime refresh success therefore did not prove question recovery.

Occurrence is 10/10 for the demonstrated parent-registered Agent / task-device
topology; impact is 8/10 because a legitimate original-session answer cannot
continue the task.

## The two identities

The coding Agent process runs on the thread's own E2B machine. The Bot only
dispatches; its computer does not execute that thread. `agent_runs.deviceId`
and the exact owner-bound `computer_run_bindings` / `thread_machines` establish
the actual execution placement.

The `agents` row also holds the stable configuration and subscription consumer.
Cloud provisioning already relocates the run and repository without replacing
that consumer. `claimCloudRun` separately checks task-machine placement and
subscription consumer, and existing database tests reject the Bot machine,
another child machine, another owner and another workspace. Bot-runtime rebuild
can change the configuration's registered device while preserving its Agent ID.

The old skill/question guards instead required the configuration's registered
device to equal the run's actual device. This local-device assumption rejected
the valid cloud placement. Creating another consumer would change frozen
subscription scope and require a new identity-transfer mechanism for the old
native SID. This patch preserves the existing identities and corrects that
assumption; the glossary's technical note now distinguishes them explicitly.

## Recovery boundary

- Keep the local same-device checks and the legitimate pre-placement queue
  path. For a relocated cloud run, prove the exact owner, workspace, Bot, issue,
  device, repository and frozen harness through its existing bindings. A
  historical ended origin can prove provenance; it cannot authorize execution.
- Queue the answered cloud question in the existing Factory transaction on the
  original device and repository. Preserve the frozen definition, subscription
  consumer, model, branch and required native SID. Transfer custody of the same
  sandbox; retain the origin's historical scope.
- Retain existing publication scope. Do not copy a run-scoped desktop approval
  to the new run. An answer grants no new credential, tool or computer authority.
- After commit, use the existing durable Factory handoff. A paused original VM
  can resume; a missing original VM cannot be replaced with a fresh one. A live
  claimed worker is observed without restarting it or rotating its token.
  Unavailable wake attempts throw from the existing durable step for retry and
  preserve the original VM and queued continuation.
- Acquire run locks before placement locks. Provider I/O happens after the
  lease transaction, with lease-specific cleanup on failure.

This change adds no queue, worker, table, consumer-migration protocol or official
template/CLI-package mutation. The cloud queue correction is scoped to the
original official-subscription credential; it introduces no API-key fallback.

## Verification scope

Real isolated PostgreSQL regressions cover relocated configuration identity,
cross-scope rejection, unchanged original subscription/SID, same-machine
question replay, post-commit durable handoff and exact paused-machine recovery.
Red/green checks reproduce the old local-only dispatch and missing exact-machine
guards. Physical production observations before this patch are retained as
failed recovery evidence, not relabeled as passing tests of the new code.

The integrated loopback PostgreSQL 17 run passed 88/88 tests with no skips,
including a real skill-guard → cloud-answer → same-machine transfer → required
original-SID claim. Types, strict lint, migration checks and the existing Factory
source checks passed. Provider responses in the database tests are synthetic;
these tests make no paid model call and do not replace production acceptance.

Production question resume, independent review/verify and actual owner UI
acceptance must still pass after this server correction is released. The
separate wrong-repository selection/clone scenarios also remain pending.
