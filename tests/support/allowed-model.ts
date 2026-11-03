// A person's 优先使用的模型 for DB fixtures: their own workspace, a connected ChatGPT
// subscription whose account lists gpt-5, and a computer whose Codex reports that model.
// Every run (Factory runs included) is frozen with a model chosen from this list.
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

export const ALLOWED_MODEL = 'gpt-5'
export const codexWithModel = [{ harness: 'codex', installed: true, subscriptionBroker: true, toolApproval: true, modelSlots: [{ slot: ALLOWED_MODEL, model: ALLOWED_MODEL, name: ALLOWED_MODEL }] }]

/** Gives `userId` a workspace (unless they have one) and an allowed Codex model. Needs the byos switch on (MIKKA_BYOS_ENABLED=1). */
export async function seedAllowedModel(pool: Pool, userId: string, options: { workspaceId?: string; deviceIds?: string[] } = {}) {
  let workspaceId = options.workspaceId
  if (!workspaceId) {
    const { rows: [member] } = await pool.query('SELECT "workspaceId" FROM mikka_workspace_members WHERE "userId"=$1 AND status=\'active\' LIMIT 1', [userId])
    workspaceId = member?.workspaceId as string | undefined
  }
  if (!workspaceId) {
    workspaceId = randomUUID()
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name,slug) VALUES ($1,$2,$3,$4)', [workspaceId, userId, 'Fixture personal workspace', `ws-${workspaceId.slice(0, 8)}`])
    await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [workspaceId, userId, `${userId}@example.invalid`])
  }
  const connection = randomUUID()
  await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,'codex','connected',1,$4,$5,'fixture-subject',$6,$7)`,
    [connection, userId, workspaceId, `fixture-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models: [ALLOWED_MODEL] }), JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .1, resetsAt: null }] })])
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa',$5)`, [randomUUID(), userId, workspaceId, connection, ALLOWED_MODEL])
  for (const deviceId of options.deviceIds ?? []) {
    await pool.query(`UPDATE devices SET harnesses=$2,enabled=true,"lastSeenAt"=coalesce("lastSeenAt",now()) WHERE id=$1`, [deviceId, JSON.stringify(codexWithModel)])
  }
  return { workspaceId, connectionId: connection }
}

/** Removes what seedAllowedModel wrote for these people. */
export async function cleanAllowedModels(pool: Pool, userIds: string[]) {
  await pool.query('DELETE FROM model_order_entries WHERE "ownerId" = ANY($1)', [userIds]).catch(() => undefined)
  await pool.query('DELETE FROM model_order_settings WHERE "ownerId" = ANY($1)', [userIds]).catch(() => undefined)
  await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [userIds])
  await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [userIds])
}
