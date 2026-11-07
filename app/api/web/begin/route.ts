import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { desktopAuthRequests } from '@/lib/db/schema'
import { DESKTOP_AUTH_PENDING_TTL_MS, desktopAuthChallenge, desktopAuthState } from '@/lib/desktop-auth'
import { withRequestLog } from '@/lib/request-log'
import { officialWebCallback, officialWebOriginAllowed } from '@/lib/web-connection/policy'
import { webAuthSignInPath } from '@/lib/web-connection/auth'
import { webAuthHeaders, webAuthStateHash } from '@/lib/web-connection/auth-server'

export const dynamic = 'force-dynamic'
async function handlePOST(request: Request) {
  if (!officialWebOriginAllowed(request.headers.get('origin'))) return NextResponse.json({ error: 'web_auth_forbidden' }, { status: 403, headers: webAuthHeaders })
  let value: Record<string, unknown>
  try { value = await request.json() } catch { value = {} }
  const state = desktopAuthState(value?.state)
  const challenge = desktopAuthChallenge(value?.challenge)
  const callback = officialWebCallback(value?.callback)
  if (!state || !challenge || !callback) return NextResponse.json({ error: 'web_auth_invalid_request' }, { status: 400, headers: webAuthHeaders })
  const result = await db.insert(desktopAuthRequests).values({
    stateHash: webAuthStateHash(state), callback, codeChallenge: challenge,
    expiresAt: new Date(Date.now() + DESKTOP_AUTH_PENDING_TTL_MS),
  }).onConflictDoNothing()
  if (!result.rowCount) return NextResponse.json({ error: 'web_auth_state_unavailable' }, { status: 409, headers: webAuthHeaders })
  return NextResponse.json({ signInUrl: new URL(webAuthSignInPath({ state, callback }), request.url).href }, { headers: webAuthHeaders })
}
export const POST = withRequestLog('/api/web/begin', handlePOST)
