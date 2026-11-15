import { connectForCommitEffects } from '../db/commit-effects'
import 'server-only'
import { withRunWorkspace } from '@/lib/run-completion'
import { assertLockedRunProfileClaim, assertRunProfileClaim, refreshCloudRunProfileClaim } from '@/lib/factory/profile-admission'
import { executionIdentityForRun, ExecutionIdentityError } from '../execution-identity'
import type { Pool, PoolClient } from 'pg'
import { computerPermission, type ComputerPermission } from './permission'
import { runMayUseCredentialSql } from '@/lib/personal-policy'
import { runListChanged } from '@/lib/live/lists'
import { armDueTimerAfterCommit } from '@/lib/due-timer'
import { advanceTaskAfterRunStart } from '@/lib/task-status-run-start'
import { taskActivityChanged } from '@/lib/factory/activity-live'

/** The existing local daemon cannot operate a Bot's cloud desktop. Keep its
 * claim serialized with Bot binding and fail closed until a cloud worker with
 * the computer tool can claim the run. */
export async function claimLocalRun(pool: Pool, runId: string, deviceId: string, leaseExpiresAt: Date, subscriptionBindingId?: string, beforeClaim?: (tx: PoolClient) => Promise<boolean | void>, afterClaim?: (tx: PoolClient) => Promise<void>): Promise<'claimed' | 'unavailable' | 'cloud-required'> {
  const { rows: [stored] } = await pool.query<{ userId: string; workspaceId: string | null }>(
    `SELECT r."userId",r."workspaceId" FROM agent_runs r JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
      WHERE r.id=$1 AND r."deviceId"=$2`, [runId, deviceId])
  if (!stored?.workspaceId) return 'unavailable'
  return await withRunWorkspace<'claimed' | 'unavailable' | 'cloud-required'>(stored.userId, stored.workspaceId, async () => {
  const client = await connectForCommitEffects(pool)
  try {
    await client.query('BEGIN')
    await executionIdentityForRun(client, runId)
    if (beforeClaim && (await beforeClaim(client)) === false) { await client.query('ROLLBACK'); return 'unavailable' }
    const run = (await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "deviceId"=$2 AND status=$3 AND "stopRequestedAt" IS NULL AND "workspaceId"=$4 AND "userId"=$5 FOR UPDATE', [runId, deviceId, 'queued', stored.workspaceId, stored.userId])).rows[0]
    if (!run) { await client.query('COMMIT'); return 'unavailable' }
    await assertRunProfileClaim(client, runId)
    if(await prepareLocalClaimBinding(client,runId,subscriptionBindingId)==='cloud-required'){await client.query('COMMIT');return 'cloud-required'}
    await client.query('UPDATE agent_runs SET status=$2,"startedAt"=now(),"leaseExpiresAt"=$3,"updatedAt"=now() WHERE id=$1', [runId, 'preparing', leaseExpiresAt])
    advanceTaskAfterRunStart(client, runId)
    // The lease is due to be reclaimed at its expiry if no heartbeat renews it (#1212).
    armDueTimerAfterCommit(client, 'run-recovery')
    await runListChanged(client, runId)
    await runChanged(client, runId)
    taskActivityChanged(client, runId)
    if (afterClaim) await afterClaim(client)
    await client.query('COMMIT')
    return 'claimed'
  } catch (error) {
    await client.query('ROLLBACK')
    if (error instanceof ExecutionIdentityError) return 'unavailable'
    throw error
  } finally { client.release() }
  }) ?? 'unavailable'
}

/** The scoped cloud device may claim only a run bound to its owner's Bot
 * and to that run's own thread machine. Binding and claim use the same run row lock.
 * A run frozen on an API key has no subscription binding (null): its key
 * was checked and recorded for it by `apiKeyForRun` before the claim. */
export async function claimCloudRun(pool: Pool, actor: { userId: string; workspaceId: string }, runId: string, deviceId: string, leaseExpiresAt: Date, subscriptionBindingId: string | null, beforeClaim?: (tx: PoolClient) => Promise<boolean | void>, afterClaim?: (tx: PoolClient) => Promise<void>, desktop = true): Promise<{ botId: string; ownerId: string; display: string; policyVersion: number; permission: ComputerPermission } | null> {
  const { rows: [stored] } = await pool.query<{ workspaceId: string | null }>(
    'SELECT "workspaceId" FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3',
    [runId, actor.userId, deviceId])
  if (!stored?.workspaceId || stored.workspaceId !== actor.workspaceId) return null
  return withRunWorkspace(actor.userId, stored.workspaceId, async () => {
  await refreshCloudRunProfileClaim(pool, actor, runId, deviceId, subscriptionBindingId)
  const client = await connectForCommitEffects(pool)
  try {
    await client.query('BEGIN')
    // Bot binding takes policy -> run locks. Acquire that same policy lock
    // before Factory authorization can lock its task/run.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    const policy = (await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0]
    // The workspace computer policy governs computer use only: a machine without a desktop takes
    // repository tasks under any policy, and its claim never carries a computer grant.
    if (desktop && computerPermission(policy?.permission) !== 'allow') { await client.query('COMMIT'); return null }
    const permission: ComputerPermission = desktop ? 'allow' : 'deny'
    await executionIdentityForRun(client, runId)
    if (beforeClaim && (await beforeClaim(client)) === false) { await client.query('ROLLBACK'); return null }
    const run = (await client.query<typeof import('@/lib/db/schema').agentRuns.$inferSelect>('SELECT * FROM agent_runs WHERE id=$1 AND "deviceId"=$2 AND "userId"=$3 AND status=$4 AND "stopRequestedAt" IS NULL AND "workspaceId"=$5 FOR UPDATE', [runId, deviceId, actor.userId, 'queued', stored.workspaceId])).rows[0]
    if (!run) { await client.query('COMMIT'); return null }
    await assertLockedRunProfileClaim(client, run)
    // Every cloud thread runs on its own thread machine; the Bot's computer serves only the Bot.
    const binding = (await client.query(`SELECT b."botId",1 AS display FROM computer_run_bindings b
      JOIN thread_machines m ON m."runId"=b."runId" AND m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId" AND m."deviceId"=$2
      JOIN devices dev ON dev.id=m."deviceId" AND dev."ownerId"=b."ownerId" AND dev.kind='cloud' AND dev.enabled=true
      WHERE b."runId"=$1 AND b."workspaceId"=$3 AND b."ownerId"=$4 AND m.state IN ('starting','running')`, [runId, deviceId, actor.workspaceId, actor.userId])).rows[0]
    if (!binding) { await client.query('COMMIT'); return null }
    // The run uses its own thread machine's desktop, never the Bot's: a person holding the Bot's desktop does not hold it.
    if (subscriptionBindingId) {
      const subscription = await client.query(`SELECT 1 FROM byos_bindings b WHERE b.id=$1 AND b."workspaceId"=$3 AND b."consumerId"=$4
        AND ${runMayUseCredentialSql('b."ownerId"', '$2', '$3')}`, [subscriptionBindingId, actor.userId, actor.workspaceId, run.agentId])
      if (!subscription.rowCount) { await client.query('COMMIT'); return null }
      await client.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)', [runId, subscriptionBindingId])
    } else if (!(await client.query('SELECT 1 FROM model_api_key_runs WHERE "runId"=$1', [runId])).rowCount) { await client.query('COMMIT'); return null }
    await client.query('UPDATE agent_runs SET status=$2,"startedAt"=now(),"leaseExpiresAt"=$3,"updatedAt"=now() WHERE id=$1', [runId, 'preparing', leaseExpiresAt])
    advanceTaskAfterRunStart(client, runId)
    // The lease is due to be reclaimed at its expiry if no heartbeat renews it (#1212).
    armDueTimerAfterCommit(client, 'run-recovery')
    await runListChanged(client, runId)
    await runChanged(client, runId)
    taskActivityChanged(client, runId)
    if (afterClaim) await afterClaim(client)
    await client.query('COMMIT')
    return { botId: binding.botId, ownerId: actor.userId, display: `:${binding.display}`, policyVersion: policy?.version ?? 0, permission }
  } catch (error) { await client.query('ROLLBACK'); if (error instanceof ExecutionIdentityError) return null; throw error } finally { client.release() }
  })
}

/** Existing local binding checks shared with Factory's already-fenced CAS. */
export async function prepareLocalClaimBinding(client:PoolClient,runId:string,subscriptionBindingId?:string):Promise<'ready'|'cloud-required'>{
  const bound=(await client.query('SELECT 1 FROM computer_run_bindings WHERE "runId"=$1',[runId])).rowCount
  if(bound)return 'cloud-required'
  if(subscriptionBindingId)await client.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)',[runId,subscriptionBindingId])
  return 'ready'
}

import { runChanged } from '../live/panels'
