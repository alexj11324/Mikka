/**
 * Raw read behind the issue thread question badge (app/actions/agents.ts). The resumed run is
 * not read here: it is the thread's run chain (lib/run-chain.ts).
 */
export interface ThreadQuestionQueryable {
  query<R extends Record<string, unknown>>(text: string, values: unknown[]): Promise<{ rows: R[] }>
}

/** Which of the viewer's own runs still owe or are resuming from an answer, by origin run. */
export type ThreadQuestionDeadline = { at: string; afterMs: number }

export async function readThreadQuestionState(db: ThreadQuestionQueryable, runIds: readonly string[], viewerId: string) {
  if (!runIds.length) return { states: new Map<string, 'waiting' | 'resuming'>(), deadline: null as ThreadQuestionDeadline | null }
  const { rows } = await db.query<{ runId: string; status: string; expiresAt: Date | string | null; afterMs: number | string | null }>(
    `SELECT DISTINCT ON (q."originRunId") q."originRunId" AS "runId", q.status, q."expiresAt",
      greatest(0,extract(epoch FROM (q."expiresAt"-clock_timestamp()))*1000) AS "afterMs" FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId"
      WHERE q."originRunId"=ANY($1::uuid[]) AND q."userId"=$2 AND t."userId"=$2 AND t.status NOT IN ('cancelled','revoked')
        AND t."candidateId" IS NOT DISTINCT FROM q."candidateId"
        AND (q.status='resuming' OR (q.status IN ('open','waiting_user') AND (q."expiresAt" IS NULL OR q."expiresAt">now())))
      ORDER BY q."originRunId", q."createdAt" DESC`,
    [[...runIds], viewerId],
  )
  const states = new Map(rows.map(row => [row.runId, row.status === 'resuming' ? 'resuming' as const : 'waiting' as const]))
  const deadlines = rows.flatMap(row => row.status !== 'resuming' && row.expiresAt && Number.isFinite(Number(row.afterMs))
    ? [{ at: new Date(row.expiresAt).toISOString(), afterMs: Number(row.afterMs) }] : []).sort((a, b) => a.afterMs - b.afterMs)
  return { states, deadline: deadlines[0] ?? null }
}

/** Existing list consumers need only the effective badge state. */
export async function threadQuestionStates(db: ThreadQuestionQueryable, runIds: readonly string[], viewerId: string) {
  return (await readThreadQuestionState(db, runIds, viewerId)).states
}
