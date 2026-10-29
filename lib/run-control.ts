import { personalRunMessageText } from './personal-run-message'
import { and, eq, sql } from 'drizzle-orm'
import { ActionFailureError } from './action-error'
import { agentRuns, bots, deviceRepos, repositorySettings, runMessages } from './db/schema'
import { matchesRepositoryAdmission } from './repository-admission'
import { repositoryPushApproved } from './run-publication-policy'
import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'
import type { db } from './db'

export type RunControlDatabase = Pick<typeof db, 'transaction'>

/** Lock the owned run before checking its state so completion and messages serialize. */
export async function sendOwnedRunMessage(database: RunControlDatabase, userId: string, input: { runId: string; text: string }, origin: 'user' | 'peer' = 'user') {
  await database.transaction(async tx => {
    const [run] = await tx.select({ id: agentRuns.id, status: agentRuns.status, stopRequestedAt: agentRuns.stopRequestedAt,
      agentDefinition: agentRuns.agentDefinition, deviceRepoId: agentRuns.deviceRepoId, deviceId: agentRuns.deviceId,
      issueId: agentRuns.issueId, agentId: agentRuns.agentId, botId: agentRuns.botId })
      .from(agentRuns).where(and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, userId))).limit(1).for('update')
    if (!run || run.stopRequestedAt || !UNFINISHED_RUN_STATUSES.some(status => status === run.status)) throw new ActionFailureError('runNotFound')
    if (run.deviceRepoId) {
      const [repo] = await tx.select().from(deviceRepos).where(and(eq(deviceRepos.id, run.deviceRepoId), eq(deviceRepos.userId, userId))).limit(1)
      if (!repo || !repo.remoteUrl) throw new ActionFailureError('runInvalid')
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['repository-approval', userId, repo.repoPath])}, 0))`)
      const [setting] = await tx.select().from(repositorySettings).where(and(eq(repositorySettings.userId, userId), eq(repositorySettings.remoteKey, repo.repoPath))).limit(1)
      const receipt = run.agentDefinition?.repositoryAdmission
      if (receipt) {
        const [bot] = run.botId ? await tx.select().from(bots).where(and(eq(bots.id, run.botId), eq(bots.ownerId, userId))).for('share') : []
        if (!run.issueId || !run.deviceId || repo.deviceId !== run.deviceId || !matchesRepositoryAdmission(receipt, { userId, issueId: run.issueId, deviceId: run.deviceId, agentId: run.agentId,
          remoteKey: repo.repoPath, remoteUrl: repo.remoteUrl, targetBranch: receipt.targetBranch, workspaceId: bot?.workspaceId, workspaceLinked: receipt.workspaceLinked, requestEventId: receipt.requestEventId })
          || !await (await import('./run-admission-store')).acceptedEventStillMatches(receipt, run.botId, tx) || !repositoryPushApproved(setting?.push, userId)) throw new ActionFailureError('runInvalid')
      } else if (setting?.push?.approved === false) throw new ActionFailureError('runInvalid')
    }
    const id = crypto.randomUUID()
    await tx.insert(runMessages).values({ id, runId: run.id, userId, text: personalRunMessageText(id, input.text, origin) })
  })
}

/** Repeated stop requests preserve the original timestamp; foreign runs are rejected. */
export async function stopOwnedRun(database: RunControlDatabase, userId: string, runId: string) {
  await database.transaction(async tx => {
    const [run] = await tx.select({ id: agentRuns.id, status: agentRuns.status, stopRequestedAt: agentRuns.stopRequestedAt })
      .from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId))).limit(1).for('update')
    if (!run || !UNFINISHED_RUN_STATUSES.some(status => status === run.status)) throw new ActionFailureError('runNotFound')
    if (run.stopRequestedAt) return
    await tx.update(agentRuns).set({ stopRequestedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
  })
}
