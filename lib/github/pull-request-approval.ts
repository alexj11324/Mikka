import 'server-only'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { agentRuns, pendingActions } from '@/lib/db/schema'
import { PENDING_ACTION_TTL_MS } from '@/lib/pending-action-view'

/**
 * 创建 Pull Request set to 询问: one card per run's publication, decided by
 * the person in chat. Approving lets that run's publication open its pull
 * request; it grants nothing else (lib/pending-actions.ts restarts only that
 * publication, and only while it waits for this card).
 */
export const PULL_REQUEST_APPROVAL = 'approve_pull_request'

/** What the card shows and the decision is bound to; built by the server from the publication. */
export const pullRequestApprovalInput = z.strictObject({
  runId: z.uuid(),
  repo: z.string().min(1).max(200),
  branch: z.string().min(1).max(255),
  title: z.string().max(500),
})
export type PullRequestApprovalInput = z.infer<typeof pullRequestApprovalInput>

/** The person's answer for this run, or a new card when there is none yet. */
export async function pullRequestApproval(userId: string, raw: PullRequestApprovalInput): Promise<'approved' | 'declined' | 'awaiting'> {
  const input = pullRequestApprovalInput.parse(raw)
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['pull-request-approval', userId, input.runId])}, 0))`)
    const [decided] = await tx.select({ status: pendingActions.status }).from(pendingActions).where(and(
      eq(pendingActions.userId, userId), eq(pendingActions.action, PULL_REQUEST_APPROVAL),
      sql`${pendingActions.input}->>'runId' = ${input.runId}`, sql`${pendingActions.status} in ('done','declined')`,
    )).orderBy(desc(pendingActions.decidedAt)).limit(1)
    if (decided) return decided.status === 'done' ? 'approved' : 'declined'
    const [waiting] = await tx.select({ id: pendingActions.id }).from(pendingActions).where(and(
      eq(pendingActions.userId, userId), eq(pendingActions.action, PULL_REQUEST_APPROVAL), eq(pendingActions.status, 'pending'),
      gt(pendingActions.createdAt, new Date(Date.now() - PENDING_ACTION_TTL_MS)),
      sql`${pendingActions.input}->>'runId' = ${input.runId}`,
    )).limit(1)
    // The card goes back to the chat of the bot that dispatched the run.
    const [run] = waiting ? [] : await tx.select({ botId: agentRuns.botId }).from(agentRuns).where(and(eq(agentRuns.id, input.runId), eq(agentRuns.userId, userId))).limit(1)
    if (!waiting) await tx.insert(pendingActions).values({ id: crypto.randomUUID(), userId, botId: run?.botId ?? null, action: PULL_REQUEST_APPROVAL, input })
    return 'awaiting'
  })
}
