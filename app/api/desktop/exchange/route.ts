import { NextResponse } from 'next/server'
import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm'

import { db } from '@/lib/db'
import { desktopAuthRequests } from '@/lib/db/schema'
import { desktopAuthCode, desktopAuthState, desktopAuthVerifier } from '@/lib/desktop-auth'
import { sha256Hex, verifierMatches } from '@/lib/desktop-auth-server'
import { withRequestLog } from '@/lib/request-log'

export const dynamic = 'force-dynamic'

const noStore = { 'Cache-Control': 'no-store' }

/**
 * The desktop trades the loopback code and the verifier it kept since
 * /begin for the parked one-time sign-in token. The row is consumed on the
 * first attempt, right or wrong, so a code cannot be guessed against.
 */
async function handlePOST(request: Request) {
  const origin = request.headers.get('origin')
  if (origin && origin !== new URL(request.url).origin) return new NextResponse(null, { status: 403 })
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
  if (!state || !code || !verifier) return NextResponse.json({ error: 'invalidRequest' }, { status: 400, headers: noStore })

  const now = new Date()
  const [row] = await db.update(desktopAuthRequests).set({ usedAt: now })
    .where(and(eq(desktopAuthRequests.stateHash, sha256Hex(state)), isNotNull(desktopAuthRequests.boundAt), isNull(desktopAuthRequests.usedAt), gt(desktopAuthRequests.expiresAt, now)))
    .returning({ codeHash: desktopAuthRequests.codeHash, challenge: desktopAuthRequests.codeChallenge, token: desktopAuthRequests.token })
  // RETURNING yields the row after the update, so clear the parked token next.
  if (row) await db.update(desktopAuthRequests).set({ token: null }).where(eq(desktopAuthRequests.stateHash, sha256Hex(state)))
  if (!row?.token || row.codeHash !== sha256Hex(code) || !verifierMatches(verifier, row.challenge)) {
    return NextResponse.json({ error: 'exchangeRejected' }, { status: 400, headers: noStore })
  }
  return NextResponse.json({ token: row.token }, { headers: noStore })
}

export const POST = withRequestLog('/api/desktop/exchange', handlePOST)
