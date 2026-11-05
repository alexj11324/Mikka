import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { botWorkspacePath } from './bot-workspace'
import { recordBotRuntime } from './bot-runtime'

/** Declare the Bot's task identities without allocating or contacting a parent
 * VM. Official task templates supply their own harnesses; these rows are not
 * a claim that a parent worker is online or has installed either harness. */
export async function ensureBotTaskRuntime(pool: Pool, actor: { userId: string; workspaceId: string }, botId: string) {
  z.uuid().parse(botId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-runtime:${botId}`])
    const bot = await client.query(`SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3
      AND "archivedAt" IS NULL FOR SHARE`, [botId, actor.userId, actor.workspaceId])
    if (!bot.rowCount) throw new Error('Bot runtime unavailable')
    await client.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId")
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actor.workspaceId, actor.userId, randomUUID()])
    // This same machine lock serializes desktop numbering with explicit
    // ComputerStore.operate. Existing state, leases and sandbox are untouched.
    const machine = (await client.query(`SELECT "deviceId" FROM cloud_machines
      WHERE "workspaceId"=$1 AND "ownerId"=$2 FOR UPDATE`, [actor.workspaceId, actor.userId])).rows[0]
    if (!machine) throw new Error('Bot runtime unavailable')
    let deviceId: string = machine.deviceId
    if (deviceId) {
      const device = await client.query(`SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2
        AND kind='cloud' AND enabled=true FOR SHARE`, [deviceId, actor.userId])
      if (!device.rowCount) throw new Error('Bot runtime unavailable')
    } else {
      deviceId = randomUUID()
      await client.query(`INSERT INTO devices (id,"ownerId",name,kind,"nameLocked")
        VALUES ($1,$2,'Cloud computer','cloud',true)`, [deviceId, actor.userId])
      await client.query(`UPDATE cloud_machines SET "deviceId"=$3 WHERE "workspaceId"=$1 AND "ownerId"=$2`,
        [actor.workspaceId, actor.userId, deviceId])
    }
    const desktop = (await client.query(`SELECT "ownerId","workspaceId" FROM bot_desktops WHERE "botId"=$1 FOR UPDATE`, [botId])).rows[0]
    if (desktop) {
      if (desktop.ownerId !== actor.userId || desktop.workspaceId !== actor.workspaceId) throw new Error('Bot runtime unavailable')
    } else {
      const next = Number((await client.query(`SELECT coalesce(max(display),0)+1 AS n FROM bot_desktops
        WHERE "workspaceId"=$1 AND "ownerId"=$2`, [actor.workspaceId, actor.userId])).rows[0].n)
      if (next > 999) throw new Error('Desktop limit reached')
      await client.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,$4)`,
        [botId, actor.workspaceId, actor.userId, next])
    }
    const rows = await recordBotRuntime(client, actor, botId, deviceId, botWorkspacePath(botId),
      [{ harness: 'claude_code' }, { harness: 'codex' }])
    await client.query('COMMIT')
    return rows
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
