import { NextResponse } from 'next/server'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { desktopAuthRequests } from '@/lib/db/schema'
import { withBasePath } from '@/lib/base-path'
import { DESKTOP_AUTH_EXCHANGE_TTL_MS, desktopAuthState } from '@/lib/desktop-auth'
import { newExchangeCode, sha256Hex } from '@/lib/desktop-auth-server'
import { withoutDesktopSession } from '@/lib/desktop-rpc/session'
import { officialWebCallback } from '@/lib/web-connection/policy'
import { webAuthSignInPath } from '@/lib/web-connection/auth'
import { webAuthConfirmedNavigation, webAuthHeaders, webAuthStateHash } from '@/lib/web-connection/auth-server'

export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  const url = new URL(request.url)
  const state = desktopAuthState(url.searchParams.get('state'))
  const callback = officialWebCallback(url.searchParams.get('callback'))
  const fail = () => {
    const target = new URL(state && callback ? webAuthSignInPath({ state, callback }) : withBasePath('/sign-in'), url.origin)
    target.searchParams.set('oauth', 'failed')
    return NextResponse.redirect(target, { status: 303, headers: webAuthHeaders })
  }
  if (!state || !callback || !webAuthConfirmedNavigation(request)) return fail()
  try {
    // Only this browser's fresh same-origin cookie can authorize the handoff.
    const headers = new Headers(request.headers)
    headers.delete('authorization')
    const session = await withoutDesktopSession(() => auth.api.getSession({ headers, query: { disableCookieCache: true } }))
    if (!session?.session.token) return fail()
    const code = newExchangeCode()
    const now = new Date()
    const bound = await db.update(desktopAuthRequests).set({
      userId: session.user.id, boundAt: now, codeHash: sha256Hex(code),
      // The source session is rechecked at exchange; the client receives a new independent session.
      token: session.session.token, expiresAt: new Date(now.getTime() + DESKTOP_AUTH_EXCHANGE_TTL_MS),
    }).where(and(eq(desktopAuthRequests.stateHash, webAuthStateHash(state)), eq(desktopAuthRequests.callback, callback), isNull(desktopAuthRequests.boundAt), isNull(desktopAuthRequests.usedAt), gt(desktopAuthRequests.expiresAt, now))).returning({ stateHash: desktopAuthRequests.stateHash })
    if (!bound.length) return fail()
    const target = new URL(callback)
    target.hash = new URLSearchParams({ state, code }).toString()
    return NextResponse.redirect(target, { status: 303, headers: webAuthHeaders })
  } catch { return fail() }
}
