import { personalRunMessageText } from './personal-run-message'
import { and, eq, sql } from 'drizzle-orm'
import { ActionFailureError } from './action-error'
import { agentRuns, devices, repositorySettings, runMessages } from './db/schema'
import { admitRepositoryTask, matchesRepositoryAdmission } from './repository-admission'
import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'
import type { db } from './db'

export type RunControlDatabase = Pick<typeof db, 'transaction'>

/** Lock the owned run before checking its state so completion and messages serialize. */
export async function sendOwnedRunMessage(database: RunControlDatabase, userId: string, input: { runId: string; text: string }, origin: 'user' | 'peer' = 'user') {
  await database.transaction(async tx => {
    const [run] = await tx.select({ id: agentRuns.id, status: agentRuns.status, stopRequestedAt: agentRuns.stopRequestedAt, deviceId: agentRuns.deviceId, agentId: agentRuns.agentId, issueId: agentRuns.issueId, repositoryAdmission: agentRuns.repositoryAdmission })
      .from(agentRuns).where(and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, userId))).limit(1).for('update')
    if (!run || run.stopRequestedAt || !UNFINISHED_RUN_STATUSES.some(status => status === run.status)) throw new ActionFailureError('runNotFound')
    let admission = run.repositoryAdmission
    if (run.deviceId && !admission) {
      const [device] = await tx.select({ kind: devices.kind }).from(devices).where(eq(devices.id, run.deviceId)).limit(1)
      if (device?.kind === 'local') throw new ActionFailureError('runInvalid')
    }
    if (admission) {
      if (!run.issueId || !run.deviceId || !matchesRepositoryAdmission(admission, { ...admission, issueId: run.issueId, deviceId: run.deviceId, agentId: run.agentId, userId })) throw new ActionFailureError('runInvalid')
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['repository-approval', userId, admission.remoteKey])}, 0))`)
      const [settings] = await tx.select().from(repositorySettings).where(and(eq(repositorySettings.userId, userId), eq(repositorySettings.remoteKey, admission.remoteKey))).limit(1)
      admission = admitRepositoryTask({ ...admission, push: settings?.push, now: new Date() })
      if (!admission) throw new ActionFailureError('runInvalid')
    }
    const id = crypto.randomUUID()
    await tx.insert(runMessages).values({ id, runId: run.id, userId, text: personalRunMessageText(id, input.text, origin), ...(admission ? { repositoryAdmission: admission } : {}) })
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
