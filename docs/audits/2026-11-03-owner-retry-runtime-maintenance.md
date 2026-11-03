# Owner Retry prepares the retained runtime before recovery

Refs #1166 and #1132. This follow-up starts from `6b5a2e8eb6c5d45f6aa49f4fb9f69a22b51d52d3`, which already contains #1167. It does not repeat the prior native broker and recovery patches.

## Confirmed source-level blocker

The latest failed strict continuation retains the original task VM, while its question and task are blocked. The existing owner Retry recovered and queued the next continuation before waking that VM. An older retained worker could therefore fail the version check after custody had already transferred.

The existing `refresh_runtime` path also reused guards intended for an active continuation: it required a resuming question, could return early for an already-running VM, and rejected the terminal run at the later provisioning check. A separately callable maintenance endpoint was therefore insufficient to make the normal Retry work.

## Product behavior

- Owner Retry and the owner recovery API use the same recovery service. A first short transaction authenticates the current owner/session, checks the stable receipt, and validates the current blocked question/task, latest failed run, immutable answer, original session, exact VM custody and live subscription binding.
- An existing receipt reuses its continuation and wake without maintaining the old run's already-transferred custody. A new recovery releases database locks before host-authorized runtime maintenance. A second short transaction repeats the full admission before dispatch and receipt creation.
- The original queue admission SQL is shared by preparation and dispatch. A retained machine in `error` may enter blocked recovery maintenance; dispatch still requires a running or paused machine. There is no replacement VM, generic retry, model reselection or API-key fallback.
- Terminal maintenance retains the original sandbox, device, repository, session, answer, task/attempt history and recovery receipts. Active work and foreign/changed custody are refused. Failed maintenance records its diagnostics on the machine, never overwriting the historical failed run's error.
- Runtime operations share a 240-second refresh budget and a separate bounded 30-second rollback budget. SDK requests and foreground commands are bounded; the foreground runtime switch uses a local lock and remote process timeout. The owner recovery route and workspace page allow 300 seconds. A timeout is not treated as proof that a remote command completed or stopped.

Official E2B templates and their CLI packages are unchanged. This change is confined to application-side maintenance/orchestration and tests. The reviewed worker digest remains `9d9799cd6edac2d8920b4b47cb6bef73736d5742`; the modified paths do not enter the worker source/recipe hash. The protected Acme VM is outside this change and acceptance scope.

## Verification and remaining acceptance

Local route/action/question tests passed: **32 tests, zero skipped**. Type checking, strict lint on the changed files and diff checks passed. The final independent source review reported no blocking issue.

New PostgreSQL regressions cover lock release before provider I/O, receipt replay after custody transfer, failure without answer/task/history changes, subscription/question/custody changes between transactions, retained-error retry, original VM maintenance, timeout rollback and historical-run immutability. **These database regressions have not run locally:** this environment has no disposable PostgreSQL service. The existing required CI must execute them against real PG17 before merge.

This is not production acceptance. A fresh normal-owner Retry still needs to prove original-VM runtime readiness, same native session execution, independent review and verification, physical artifact/repository evidence and owner UI acceptance. Separate API-key, Codex-subscription and Claude-Code-subscription production cases, both wrong-repository cases, and the original offline-WIP obligation remain tracked by their issues. Neither #1166 nor #1132 is closed by this change.
