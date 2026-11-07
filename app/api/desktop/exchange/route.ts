import { NextResponse } from 'next/server'
import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm'

import { db } from '@/lib/db'
import { desktopAuthRequests } from '@/lib/db/schema'
import { desktopAuthCode, desktopAuthState, desktopAuthVerifier, desktopSameOriginRequest } from '@/lib/desktop-auth'
import { sha256Hex, verifierMatches } from '@/lib/desktop-auth-server'
import { withRequestLog } from '@/lib/request-log'
import { auth } from '@/lib/auth'
import { safeDesktopSession } from '@/lib/desktop-rpc/session'
import { DESKTOP_SESSION_CACHE_HEADER, desktopSessionCacheFromHeaders } from '@/lib/desktop-rpc/session-cache'

export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store' }

/**
 * The desktop trades the loopback code and the verifier it kept since
 * /begin for the parked one-time sign-in token. The row is consumed on the
 * first attempt, right or wrong, so a code cannot be guessed against.
 */
async function handlePOST(request: Request) {
  if (!desktopSameOriginRequest(request)) return new NextResponse(null, { status: 403 })
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalidRequest' }, { status: 400, headers: noStore })
  }
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const state = desktopAuthState(value.state)
  const code = desktopAuthCode(value.code)
  const verifier = desktopAuthVerifier(value.verifier)
  if (!state || !code || !verifier || (value.client !== undefined && value.client !== 'bundled')) return NextResponse.json({ error: 'invalidRequest' }, { status: 400, headers: noStore })

  const now = new Date()
  // Lock the still-unused row before returning its old token. Consuming and
  // clearing then commit together; concurrent attempts cannot both redeem it.
  const pending = db.$with('pending_desktop_auth').as(db.select({
    stateHash: desktopAuthRequests.stateHash, codeHash: desktopAuthRequests.codeHash,
    challenge: desktopAuthRequests.codeChallenge, token: desktopAuthRequests.token,
  }).from(desktopAuthRequests)
    .where(and(eq(desktopAuthRequests.stateHash, sha256Hex(state)), isNotNull(desktopAuthRequests.boundAt), isNull(desktopAuthRequests.usedAt), gt(desktopAuthRequests.expiresAt, now)))
    .for('update'))
  const [row] = await db.with(pending).update(desktopAuthRequests).set({ usedAt: now, token: null })
    .from(pending).where(eq(desktopAuthRequests.stateHash, pending.stateHash))
    .returning({ codeHash: pending.codeHash, challenge: pending.challenge, token: pending.token })
  if (!row?.token || row.codeHash !== sha256Hex(code) || !verifierMatches(verifier, row.challenge)) {
    return NextResponse.json({ error: 'exchangeRejected' }, { status: 400, headers: noStore })
  }
  if (value.client === 'bundled') {
    try {
      // The same single-use PKCE handoff, redeemed here so only the main process
      // receives a bearer. Never expose the parked token to the local renderer.
      const { response: session, headers } = await auth.api.verifyOneTimeToken({ body: { token: row.token }, headers: new Headers(), returnHeaders: true })
      const cache = desktopSessionCacheFromHeaders(headers, (await auth.$context).authCookies.sessionData.name)
      return NextResponse.json({ token: session.session.token, ...safeDesktopSession(session) }, { headers: { ...noStore, ...(cache !== undefined ? { [DESKTOP_SESSION_CACHE_HEADER]: cache } : {}) } })
    } catch {
      return NextResponse.json({ error: 'exchangeRejected' }, { status: 400, headers: noStore })
    }
  }
  return NextResponse.json({ token: row.token }, { headers: noStore })
}

export const POST = withRequestLog('/api/desktop/exchange', handlePOST)
