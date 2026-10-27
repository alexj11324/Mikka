import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { SubagentState } from '@mikka/protocol/computer'
import { finishSuggestionSubagent } from '@/lib/suggestions/execution'

type Actor = { userId: string; workspaceId: string }
export const BOT_SUBAGENT_LIMIT = 6
export type Subagent = { id: string; botId: string; task: string; state: SubagentState }

/** Queue ownership and capacity live in Postgres so two workers cannot both
 * admit a seventh browser. A needs-you browser still consumes a slot. */
export class SubagentQueue {
  constructor(private readonly pool: Pool) {}

  async enqueue(actor: Actor, botId: string, task: string, idempotencyKey?: string): Promise<Subagent> {
    const sentence = task.trim()
    if (!sentence || sentence.length > 200 || (idempotencyKey !== undefined && (!idempotencyKey.length || idempotencyKey.length > 256))) throw new Error('Invalid web task')
    const key = idempotencyKey === undefined ? null : createHash('sha256').update(JSON.stringify([actor.userId, actor.workspaceId, idempotencyKey])).digest('hex')
    if (key) {
      const keyed = await this.pool.query<Subagent>(`INSERT INTO bot_subagents (id,"workspaceId","ownerId","botId",task,"idempotencyKey")
        SELECT $4,b."workspaceId",b."ownerId",b.id,$5,$6 FROM bots b WHERE b.id=$1 AND b."workspaceId"=$2 AND b."ownerId"=$3
        ON CONFLICT ("ownerId","workspaceId","idempotencyKey") WHERE "idempotencyKey" IS NOT NULL
        DO UPDATE SET "idempotencyKey"=EXCLUDED."idempotencyKey"
        WHERE bot_subagents."botId"=EXCLUDED."botId" AND bot_subagents.task=EXCLUDED.task RETURNING id,"botId",task,state`,
      [botId, actor.workspaceId, actor.userId, randomUUID(), sentence, key])
      if (!keyed.rowCount) throw new Error('Bot or web task unavailable')
      return keyed.rows[0]
    }
    const result = await this.pool.query<Subagent>(`INSERT INTO bot_subagents (id,"workspaceId","ownerId","botId",task)
      SELECT $4,b."workspaceId",b."ownerId",b.id,$5 FROM bots b
      WHERE b.id=$1 AND b."workspaceId"=$2 AND b."ownerId"=$3 RETURNING id,"botId",task,state`,
    [botId, actor.workspaceId, actor.userId, randomUUID(), sentence])
    if (!result.rowCount) throw new Error('Bot unavailable')
    return result.rows[0]
  }

  async claimNext(actor: Actor, workerKey?: string): Promise<Subagent | null> {
    if (workerKey !== undefined && (!workerKey || workerKey.length > 256)) throw new Error('Invalid worker')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-subagent-capacity:${actor.workspaceId}`])
      if (workerKey) {
        const prior = await client.query<Subagent>(`SELECT id,"botId",task,state FROM bot_subagents
          WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "workerKey"=$3 AND state IN ('running','needs_you')`, [actor.workspaceId, actor.userId, workerKey])
        if (prior.rowCount) { await client.query('COMMIT'); return prior.rows[0] }
      }
      const occupied = (await client.query<{ count: string }>(`SELECT count(*) AS count FROM bot_subagents WHERE "workspaceId"=$1 AND state IN ('running','needs_you')`, [actor.workspaceId])).rows[0]
      if (Number(occupied.count) >= BOT_SUBAGENT_LIMIT) { await client.query('COMMIT'); return null }
      const result = await client.query<Subagent>(`UPDATE bot_subagents SET state='running',control='agent',"startedAt"=now(),"workerKey"=$3 WHERE id=(
        SELECT id FROM bot_subagents WHERE "workspaceId"=$1 AND "ownerId"=$2 AND state='queued'
        ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,"botId",task,state`, [actor.workspaceId, actor.userId, workerKey ?? null])
      await client.query('COMMIT')
      return result.rows[0] ?? null
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  /** A running browser retains its slot until a worker actually closes it.
   * Queued tasks need no cleanup and can become terminal immediately. */
  async stop(actor: Actor, botId: string, id: string): Promise<boolean> {
    const result = await this.pool.query<{ state: SubagentState }>(`UPDATE bot_subagents SET
        state=CASE WHEN state='queued' THEN 'stopped' ELSE state END,
        control=CASE WHEN state='queued' THEN 'idle' ELSE control END,
        "endedAt"=CASE WHEN state='queued' THEN now() ELSE "endedAt" END,
        "stopRequestedAt"=COALESCE("stopRequestedAt",now())
      WHERE id=$1 AND "botId"=$2 AND "workspaceId"=$3 AND "ownerId"=$4 AND state IN ('queued','running','needs_you') RETURNING state`,
    [id, botId, actor.workspaceId, actor.userId])
    if (result.rows[0]?.state === 'stopped') await finishSuggestionSubagent(this.pool, actor.userId, id, 'stopped')
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
    if (result.rows[0]) await finishSuggestionSubagent(this.pool, actor.userId, id, result.rows[0].state)
    return result.rows[0] ?? null
  }
}
