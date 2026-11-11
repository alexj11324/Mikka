# ALE-88: live notifications retain a Workspace transaction

The Factory admission suite can pass while a live notification fails in a
transaction borrowed from its writer. APP commit observers start notifications
before the outer Workspace transaction necessarily finishes. A send can open a
nested Workspace savepoint, outlive the writer and then release that savepoint
after COMMIT. The failure can also interfere with the writer's later statements.

## Evidence

Cloud Linux, Node 24.19.0, isolated Docker PostgreSQL 17 on loopback port 55432.
No production database or external model request was used.

- Current baseline: `43838a6efd6b66472b0c1f221829125bfb31fe34`.
- Historical control: `d2ec50dc4`, before the eve merge.
- The exact admission suite passed 22/22 three times on each revision using the
  current disposable schema. This is a code comparison, not historical schema proof.
- A separate database bootstrapped from d2ec50dc4's own migrations also passed
  22/22. PostgreSQL diagnostics still captured `25P01` for `release savepoint sp2`
  followed by `rollback to savepoint sp2`. The problem predates eve.
- Temporary instrumentation traced the failed savepoint to
  `enterprise/live-authority.ts` through `live/factory.ts` and `scheduleLive`.
  It recorded operation names, error codes and stacks, without query parameters.
- A deterministic regression keeps the notification's transaction open until
  the writer has committed. Before the fix it borrows the writer's transaction
  identity and fails; after the fix it completes on an independent transaction.

The originally reported `25P02`/`release savepoint sp1` failure itself did not
recur in these runs. This change fixes the independently reproduced transaction
lifetime defect; it does not claim that every possible admission failure is gone.

## Change and validation

`scheduleLive` exits both APP client and Workspace transaction contexts before
running deferred work. It retains request database routing and device authority.
Enterprise membership and capability checks still acquire their ordinary locks.
No task, model, credential or tenant authorization is broadened.

The regression, Factory admission and Enterprise live authority suites passed
31/31. Three additional admission runs passed 22/22 each with no PostgreSQL query
error captured by the same diagnostic hook. The DB runner inventory passed 25/25.
Targeted lint passed. Full typechecking is recorded separately in the PR.

Revert the code change to roll back; no schema or persisted data changes exist.
