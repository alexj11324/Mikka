import { after, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { runCompleteRequest } from '@mikka/protocol/run'
import { authenticateDevice } from '@/lib/device-link'
import { persistRunCompletion } from '@/lib/run-publications'
import { startRunPublication } from '@/lib/run-publication-workflow'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { dispatchLinearIssueSync } from '@/lib/linear-sync/dispatch'
import { stopRecordingsAfter } from '@/lib/captures/run-end'
import { db } from '@/lib/db'
import { agentRuns, devices } from '@/lib/db/schema'
import { dispatchCompletedIssue } from '@/lib/run-completion'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { ImprovementError } from '@/lib/self-improvement/contract'

export const dynamic = 'force-dynamic'

/** The first completion is immutable; retries also recover a failed enqueue. */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  const parsed = runCompleteRequest.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    // A malformed replay cannot change a completed run. Preserve the daemon's
    // idempotent acknowledgement without skipping valid publication retries.
    const [ended] = await db.select({ status: agentRuns.status }).from(agentRuns).innerJoin(devices, eq(devices.id, agentRuns.deviceId))
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, caller.userId), eq(devices.ownerId, caller.userId), ...(caller.scopeDeviceId ? [eq(devices.id, caller.scopeDeviceId)] : []))).limit(1)
    if (ended && !(UNFINISHED_RUN_STATUSES as readonly string[]).includes(ended.status)) return new NextResponse(null, { status: 204 })
    return NextResponse.json({ error: 'Invalid completion.' }, { status: 400 })
  }
  let result: Awaited<ReturnType<typeof persistRunCompletion>>
  try { result = await persistRunCompletion(caller.userId, runId, parsed.data, caller.scopeDeviceId) }
  catch (error) {
    if (error instanceof ImprovementError) return NextResponse.json({ error: error.code }, { status: 409 })
    throw error
  }
  if (!result) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 })
  stopRecordingsAfter([runId])
  if (result.publicationPending) {
    try { await startRunPublication(runId) }
    catch { return NextResponse.json({ error: 'Result publication is temporarily unavailable.' }, { status: 503, headers: { 'Retry-After': '15' } }) }
  } else {
    await dispatchCompletedIssue(result, dispatchLinearIssueSync)
    after(() => wakeCoordinator(result.userId))
  }
  return new NextResponse(null, { status: 204 })
}
