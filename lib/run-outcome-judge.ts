import 'server-only'
import { and, count, eq, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agentRuns, issues, type RunOutcome } from '@/lib/db/schema'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { runSummaryText } from '@/lib/issue-run-conversation'
import { ENDED_RUN_STATUSES, OUTCOME_CHOICES, OUTCOME_QUESTIONS, outcomeText, parseOutcome, readOutcome, type OutcomeEvidence } from '@/lib/run-outcome'

/** Ended runs older than this are not judged (the backfill window too). */
export const OUTCOME_WINDOW_DAYS = 7
/** How many runs one minute sweep judges. */
const SWEEP_LIMIT = 10

type Verdict = { outcome: RunOutcome; decidedBy: 'decision' | 'agent_model'; reason: string }

/** The judges, injectable so tests never reach a model. */
export interface OutcomeJudges {
  /** The decision model (lib/coordinator/decide.ts); null when it is unavailable or refuses. */
  decision(evidence: OutcomeEvidence, scope: { userId: string }): Promise<Verdict | null>
  /** The agent model, used when the decision model gives no answer; null when it gives none either. */
  agentModel(evidence: OutcomeEvidence, scope: { userId: string }): Promise<Verdict | null>
}

/** Billing goes to the person's execution workspace, as the other decision callers do (lib/attention/score.ts). */
async function inScope<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const [{ hostedBillingScope }, { executionWorkspace }] = await Promise.all([import('@/lib/abuse/context'), import('@/lib/execution-settings')])
  return hostedBillingScope.run({ workspaceId: await executionWorkspace(userId, null), ownerId: userId }, work)
}

export const defaultJudges: OutcomeJudges = {
  async decision(evidence, { userId }) {
    try {
      const { decide } = await import('@/lib/coordinator/decide')
      const answers = await inScope(userId, () => decide('run-outcome', outcomeText(evidence), OUTCOME_QUESTIONS))
      const outcome = readOutcome(answers)
      if (!outcome) return null
      const answer = answers?.get('outcome')
      const confidence = answer?.type === 'choice' && answer.confidence !== undefined ? ` (${Math.round(answer.confidence * 100)}%)` : ''
      return { outcome, decidedBy: 'decision', reason: `${OUTCOME_CHOICES.find(choice => choice.value === outcome)!.description}${confidence}` }
    } catch { return null }
  },
  async agentModel(evidence, { userId }) {
    try {
      const [{ generateText, Output }, { z }, { hostedModel }, { COORDINATOR_MODEL }, { executionWorkspace }] = await Promise.all([
        import('ai'), import('zod'), import('@/lib/abuse/model'), import('@/lib/coordinator/model'), import('@/lib/execution-settings'),
      ])
      const workspaceId = await executionWorkspace(userId, null)
      const result = await inScope(userId, async () => generateText({
        model: await hostedModel(workspaceId, COORDINATOR_MODEL, undefined, userId),
        system: `${OUTCOME_QUESTIONS[0].instructions}\nChoices:\n${OUTCOME_CHOICES.map(choice => `- ${choice.value}: ${choice.description}`).join('\n')}\nAnswer with the choice and a one-line reason.`,
        prompt: outcomeText(evidence),
        output: Output.object({ schema: z.object({ outcome: z.enum(OUTCOME_CHOICES.map(choice => choice.value) as [RunOutcome, ...RunOutcome[]]), reason: z.string().max(300) }) }),
        maxOutputTokens: 300, maxRetries: 0, abortSignal: AbortSignal.timeout(20000),
      }))
      const parsed = parseOutcome(result.output)
      return parsed && { ...parsed, decidedBy: 'agent_model' }
    } catch { return null }
  },
}

/** What the judge reads about a run: its own words, its task and that task's PRs. */
async function evidenceOf(runId: string): Promise<{ userId: string; evidence: OutcomeEvidence } | null> {
  const [run] = await db.select({
    userId: agentRuns.userId, status: agentRuns.status, stopReason: agentRuns.stopReason, report: agentRuns.report, error: agentRuns.error,
    lastReply: agentRuns.lastReply, issueId: agentRuns.issueId,
  }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  if (!run) return null
  const [issue] = run.issueId ? await db.select({ status: issues.status, title: issues.title, content: issues.content }).from(issues).where(eq(issues.id, run.issueId)).limit(1) : []
  const [attempts] = run.issueId ? await db.select({ value: count() }).from(agentRuns).where(eq(agentRuns.issueId, run.issueId)) : [{ value: 1 }]
  return {
    userId: run.userId,
    evidence: {
      status: run.status, stopReason: run.stopReason, summary: runSummaryText(run), lastReply: run.lastReply,
      issue: issue ? { status: issue.status, title: issue.title } : null,
      pullRequests: issue ? readIssueMetadata(issue.content).pullRequests.map(pr => ({ state: pr.state })) : [],
      attempts: Number(attempts?.value ?? 1),
    },
  }
}

/**
 * Judges one ended run once: the decision model first, the agent model when it
 * gives no answer. The run is claimed first (outcomeAt), so a sweep and the
 * completion hook never judge it twice. When neither judge answers the outcome
 * stays empty and the thread sits under 受阻 or 等待你, never 已解决 (R-52).
 */
export async function judgeRunOutcome(runId: string, judges: OutcomeJudges = defaultJudges, claimed = false): Promise<RunOutcome | null> {
  if (!claimed) {
    const [claim] = await db.update(agentRuns).set({ outcomeAt: new Date() })
      .where(and(eq(agentRuns.id, runId), sql`${agentRuns.outcome} IS NULL AND ${agentRuns.outcomeAt} IS NULL AND ${agentRuns.status} IN ('succeeded', 'stopped', 'failed', 'cancelled')`))
      .returning({ id: agentRuns.id })
    if (!claim) return null
  }
  const found = await evidenceOf(runId)
  if (!found) return null
  const verdict = await judges.decision(found.evidence, found) ?? await judges.agentModel(found.evidence, found)
  if (!verdict) return null
  await db.update(agentRuns).set({ outcome: verdict.outcome, outcomeDecidedBy: verdict.decidedBy, outcomeReason: verdict.reason.slice(0, 500), outcomeAt: new Date() })
    .where(and(eq(agentRuns.id, runId), sql`${agentRuns.outcome} IS NULL`))
  return verdict.outcome
}

/**
 * The minute sweep (app/api/cron/run-recovery): claims up to SWEEP_LIMIT ended
 * runs from the last OUTCOME_WINDOW_DAYS that were never judged, newest first,
 * and judges them. It is also the backfill: runs that ended before outcomes
 * existed are judged as it reaches them, and older ones are left alone.
 */
export async function judgePendingOutcomes(judges: OutcomeJudges = defaultJudges, limit = SWEEP_LIMIT): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE agent_runs SET "outcomeAt" = now() WHERE id IN (
       SELECT id FROM agent_runs
       WHERE outcome IS NULL AND "outcomeAt" IS NULL AND status = ANY($1::text[])
         AND coalesce("finishedAt", "updatedAt") > now() - make_interval(days => $2)
       ORDER BY coalesce("finishedAt", "updatedAt") DESC LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING id`, [[...ENDED_RUN_STATUSES], OUTCOME_WINDOW_DAYS, limit])
  let judged = 0
  for (const { id } of rows) if (await judgeRunOutcome(id, judges, true).catch(() => null)) judged++
  return judged
}
