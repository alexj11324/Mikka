import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db, pool, withDatabaseClient } from '@/lib/db'
import { revalidateExecutionIdentity, ExecutionIdentityError } from '@/lib/execution-identity'
import { agentRuns, devices, issues } from '@/lib/db/schema'
import { mayCompleteIssue, withRunWorkspace } from '@/lib/run-completion'
import { lockResourceAccess } from '@/lib/resource-access/store'
import { ActionFailureError } from '@/lib/action-error'

type Run = typeof agentRuns.$inferSelect
type ClaimTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type ResourceFence = (run: Run, tx: ClaimTransaction) => Promise<boolean>

/** Authorize the response after all asynchronous claim preparation. Retirement
 * uses the same issue -> run locks. Building the response synchronously here
 * gives it an authorization point before retirement, or refuses it afterwards.
 * Bytes already handed to the transport cannot be recalled. No provider IO or
 * additional database work belongs in the response builder. */
export async function authorizedClaimResponse(userId: string, hint: Pick<Run, 'id' | 'issueId' | 'agentId' | 'deviceId' | 'deviceRepoId'>, leaseExpiresAt: string, respond: (run: Run) => Response, authorizeResources?: ResourceFence): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const [stored] = await db.select({ workspaceId: agentRuns.workspaceId }).from(agentRuns)
        .where(and(eq(agentRuns.id, hint.id), eq(agentRuns.userId, userId))).limit(1)
      if (!stored?.workspaceId) return null
      return await withRunWorkspace(userId, stored.workspaceId, () => claimResponseTransaction(userId, hint, leaseExpiresAt, respond, stored.workspaceId!, authorizeResources))
    }
    catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : error
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
      // A heartbeat may already hold the run before its issue-scope trigger.
      // Retry only a rolled-back local transaction, never claim/provider IO.
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error
    }
  }
}

async function claimResponseTransaction(userId: string, hint: Pick<Run, 'id' | 'issueId' | 'agentId' | 'deviceId' | 'deviceRepoId'>, leaseExpiresAt: string, respond: (run: Run) => Response, workspaceId: string, authorizeResources?: ResourceFence) {
  const client = await pool.connect()
  try {
    return await withDatabaseClient(client, () => db.transaction(async tx => {
      if (!hint.issueId) return null
      try { await lockResourceAccess(tx, userId, { kind: 'thread', id: hint.id, workspaceId }, 'canSteer') }
      catch (error) { if (error instanceof ActionFailureError) return null; throw error }
      const [issue] = await tx.select().from(issues).where(eq(issues.id, hint.issueId)).for('update')
      if (!issue || !await mayCompleteIssue(issue, userId, workspaceId)) return null
      const [row] = await tx.select({ run: agentRuns, enabled: devices.enabled }).from(agentRuns)
        .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
        .where(and(eq(agentRuns.id, hint.id), eq(agentRuns.userId, userId), eq(devices.ownerId, userId)))
        .for('update', { of: agentRuns })
      if (!row?.enabled) return null
      const run = row.run
      if (run.workspaceId !== workspaceId || run.issueId !== issue.id || run.deviceId !== hint.deviceId || run.agentId !== hint.agentId || run.deviceRepoId !== hint.deviceRepoId || run.status !== 'preparing' || run.stopRequestedAt || !run.leaseExpiresAt || run.leaseExpiresAt.toISOString() !== leaseExpiresAt || run.leaseExpiresAt.getTime() <= Date.now()) return null
      try {
        const identity = await revalidateExecutionIdentity(pool, run)
        if (identity && identity.workspaceId !== workspaceId) return null
      }
      catch (error) { if (error instanceof ExecutionIdentityError) return null; throw error }
      try { if (authorizeResources && !await authorizeResources(run, tx)) return null }
      catch (error) { if (error instanceof ActionFailureError) return null; throw error }
      return respond(run)
    }))
  } finally { client.release() }
}
