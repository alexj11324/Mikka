import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { RunToolApprovalStore } from '@/lib/agent-tool-approval/approvals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'private, no-store' }

/** The owner's Ask approvals for one run; the approval surface (#1735) reads this. */
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const session = await auth.api.getSession({ headers: _request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers: noStore })
  try {
    const runId = z.uuid().parse((await params).runId)
    return NextResponse.json({ approvals: await new RunToolApprovalStore(pool).list(session.user.id, runId) }, { headers: noStore })
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: 'invalidRequest' }, { status: 400, headers: noStore })
    return NextResponse.json({ error: 'approvalUnavailable' }, { status: 404, headers: noStore })
  }
}
