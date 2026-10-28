import { after, NextResponse } from 'next/server'
import { drizzle } from 'drizzle-orm/node-postgres'
import { recordCompletionSkillMount } from '@/lib/self-improvement/skill-mounts'
import { skillEvaluations } from '@/lib/self-improvement/server'
import { ImprovementError } from '@/lib/self-improvement/contract'
import { issueForUser } from '@/lib/issue-access'
import { and, eq } from 'drizzle-orm'
import { runStateForStop } from '@mikka/protocol/daemon'
import { runCompleteRequest, reachesReview } from '@mikka/protocol/run'
import { db, pool } from '@/lib/db'
import { dispatchLinearIssueSync } from '@/lib/linear-sync/dispatch'
import { agentRuns, devices, issues, type RunStatus } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'
import { runFinishedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { factoryMonitor, factoryQuestions } from '@/lib/factory/server'
import { factoryEventId } from '@/lib/factory/event-id'
import { FactoryError } from '@/lib/factory/contract'
import { revokeRunTokens } from '@/lib/mcp/worker'

export const dynamic = 'force-dynamic'

/** A run in one of these states may still be completed; the rest already ended. */
const LIVE_STATUSES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing',] as const

/**
 * `POST /v1/runs/:runId/complete`: how the run ended, once. Only an explicit
 * `submitted` whose verify did not fail counts as success; the issue then
 * moves to review, which is the only issue write this route makes. The
 * owner's Coordinator hears that the run ended.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> },) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  const [run] = await db
    .select({ id: agentRuns.id, userId: agentRuns.userId, botId: agentRuns.botId, issueId: agentRuns.issueId, status: agentRuns.status, kind: agentRuns.kind })
    .from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.id, runId), eq(devices.ownerId, caller.userId)))
    .limit(1)
  if (!run) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 })
  // A run ends once: a repeated completion is accepted and ignored.
  if (!(LIVE_STATUSES as readonly string[]).includes(run.status)) return new NextResponse(null, { status: 204 })
  const parsed = runCompleteRequest.safeParse(await request.json().catch(() => null),)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid completion.' }, { status: 400 })
  const { stopReason } = parsed.data
  let report = parsed.data.report
  // The daemon's own terminal mapping, not just the stop reason: a
  // submission whose verify failed is a failure, and one with no verify
  // result only stopped. A `plan` run writes no code, so its verify says
  // nothing about it.
  let status: RunStatus = runStateForStop(stopReason)
  if (stopReason === 'submitted' && report?.verify.status !== 'passed' && run.kind !== 'plan') {
    status = report?.verify.status === 'failed' ? 'failed' : 'stopped'
  }
  const tx = await pool.connect()
  let ended = false
  try { await tx.query('BEGIN')
    // Match Factory cancellation/answer lock order before touching the run row.
    await tx
    .query(
      'SELECT t.id FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE a."runId"=$1 AND t."userId"=$2 FOR UPDATE OF t',
      [runId, run.userId],
    )
    report = await recordCompletionSkillMount(tx, run.userId, runId, stopReason, report,
      async (userId, issueId, client) => Boolean(await issueForUser(userId, issueId, false, drizzle(client))),
      skillEvaluations.authorizeEvaluation,skillEvaluations.validateExecution)
    if (stopReason === 'submitted') {
      await tx.query('SAVEPOINT monitor_probe')
      try { await factoryMonitor.probeRun(run.userId, runId, tx, report) }
      catch (error) {
        await tx.query('ROLLBACK TO SAVEPOINT monitor_probe')
        if (!(error instanceof FactoryError)) throw error
      }
    }
    const updated = await tx.query(
      'UPDATE agent_runs SET status=$2,"stopReason"=$3,report=$4,"finishedAt"=clock_timestamp(),"updatedAt"=now() WHERE id=$1 AND status=ANY($5::text[]) RETURNING id',
      [
        runId, status, stopReason,
        JSON.stringify( report ?? null), [...LIVE_STATUSES],
      ],)
    ended = updated
    .rows.length > 0
  if (ended) {
    await tx.query('SAVEPOINT question_settle')
      try {
        await factoryQuestions.settle(run.userId,runId, tx)
      } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT question_settle')
        if (!(error instanceof FactoryError)) throw error
      }
      if (['asked_human', 'blocked'].includes(stopReason)) {
        await tx.query('SAVEPOINT execution_question')
        try {
          await factoryQuestions.record(run.userId, runId, tx)
        } catch (error) {
          await tx.query('ROLLBACK TO SAVEPOINT execution_question')
          // Unbound legacy runs retain their report; the Factory reconciler
          // persists a blocked reason for invalid bound question provenance.
          if (!(error instanceof FactoryError)) throw error
        }
      }
      const event = runFinishedEvent({ ...run, status, stopReason, report })
      await tx.query(
        'INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT ("dedupeKey") DO NOTHING',
        [
          factoryEventId('run-finished', runId),
          event.userId,
          event.kind,
          event.dedupeKey,
          event.issueId,
          event.runId,
          JSON.stringify(event.payload),
        ],
      )
    }
    await tx.query('COMMIT')
  } catch (error) {
    await tx.query('ROLLBACK')
    if (error instanceof ImprovementError) return NextResponse.json({ error: error.code }, { status: 409 })
    throw error
  } finally {
    tx.release()
  }
  // Only the completion that ended the run tells the Coordinator.
  if (ended) {
    await revokeRunTokens(runId)
    after(() => wakeCoordinator(run.userId))
  }
  if (ended && run.issueId && reachesReview(stopReason, report)) {
    await db.update(issues).set({ status: 'review', updatedAt: new Date() }).where(eq(issues.id, run.issueId))
    dispatchLinearIssueSync(run.issueId)
  }
  return new NextResponse(null, { status: 204 })
}
