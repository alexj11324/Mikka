import 'server-only'
import type { Pool } from 'pg'

/** The existing local daemon cannot operate a Bot's cloud desktop. Keep its
 * claim serialized with Bot binding and fail closed until a cloud worker with
 * the computer tool and approval gate can claim the run. */
export async function claimLocalRun(pool: Pool, runId: string, deviceId: string, leaseExpiresAt: Date, subscriptionBindingId?: string): Promise<'claimed' | 'unavailable' | 'cloud-required'> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const run = (await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "deviceId"=$2 AND status=$3 AND "stopRequestedAt" IS NULL FOR UPDATE', [runId, deviceId, 'queued'])).rows[0]
    if (!run) { await client.query('COMMIT'); return 'unavailable' }
    const bound = (await client.query('SELECT 1 FROM computer_run_bindings WHERE "runId"=$1', [runId])).rowCount
    if (bound) { await client.query('COMMIT'); return 'cloud-required' }
    if (subscriptionBindingId) await client.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)', [runId, subscriptionBindingId])
    await client.query('UPDATE agent_runs SET status=$2,"startedAt"=now(),"leaseExpiresAt"=$3,"updatedAt"=now() WHERE id=$1', [runId, 'preparing', leaseExpiresAt])
    await client.query('COMMIT')
    return 'claimed'
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

/** The scoped cloud device may claim only a run bound to its owner's Bot
 * and its workspace's machine. Binding and claim use the same run row lock. */
export async function claimCloudRun(pool: Pool, actor: { userId: string; workspaceId: string }, runId: string, deviceId: string, leaseExpiresAt: Date, subscriptionBindingId: string): Promise<{ botId: string; ownerId: string; display: string; policyVersion: number } | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    const policy = (await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0]
    if (policy?.permission === 'deny') { await client.query('COMMIT'); return null }
    const run = (await client.query('SELECT id,"agentId" FROM agent_runs WHERE id=$1 AND "deviceId"=$2 AND "userId"=$3 AND status=$4 AND "stopRequestedAt" IS NULL FOR UPDATE', [runId, deviceId, actor.userId, 'queued'])).rows[0]
    if (!run) { await client.query('COMMIT'); return null }
    const binding = (await client.query(`SELECT b."botId",d.display FROM computer_run_bindings b
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId" AND m."deviceId"=$2
      JOIN devices dev ON dev.id=m."deviceId" AND dev."ownerId"=b."ownerId" AND dev.kind='cloud' AND dev.enabled=true
      JOIN bot_desktops d ON d."botId"=b."botId" AND d."workspaceId"=b."workspaceId" AND d."ownerId"=b."ownerId"
      WHERE b."runId"=$1 AND b."workspaceId"=$3 AND b."ownerId"=$4`, [runId, deviceId, actor.workspaceId, actor.userId])).rows[0]
    if (!binding) { await client.query('COMMIT'); return null }
    const subscription = await client.query('SELECT 1 FROM byos_bindings WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "consumerId"=$4', [subscriptionBindingId, actor.userId, actor.workspaceId, run.agentId])
    if (!subscription.rowCount) { await client.query('COMMIT'); return null }
    await client.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)', [runId, subscriptionBindingId])
    await client.query('UPDATE agent_runs SET status=$2,"startedAt"=now(),"leaseExpiresAt"=$3,"updatedAt"=now() WHERE id=$1', [runId, 'preparing', leaseExpiresAt])
    await client.query('COMMIT')
    return { botId: binding.botId, ownerId: actor.userId, display: `:${binding.display}`, policyVersion: policy?.version ?? 0 }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
