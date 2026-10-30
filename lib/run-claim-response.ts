import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentRuns, devices, issues, githubCiObservations } from '@/lib/db/schema'
import { issueTeamAccess } from '@/lib/issue-team-access'
import { readIssueMetadata } from '@/lib/issue-metadata'

type Run = typeof agentRuns.$inferSelect

/** Authorize the response after all asynchronous claim preparation. Retirement
 * uses the same issue -> run locks. Building the response synchronously here
 * gives it an authorization point before retirement, or refuses it afterwards.
 * Bytes already handed to the transport cannot be recalled. No provider IO or
 * additional database work belongs in the response builder. */
export async function authorizedClaimResponse(userId: string, hint: Pick<Run, 'id' | 'issueId' | 'agentId' | 'deviceId' | 'deviceRepoId'>, leaseExpiresAt: string, respond: (run: Run) => Response, ciGeneration?: string): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    try { return await claimResponseTransaction(userId, hint, leaseExpiresAt, respond, ciGeneration) }
    catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : error
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null
      // A heartbeat may already hold the run before its issue-scope trigger.
      // Retry only a rolled-back local transaction, never claim/provider IO.
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error
    }
  }
}

async function claimResponseTransaction(userId: string, hint: Pick<Run, 'id' | 'issueId' | 'agentId' | 'deviceId' | 'deviceRepoId'>, leaseExpiresAt: string, respond: (run: Run) => Response, ciGeneration?: string) {
  return db.transaction(async tx => {
    if (!hint.issueId) return null
    const [issue] = await tx.select().from(issues).where(eq(issues.id, hint.issueId)).for('update')
    if (!issue || readIssueMetadata(issue.content).deletedAt) return null
    const [row] = await tx.select({ run: agentRuns, enabled: devices.enabled }).from(agentRuns)
      .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
      .where(and(eq(agentRuns.id, hint.id), eq(agentRuns.userId, userId), eq(devices.ownerId, userId)))
      .for('update', { of: agentRuns })
    if (!row?.enabled) return null
    const run = row.run
    if (run.issueId !== issue.id || run.deviceId !== hint.deviceId || run.agentId !== hint.agentId || run.deviceRepoId !== hint.deviceRepoId || run.status !== 'preparing' || run.stopRequestedAt || !run.leaseExpiresAt || run.leaseExpiresAt.toISOString() !== leaseExpiresAt || run.leaseExpiresAt.getTime() <= Date.now()) return null
    if (issue.userId !== userId && (issue.scope !== 'workspace' || !(await issueTeamAccess(issue.id, userId)).allowed)) return null
    if (run.ciContinuation) {
      const c = run.ciContinuation
      const [observation] = await tx.select().from(githubCiObservations).where(and(eq(githubCiObservations.userId, userId), eq(githubCiObservations.issueId, issue.id), eq(githubCiObservations.remoteKey, c.remoteKey), eq(githubCiObservations.prNumber, c.prNumber))).for('update')
      const [origin] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, c.originRunId), eq(agentRuns.userId, userId), eq(agentRuns.issueId, issue.id))).for('share')
      if (!observation || ciGeneration === undefined || String(observation.generation) !== ciGeneration || observation.originRunId !== c.originRunId || observation.scopeVersion !== c.scopeVersion || issue.scopeVersion !== c.scopeVersion || observation.head !== c.head || observation.fingerprint !== c.fingerprint || observation.expiresAt.getTime() <= Date.now() || !origin || origin.stopRequestedAt || origin.sessionId !== c.originSessionId || origin.agentId !== run.agentId || origin.deviceId !== run.deviceId || origin.deviceRepoId !== run.deviceRepoId || origin.botId !== run.botId || origin.agentDefinition?.definitionDigest !== run.agentDefinition?.definitionDigest) return null
    }
    return respond(run)
  })
}
