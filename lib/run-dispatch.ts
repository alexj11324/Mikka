import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError } from './action-error'
import type { db } from './db'
import { agentRuns, type RunStatus } from './db/schema'

/** Reuse this key for retries of one logical dispatch, including after a lost response. */
export const dispatchRequestKey = z.string().trim().min(1).max(200)
export const dispatchInput = z.object({
  issueId: z.uuid(), agentId: z.uuid(), deviceRepoId: z.uuid(),
  note: z.string().trim().max(10_000).optional(),
  requestKey: dispatchRequestKey.optional(),
})
export type DispatchInput = z.infer<typeof dispatchInput>
export interface DispatchResult { runId: string; status: RunStatus; replayed: boolean }

const LIVE_STATUSES: RunStatus[] = ['queued', 'preparing', 'running', 'waiting_input', 'finishing']

/** Bind caller parameters, not mutable issue text or standing instructions. */
export function dispatchFingerprint(input: DispatchInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.issueId, input.agentId, input.deviceRepoId, input.note ?? '',
  ])).digest('hex')
}

/**
 * Called only after queueRun checks current issue, agent and repository access.
 * Locks and the request record live in the same transaction as the new run.
 * Lock order is always request key, then issue; unkeyed calls take only issue.
 */
export async function insertRunOnce(database: Pick<typeof db, 'transaction'>, userId: string, input: DispatchInput,
  brief: { deviceId: string; baseBranch: string; prompt: string; botId?:string|null; agentDefinition?:typeof agentRuns.$inferInsert.agentDefinition }): Promise<DispatchResult> {
  return database.transaction(async tx => {
    const hash = input.requestKey ? dispatchFingerprint(input) : null
    if (input.requestKey) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['dispatch-key', userId, input.requestKey])}, 0))`)
      const [previous] = await tx.select().from(agentRuns)
        .where(and(eq(agentRuns.userId, userId), eq(agentRuns.dispatchKey, input.requestKey))).limit(1)
      if (previous) {
        if (previous.dispatchFingerprint !== hash) throw new ActionFailureError('runDispatchKeyConflict')
        return { runId: previous.id, status: previous.status, replayed: true }
      }
    }
    // A prompt is advice; this transaction is the actual duplicate-run gate.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['dispatch-issue', userId, input.issueId])}, 0))`)
    const [active] = await tx.select({ id: agentRuns.id }).from(agentRuns)
      .where(and(eq(agentRuns.userId, userId), eq(agentRuns.issueId, input.issueId), inArray(agentRuns.status, LIVE_STATUSES))).limit(1)
    if (active) throw new ActionFailureError('runAlreadyActive', { runId: active.id })
    const runId = crypto.randomUUID()
    await tx.insert(agentRuns).values({
      id: runId, userId, issueId: input.issueId, agentId: input.agentId, deviceId: brief.deviceId,
      deviceRepoId: input.deviceRepoId, status: 'queued', kind: 'implement', baseBranch: brief.baseBranch,
      botId:brief.botId??null, agentDefinition:brief.agentDefinition??null, prompt: brief.prompt, dispatchKey: input.requestKey ?? null, dispatchFingerprint: hash,
    })
    return { runId, status: 'queued', replayed: false }
  })
}
