import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { SubagentState } from '@mikka/protocol/computer'

type Actor = { userId: string; workspaceId: string }
export const BOT_SUBAGENT_LIMIT = 6
export type Subagent = { id: string; botId: string; task: string; state: SubagentState }

/** Queue ownership and capacity live in Postgres so two workers cannot both
 * admit a seventh browser. A needs-you browser still consumes a slot. */
export class SubagentQueue {
  constructor(private readonly pool: Pool) {}

  async enqueue(actor: Actor, botId: string, task: string): Promise<Subagent> {
    const sentence = task.trim()
    if (!sentence || sentence.length > 200) throw new Error('Invalid web task')
    const result = await this.pool.query<Subagent>(`INSERT INTO bot_subagents (id,"workspaceId","ownerId","botId",task)
      SELECT $4,b."workspaceId",b."ownerId",b.id,$5 FROM bots b
      WHERE b.id=$1 AND b."workspaceId"=$2 AND b."ownerId"=$3 RETURNING id,"botId",task,state`,
    [botId, actor.workspaceId, actor.userId, randomUUID(), sentence])
    if (!result.rowCount) throw new Error('Bot unavailable')
    return result.rows[0]
  }

  async claimNext(actor: Actor): Promise<Subagent | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-subagent-capacity:${actor.workspaceId}`])
      const occupied = (await client.query<{ count: string }>(`SELECT count(*) AS count FROM bot_subagents WHERE "workspaceId"=$1 AND state IN ('running','needs_you')`, [actor.workspaceId])).rows[0]
      if (Number(occupied.count) >= BOT_SUBAGENT_LIMIT) { await client.query('COMMIT'); return null }
      const result = await client.query<Subagent>(`UPDATE bot_subagents SET state='running',control='agent' WHERE id=(
        SELECT id FROM bot_subagents WHERE "workspaceId"=$1 AND "ownerId"=$2 AND state='queued'
        ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,"botId",task,state`, [actor.workspaceId, actor.userId])
      await client.query('COMMIT')
      return result.rows[0] ?? null
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  /** A running browser retains its slot until a worker actually closes it.
   * Queued tasks need no cleanup and can become terminal immediately. */
  async stop(actor: Actor, botId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE bot_subagents SET
        state=CASE WHEN state='queued' THEN 'stopped' ELSE state END,
        control=CASE WHEN state='queued' THEN 'idle' ELSE control END,
        "endedAt"=CASE WHEN state='queued' THEN now() ELSE "endedAt" END,
        "stopRequestedAt"=COALESCE("stopRequestedAt",now())
      WHERE id=$1 AND "botId"=$2 AND "workspaceId"=$3 AND "ownerId"=$4 AND state IN ('queued','running','needs_you') RETURNING id`,
    [id, botId, actor.workspaceId, actor.userId])
    return result.rowCount === 1
  }

  /** Call only after the worker has closed its browser. A stop request wins
   * a race against a completion so the final state reflects the user's stop. */
  async finish(actor: Actor, botId: string, id: string, outcome: 'done' | 'failed'): Promise<Subagent | null> {
    const result = await this.pool.query<Subagent>(`UPDATE bot_subagents SET
        state=CASE WHEN "stopRequestedAt" IS NOT NULL THEN 'stopped' ELSE $5 END,
        control='idle',"endedAt"=now(),"browserContextId"=NULL
      WHERE id=$1 AND "botId"=$2 AND "workspaceId"=$3 AND "ownerId"=$4 AND state IN ('running','needs_you')
      RETURNING id,"botId",task,state`, [id, botId, actor.workspaceId, actor.userId, outcome])
    return result.rows[0] ?? null
  }
}
