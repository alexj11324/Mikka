import { NextResponse } from 'next/server'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { handleRead, requestHost, type ReadRequest } from '@/lib/conversation-reads-store'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

async function respond(request: Request, id: string, method: ReadRequest['method']) {
  if (z.uuid().safeParse(id).success) {
    const { respondGroup } = await import('@/lib/group-conversations-route')
    return respondGroup(request, 'read', id)
  }
  const session = await auth.api.getSession({ headers: request.headers })
  const userId = session?.user?.id ?? null
  const result = await handleRead(pool, {
    // The Coordinator is an ordinary bot (#757): its chat is its bot's rows, resolved at this entry point.
    coordinatorBot: session?.user ? async () => (await import('@/lib/coordinator/coordinator-bot')).chatBotId(session.user.id, null,
      (await (await import('@/lib/workspace-access')).loadWorkspaceContext(undefined, session.user)).workspace.id) : undefined,
    method,
    userId,
    conversationId: id,
    origin: request.headers.get('origin'),
    host: requestHost(request.headers.get('x-forwarded-host'), request.headers.get('host') ?? new URL(request.url).host),
    body: method === 'POST' ? await request.text().catch(() => '') : undefined,
  })
  return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'private, no-store' } })
}

/** `GET /api/conversations/:id/read`: where the person left off, and how many replies came after. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(request, (await params).id, 'GET')
}

/** `POST /api/conversations/:id/read` with `{ messageId }`: moves the read position forward (never back). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return respond(request, (await params).id, 'POST')
}
