import { after, NextResponse } from 'next/server'
import { runCompleteRequest } from '@mikka/protocol/run'
import { authenticateDevice } from '@/lib/device-link'
import { persistRunCompletion } from '@/lib/run-publications'
import { startRunPublication } from '@/lib/run-publication-workflow'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { dispatchLinearIssueSync } from '@/lib/linear-sync/dispatch'

export const dynamic = 'force-dynamic'

/** The first completion is immutable; retries also recover a failed enqueue. */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { runId } = await params
  const parsed = runCompleteRequest.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid completion.' }, { status: 400 })
  const result = await persistRunCompletion(caller.userId, runId, parsed.data, caller.scopeDeviceId)
  if (!result) return NextResponse.json({ error: 'Unknown run.' }, { status: 404 })
  if (result.publicationPending) {
    try { await startRunPublication(runId) }
    catch { return NextResponse.json({ error: 'Result publication is temporarily unavailable.' }, { status: 503, headers: { 'Retry-After': '15' } }) }
  } else {
    if (result.issueId) dispatchLinearIssueSync(result.issueId)
    after(() => wakeCoordinator(result.userId))
  }
  return new NextResponse(null, { status: 204 })
}
