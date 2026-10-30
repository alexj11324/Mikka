/** Raw reads behind the issue thread question badge and its resumed run (app/actions/agents.ts). */
export interface ThreadQuestionQueryable {
  query<R extends Record<string, unknown>>(text: string, values: unknown[]): Promise<{ rows: R[] }>
}

/** Which of the viewer's own runs still owe or are resuming from an answer, by origin run. */
export async function threadQuestionStates(db: ThreadQuestionQueryable, runIds: readonly string[], viewerId: string) {
  if (!runIds.length) return new Map<string, 'waiting' | 'resuming'>()
  const { rows } = await db.query<{ runId: string; status: string }>(
    `SELECT DISTINCT ON (q."originRunId") q."originRunId" AS "runId", q.status FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId"
      WHERE q."originRunId"=ANY($1::uuid[]) AND q."userId"=$2 AND t."userId"=$2 AND t.status NOT IN ('cancelled','revoked')
        AND t."candidateId" IS NOT DISTINCT FROM q."candidateId"
        AND (q.status='resuming' OR (q.status IN ('open','waiting_user') AND (q."expiresAt" IS NULL OR q."expiresAt">now())))
      ORDER BY q."originRunId", q."createdAt" DESC`,
    [[...runIds], viewerId],
  )
  return new Map(rows.map(row => [row.runId, row.status === 'resuming' ? 'resuming' as const : 'waiting' as const]))
}

/** The viewer's runs that resume originRunId after an answered question; they belong to the same thread. */
export async function threadContinuationRunIds(db: ThreadQuestionQueryable, issueId: string, viewerId: string, originRunId: string, limit: number) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM agent_runs WHERE "issueId"=$1 AND "userId"=$2 AND "questionContinuation"->>'originRunId'=$3 ORDER BY "createdAt", id LIMIT $4`,
    [issueId, viewerId, originRunId, limit],
  )
  return rows.map(row => row.id)
}
