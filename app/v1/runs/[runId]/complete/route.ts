import { NextResponse } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import { runStateForStop } from '@mikka/protocol/daemon'
import { runCompleteRequest, reachesReview } from '@mikka/protocol/run'
import { db } from '@/lib/db'
import { dispatchLinearIssueSync } from '@/lib/linear-sync/dispatch'
import { agentRuns, devices, issues, type RunStatus } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/** A run in one of these states may still be completed; the rest already ended. */
const LIVE_STATUSES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const

/**
 * `POST /v1/runs/:runId/complete`: how the run ended, once. Only an explicit
 * `submitted` whose verify did not fail counts as success; the issue then
 * moves to review, which is the only issue write this route makes.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  const [run] = await db
    .select({ id: agentRuns.id, issueId: agentRuns.issueId, status: agentRuns.status, kind: agentRuns.kind })
    .from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.id, runId), eq(devices.ownerId, caller.userId)))
    .limit(1)
  if (!run) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 })
  // A run ends once: a repeated completion is accepted and ignored.
  if (!(LIVE_STATUSES as readonly string[]).includes(run.status)) return new NextResponse(null, { status: 204 })
  const parsed = runCompleteRequest.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid completion.' }, { status: 400 })
  const { stopReason, report } = parsed.data
  // The daemon's own terminal mapping, not just the stop reason: a
  // submission whose verify failed is a failure, and one with no verify
  // result only stopped. A `plan` run writes no code, so its verify says
  // nothing about it.
  let status: RunStatus = runStateForStop(stopReason)
  if (stopReason === 'submitted' && report?.verify.status !== 'passed' && run.kind !== 'plan') {
    status = report?.verify.status === 'failed' ? 'failed' : 'stopped'
  }
  await db.update(agentRuns)
    .set({ status, stopReason, report: report ?? null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, [...LIVE_STATUSES])))
  if (run.issueId && reachesReview(stopReason, report)) {
    await db.update(issues).set({ status: 'review', updatedAt: new Date() }).where(eq(issues.id, run.issueId))
    dispatchLinearIssueSync(run.issueId)
  }
  return new NextResponse(null, { status: 204 })
}
