import { readRunFailure, type RunFailure } from '@mikka/protocol/run-failure'
import { readCompactRunFailure, type CompactRunFailure } from './run-failure-view'
import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'

/**
 * Run chains (BE-18), the GitHub Actions run_id + run_attempt model. A run's parent is
 * the run it resumes after an answered Factory question ("questionContinuation"->>'originRunId'),
 * the run it reruns ("retryOf") or the run of the same thread it goes on from after a new
 * dispatch ("continuesRunId", lib/thread-dispatch.ts); a chain is a root and every run reachable from it.
 *
 * No chain column: chains are resolved on the read path with a recursive CTE
 * over those links. A link counts only between runs of the same owner, issue
 * and non-null persisted workspace, including task-free historical runs.
 * Recursion has a depth limit of 64. Chains that
 * exceed it are rejected, including corrupt cycles; no path arrays or fallback
 * roots are maintained. Within a chain, attempts are ordered by createdAt then
 * uuid; the last one is latestRunId (deterministic on ties).
 * Reads are plain SELECTs: no row locks.
 */
export interface RunChainQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export const RUN_CHAIN_MAX_DEPTH = 64

export interface RunAttempt {
  failureDetails?: RunFailure | CompactRunFailure | null
  runId: string
  /** 1-based, in chain order: the root is attempt 1. */
  attempt: number
  status: string
  /** How it came out once it ended (R-52); null while running or not judged yet. */
  outcome?: string | null
  stopRequestedAt: Date | null
  createdAt: Date
  finishedAt: Date | null
}

export interface RunChain {
  rootRunId: string
  /** The chain's newest run: what status and send act on. */
  latestRunId: string
  attempts: RunAttempt[]
}

