import 'server-only'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { botWorkspacePath } from './bot-workspace'

type Actor = { userId: string; workspaceId: string }
type Runtime = { agentId: string; deviceId: string; repoId: string }

/** Register a missing executor only from this Bot's already prepared machine
 * and private workspace. No provider calls, machine wake or filesystem setup
 * belongs in the automatic-stage transaction. A fresh official task gets its
 * own harnesses; its host may register the same private workspace metadata
 * without treating the parent's installation as its execution capability. */
export async function ensureRecordedBotHarnessRuntime(
  tx: Pick<PoolClient, 'query'>, actor: Actor, botId: string, harness: string, options: { freshTask?: boolean } = {},
): Promise<Runtime | null> {
  if (harness !== 'claude_code' && harness !== 'codex') return null
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-runtime:${botId}`])
  const { rows: [machine] } = await tx.query<{ deviceId: string; state: string; runtimeReady: boolean; sandboxId: string | null }>(`SELECT d.id AS "deviceId",m.state,m."runtimeReady",m."sandboxId"
    FROM bots b JOIN bot_desktops desk ON desk."botId"=b.id AND desk."ownerId"=b."ownerId" AND desk."workspaceId"=b."workspaceId"
    JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
    JOIN devices d ON d.id=m."deviceId" AND d."ownerId"=b."ownerId" AND d.kind='cloud' AND d.enabled=true
    WHERE b.id=$1 AND b."ownerId"=$2 AND b."workspaceId"=$3 AND b."archivedAt" IS NULL
      AND ($6::boolean OR (d.harnesses @> $4::jsonb
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d.harnesses) info WHERE info->>'harness'=$5 AND info ? 'subscriptionPreflight')))
      FOR SHARE OF b,desk,m,d`,
  [botId, actor.userId, actor.workspaceId, JSON.stringify([{ harness, installed: true, subscriptionBroker: true, computerBroker: true }]), harness, options.freshTask === true])
  if (!machine) return null
  const { rows: [existing] } = await tx.query<Runtime>(`SELECT r."agentId",a."deviceId",r."repoId"
    FROM bot_cloud_runtimes r JOIN agents a ON a.id=r."agentId" AND a."userId"=r."ownerId" AND a.harness=r.harness
    JOIN device_repos repo ON repo.id=r."repoId" AND repo."userId"=r."ownerId" AND repo."deviceId"=a."deviceId"
    WHERE r."botId"=$1 AND r."ownerId"=$2 AND r."workspaceId"=$3 AND r.harness=$4 AND a."deviceId"=$5
    FOR SHARE OF r,a,repo`, [botId, actor.userId, actor.workspaceId, harness, machine.deviceId])
  if (existing) return existing
  // A stale or foreign slot cannot be repaired by adopting another identity.
  if ((await tx.query('SELECT 1 FROM bot_cloud_runtimes WHERE "botId"=$1 AND harness=$2', [botId, harness])).rowCount) return null
  if (!options.freshTask && (!machine.runtimeReady || !machine.sandboxId || !['running', 'sleeping'].includes(machine.state))) return null
  const { rows: [prepared] } = await tx.query<{ repoId: string }>(`SELECT repo.id AS "repoId"
    FROM bot_cloud_runtimes r JOIN agents a ON a.id=r."agentId" AND a."userId"=r."ownerId" AND a.harness=r.harness
    JOIN device_repos repo ON repo.id=r."repoId" AND repo."userId"=r."ownerId" AND repo."deviceId"=a."deviceId"
    WHERE r."botId"=$1 AND r."ownerId"=$2 AND r."workspaceId"=$3 AND a."deviceId"=$4
      AND repo."repoPath"=$5 AND repo."remoteUrl" IS NULL
    ORDER BY r.harness LIMIT 1 FOR SHARE OF r,a,repo`,
  [botId, actor.userId, actor.workspaceId, machine.deviceId, botWorkspacePath(botId)])
  if (!prepared) return null
  const name = `Cloud ${harness} ${botId}`
  const { rows: [orphan] } = await tx.query<{ id: string }>(`SELECT a.id FROM agents a
    WHERE a."userId"=$1 AND a.name=$2 AND a.harness=$3 AND a."deviceId"=$4 AND a.instructions=''
      AND NOT EXISTS (SELECT 1 FROM bot_cloud_runtimes r WHERE r."agentId"=a.id) FOR UPDATE OF a`,
  [actor.userId, name, harness, machine.deviceId])
  let agentId = orphan?.id
  if (!agentId) {
    const { rows: [created] } = await tx.query<{ id: string }>(`INSERT INTO agents (id,"userId",harness,name,"deviceId")
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id`, [randomUUID(), actor.userId, harness, name, machine.deviceId])
    if (!created) return null
    agentId = created.id
  }
  await tx.query(`INSERT INTO bot_cloud_runtimes ("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES ($1,$2,$3,$4,$5,$6)`,
    [botId, actor.workspaceId, actor.userId, harness, agentId, prepared.repoId])
  return { agentId, deviceId: machine.deviceId, repoId: prepared.repoId }
}
