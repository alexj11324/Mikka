# A thread attempt is a run in a chain, not a new entity

- Date: 2026-11-10
- Source: ALE-7 re-scoping in the ALE crew brief, after ALE-3/4/5/7 were found to rest on a wrong premise: "main 的容器是 `issues`，attempt 是 `agent_runs`，`run-chains` 的 `retryOf`/`continuesRunId` 已经把 attempt 建模成对 root 的 fold". The claim was re-verified against `08a08bec0` before writing; the citations below are the verification, not the brief.
- Rule: —
- Replaces: —

ALE-7 was scoped as "give a thread attempts" — a new table, a new identifier, a
migration to introduce it. Main already models this. What ALE-7 needs is not a new
entity but an honest account of the one that is there, so the next person extends it
instead of building a parallel one.

## What is already in the schema

A thread is an `issues` row. Its runs are `agent_runs` rows: `agent_runs."issueId"`
references `issues(id)` on delete cascade (`drizzle/0001_agents_devices.sql:63`), and a
run's own parent links are three nullable self-referencing columns on the same table:

| link | column | added by |
|---|---|---|
| rerun of a finished run | `"retryOf"` | `drizzle/20261025000400_run_retries.sql:7` |
| continuation after a new dispatch | `"continuesRunId"` | `drizzle/20261101200000_run_thread_continuations.sql:9` |
| continuation after an answered Factory question | `"questionContinuation"->>'originRunId'` | `questionContinuation` |

All three are `references agent_runs(id) on delete set null`.

## The fold is on the read path, and it is deliberate

`lib/run-chain.ts` is self-described as "the GitHub Actions run_id + run_attempt model"
(BE-18). It resolves a chain with a recursive CTE over those three links and stores no
chain column:

> No chain column: chains are resolved on the read path with a recursive CTE over those
> links. A link counts only between runs of the same owner, issue and non-null persisted
> workspace, including task-free historical runs. Recursion has a depth limit of 64.

The fold is explicit in the type and the numbering: `RunChain` is
`{ rootRunId, latestRunId, attempts }`, and `RunAttempt.attempt` is documented as
"1-based, in chain order: the root is attempt 1". `attempt` is assigned by the ordering,
not stored — `attempts` is built as

```ts
const attempts = [...runs.filter(run => run.runId === rootRunId), ...rest]
  .map((run, index) => ({ ...run, attempt: index + 1 }))
```

so `attempt` is derived, and `latestRunId` is the last element. Ordering is
`createdAt` then uuid, which makes it deterministic on ties.

## What this means for ALE-7

- A "thread attempt" is `agent_runs` scoped to an `issueId`, folded by `lib/run-chain.ts`.
  It is not a row in a new `task_thread_attempts` table.
- Anything that needs "which attempt is this" asks the chain (`RunChain.attempts`), so
  the number stays consistent with the depth cap, the owner/issue/workspace fence, and
  the tie-break. A stored counter is a second source of truth that can drift.
- A new entity is warranted only if attempts must carry data a run cannot — and runs
  already carry status, outcome, failure, `stopRequestedAt`, `createdAt`, `finishedAt`,
  and `latestRunId`. No such gap has been demonstrated.

## Consequences

The ALE-7 work is a read/describe change plus the guard `scripts/no-mode-layer.test.mjs`,
which keeps a hypothetical thread mode layer from arriving by accident — the layer whose
assumed presence caused the original mis-scope. If a future decision does add one, it
adds its file to this folder and registers the surface in that guard, in one commit.
