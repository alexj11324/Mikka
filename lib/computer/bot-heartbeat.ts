import 'server-only'
import type { Pool } from 'pg'
import { renewComputerLifetime } from './e2b-provider'

/** E2B's timeout is absolute. Only an actively owned web task keeps the
 * shared machine alive; queued or ended tasks must not keep it awake. */
export async function renewBotLifetime(pool: Pool, actor: { userId: string; workspaceId: string }, renew = renewComputerLifetime) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const machine = (await client.query(`SELECT m."sandboxId" FROM cloud_machines m
      WHERE m."workspaceId"=$1 AND m."ownerId"=$2 AND m.state='running' AND m."sandboxId" IS NOT NULL
        AND m."lastActiveAt"<now()-interval '2 minutes'
        AND EXISTS (SELECT 1 FROM bot_subagents s WHERE s."workspaceId"=m."workspaceId" AND s."ownerId"=m."ownerId"
          AND s.state IN ('running','needs_you') AND s."stopRequestedAt" IS NULL)
      FOR UPDATE OF m SKIP LOCKED`, [actor.workspaceId, actor.userId])).rows[0]
    if (!machine) { await client.query('COMMIT'); return false }
    // Update only after the provider succeeds, so transient failures retry on
    // the next poll instead of silently consuming the renewal window.
    await renew(machine.sandboxId)
    await client.query('UPDATE cloud_machines SET "lastActiveAt"=now() WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "sandboxId"=$3',
      [actor.workspaceId, actor.userId, machine.sandboxId])
    await client.query('COMMIT')
    return true
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
