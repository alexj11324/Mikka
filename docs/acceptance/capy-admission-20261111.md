# ALE-88: independent jobs must own their database transactions

APP commit observers can start background work before the writer's outer
Workspace transaction finishes. The job can borrow that transaction, open its
own savepoint, and then lose it when the writer releases an enclosing savepoint
or commits. The subsequent release fails before the visible aborted-transaction
error. Independent work now retains routing and identity while acquiring its
own Workspace transaction and resource lease.

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

The original direct admission runs did not reproduce `25P02`. A later real CI
failure on `83e67472f` supplied the missing first error: the same PostgreSQL
backend reported `release savepoint sp2` / `3B001`, then the membership read
reported `25P02`. An earlier `40P01` belonged to a separate passing failure-injection
case. The CI environment had no live gateway, so the notification-only fix was
insufficient evidence for this path.

A controlled probe uses the unmodified production commit-wake entry and its
existing scheduling/consumer seam, with real APP and Workspace transactions.
On main, the notification-only patch, and `83e67472f`, it records
`BEGIN -> SP1 -> SP2 -> RELEASE SP1 -> SELECT 1 -> RELEASE SP2`, borrows the
same Workspace transaction, and fails with `3B001`. The unchanged probe passes
with the shared-boundary fix: its consumer has a different transaction and
finishes successfully. No frozen source, model or Coordinator runtime is changed.
This proves the controlled lifetime defect; the entire original cancellation
route was not reliably reproduced, and no claim that all Factory flakes are
eliminated is made.

## Change and validation

`withoutDatabaseClient` establishes a fresh logical transaction boundary in a
pure AsyncLocalStorage module. Workspace transactions and derived Project
resource leases are reusable only while active in the same boundary. Synchronous
composition still uses its own nested savepoints. The parent lease is not
invalidated by its child, and independent work performs the existing membership,
token-tenant and Enterprise checks again. Request database routing and device
authority remain unchanged. The earlier explicit live-notification detachment
is retained.

The regression, Factory admission and Enterprise live authority suites passed
31/31. Three additional admission runs passed 22/22 each with no PostgreSQL query
error captured by the same diagnostic hook. The DB runner inventory passed 25/25.
The shared-boundary runtime source is `e7d0773f7`. New behavior regressions fail
2/2 before the fix and pass 2/2 afterward. Scope/resource/device regressions pass
24/24; official live suites 183/183; Factory routing 305/305; Linear 41/41 and
commit/background units 5/5. Root typechecking, targeted lint, policy checks and
the complete 83-suite DB inventory pass. A direct Enterprise run initially
reported 65/68 because its command omitted the fixture's CI/loopback environment;
only the two failing files were rerun with the existing CI configuration and
passed 50/50. The other three files passed initially; no assertion was changed.

| action | 合并前 | 合并后 | 放宽了？ | 依据 |
| --- | --- | --- | --- | --- |
| 独立后台 DB 操作 | 可借仍 active 的父 Workspace 事务 | 身份与路由保留；重新取得事务及原有权限锁 | 否 | `lib/db/request-scope.ts`, `lib/workspace-db.ts` |
| 借 Project 资源 lease | active、user、Workspace 匹配 | 还须同一事务边界；缺 lease 的 requireExisting 继续拒绝 | 收紧 | `lib/project-resources/store.ts` |
| 新建后台资源 lease | 原成员、PAT、Enterprise 与资源锁 | 全部保留并重新校验；父与子同步组合各复用自己的 lease | 否 | `tests/background-database-boundary.db.test.ts` |

Revert the code change to roll back; no schema or persisted data changes exist.
