import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { lockSubscriptionBinding } from '../subscription-binding-lock'

const inputSchema = z.object({ botId: z.uuid(), connectionId: z.uuid(), revision: z.number().int().positive(), harness: z.enum(['codex', 'claude_code']), modelId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/), idempotencyKey: z.string().min(1).max(256).optional() }).strict()

/** Bind one explicitly selected, connected account to this Bot's executor.
 * The user/workspace scope is supplied by an authenticated caller. */
export async function bindBotSubscription(pool: Pool, actor: { userId: string; workspaceId: string }, value: z.infer<typeof inputSchema>) {
  const input = inputSchema.parse(value)
  const route = input.harness === 'codex' ? 'codex_cli' : 'claude_code_cli'
  const provider = input.harness === 'codex' ? 'codex' : 'claude'
  const hash = input.idempotencyKey && createHash('sha256').update(JSON.stringify(['bot-subscription', actor.userId, input.idempotencyKey])).digest('hex')
  const id = hash ? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}` : randomUUID()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const runtime = (await client.query('SELECT "agentId" FROM bot_cloud_runtimes WHERE "botId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND harness=$4', [input.botId, actor.userId, actor.workspaceId, input.harness])).rows[0]
    if (!runtime) throw new Error('Bot subscription unavailable')
    await lockSubscriptionBinding(client, actor.userId, runtime.agentId, route)
    await client.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      SELECT $1,$2,$3,$4,id,epoch,$7,$8 FROM byos_connections WHERE id=$5 AND "ownerId"=$2 AND "workspaceId"=$3
        AND epoch=$6 AND state='connected' AND provider=$9 ON CONFLICT (id) DO NOTHING`,
    [id, actor.userId, actor.workspaceId, runtime.agentId, input.connectionId, input.revision, route, input.modelId, provider])
    const result = await client.query(`SELECT b.id FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId"
      WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3 AND b."consumerId"=$4 AND b."connectionId"=$5
        AND b."connectionRevision"=$6 AND b.route=$7 AND b."modelId"=$8 AND c."ownerId"=$2 AND c."workspaceId"=$3
        AND c.epoch=$6 AND c.state='connected' AND c.provider=$9`,
    [id, actor.userId, actor.workspaceId, runtime.agentId, input.connectionId, input.revision, route, input.modelId, provider])
    if (!result.rowCount) throw new Error('Bot subscription unavailable')
    await client.query('COMMIT')
    return { bindingId: id }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
