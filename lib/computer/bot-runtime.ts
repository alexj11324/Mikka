import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Pool } from 'pg'
import type { Sandbox } from 'e2b'

/** Provision the Bot's private working tree and hidden execution identities.
 * A Bot remains the owner of its desktop; these are only thread executors. */
export async function ensureBotRuntime(pool: Pool, actor: { userId: string; workspaceId: string }, botId: string, sandbox: Sandbox, deviceId: string) {
  z.uuid().parse(botId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-runtime:${botId}`])
    const machine = (await client.query(`SELECT d.harnesses FROM bots b
      JOIN bot_desktops desk ON desk."botId"=b.id AND desk."ownerId"=b."ownerId" AND desk."workspaceId"=b."workspaceId"
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
      JOIN devices d ON d.id=m."deviceId" AND d."ownerId"=b."ownerId" AND d.kind='cloud' AND d.enabled=true
      WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3 AND m."sandboxId"=$4 AND d.id=$5 FOR UPDATE OF m`,
    [botId, actor.userId, actor.workspaceId, sandbox.sandboxId, deviceId])).rows[0]
    if (!machine) throw new Error('Bot runtime unavailable')
    const harnesses = (Array.isArray(machine.harnesses) ? machine.harnesses : []).filter((h: { harness?: string; installed?: boolean; subscriptionBroker?: boolean; computerBroker?: boolean }) =>
      (h.harness === 'codex' || h.harness === 'claude_code') && h.installed === true && h.subscriptionBroker === true && h.computerBroker === true)
    if (!harnesses.length) throw new Error('Bot runtime unavailable')
    const path = `/home/user/.mikka/bot-workspaces/${botId}`
    await sandbox.commands.run(`install -d -m 0700 ${path}; if ! test -d ${path}/.git; then git -C ${path} init -q -b main && git -C ${path} -c user.name=Mikka -c user.email=bot@mikka.invalid commit --allow-empty -qm init; fi; git -C ${path} rev-parse --verify main >/dev/null`, { user: 'user', timeoutMs: 20_000 })
    const repo = (await client.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch") VALUES ($1,$2,$3,$4,'main')
      ON CONFLICT ("deviceId","repoPath") DO UPDATE SET "repoPath"=EXCLUDED."repoPath" WHERE device_repos."userId"=EXCLUDED."userId" RETURNING id`, [randomUUID(), deviceId, actor.userId, path])).rows[0]
    if (!repo) throw new Error('Bot runtime unavailable')
    for (const info of harnesses) {
      const existing = (await client.query(`SELECT x."agentId",x."repoId",a."deviceId" FROM bot_cloud_runtimes x JOIN agents a ON a.id=x."agentId" AND a."userId"=x."ownerId"
        WHERE x."botId"=$1 AND x.harness=$2 AND x."ownerId"=$3 AND x."workspaceId"=$4 FOR UPDATE OF x,a`,
      [botId, info.harness, actor.userId, actor.workspaceId])).rows[0]
      if (existing) {
        // The machine's device can change, or a device removal unbinds the agent
        // (lib/device-removal.ts): the bot keeps its runtime and moves it here.
        if (existing.deviceId !== deviceId) await client.query('UPDATE agents SET "deviceId"=$3,"updatedAt"=now() WHERE id=$1 AND "userId"=$2', [existing.agentId, actor.userId, deviceId])
        if (existing.repoId !== repo.id) await client.query('UPDATE bot_cloud_runtimes SET "repoId"=$4 WHERE "botId"=$1 AND harness=$2 AND "ownerId"=$3', [botId, info.harness, actor.userId, repo.id])
        continue
      }
      const agentId = randomUUID()
      await client.query('INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,$3,$4,$5)', [agentId, actor.userId, info.harness, `Cloud ${info.harness} ${botId}`, deviceId])
      await client.query('INSERT INTO bot_cloud_runtimes ("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES ($1,$2,$3,$4,$5,$6)', [botId, actor.workspaceId, actor.userId, info.harness, agentId, repo.id])
    }
    const rows = (await client.query('SELECT harness,"agentId","repoId" FROM bot_cloud_runtimes WHERE "botId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 ORDER BY harness', [botId, actor.userId, actor.workspaceId])).rows
    await client.query('COMMIT')
    return rows as { harness: 'codex' | 'claude_code'; agentId: string; repoId: string }[]
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
