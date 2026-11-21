import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { runPolicySchema } from '@mikka/protocol/agent-policy'
import { createFactoryClaim } from '../../lib/factory/claim'
import { factoryCheckAssignment } from '../../lib/factory/checks'
import { factoryMonitorDispatchAssignment } from '../../lib/factory/monitor-dispatch'
import { FactoryError } from '../../lib/factory/contract'
import { createFactoryStore } from '../../lib/factory/store'

/** Fixtures for tasks persisted before the host-frozen flowVersion existed.
 * Use the real lifecycle and receipt consumers. Only initial fixture materialization
 * removes the new host marker, including its initial snapshot, before work runs.
 * New flow tests must use createFactoryStore directly. */
export function createLegacyFactoryStore(...args: Parameters<typeof createFactoryStore>): ReturnType<typeof createFactoryStore> {
  const store = createFactoryStore(...args)
  const route = store.route
  store.route = async (...input) => {
    const result = await route(...input)
    const tx = input[2] ?? args[0]
    await tx.query(`UPDATE factory_tasks SET route=route-'flowVersion' WHERE id=$1`, [result.task.id])
    // Source-bound queue receipts can contain only { runId }, not a task
    // snapshot. Keep those acknowledgements intact when materializing legacy history.
    await tx.query(`UPDATE factory_events SET result=jsonb_set(result,'{task,route}',(result#>'{task,route}')-'flowVersion')
      WHERE "taskId"=$1 AND request->>'sourceEventId' IS NOT NULL
        AND result->'task'->>'id'=$1::text
        AND jsonb_typeof(result#>'{task,route}')='object'`, [result.task.id])
    delete result.task.route.flowVersion
    return result
  }
  return store
}

/** Drive the real check guard for schema-local review and monitor fixtures. */
export function claimFixtureFactoryCheck(pool: Pool, store: ReturnType<typeof createFactoryStore>) {
  const guard = createFactoryClaim(store, {
    claimContinuation: async () => { throw new Error('Expected a Factory check in the fixture') },
  }, (tx, task, runId) => task.stage === 'monitor'
    ? factoryMonitorDispatchAssignment(tx, task.userId, runId)
    : factoryCheckAssignment(tx, task.userId, runId))

  return async (userId: string, deviceId: string, runId: string, leaseExpiresAt: string, onClaim?: (tx: PoolClient) => Promise<void>) => {
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const assignment = await guard(tx, userId, deviceId, runId, leaseExpiresAt)
      await onClaim?.(tx)
      const policy = runPolicySchema.parse(assignment.policy)
      const baseBranch = z.string().parse(assignment.baseBranch)
      const updated = await tx.query(
        `UPDATE agent_runs SET status='preparing', "startedAt"=now(), "leaseExpiresAt"=$2, "updatedAt"=now()
          WHERE id=$1 AND status='queued' AND "stopRequestedAt" IS NULL`,
        [runId, leaseExpiresAt],
      )
      if (updated.rowCount !== 1) throw new FactoryError('factoryRunMismatch')
      await tx.query('COMMIT')
      return { ...assignment, policy, baseBranch }
    } catch (error) {
      await tx.query('ROLLBACK')
      throw error
    } finally {
      tx.release()
    }
  }
}
