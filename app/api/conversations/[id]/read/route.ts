import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { handleRead, type ReadRequest } from '@/lib/conversation-reads-store'

export const dynamic = 'force-dynamic'

async function respond(request: Request, id: string, method: ReadRequest['method']) {
  const session = await auth.api.getSession({ headers: request.headers })
  const result = await handleRead(pool, {
    method,
    userId: session?.user?.id ?? null,
    conversationId: id,
    origin: request.headers.get('origin'),
    host: request.headers.get('host') ?? new URL(request.url).host,
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
