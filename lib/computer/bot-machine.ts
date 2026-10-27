import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import * as provider from './e2b-provider'

type Actor = { userId: string; workspaceId: string }

/** A web subagent needs the shared Bot machine, but not an X display. */
export async function ensureBotMachine(pool: Pool, actor: Actor, botId: string, runtime = provider) {
  const owned = await pool.query('SELECT 1 FROM bots WHERE id=$1 AND "workspaceId"=$2 AND "ownerId"=$3', [botId, actor.workspaceId, actor.userId])
  if (!owned.rowCount) throw new Error('Bot machine unavailable')
  await pool.query('INSERT INTO cloud_machines ("workspaceId","ownerId","operationId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [actor.workspaceId, actor.userId, randomUUID()])
  const client = await pool.connect()
  let persistProgress = false
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    const bot = await client.query('SELECT 1 FROM bots WHERE id=$1 AND "workspaceId"=$2 AND "ownerId"=$3', [botId, actor.workspaceId, actor.userId])
    const machine = (await client.query('SELECT * FROM cloud_machines WHERE "workspaceId"=$1 FOR UPDATE', [actor.workspaceId])).rows[0]
    const policy = (await client.query('SELECT permission FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0]
    if (!bot.rowCount || !machine || machine.ownerId !== actor.userId || policy?.permission === 'deny') throw new Error('Bot machine unavailable')
    let sandbox
    if (machine.sandboxId) sandbox = await runtime.connectComputer(machine.sandboxId)
    else {
      sandbox = await runtime.createComputer(actor.workspaceId, machine.operationId)
      await client.query('UPDATE cloud_machines SET "sandboxId"=$2,state=$3 WHERE "workspaceId"=$1', [actor.workspaceId, sandbox.sandboxId, 'waking'])
      persistProgress = true
    }
    if (!machine.runtimeReady) {
      await runtime.installComputerRuntime(sandbox)
      await client.query('UPDATE cloud_machines SET "runtimeReady"=true WHERE "workspaceId"=$1', [actor.workspaceId])
      persistProgress = true
    }
    await client.query('UPDATE cloud_machines SET state=$2,"lastActiveAt"=now() WHERE "workspaceId"=$1', [actor.workspaceId, 'running'])
    await client.query('COMMIT')
    return sandbox
  } catch (error) {
    if (persistProgress) await client.query('COMMIT'); else await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}