const UUID = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`
/** The continuation origin as a uuid, only when well-formed, so it compares to the primary key. */
const ORIGIN = (alias: string) => `(CASE WHEN ${alias}."questionContinuation"->>'originRunId' ~ ${UUID} THEN (${alias}."questionContinuation"->>'originRunId')::uuid END)`
/** Every read model follows the same owner, issue and immutable tenant fence. */
const PARENT = (child: string, parent: string) => `${parent}.id IN (${child}.origin, ${child}."retryOf", ${child}."continuesRunId")
  AND ${parent}."userId" = ${child}."userId" AND ${parent}."issueId" IS NOT DISTINCT FROM ${child}."issueId"
  AND ${parent}."workspaceId" = ${child}."workspaceId"`


/**
 * Every run in scope with its chain root. `scope` filters agent_runs aliased `r`;
 * parameters $1..$n belong to the caller, `depth` is the depth-cap placeholder.
 */
function chainSql(scope: string, depth: string) {
  return `
    runs AS (
      SELECT r.id, r."userId", r."issueId", r."workspaceId", r."createdAt", ${ORIGIN('r')} AS origin, r."retryOf", r."continuesRunId" FROM agent_runs r WHERE ${scope}
    ), edges AS (
      SELECT DISTINCT c.id AS child, p.id AS parent FROM runs c JOIN runs p
        ON ${PARENT('c', 'p')}
    ), up AS (
      SELECT id AS start, id AS node, 0 AS depth FROM runs
      UNION
      SELECT u.start, e.parent, u.depth + 1
      FROM up u JOIN edges e ON e.child = u.node
      WHERE u.depth < ${depth}
    ), assigned AS (
      SELECT DISTINCT ON (u.start) u.start AS id, u.node AS root,
        EXISTS (SELECT 1 FROM up tail JOIN edges e ON e.child=tail.node
          WHERE tail.start=u.start AND tail.depth=${depth}) AS "depthExceeded"
      FROM up u JOIN runs n ON n.id = u.node
      ORDER BY u.start, u.depth DESC, n."createdAt", n.id
    )`
}

// Chain lists must not transfer the private response text from any attempt.
const COMPACT_FAILURE = `CASE WHEN jsonb_typeof(x."failureDetails")='object' AND x."failureDetails"->>'schemaVersion'='1' THEN
  jsonb_build_object('schemaVersion',x."failureDetails"->'schemaVersion','code',x."failureDetails"->'code',
    'category',x."failureDetails"->'category','runId',x."failureDetails"->'runId',
    'occurredAt',x."failureDetails"->'occurredAt','appVersion',x."failureDetails"->'appVersion') ||
  jsonb_strip_nulls(jsonb_build_object('detail',x."failureDetails"->'detail','provider',x."failureDetails"->'provider',
    'status',x."failureDetails"->'status','recovery',x."failureDetails"->'recovery')) END`
const selectAttempts = (ownerDetail = false) => `a."depthExceeded", a.root::text AS "rootRunId", x.id::text AS "runId", x.status, x.outcome,
  x."stopRequestedAt", x."createdAt", x."finishedAt", ${ownerDetail ? 'x."failureDetails"' : COMPACT_FAILURE} AS "failureDetails"`

/**
 * The newest `limit` chains on an issue among `userIds`' runs. Runs are folded by root
 * first and the limit applies to roots, so continuations and reruns never use up a slot.
 */
export async function listIssueRunChains(q: RunChainQueryable, issueId: string, userIds: readonly string[], limit: number, readerId?: string): Promise<RunChain[]> {
  const { rows } = await q.query(`
    WITH RECURSIVE ${chainSql(`r."issueId" = $1 AND r."userId" = ANY($2::text[])
      AND EXISTS (SELECT 1 FROM issues i WHERE i.id=r."issueId" AND i."ownershipState"='bound' AND i."workspaceId"=r."workspaceId")
      ${readerId === undefined ? '' : `AND mikka_resource_acl_allowed('account',$5,r."workspaceId",'thread',r.id,'canReadContent')`}`, '$4')},
    roots AS (
      SELECT DISTINCT a.root, n."createdAt" FROM assigned a JOIN runs n ON n.id = a.root
      ORDER BY n."createdAt" DESC, a.root DESC LIMIT $3
    )
    SELECT ${selectAttempts()}, roots."createdAt" AS "rootCreatedAt"
    FROM assigned a JOIN roots ON roots.root = a.root JOIN agent_runs x ON x.id = a.id`, [issueId, [...userIds], limit, RUN_CHAIN_MAX_DEPTH, ...(readerId === undefined ? [] : [readerId])])
  return foldChains(rows)
}

/** Roots started in the period, among these bots; retries and continuations share one root. */
export async function listBotRunRoots(q: RunChainQueryable, botIds: readonly string[], start: Date, end: Date): Promise<Array<{ rootRunId: string; botId: string; createdAt: Date }>> {
  if (!botIds.length) return []
  // Only month-local runs seed the walk. Parents may belong to another bot or
  // month, so resolve them by primary key without widening the visible result.
  const { rows } = await q.query(`
    WITH RECURSIVE up AS (
      SELECT r.id AS start, r.id AS node, r."userId", r."issueId", r."workspaceId", r."createdAt", ${ORIGIN('r')} AS origin, r."retryOf", r."continuesRunId", 0 AS depth
      FROM agent_runs r WHERE r."botId" = ANY($1::uuid[]) AND r."workspaceId" IS NOT NULL AND r."createdAt" >= $2::timestamptz AND r."createdAt" < $3::timestamptz
      UNION
      SELECT u.start, p.id, p."userId", p."issueId", p."workspaceId", p."createdAt", ${ORIGIN('p')}, p."retryOf", p."continuesRunId", u.depth + 1
      FROM up u JOIN agent_runs p ON ${PARENT('u', 'p')}
      WHERE u.depth < $4
    ), assigned AS (
      SELECT DISTINCT ON (u.start) u.node AS root,
        EXISTS (SELECT 1 FROM up tail JOIN agent_runs p ON ${PARENT('tail', 'p')}
          WHERE tail.start = u.start AND tail.depth = $4) AS "depthExceeded"
      FROM up u ORDER BY u.start, u.depth DESC, u."createdAt", u.node
    )
    SELECT DISTINCT root.id::text AS "rootRunId", root."botId", root."createdAt", false AS "depthExceeded"
    FROM assigned a JOIN agent_runs root ON root.id = a.root
    WHERE NOT a."depthExceeded" AND root."botId" = ANY($1::uuid[]) AND root."createdAt" >= $2::timestamptz AND root."createdAt" < $3::timestamptz
    UNION ALL
    SELECT NULL::text, NULL::uuid, NULL::timestamptz, true WHERE EXISTS (SELECT 1 FROM assigned WHERE "depthExceeded")`, [[...botIds], start, end, RUN_CHAIN_MAX_DEPTH])
  if (rows.some(row => row.depthExceeded)) throw new Error('runChainDepthExceeded')
  return rows.map(row => ({ rootRunId: String(row.rootRunId), botId: String(row.botId), createdAt: row.createdAt as Date }))
}

function foldChains(rows: Record<string, unknown>[]): RunChain[] {
  if (rows.some(row => row.depthExceeded)) throw new Error('runChainDepthExceeded')
  const byRoot = new Map<string, { rootCreatedAt: Date; runs: Omit<RunAttempt, 'attempt'>[] }>()
  for (const row of rows) {
    const root = String(row.rootRunId)
    const entry = byRoot.get(root) ?? { rootCreatedAt: row.rootCreatedAt as Date, runs: [] }
    const failureDetails = readRunFailure(row.failureDetails) ?? readCompactRunFailure(row.failureDetails)
    entry.runs.push({ ...(failureDetails ? { failureDetails } : {}), runId: String(row.runId), status: String(row.status), outcome: (row.outcome as string | null) ?? null, stopRequestedAt: (row.stopRequestedAt as Date | null) ?? null, createdAt: row.createdAt as Date, finishedAt: (row.finishedAt as Date | null) ?? null })
    byRoot.set(root, entry)
  }
  const order = (a: { createdAt: Date; runId: string }, b: { createdAt: Date; runId: string }) => a.createdAt.getTime() - b.createdAt.getTime() || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)
  return [...byRoot.entries()]
    .sort(([ra, a], [rb, b]) => b.rootCreatedAt.getTime() - a.rootCreatedAt.getTime() || (rb < ra ? -1 : rb > ra ? 1 : 0))
    .map(([rootRunId, { runs }]) => {
      const rest = runs.filter(run => run.runId !== rootRunId).sort(order)
      const attempts = [...runs.filter(run => run.runId === rootRunId), ...rest].map((run, index) => ({ ...run, attempt: index + 1 }))
      return { rootRunId, latestRunId: attempts.at(-1)!.runId, attempts }
    })
}

/** Shared by attempt and checkpoint reads, with identical tenant/depth fences. */
function selectedChainSql(withReader = false) {
  return `start AS (
      SELECT "issueId","workspaceId" FROM agent_runs WHERE id = $1::uuid AND "userId" = $2 AND "workspaceId" IS NOT NULL
    ), ${chainSql(`r."userId" = $2 AND EXISTS (SELECT 1 FROM start s WHERE r."issueId" IS NOT DISTINCT FROM s."issueId" AND r."workspaceId"=s."workspaceId")
      ${withReader ? `AND mikka_resource_acl_allowed('account',$4,r."workspaceId",'thread',r.id,'canReadContent')` : ''}`, '$3')},
    selected AS (
      SELECT * FROM assigned WHERE root = (SELECT root FROM assigned WHERE id = $1::uuid)
    )`
}

/** The whole chain containing `runId`, if `userId` owns that run; null otherwise. */
export async function readRunChain(q: RunChainQueryable, userId: string, runId: string, readerId?: string): Promise<RunChain | null> {
  if (!new RegExp(UUID.slice(1, -1)).test(runId)) return null
  const { rows } = await q.query(`
    WITH RECURSIVE ${selectedChainSql(readerId !== undefined)}
    SELECT ${selectAttempts(true)}, now() AS "rootCreatedAt"
    FROM selected a JOIN agent_runs x ON x.id = a.id`, [runId, userId, RUN_CHAIN_MAX_DEPTH, ...(readerId === undefined ? [] : [readerId])])
  const [chain] = foldChains(rows)
  return chain && chain.attempts.some(attempt => attempt.runId === runId) ? chain : null
}

/** Read one checkpoint for the authorized chain without transporting every
 * attempt or issuing another query for its ids. A malformed chain still fails
 * before checkpoint content is read. */
export async function readRunChainCheckpoint(q: RunChainQueryable, userId: string, runId: string, readerId?: string): Promise<{
  runIds: string[]
  checkpoint: { patch: Buffer; unavailableReason: string | null } | null
}> {
  if (!new RegExp(UUID.slice(1, -1)).test(runId)) return { runIds: [], checkpoint: null }
  const { rows: [row] } = await q.query(`
    WITH RECURSIVE ${selectedChainSql(readerId !== undefined)}, grouped AS (
      SELECT coalesce(array_agg(id::text ORDER BY id), ARRAY[]::text[]) AS "runIds",
        coalesce(bool_or("depthExceeded"), false) AS "depthExceeded" FROM selected
    )
    SELECT grouped."runIds", grouped."depthExceeded", checkpoint.patch, checkpoint."unavailableReason"
    FROM grouped LEFT JOIN LATERAL (
      SELECT patch,"unavailableReason" FROM run_checkpoints
      WHERE NOT grouped."depthExceeded" AND "runId"=ANY(grouped."runIds"::uuid[])
      ORDER BY "updatedAt" DESC LIMIT 1
    ) checkpoint ON true`, [runId, userId, RUN_CHAIN_MAX_DEPTH, ...(readerId === undefined ? [] : [readerId])])
  if (row.depthExceeded) throw new Error('runChainDepthExceeded')
  return {
    runIds: row.runIds as string[],
    checkpoint: row.patch === null ? null : { patch: row.patch as Buffer, unavailableReason: row.unavailableReason as string | null },
  }
}

export type StopTargets =
  | { kind: 'stop'; runIds: string[]; latestRunId: string }
  | { kind: 'notFound' }
  | { kind: 'chainEnded'; latestRunId: string }

/**
 * What a stop on `runId` stops (Tech Lead, BE-18): the requested run and every later attempt
 * of its chain that is still unfinished. A(succeeded)→B(running)→C(running): stop B stops B
 * and C; stop A stops B and C. B(running)→C(ended): stop B stops only B.
 * - unknown run, or not the caller's → notFound (404, `runNotFound`);
 * - nothing unfinished from the requested run onward → chainEnded (409, `runChainEnded`,
 *   with latestRunId). Never a silent no-op.
 * Only the caller's own chain on one issue is considered, so another chain is never reached.
 */
export async function resolveStopTargets(q: RunChainQueryable, userId: string, runId: string): Promise<StopTargets> {
  const chain = await readRunChain(q, userId, runId)
  if (!chain) return { kind: 'notFound' }
  const from = chain.attempts.findIndex(attempt => attempt.runId === runId)
  const runIds = chain.attempts.slice(from).filter(attempt => (UNFINISHED_RUN_STATUSES as readonly string[]).includes(attempt.status)).map(attempt => attempt.runId)
  return runIds.length ? { kind: 'stop', runIds, latestRunId: chain.latestRunId } : { kind: 'chainEnded', latestRunId: chain.latestRunId }
}
