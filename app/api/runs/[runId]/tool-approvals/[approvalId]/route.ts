import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { RunToolApprovalStore } from '@/lib/agent-tool-approval/approvals'
import { ApprovalUnavailable } from '@/lib/agent-tool-approval/store'
import { toolApprovalDecisionSchema } from '@mikka/protocol/tool-approval'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'private, no-store' }

/** Approve or deny one exact Ask request. The run's owner only; a stale mode
 * or policy revision refuses the card instead of granting it. */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string; approvalId: string }> }) {
  const respond = (body: unknown, status: number) => NextResponse.json(body, { status, headers: noStore })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return respond({ error: 'authRequired' }, 401)
  if (request.headers.get('origin') !== new URL(request.url).origin) return respond({ error: 'invalidOrigin' }, 403)
  try {
    const { runId, approvalId } = await params
    const ids = z.object({ runId: z.uuid(), approvalId: z.uuid() }).parse({ runId, approvalId })
    const { decision } = toolApprovalDecisionSchema.parse(await request.json())
    const state = await new RunToolApprovalStore(pool).decide(session.user.id, ids.runId, ids.approvalId, decision, session.user.name)
    return respond(state, 200)
  } catch (error) {
    if (error instanceof z.ZodError) return respond({ error: 'invalidRequest' }, 400)
    if (error instanceof ApprovalUnavailable) {
      if (error.revokeReason === 'not_pending') return respond({ error: 'approvalAlreadyDecided' }, 409)
      if (error.revokeReason === 'expired') return respond({ error: 'approvalExpired' }, 409)
      if (error.revokeReason === 'mode_not_ask' || error.revokeReason === 'policy_changed') return respond({ error: 'approvalNoLongerApplies' }, 409)
      return respond({ error: 'approvalUnavailable' }, 404)
    }
    return respond({ error: 'approvalUnavailable' }, 503)
  }
}
