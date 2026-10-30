import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'

/**
 * Run chains (BE-18). Answering a Factory question queues a continuation as a new
 * agent_run whose "questionContinuation"->>'originRunId' points at the run it resumes,
 * so one conversation can be A → B → C. Like GitHub Actions' run_id + run_attempt, the
 * chain is identified by its root and each run in it is one attempt.
 *
 * No column and no migration: the chain is resolved on the read path with recursive
 * CTEs over the existing link. A link is followed only between runs of the same owner
 * on the same issue, so another person's, issue's or workspace's run can never join a
 * chain. Every recursion carries a path array (a run is never visited twice) and a
 * depth cap, so a corrupt cyclic link terminates. Reads are plain SELECTs, no row locks.
 */
export interface RunChainQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export const RUN_CHAIN_MAX_DEPTH = 64

export interface RunAttempt {
  runId: string
  /** 1-based, in creation order: the root is attempt 1. */
  attempt: number
  status: string
  stopRequestedAt: Date | null
  createdAt: Date
  finishedAt: Date | null
}

export interface RunChain {
  rootRunId: string
  /** The chain's newest run: what stop, status and send act on. */
  latestRunId: string
  attempts: RunAttempt[]
}

const active = (status: string) => (UNFINISHED_RUN_STATUSES as readonly string[]).includes(status)

/** The parent link of `r`, restricted to the same owner and issue. */
const SAME_CHAIN = `o."userId" = r."userId" AND o."issueId" IS NOT DISTINCT FROM r."issueId"`

/**
 * The newest `limit` chains on an issue among `userIds`' runs. Chains are folded by
 * root first and the limit applies to roots, so continuations never use up a slot.
 */
export async function listIssueRunChains(q: RunChainQueryable, issueId: string, userIds: readonly string[], limit: number): Promise<RunChain[]> {
  const { rows } = await q.query(`
    WITH RECURSIVE roots AS (
      SELECT r.id, r."createdAt" FROM agent_runs r
      WHERE r."issueId" = $1 AND r."userId" = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM agent_runs o WHERE o.id::text = r."questionContinuation"->>'originRunId' AND ${SAME_CHAIN})
      ORDER BY r."createdAt" DESC, r.id DESC
      LIMIT $3
    ), chain AS (
      SELECT roots.id AS root, roots.id, ARRAY[roots.id] AS path, 0 AS depth FROM roots
      UNION ALL
      SELECT c.root, r.id, c.path || r.id, c.depth + 1
      FROM chain c JOIN agent_runs o ON o.id = c.id
      JOIN agent_runs r ON r."questionContinuation"->>'originRunId' = c.id::text AND ${SAME_CHAIN}
      WHERE NOT r.id = ANY(c.path) AND c.depth < $4
    )
    SELECT DISTINCT ON (c.root, c.id) c.root::text AS "rootRunId", r.id::text AS "runId", r.status, r."stopRequestedAt", r."createdAt", r."finishedAt", roots."createdAt" AS "rootCreatedAt"
    FROM chain c JOIN agent_runs r ON r.id = c.id JOIN roots ON roots.id = c.root
    ORDER BY c.root, c.id`, [issueId, [...userIds], limit, RUN_CHAIN_MAX_DEPTH])
  return foldChains(rows)
}

