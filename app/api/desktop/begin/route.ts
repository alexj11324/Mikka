import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { desktopAuthRequests } from '@/lib/db/schema'
import { DESKTOP_AUTH_PENDING_TTL_MS, desktopAuthChallenge, desktopAuthState, desktopLoopbackCallback } from '@/lib/desktop-auth'
import { sha256Hex } from '@/lib/desktop-auth-server'
import { withRequestLog } from '@/lib/request-log'

export const dynamic = 'force-dynamic'

/**
 * Registers a desktop sign-in before the system browser opens. The desktop is
 * usually signed out, so the row is not bound to anyone yet: it holds the
 * nonce hash, the loopback callback and a challenge for a verifier only the
 * desktop knows. The browser that finishes OAuth binds it once (/return), and
 * only the holder of the verifier can trade the result for a token (/exchange).
 */
async function handlePOST(request: Request) {
  const origin = request.headers.get('origin')
  if (origin && origin !== new URL(request.url).origin) return new NextResponse(null, { status: 403 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalidRequest' }, { status: 400 })
  }
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const state = desktopAuthState(value.state)
  const callback = desktopLoopbackCallback(value.callback)
  const challenge = desktopAuthChallenge(value.challenge)
  if (!state || !callback || !challenge) return NextResponse.json({ error: 'invalidRequest' }, { status: 400 })

  const result = await db.insert(desktopAuthRequests).values({
    stateHash: sha256Hex(state),
    callback,
    codeChallenge: challenge,
    expiresAt: new Date(Date.now() + DESKTOP_AUTH_PENDING_TTL_MS),
  }).onConflictDoNothing()
  if (!result.rowCount) return NextResponse.json({ error: 'stateUnavailable' }, { status: 409 })
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

export const POST = withRequestLog('/api/desktop/begin', handlePOST)
