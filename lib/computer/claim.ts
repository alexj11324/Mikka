import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { computerPermission } from './permission'

/** The existing local daemon cannot operate a Bot's cloud desktop. Keep its
 * claim serialized with Bot binding and fail closed until a cloud worker with
 * the computer tool can claim the run. */
export async function claimLocalRun(pool: Pool, runId: string, deviceId: string, leaseExpiresAt: Date, subscriptionBindingId?: string, beforeClaim?: (tx: PoolClient) => Promise<boolean | void>, afterClaim?: (tx: PoolClient) => Promise<void>): Promise<'claimed' | 'unavailable' | 'cloud-required'> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (beforeClaim && (await beforeClaim(client)) === false) { await client.query('ROLLBACK'); return 'unavailable' }
    const run = (await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "deviceId"=$2 AND status=$3 AND "stopRequestedAt" IS NULL FOR UPDATE', [runId, deviceId, 'queued'])).rows[0]
    if (!run) { await client.query('COMMIT'); return 'unavailable' }
    if(await prepareLocalClaimBinding(client,runId,subscriptionBindingId)==='cloud-required'){await client.query('COMMIT');return 'cloud-required'}
    await client.query('UPDATE agent_runs SET status=$2,"startedAt"=now(),"leaseExpiresAt"=$3,"updatedAt"=now() WHERE id=$1', [runId, 'preparing', leaseExpiresAt])
    if (afterClaim) await afterClaim(client)
    await client.query('COMMIT')
    return 'claimed'
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

/** The scoped cloud device may claim only a run bound to its owner's Bot
 * and its workspace's machine. Binding and claim use the same run row lock.
 * A run frozen on an API key has no subscription binding (null): its key
 * was checked and recorded for it by `apiKeyForRun` before the claim. */
export async function claimCloudRun(pool: Pool, actor: { userId: string; workspaceId: string }, runId: string, deviceId: string, leaseExpiresAt: Date, subscriptionBindingId: string | null, beforeClaim?: (tx: PoolClient) => Promise<boolean | void>, afterClaim?: (tx: PoolClient) => Promise<void>): Promise<{ botId: string; ownerId: string; display: string; policyVersion: number; permission: 'allow' } | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Bot binding takes policy -> run locks. Acquire that same policy lock
    // before either Factory authorization check can lock its task/run.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    if (beforeClaim && (await beforeClaim(client)) === false) { await client.query('ROLLBACK'); return null }
    const policy = (await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0]
    const permission = computerPermission(policy?.permission)
    if (permission !== 'allow') { await client.query('COMMIT'); return null }
    if (beforeClaim && (await beforeClaim(client)) === false) { await client.query('ROLLBACK'); return null }
    const run = (await client.query('SELECT id,"agentId" FROM agent_runs WHERE id=$1 AND "deviceId"=$2 AND "userId"=$3 AND status=$4 AND "stopRequestedAt" IS NULL FOR UPDATE', [runId, deviceId, actor.userId, 'queued'])).rows[0]
    if (!run) { await client.query('COMMIT'); return null }
    const binding = process.env.MIKKA_CLOUD_THREAD_MACHINES === '1' ? (await client.query(`SELECT b."botId",1 AS display FROM computer_run_bindings b
      JOIN thread_machines m ON m."runId"=b."runId" AND m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId" AND m."deviceId"=$2
      JOIN devices dev ON dev.id=m."deviceId" AND dev."ownerId"=b."ownerId" AND dev.kind='cloud' AND dev.enabled=true
      WHERE b."runId"=$1 AND b."workspaceId"=$3 AND b."ownerId"=$4 AND m.state IN ('starting','running')`, [runId, deviceId, actor.workspaceId, actor.userId])).rows[0] : (await client.query(`SELECT b."botId",d.display FROM computer_run_bindings b
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId" AND m."deviceId"=$2
      JOIN devices dev ON dev.id=m."deviceId" AND dev."ownerId"=b."ownerId" AND dev.kind='cloud' AND dev.enabled=true
      JOIN bot_desktops d ON d."botId"=b."botId" AND d."workspaceId"=b."workspaceId" AND d."ownerId"=b."ownerId"
      WHERE b."runId"=$1 AND b."workspaceId"=$3 AND b."ownerId"=$4`, [runId, deviceId, actor.workspaceId, actor.userId])).rows[0]
    if (!binding) { await client.query('COMMIT'); return null }
    const held = await client.query(`SELECT 1 FROM bot_desktops WHERE "botId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND control='user' AND "controlUntil">now()`, [binding.botId, actor.userId, actor.workspaceId])
    if (held.rowCount) { await client.query('COMMIT'); return null }
    if (subscriptionBindingId) {
      const subscription = await client.query('SELECT 1 FROM byos_bindings WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "consumerId"=$4', [subscriptionBindingId, actor.userId, actor.workspaceId, run.agentId])
      if (!subscription.rowCount) { await client.query('COMMIT'); return null }
      await client.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)', [runId, subscriptionBindingId])
    } else if (!(await client.query('SELECT 1 FROM model_api_key_runs WHERE "runId"=$1', [runId])).rowCount) { await client.query('COMMIT'); return null }
    await client.query('UPDATE agent_runs SET status=$2,"startedAt"=now(),"leaseExpiresAt"=$3,"updatedAt"=now() WHERE id=$1', [runId, 'preparing', leaseExpiresAt])
    if (afterClaim) await afterClaim(client)
    await client.query('COMMIT')
    return { botId: binding.botId, ownerId: actor.userId, display: `:${binding.display}`, policyVersion: policy?.version ?? 0, permission }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** Existing local binding checks shared with Factory's already-fenced CAS. */
export async function prepareLocalClaimBinding(client:PoolClient,runId:string,subscriptionBindingId?:string):Promise<'ready'|'cloud-required'>{
  const bound=(await client.query('SELECT 1 FROM computer_run_bindings WHERE "runId"=$1',[runId])).rowCount
  if(bound)return 'cloud-required'
  if(subscriptionBindingId)await client.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)',[runId,subscriptionBindingId])
  return 'ready'
}
