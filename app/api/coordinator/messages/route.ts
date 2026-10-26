import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { after, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { userMessageEvent } from '@/lib/coordinator-events'
import { chatView } from '@/lib/coordinator/store'
import { coordinatorEnabled, wakeCoordinator } from '@/lib/coordinator/wake'

export const dynamic = 'force-dynamic'

/** `GET /api/coordinator/messages`: the person's conversation with their Coordinator, oldest first. */
async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  noteLogUser(session?.user?.id)
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  return NextResponse.json({ enabled: coordinatorEnabled(), ...(await chatView(session.user.id)) }, { headers: { 'Cache-Control': 'private, no-store' } },)
}

/**
 * `POST /api/coordinator/messages` with `{ text }`: a message to the
 * Coordinator. It lands in the inbox and wakes a turn; the reply shows up in
 * the conversation.
 */
async function handlePOST(request: Request) {
  // A browser message can attest a human answer. Validate its origin and
  // current session before persisting that authority in an inbox event.
  if (!request.headers.has('authorization') && request.headers.get('cookie')) {
    try {
      if (new URL(request.headers.get('origin') ?? '').origin !== new URL(request.url).origin)
        return NextResponse.json({ error: 'originRejected' }, { status: 403 })
    } catch {
      return NextResponse.json({ error: 'originRejected' }, { status: 403 })
    }
  }
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  noteLogUser(session?.user?.id)
  if (!session?.user) return NextResponse.json({ error: 'authRequired' }, { status: 401 })
  const parsed = z.object({ text: z.string().trim().min(1).max(10_000),
      questionId: z.uuid().optional(), }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'messageRequired' }, { status: 400 })
  const userId = session.user.id
  const event = userMessageEvent(userId, parsed.data.text)
  event.payload = {
    ...event.payload,
    ...(!request.headers.has('authorization') && request.headers.get('cookie')
      ? { humanSessionId: session.session.id }
      : {}),
    ...(parsed.data.questionId ? { questionId: parsed.data.questionId } : {}),
  }
  await recordCoordinatorEvent(db, event)
  after(() => wakeCoordinator(userId))
  return NextResponse.json({ queued: true, enabled: coordinatorEnabled() }, { status: 202 },)
}

export const GET = withRequestLog('/api/coordinator/messages', handleGET)
export const POST = withRequestLog('/api/coordinator/messages', handlePOST)
