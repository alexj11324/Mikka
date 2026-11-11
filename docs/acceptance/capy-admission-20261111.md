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

## Main integration on 2026-11-11

Merge `f32f04d0dbc4ee24cd8a8c8ae124232f5a8737a8` incorporates main
`5c1e0522483d504f64de07066bcd35f603c44248` into the combined dispatch and
transaction-boundary branch. The merge has no conflicts. All seven production
runtime files retain the same blobs as `b5f7429b7`; incoming main changes are
the baseline, including its eve changes. The net patch against main contains
no frozen-path changes, deletions, migration or UI changes. No main commits are
missing from this branch. Its three modified package scripts preserve main's
entries and add the existing dispatch, notification and boundary regressions.

Fresh Cloud Linux validation bootstrapped a separate loopback PostgreSQL 17
database with this merge's complete migrations. The six dispatch/continuation/
shared-subscription/notification/boundary/resource-lease files pass 69/69;
the complete Factory routing package script passes 305/305; coordinator-events
source checks pass 411/411; the updated DB-runner inventory passes 32/32.
All have zero skips. These fixtures do not make provider requests.

The unchanged official-wake probe again records separate Workspace transaction
identities and a fulfilled consumer. The unchanged lock-pool probe again holds
exactly two connections for five dispatches and closes to zero after permitting
the owner's final APP query. Root/API typechecking and the frontend package's
4 GB typecheck pass, as do targeted lint, cloud-boundary/error-cause/polling/
Factory policies and whitespace checks. The startup and dispatch fixtures retain
all 116 and 29 assertion lines from main. This source-bound local evidence does
not establish new-head CI, deployed behavior or live model acceptance.

## Observing physical connection shutdown

An inherited run of the new dispatch fixture on privacy #1952 observed one
backend immediately after `scope.close()`, then its ordinary DROP DATABASE
succeeded. pg-pool removes idle clients from its logical owners before their
asynchronous Client end callbacks finish; both pools had received termination.
The fixture now observes real Client end events for its unique test database
before making the unchanged zero-backend assertion. Production code is unchanged.

A real-PG driver gate makes the boundary deterministic: the old observation sees
two pending sockets and fails; waiting for their actual end events sees zero and
passes. A control that omits derived-pool termination still sees one backend and
fails the same assertion. No sleep, polling, backend termination or assertion
relaxation is used. The corrected dispatch fixture passes 5/5 with its original
six assertion lines intact; earlier broader results remain bound to their sources.
