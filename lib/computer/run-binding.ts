import 'server-only'
import type { Pool } from 'pg'
import { ComputerError } from './store'

type Actor = { userId: string; workspaceId: string }

/**
 * Bind a queued run to the Bot selected by a trusted, workspace-authorized
 * caller. Locking the run serializes this operation with the daemon claim.
 * A binding cannot be switched after creation or inherited by another owner.
 */
export async function bindComputerRun(pool: Pool, actor: Actor, runId: string, botId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    const run = (await client.query('SELECT status FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])).rows[0]
    if (!run) throw new ComputerError(404, 'Run not found')
    const bot = (await client.query('SELECT id FROM bots WHERE id=$1 AND "workspaceId"=$2 AND "ownerId"=$3', [botId, actor.workspaceId, actor.userId])).rows[0]
    if (!bot) throw new ComputerError(404, 'Bot not found')
    const existing = (await client.query('SELECT "botId", "workspaceId" FROM computer_run_bindings WHERE "runId"=$1', [runId])).rows[0]
    if (existing) {
      if (existing.botId !== botId || existing.workspaceId !== actor.workspaceId) throw new ComputerError(409, 'Run already bound to another Bot')
    } else {
      if (run.status !== 'queued') throw new ComputerError(409, 'Run has already started')
      await client.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [runId, botId, actor.workspaceId, actor.userId])
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
