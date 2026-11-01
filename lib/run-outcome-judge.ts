import 'server-only'
import { and, count, eq, sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { agentRuns, issues, type RunOutcome } from '@/lib/db/schema'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { runSummaryText } from '@/lib/issue-run-conversation'
import { ENDED_RUN_STATUSES, OUTCOME_CHOICES, OUTCOME_QUESTIONS, outcomeText, readOutcome, type OutcomeEvidence } from '@/lib/run-outcome'

/** Ended runs older than this are not judged (the backfill window too). */
export const OUTCOME_WINDOW_DAYS = 7
/** How many runs one minute sweep judges. */
const SWEEP_LIMIT = 10

/** An unanswered run is asked again after this long, while it is inside the window. */
const RETRY_AFTER = '1 hour'

type Verdict = { outcome: RunOutcome; decidedBy: 'decision'; reason: string }

/** The judge, injectable so tests never reach a model. */
export interface OutcomeJudges {
  /** The decision model (lib/coordinator/decide.ts); null when it is unavailable, refuses or answers out of range. */
  decision(evidence: OutcomeEvidence, scope: { userId: string; botId: string | null }): Promise<Verdict | null>
}

export const defaultJudges: OutcomeJudges = {
  async decision(evidence, { userId, botId }) {
    try {
      const [{ hostedBillingScope }, { executionWorkspace }, { decide }] = await Promise.all([
        import('@/lib/abuse/context'), import('@/lib/execution-settings'), import('@/lib/coordinator/decide'),
      ])
      // Billed like the other decision callers (lib/attention/score.ts), to the workspace the run's bot belongs to.
      const answers = await hostedBillingScope.run({ workspaceId: await executionWorkspace(userId, botId), ownerId: userId },
        () => decide('run-outcome', outcomeText(evidence), OUTCOME_QUESTIONS))
      const outcome = readOutcome(answers)
      if (!outcome) return null
      const answer = answers?.get('outcome')
      const confidence = answer?.type === 'choice' && answer.confidence !== undefined ? ` (${Math.round(answer.confidence * 100)}%)` : ''
      return { outcome, decidedBy: 'decision', reason: `${OUTCOME_CHOICES.find(choice => choice.value === outcome)!.description}${confidence}` }
    } catch { return null }
  },
}

/** What the judge reads about a run: its own words, its task and that task's PRs. */
async function evidenceOf(runId: string): Promise<{ userId: string; botId: string | null; evidence: OutcomeEvidence } | null> {
  const [run] = await db.select({
    userId: agentRuns.userId, botId: agentRuns.botId, status: agentRuns.status, stopReason: agentRuns.stopReason, report: agentRuns.report, error: agentRuns.error,
    lastReply: agentRuns.lastReply, issueId: agentRuns.issueId,
  }).from(agentRuns).where(eq(agentRuns.id, runId)).limit(1)
  if (!run) return null
  const [issue] = run.issueId ? await db.select({ status: issues.status, title: issues.title, content: issues.content }).from(issues).where(eq(issues.id, run.issueId)).limit(1) : []
  const [attempts] = run.issueId ? await db.select({ value: count() }).from(agentRuns).where(eq(agentRuns.issueId, run.issueId)) : [{ value: 1 }]
  return {
    userId: run.userId, botId: run.botId,
    evidence: {
      status: run.status, stopReason: run.stopReason, summary: runSummaryText(run), lastReply: run.lastReply,
      issue: issue ? { status: issue.status, title: issue.title } : null,
      pullRequests: issue ? readIssueMetadata(issue.content).pullRequests.map(pr => ({ state: pr.state })) : [],
      attempts: Number(attempts?.value ?? 1),
    },
  }
}

/**
 * Judges one ended run with the decision model. The run is claimed first
 * (outcomeAt), so a sweep and the completion hook never judge it at the same
 * time. With no answer the outcome stays empty, the thread sits under 受阻 or
 * 等待你 (never 已解决, R-52), and the sweep asks again after RETRY_AFTER.
 * Nothing in code guesses an outcome.
 */
export async function judgeRunOutcome(runId: string, judges: OutcomeJudges = defaultJudges, claimed = false): Promise<RunOutcome | null> {
  if (!claimed) {
    const [claim] = await db.update(agentRuns).set({ outcomeAt: new Date() })
      .where(and(eq(agentRuns.id, runId), sql`${agentRuns.outcome} IS NULL AND ${agentRuns.status} IN ('succeeded', 'stopped', 'failed', 'cancelled')
        AND (${agentRuns.outcomeAt} IS NULL OR ${agentRuns.outcomeAt} < now() - ${RETRY_AFTER}::interval)`))
      .returning({ id: agentRuns.id })
    if (!claim) return null
  }
  const found = await evidenceOf(runId)
  if (!found) return null
  const verdict = await judges.decision(found.evidence, found)
  if (!verdict) return null
  await db.update(agentRuns).set({ outcome: verdict.outcome, outcomeDecidedBy: verdict.decidedBy, outcomeReason: verdict.reason.slice(0, 500), outcomeAt: new Date() })
    .where(and(eq(agentRuns.id, runId), sql`${agentRuns.outcome} IS NULL`))
  return verdict.outcome
}

/**
 * The minute sweep (app/api/cron/run-recovery): claims up to SWEEP_LIMIT ended
 * runs from the last OUTCOME_WINDOW_DAYS with no outcome (never asked, or
 * unanswered more than RETRY_AFTER ago), newest first, and judges them. It is
 * also the backfill: runs that ended before outcomes existed are judged as it
 * reaches them, and older ones are left alone.
 */
export async function judgePendingOutcomes(judges: OutcomeJudges = defaultJudges, limit = SWEEP_LIMIT): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE agent_runs SET "outcomeAt" = now() WHERE id IN (
       SELECT id FROM agent_runs
       WHERE outcome IS NULL AND status = ANY($1::text[])
         AND ("outcomeAt" IS NULL OR "outcomeAt" < now() - $4::interval)
         AND coalesce("finishedAt", "updatedAt") > now() - make_interval(days => $2)
       ORDER BY coalesce("finishedAt", "updatedAt") DESC LIMIT $3 FOR UPDATE SKIP LOCKED)
     RETURNING id`, [[...ENDED_RUN_STATUSES], OUTCOME_WINDOW_DAYS, limit, RETRY_AFTER])
  let judged = 0
  for (const { id } of rows) if (await judgeRunOutcome(id, judges, true).catch(() => null)) judged++
  return judged
}