function foldChains(rows: Record<string, unknown>[]): RunChain[] {
  const byRoot = new Map<string, { rootCreatedAt: Date; runs: Omit<RunAttempt, 'attempt'>[] }>()
  for (const row of rows) {
    const root = String(row.rootRunId)
    const entry = byRoot.get(root) ?? { rootCreatedAt: row.rootCreatedAt as Date, runs: [] }
    entry.runs.push({ runId: String(row.runId), status: String(row.status), stopRequestedAt: (row.stopRequestedAt as Date | null) ?? null, createdAt: row.createdAt as Date, finishedAt: (row.finishedAt as Date | null) ?? null })
    byRoot.set(root, entry)
  }
  const order = (a: { createdAt: Date; runId: string }, b: { createdAt: Date; runId: string }) => a.createdAt.getTime() - b.createdAt.getTime() || a.runId.localeCompare(b.runId)
  return [...byRoot.entries()]
    .sort(([ra, a], [rb, b]) => b.rootCreatedAt.getTime() - a.rootCreatedAt.getTime() || rb.localeCompare(ra))
    .map(([rootRunId, { runs }]) => {
      const rest = runs.filter(run => run.runId !== rootRunId).sort(order)
      const attempts = [...runs.filter(run => run.runId === rootRunId), ...rest].map((run, index) => ({ ...run, attempt: index + 1 }))
      return { rootRunId, latestRunId: attempts.at(-1)!.runId, attempts }
    })
}

/** The whole chain containing `runId`, if `userId` owns that run; null otherwise. */
export async function readRunChain(q: RunChainQueryable, userId: string, runId: string): Promise<RunChain | null> {
  const { rows } = await q.query(`
    WITH RECURSIVE up AS (
      SELECT r.id, ARRAY[r.id] AS path, 0 AS depth FROM agent_runs r WHERE r.id = $1::uuid AND r."userId" = $2
      UNION ALL
      SELECT o.id, u.path || o.id, u.depth + 1
      FROM up u JOIN agent_runs r ON r.id = u.id
      JOIN agent_runs o ON o.id::text = r."questionContinuation"->>'originRunId' AND ${SAME_CHAIN}
      WHERE NOT o.id = ANY(u.path) AND u.depth < $3
    ), root AS (
      SELECT id FROM up ORDER BY depth DESC LIMIT 1
    ), chain AS (
      SELECT root.id AS root, root.id, ARRAY[root.id] AS path, 0 AS depth FROM root
      UNION ALL
      SELECT c.root, r.id, c.path || r.id, c.depth + 1
      FROM chain c JOIN agent_runs o ON o.id = c.id
      JOIN agent_runs r ON r."questionContinuation"->>'originRunId' = c.id::text AND ${SAME_CHAIN}
      WHERE NOT r.id = ANY(c.path) AND c.depth < $3
    )
    SELECT DISTINCT ON (c.id) c.root::text AS "rootRunId", r.id::text AS "runId", r.status, r."stopRequestedAt", r."createdAt", r."finishedAt", now() AS "rootCreatedAt"
    FROM chain c JOIN agent_runs r ON r.id = c.id ORDER BY c.id`, [runId, userId, RUN_CHAIN_MAX_DEPTH])
  const [chain] = foldChains(rows)
  return chain && chain.attempts.some(attempt => attempt.runId === runId) ? chain : null
}

export type StopTarget =
  | { kind: 'stop'; runId: string; forwardedFrom: string | null }
  | { kind: 'notFound' }
  | { kind: 'chainEnded'; latestRunId: string }

/**
 * Where a stop for `runId` goes. Never silently does nothing:
 * - the run is unknown or not the caller's → notFound (404, `runNotFound`);
 * - the run itself is unfinished → stop it;
 * - it has ended but its chain's latest run is unfinished → forward the stop there
 *   (a stale page still holding attempt A or B stops the live attempt C);
 * - every run in the chain has ended → chainEnded (409, `runChainEnded`, with latestRunId).
 * Forwarding stays inside one owner's chain on one issue, so it cannot reach another chain.
 */
export async function resolveStopTarget(q: RunChainQueryable, userId: string, runId: string): Promise<StopTarget> {
  const chain = await readRunChain(q, userId, runId)
  if (!chain) return { kind: 'notFound' }
  const requested = chain.attempts.find(attempt => attempt.runId === runId)!
  if (active(requested.status)) return { kind: 'stop', runId, forwardedFrom: null }
  const latest = chain.attempts.find(attempt => attempt.runId === chain.latestRunId)!
  if (active(latest.status)) return { kind: 'stop', runId: latest.runId, forwardedFrom: runId }
  return { kind: 'chainEnded', latestRunId: chain.latestRunId }
}
