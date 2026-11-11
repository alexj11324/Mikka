import { NextResponse } from 'next/server'
import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { desktopAuthRequests } from '@/lib/db/schema'
import { desktopAuthCode, desktopAuthState, desktopAuthVerifier } from '@/lib/desktop-auth'
import { sha256Hex, verifierMatches } from '@/lib/desktop-auth-server'
import { safeDesktopSession } from '@/lib/desktop-rpc/session'
import { withRequestLog } from '@/lib/request-log'
import { officialWebCallback, officialWebOriginAllowed } from '@/lib/web-connection/policy'
import { webAuthHeaders, webAuthStateHash } from '@/lib/web-connection/auth-server'

import { inheritEnterpriseSession } from '@/lib/enterprise/session-handoff'

export const dynamic = 'force-dynamic'
async function handlePOST(request: Request) {
  const reject = () => NextResponse.json({ error: 'web_auth_exchange_rejected' }, { status: 400, headers: webAuthHeaders })
  if (!officialWebOriginAllowed(request.headers.get('origin'))) return NextResponse.json({ error: 'web_auth_forbidden' }, { status: 403, headers: webAuthHeaders })
  let value: Record<string, unknown>
  try { value = await request.json() } catch { value = {} }
  const state = desktopAuthState(value?.state)
  const code = desktopAuthCode(value?.code)
  const verifier = desktopAuthVerifier(value?.verifier)
  const callback = officialWebCallback(value?.callback)
  if (!state || !code || !verifier || !callback) return NextResponse.json({ error: 'web_auth_invalid_request' }, { status: 400, headers: webAuthHeaders })
  const now = new Date()
  const scope = and(eq(desktopAuthRequests.stateHash, webAuthStateHash(state)), eq(desktopAuthRequests.callback, callback))
  // The first proof attempt consumes the code, including an incorrect verifier.
  const [row] = await db.update(desktopAuthRequests).set({ usedAt: now }).where(and(scope, isNotNull(desktopAuthRequests.boundAt), isNull(desktopAuthRequests.usedAt), gt(desktopAuthRequests.expiresAt, now))).returning({ codeHash: desktopAuthRequests.codeHash, challenge: desktopAuthRequests.codeChallenge, token: desktopAuthRequests.token, userId: desktopAuthRequests.userId })
  if (row) await db.update(desktopAuthRequests).set({ token: null }).where(scope)
  if (!row?.token || !row.userId || row.codeHash !== sha256Hex(code) || !verifierMatches(verifier, row.challenge)) return reject()
  try {
    const { internalAdapter } = await auth.$context
    const source = await internalAdapter.findSession(row.token)
    if (!source || source.user.id !== row.userId || source.session.expiresAt.getTime() <= Date.now()) return reject()
    const session = await internalAdapter.createSession(source.user.id)
    if (!session) return reject()
    let admitted = false
    try {
      admitted = await inheritEnterpriseSession(source.session.id, session.id, source.user.id)
      if (!admitted) return reject()
      return NextResponse.json({ token: session.token, ...safeDesktopSession({ user: source.user, session }) }, { headers: webAuthHeaders })
    } finally {
      if (!admitted) await internalAdapter.deleteSession(session.token)
    }
  } catch { return reject() }
}
export const POST = withRequestLog('/api/web/exchange', handlePOST)
