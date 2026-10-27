import { and, eq } from 'drizzle-orm'
import { ActionFailureError } from './action-error'
import { agentRuns, runMessages } from './db/schema'
import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'
import type { db } from './db'

export type RunControlDatabase = Pick<typeof db, 'transaction'>

/** Lock the owned run before checking its state so completion and messages serialize. */
export async function sendOwnedRunMessage(database: RunControlDatabase, userId: string, input: { runId: string; text: string }) {
  await database.transaction(async tx => {
    const [run] = await tx.select({ id: agentRuns.id, status: agentRuns.status, stopRequestedAt: agentRuns.stopRequestedAt })
      .from(agentRuns).where(and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, userId))).limit(1).for('update')
    if (!run || run.stopRequestedAt || !UNFINISHED_RUN_STATUSES.some(status => status === run.status)) throw new ActionFailureError('runNotFound')
    await tx.insert(runMessages).values({ id: crypto.randomUUID(), runId: run.id, userId, text: input.text })
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
