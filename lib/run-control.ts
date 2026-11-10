import { personalRunMessageText } from './personal-run-message'
import { MAILBOX_NOTIFICATION_LIMIT } from './mailbox-notification-budget'
import { and, eq, sql } from 'drizzle-orm'
import { ActionFailureError } from './action-error'
import { agentRuns, bots, deviceRepos, runMessages } from './db/schema'
import { matchesRepositoryAdmission } from './repository-admission'
import { remoteKey } from '@mikka/protocol/repository'
import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'
import type { db } from './db'
import { notifyDeviceWork } from './device-gateway-notify'
import { runChanged } from './live/panels'
import { runListChanged } from './live/lists'

export type RunControlDatabase = Pick<typeof db, 'transaction'>
export type RunMessageWriter = Pick<typeof db, 'select' | 'insert'>

/** Lock the owned run before checking its state so completion and messages serialize. */
export async function sendOwnedRunMessage(database: RunControlDatabase, userId: string, input: { runId: string; text: string; messageId?: string }, origin: 'user' | 'peer' = 'user') {
  const deviceId = await database.transaction(tx => sendOwnedRunMessageInTransaction(tx, userId, input, origin))
  notifyDeviceWork(deviceId)
}

/** Compose with an existing authorization transaction. The caller owns its
 * commit and the subsequent device wake; no second inbox or nested commit. */
export async function sendOwnedRunMessageInTransaction(tx: RunMessageWriter, userId: string,
  input: { runId: string; text: string; messageId?: string }, origin: 'user' | 'peer' = 'user') {
  const [run] = await tx.select({ id: agentRuns.id, status: agentRuns.status, stopRequestedAt: agentRuns.stopRequestedAt,
    agentDefinition: agentRuns.agentDefinition, deviceRepoId: agentRuns.deviceRepoId, deviceId: agentRuns.deviceId,
    issueId: agentRuns.issueId, agentId: agentRuns.agentId, botId: agentRuns.botId, workspaceId: agentRuns.workspaceId })
    .from(agentRuns).where(and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, userId))).limit(1).for('update')
  if (!run) throw new ActionFailureError('runNotFound')
  if (input.messageId) {
    const [prior] = await tx.select().from(runMessages).where(eq(runMessages.id, input.messageId)).limit(1)
    if (prior) {
      if (prior.runId !== run.id || prior.userId !== userId || prior.origin !== (origin === 'user' ? 'owner' : 'peer')
        || prior.text !== personalRunMessageText(input.messageId, input.text, origin)) throw new ActionFailureError('submissionConflict')
      return null
    }
  }
  if (run.stopRequestedAt || !UNFINISHED_RUN_STATUSES.some(status => status === run.status)) throw new ActionFailureError('runNotFound')
  if (run.deviceRepoId) {
    const [repo] = await tx.select().from(deviceRepos).where(and(eq(deviceRepos.id, run.deviceRepoId), eq(deviceRepos.userId, userId))).limit(1)
    if (!repo || !repo.remoteUrl) throw new ActionFailureError('runInvalid')
    let key: string
    try { key = remoteKey(repo.remoteUrl) } catch { throw new ActionFailureError('runInvalid') }
    // The receipt binds the task to its repository and branch.
    const receipt = run.agentDefinition?.repositoryAdmission
    if (receipt) {
      const [bot] = run.botId ? await tx.select().from(bots).where(and(eq(bots.id, run.botId), eq(bots.ownerId, userId))).for('share') : []
      if ((run.botId && bot?.workspaceId !== run.workspaceId) || !run.issueId || !run.deviceId || repo.deviceId !== run.deviceId || repo.repoPath !== key || !matchesRepositoryAdmission(receipt, { userId, issueId: run.issueId, deviceId: run.deviceId, agentId: run.agentId,
        remoteKey: key, remoteUrl: repo.remoteUrl, targetBranch: receipt.targetBranch, workspaceId: run.workspaceId ?? undefined, workspaceLinked: receipt.workspaceLinked, requestEventId: receipt.requestEventId })
        || !await (await import('./run-admission-store')).acceptedEventStillMatches(receipt, run.botId, tx)) throw new ActionFailureError('runInvalid')
    }
  }
  const id = input.messageId ?? crypto.randomUUID()
  await tx.insert(runMessages).values({ id, runId: run.id, userId, text: personalRunMessageText(id, input.text, origin),
    origin: origin === 'user' ? 'owner' : 'peer', mailboxWakeDepth: origin === 'user' ? -1 : MAILBOX_NOTIFICATION_LIMIT })
  await runChanged(tx, run.id)
  return run.deviceId
}

/**
 * Repeated stop requests preserve the original timestamp; foreign runs are rejected.
 * A queued run has no daemon to acknowledge the stop, so it ends here: status 'stopped'
 * in the same locked transaction (the claim route only takes status='queued' with no
 * stopRequestedAt, so it cannot pick it up). Returns true when this call ended the run;
 * the caller then runs afterRunEnded after commit.
 */
export async function stopOwnedRun(database: RunControlDatabase, userId: string, runId: string): Promise<boolean> {
  let ended = false
  let wake: string | null = null
  await database.transaction(async tx => {
    const [run] = await tx.select({ id: agentRuns.id, status: agentRuns.status, pauseReason: agentRuns.pauseReason, stopRequestedAt: agentRuns.stopRequestedAt, deviceId: agentRuns.deviceId })
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
      await runListChanged(tx, runId)
      ended = true
      await runChanged(tx, runId)
      return true
    }
    if (run.stopRequestedAt) return false
    await tx.update(agentRuns).set({ stopRequestedAt: now, updatedAt: now })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
    await runListChanged(tx, runId)
    wake = run.deviceId
    await runChanged(tx, runId)
    return false
  })
  notifyDeviceWork(wake)
  return ended
}
