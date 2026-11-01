import { personalRunMessageText } from './personal-run-message'
import { and, eq, sql } from 'drizzle-orm'
import { ActionFailureError } from './action-error'
import { agentRuns, bots, deviceRepos, repositorySettings, runMessages } from './db/schema'
import { matchesRepositoryAdmission } from './repository-admission'
import { repositoryPushApproved } from './run-publication-policy'
import { remoteKey } from '@mikka/protocol/repository'
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
      let key: string
      try { key = remoteKey(repo.remoteUrl) } catch { throw new ActionFailureError('runInvalid') }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['repository-approval', userId, key])}, 0))`)
      const [setting] = await tx.select().from(repositorySettings).where(and(eq(repositorySettings.userId, userId), eq(repositorySettings.remoteKey, key))).limit(1)
      const receipt = run.agentDefinition?.repositoryAdmission
      if (receipt) {
        const [bot] = run.botId ? await tx.select().from(bots).where(and(eq(bots.id, run.botId), eq(bots.ownerId, userId))).for('share') : []
        if (!run.issueId || !run.deviceId || repo.deviceId !== run.deviceId || repo.repoPath !== key || !matchesRepositoryAdmission(receipt, { userId, issueId: run.issueId, deviceId: run.deviceId, agentId: run.agentId,
          remoteKey: key, remoteUrl: repo.remoteUrl, targetBranch: receipt.targetBranch, workspaceId: bot?.workspaceId, workspaceLinked: receipt.workspaceLinked, requestEventId: receipt.requestEventId })
          || !await (await import('./run-admission-store')).acceptedEventStillMatches(receipt, run.botId, tx) || !repositoryPushApproved(setting?.push, userId)) throw new ActionFailureError('runInvalid')
      } else if (setting?.push?.approved === false) throw new ActionFailureError('runInvalid')
    }
    const id = crypto.randomUUID()
    await tx.insert(runMessages).values({ id, runId: run.id, userId, text: personalRunMessageText(id, input.text, origin) })
  })
}

/**
 * Repeated stop requests preserve the original timestamp; foreign runs are rejected.
 * A queued run has no daemon to acknowledge the stop, so it ends here: status 'stopped'
 * in the same locked transaction (the claim route only takes status='queued' with no
 * stopRequestedAt, so it cannot pick it up). Returns true when this call ended the run;
 * the caller then runs afterRunEnded after commit.
 */
export async function stopOwnedRun(database: RunControlDatabase, userId: string, runId: string): Promise<boolean> {
  return database.transaction(async tx => {
    const [run] = await tx.select({ id: agentRuns.id, status: agentRuns.status, pauseReason: agentRuns.pauseReason, stopRequestedAt: agentRuns.stopRequestedAt })
      .from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId))).limit(1).for('update')
    if (!run || !UNFINISHED_RUN_STATUSES.some(status => status === run.status)) throw new ActionFailureError('runNotFound')
    const now = new Date()
    // A queued cloud run with a thread_machines binding may already hold (or be acquiring) a
    // sandbox. Ending it here would skip machine release, so it keeps the stop-request path
    // and the machine lifecycle acknowledges it. (Follow-up: release the binding directly.)
    const machineBound = run.status === 'queued'
      && (await tx.execute(sql`SELECT 1 FROM thread_machines WHERE "runId"=${runId} LIMIT 1`)).rows.length > 0
    // A run paused on its quota has no machine working on it: it ends here too.
    const quotaPaused = run.status === 'paused' && run.pauseReason === 'quota_exhausted'
    if ((run.status === 'queued' && !machineBound) || quotaPaused) {
      await tx.update(agentRuns).set({ status: 'stopped', pauseReason: null, stopRequestedAt: run.stopRequestedAt ?? now, finishedAt: now, updatedAt: now })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      return true
    }
    if (run.stopRequestedAt) return false
    await tx.update(agentRuns).set({ stopRequestedAt: now, updatedAt: now })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
    return false
  })
}
