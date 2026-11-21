import type { Pool } from 'pg'

export const factoryReconcilePendingSql = `t.stage IN ('spec','execute','review','verify','monitor') AND (t.status='running' OR
    (t.status='pending' AND EXISTS(SELECT 1 FROM factory_events f WHERE f."taskId"=t.id AND f.request->>'kind'='request_epoch' AND f.request->>'sourceEventId'=t."sourceEventId"::text)) OR
    (t.status='failed' AND EXISTS (SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r."retryOf"=a."runId" WHERE a.id=t."attemptId")))`

/** The same bounded Bot sweep used by native instruction routing and reconciliation. */
export async function pendingFactoryReconciliation(pool: Pick<Pool, 'query'>, userId: string, botId: string | null) {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT t.id FROM factory_tasks t WHERE t."userId"=$1 AND t."botId" IS NOT DISTINCT FROM $2::uuid AND ${factoryReconcilePendingSql} ORDER BY t."updatedAt" LIMIT 50`,
    [userId, botId],
  )
  return rows
}
