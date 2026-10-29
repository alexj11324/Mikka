import { createHash } from 'node:crypto'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { desktopAuthRequests } from '@/lib/db/schema'
import { desktopAuthState, desktopLoopbackCallback } from '@/lib/desktop-auth'
import { withRequestLog } from '@/lib/request-log'

export const dynamic = 'force-dynamic'

/**
 * Records the loopback callback before the browser starts. The return route
 * accepts a callback only when it matches the row for this signed-in person;
 * a crafted page cannot point another person's token at a local listener.
 */
async function handlePOST(request: Request) {
  const origin = request.headers.get('origin')
  if (origin && origin !== new URL(request.url).origin) return new NextResponse(null, { status: 403 })
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) return new NextResponse(null, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalidRequest' }, { status: 400 })
  }
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const state = desktopAuthState(value.state)
  const callback = desktopLoopbackCallback(value.callback)
  if (!state || !callback) return NextResponse.json({ error: 'invalidRequest' }, { status: 400 })

  const now = new Date()
  const result = await db.insert(desktopAuthRequests).values({
    stateHash: createHash('sha256').update(state).digest('hex'),
    userId: session.user.id,
    callback,
    expiresAt: new Date(now.getTime() + 10 * 60_000),
  }).onConflictDoNothing()
  if (!result.rowCount) return NextResponse.json({ error: 'stateUnavailable' }, { status: 409 })
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

export const POST = withRequestLog('/api/desktop/begin', handlePOST)
