import { after, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { attentionBudgets, setAttentionEnabled } from '@/lib/attention/store'
import { wakeCoordinator } from '@/lib/coordinator/wake'

export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'private, no-store' }

/** Whether the Coordinator is handed matters from connected apps (R-20), and both budgets as they stand. */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  return NextResponse.json(await attentionBudgets(session.user.id), { headers })
}

/** The person's off switch. Off settles what waits as quiet; 建议 keeps filling either way. */
export async function PUT(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return NextResponse.json({ error: 'originMismatch' }, { status: 403, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  const parsed = z.object({ enabled: z.boolean() }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalidInput' }, { status: 400, headers })
  await setAttentionEnabled(session.user.id, parsed.data.enabled)
  if (parsed.data.enabled) after(() => wakeCoordinator(session.user.id))
  return NextResponse.json(await attentionBudgets(session.user.id), { headers })
}
