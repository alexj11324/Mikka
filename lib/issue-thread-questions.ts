/**
 * Raw read behind the issue thread question badge (app/actions/agents.ts). The resumed run is
 * not read here: it is the thread's run chain (lib/run-chain.ts).
 */
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
