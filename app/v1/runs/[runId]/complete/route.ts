import { after, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { runCompleteRequest } from '@mikka/protocol/run'
import { db } from '@/lib/db'
import { dispatchLinearIssueSync } from '@/lib/linear-sync/dispatch'
import { agentRuns, devices } from '@/lib/db/schema'
import { authenticateDevice } from '@/lib/device-link'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { completeRunForDevice, dispatchCompletedIssue } from '@/lib/run-completion'

export const dynamic = 'force-dynamic'

/** A run in one of these states may still be completed; the rest already ended. */
const LIVE_STATUSES = ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const

/**
 * `POST /v1/runs/:runId/complete`: how the run ended, once. Only an explicit
 * `submitted` whose verify did not fail counts as success; the issue then
 * moves to review, which is the only issue write this route makes. The
 * owner's Coordinator hears that the run ended.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  const [run] = await db
    .select({ id: agentRuns.id, userId: agentRuns.userId, issueId: agentRuns.issueId, status: agentRuns.status, kind: agentRuns.kind })
    .from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.id, runId), eq(devices.ownerId, caller.userId)))
    .limit(1)
  if (!run) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 })
  // A run ends once: a repeated completion is accepted and ignored.
  if (!(LIVE_STATUSES as readonly string[]).includes(run.status)) return new NextResponse(null, { status: 204 })
  const parsed = runCompleteRequest.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid completion.' }, { status: 400 })
  const completed = await completeRunForDevice(caller.userId, run, parsed.data)
  if (completed) {
    await dispatchCompletedIssue(completed, dispatchLinearIssueSync)
    after(() => wakeCoordinator(completed.userId))
  }
  return new NextResponse(null, { status: 204 })
}
