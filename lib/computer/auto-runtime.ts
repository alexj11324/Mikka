import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { botListChanged } from '../live/lists'

type Actor = { userId: string; workspaceId: string }
export type BotCloudRuntime = { botId: string; harness: 'codex' | 'claude_code'; agentId: string }

/** Task admission needs declared execution identities, not a live parent.
 * Tests can replace registration; production makes no provider calls here. */
export const botRuntimeProvisioner = {
  provision: async (pool: Pool, actor: Actor, botId: string) => {
    await (await import('./task-runtime')).ensureBotTaskRuntime(pool, actor, botId)
  },
}

/** The owner's Coordinator in this workspace: an ordinary bot row (glossary:
 * the Coordinator is a bot), named in coordinator_bots and created on first
 * use. Its cloud runtime is its own, so a Coordinator run never borrows
 * another bot's (#727). A bot the person already named "Coordinator" keeps
 * its name; this one takes the next free one. */
export async function ensureCoordinatorBot(pool: Pool, actor: Actor) {
  const find = async (query: Pick<Pool, 'query'>) => (await query.query<{ botId: string }>(
    'SELECT "botId" FROM coordinator_bots WHERE "ownerId"=$1 AND "workspaceId"=$2', [actor.userId, actor.workspaceId])).rows[0]?.botId
  const found = await find(pool)
  if (found) return found
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`coordinator-bot:${actor.userId}:${actor.workspaceId}`])
    let botId = await find(client)
    if (!botId) {
      const taken = new Set((await client.query<{ name: string }>(`SELECT lower(name) AS name FROM bots WHERE "ownerId"=$1 AND "workspaceId"=$2 AND lower(name) LIKE 'coordinator%'`, [actor.userId, actor.workspaceId])).rows.map(row => row.name))
      let name = 'Coordinator'
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `Coordinator ${n}`
      botId = randomUUID()
      await client.query('INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,$4)', [botId, actor.workspaceId, actor.userId, name])
      await client.query('INSERT INTO coordinator_bots ("ownerId","workspaceId","botId") VALUES ($1,$2,$3)', [actor.userId, actor.workspaceId, botId])
      await botListChanged(client, botId)
    }
    await client.query('COMMIT')
    return botId
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

async function findRuntime(pool: Pool, actor: Actor, botId: string, harness: string) {
  const rows = (await pool.query<BotCloudRuntime>(`SELECT r."botId",r.harness,r."agentId" FROM bot_cloud_runtimes r
    JOIN bots b ON b.id=r."botId" AND b."ownerId"=r."ownerId" AND b."workspaceId"=r."workspaceId" AND b."archivedAt" IS NULL
    JOIN bot_desktops desktop ON desktop."botId"=b.id AND desktop."ownerId"=b."ownerId" AND desktop."workspaceId"=b."workspaceId"
    JOIN agents a ON a.id=r."agentId" AND a."userId"=r."ownerId" AND a.harness=r.harness
    JOIN cloud_machines m ON m."deviceId"=a."deviceId" AND m."ownerId"=r."ownerId" AND m."workspaceId"=r."workspaceId"
    JOIN devices d ON d.id=m."deviceId" AND d."ownerId"=r."ownerId" AND d.kind='cloud' AND d.enabled=true
    WHERE r."botId"=$1 AND r."ownerId"=$2 AND r."workspaceId"=$3 AND ($4='auto' OR r.harness=$4) ORDER BY r.harness`,
  [botId, actor.userId, actor.workspaceId, harness])).rows
  return rows[0] ?? null
}

/** The runtime's Agent uses the owner's own connected subscription for its
 * harness when nothing is bound yet (orchestration § 2). A saved binding wins. */
async function bindOwnSubscription(pool: Pool, actor: Actor, runtime: BotCloudRuntime, model: string) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(model)) return
  const route = runtime.harness === 'codex' ? 'codex_cli' : 'claude_code_cli'
  const provider = runtime.harness === 'codex' ? 'codex' : 'claude'
  const hash = createHash('sha256').update(JSON.stringify(['auto-runtime-binding', actor.userId, runtime.agentId, route])).digest('hex')
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
    SELECT $1,$2,$3,$4,c.id,c.epoch,$5,$6 FROM byos_connections c
    WHERE c."ownerId"=$2 AND c.provider=$7 AND c.state='connected' AND c.paused=false
      AND NOT EXISTS (SELECT 1 FROM byos_bindings b WHERE b."ownerId"=$2 AND b."consumerId"=$4 AND b.route=$5)
    ORDER BY c."createdAt" DESC,c.id LIMIT 1 ON CONFLICT (id) DO NOTHING`,
  [id, actor.userId, actor.workspaceId, runtime.agentId, route, model, provider])
}

/** The bot's own task runtime is registered on first use. A fresh official
 * task container initializes its workspace and receives runtime credentials.
 * Registration never starts, connects to or changes the parent's VM. */
export async function ensureBotCloudRuntime(pool: Pool, actor: Actor, botId: string, target: { harness: string; model?: string }, provisioner = botRuntimeProvisioner) {
  if (!['auto', 'codex', 'claude_code'].includes(target.harness)) return null
  let runtime = await findRuntime(pool, actor, botId, target.harness)
  if (!runtime) {
    try { await provisioner.provision(pool, actor, botId) } catch { return null }
    runtime = await findRuntime(pool, actor, botId, target.harness)
    if (!runtime) return null
  }
  if (target.model) await bindOwnSubscription(pool, actor, runtime, target.model)
  return runtime
}
