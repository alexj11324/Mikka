import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/** Caller must first authorize the person in this workspace. An internal Bot
 * supplies the same isolation keys as named Bots without adding a second chat. */
export async function coordinatorWebBot(pool: Pool, actor: { userId: string; workspaceId: string }) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`coordinator-browser:${actor.workspaceId}:${actor.userId}`])
    const existing = (await client.query('SELECT "botId" FROM coordinator_web_bots WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId, actor.userId])).rows[0]
    if (existing) { await client.query('COMMIT'); return existing.botId as string }
    const id = randomUUID()
    await client.query('INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,$4)', [id, actor.workspaceId, actor.userId, `__mikka_coordinator_${id}`])
    await client.query('INSERT INTO coordinator_web_bots ("workspaceId","ownerId","botId") VALUES ($1,$2,$3)', [actor.workspaceId, actor.userId, id])
    await client.query('COMMIT')
    return id
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
