import type { PoolClient } from 'pg'
/** The chat Bot and cloud runtime Bot may differ, within the same owned workspace. */
export async function factoryRunBotMatches(tx: Pick<PoolClient, 'query'>, task: { userId: string; botId?: string | null }, run: { id: string; botId: string | null }) {
  if (run.botId === task.botId) return true
  if (!task.botId || !run.botId) return false
  const { rowCount } = await tx.query(`SELECT 1 FROM computer_run_bindings b JOIN bots source ON source.id=$2 AND source."ownerId"=b."ownerId" AND source."workspaceId"=b."workspaceId"
    WHERE b."runId"=$1 AND b."ownerId"=$3 AND b."botId"=$4`, [run.id, task.botId, task.userId, run.botId])
  return rowCount === 1
}
