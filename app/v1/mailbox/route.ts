import { NextResponse } from 'next/server'
import { verifyRunToken, workerRun } from '@/lib/mcp/worker'
import { personalMailboxEnabled, personalWorkerMailbox } from '@/lib/personal-mailbox-runtime'
import { withMailboxDiagnostics } from '@/lib/mailbox-diagnostics'

export async function POST(request: Request) {
  if (!personalMailboxEnabled()) return NextResponse.json({ error: 'personal_mailbox_unavailable' }, { status: 503 })
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  const auth = await verifyRunToken(request, token)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const run = workerRun(auth)
  const result = await withMailboxDiagnostics(run.id, request.signal, async () => personalWorkerMailbox(run.userId, run.id, await request.json().catch(() => null), auth.token, request.signal))
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
}
