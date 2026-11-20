// Synthetic model boundary for the existing isolated MVP acceptance environment.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { assertMvpEnvironment } from './isolated-env.mjs'
export const MVP_SUBSCRIPTION_MODEL = 'mvp-subscription-model'
export const MVP_NATIVE_ACCOUNT = 'mvp_synthetic_account'
export const MVP_NATIVE_TOKEN = 'mvp-synthetic-native-access'
export async function seedMvpSubscription(pool, ownerId) {
  assertMvpEnvironment()
  const { rows: [workspace] } = await pool.query(`SELECT w.id FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id WHERE m."userId"=$1 AND m.status='active' ORDER BY w."createdAt" LIMIT 1`, [ownerId])
  assert.ok(workspace, 'MVP owner needs its real workspace')
  const connectionId=randomUUID(),bindingId=randomUUID(),consumerId=randomUUID()
  await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,"secretName","secretDigest","providerSubject",quota) VALUES ($1,$2,$3,'codex','connected',$4,$5,'mvp-synthetic',$6)`,[connectionId,ownerId,workspace.id,`mvp-synthetic-${connectionId}`,'0'.repeat(64),JSON.stringify({vendor:'codex',source:'official',status:'ok',observedAt:new Date().toISOString(),plan:null,windows:[{kind:'five_hour',used:0.1,resetsAt:null}]})])
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,1,'codex_cpa',$6)`,[bindingId,ownerId,workspace.id,consumerId,connectionId,MVP_SUBSCRIPTION_MODEL])
  return { connectionId,bindingId,workspaceId:workspace.id }
}

/** The real daemon uses its existing test-only mock adapter. Seed a concrete
 * choice just as a person would save one; never rely on an automatic default. */
export async function seedMvpExecutionRule(pool,ownerId,workspaceId,deviceId) {
  assertMvpEnvironment()
  const device=await pool.query(`SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind='local' AND "removedAt" IS NULL AND harnesses @> '[{"harness":"mock","installed":true}]'::jsonb`,[deviceId,ownerId])
  assert.equal(device.rowCount,1,'MVP rule requires the actual registered mock daemon')
  await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position)
    VALUES ($1,$2,$3,NULL,$4,'mock',$5,2147483647)
    ON CONFLICT ("ownerId","workspaceId") WHERE label IS NULL DO UPDATE SET place=EXCLUDED.place,harness=EXCLUDED.harness,model=EXCLUDED.model`,[randomUUID(),ownerId,workspaceId,deviceId,MVP_SUBSCRIPTION_MODEL])
}

/** Current source-bound dispatch contract, for the trace fixture's synthetic
 * Codex protocol peer. It still uses the real person's own subscription. */
export async function seedMvpExecutionOrder(pool, ownerId, workspaceId, deviceId, connectionId) {
  assertMvpEnvironment()
  const device = await pool.query(`SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind='local' AND enabled=true AND "removedAt" IS NULL
    AND harnesses @> $3::jsonb`, [deviceId, ownerId, JSON.stringify([{ harness: 'codex', installed: true, subscriptionBroker: true, models: [MVP_SUBSCRIPTION_MODEL] }])])
  assert.equal(device.rowCount, 1, 'TRACE_REQUIRES_REGISTERED_SYNTHETIC_CODEX')
  const source = await pool.query(`SELECT id FROM byos_connections WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3
    AND provider='codex' AND state='connected' AND paused=false AND "removedAt" IS NULL`, [connectionId, ownerId, workspaceId])
  assert.equal(source.rowCount, 1, 'TRACE_REQUIRES_OWNED_SYNTHETIC_SUBSCRIPTION')
  await pool.query(`INSERT INTO model_order_settings ("ownerId","workspaceId",location,customized,"preferredHarness","autoModelRouting")
    VALUES ($1,$2,'local',true,'codex',false) ON CONFLICT ("ownerId","workspaceId")
    DO UPDATE SET location='local',customized=true,"preferredHarness"='codex',"autoModelRouting"=false,"updatedAt"=now()`, [ownerId, workspaceId])
  await pool.query(`INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId")
    VALUES ($1,$2,$3,0,'codex',$4,'subscription',$5)
    ON CONFLICT ("ownerId","workspaceId",harness,model,"sourceId") DO UPDATE SET position=0`, [randomUUID(), ownerId, workspaceId, MVP_SUBSCRIPTION_MODEL, connectionId])
}

