import { createHash } from 'node:crypto'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { and, eq, gt, isNull } from 'drizzle-orm'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { desktopAuthRequests } from '@/lib/db/schema'
import { safeAuthReturn } from '@/lib/auth-return'
import { withBasePath } from '@/lib/base-path'
import { desktopAuthState, desktopLoopbackCallback } from '@/lib/desktop-auth'

export const dynamic = 'force-dynamic'

const safeHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
}

/**
 * OAuth lands here in the system browser after the provider callback. The
 * browser holds the web session; the desktop app does not. Mint a one-minute,
 * single-use token and hand it to the Electron loopback listener, together
 * with the nonce the app stored before opening the browser. The app exchanges
 * the token for its own session cookie; the token never becomes an app
 * credential and never travels through a custom URL scheme.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const state = desktopAuthState(url.searchParams.get('state'))
  const callback = desktopLoopbackCallback(url.searchParams.get('callback'))
  const next = safeAuthReturn(url.searchParams.get('next') ?? '/')
  const fail = () => {
    const query = new URLSearchParams({ oauth: 'failed' })
    if (state) {
      query.set('desktop', '1')
      query.set('desktop_state', state)
      query.set('desktop_next', next)
    }
    if (callback) query.set('desktop_callback', callback)
    return NextResponse.redirect(new URL(withBasePath(`/sign-in?${query}`), url.origin), { status: 303, headers: safeHeaders })
  }

  if (!state || !callback) return fail()

  const requestHeaders = await headers()
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) return fail()

  const stateHash = createHash('sha256').update(state).digest('hex')
  const [authRequest] = await db.select({ callback: desktopAuthRequests.callback })
    .from(desktopAuthRequests)
    .where(and(eq(desktopAuthRequests.stateHash, stateHash), eq(desktopAuthRequests.userId, session.user.id), isNull(desktopAuthRequests.usedAt), gt(desktopAuthRequests.expiresAt, new Date())))
    .limit(1)
  if (!authRequest || authRequest.callback !== callback) return fail()

  try {
    const claimed = await db.update(desktopAuthRequests).set({ usedAt: new Date() })
      .where(and(eq(desktopAuthRequests.stateHash, stateHash), eq(desktopAuthRequests.userId, session.user.id), isNull(desktopAuthRequests.usedAt), gt(desktopAuthRequests.expiresAt, new Date())))
      .returning({ stateHash: desktopAuthRequests.stateHash })
    if (!claimed.length) return fail()
    const { token } = await auth.api.generateOneTimeToken({ headers: requestHeaders })
    if (!token) return fail()
    const target = new URL(callback)
    target.searchParams.set('token', token)
    target.searchParams.set('state', state)
    target.searchParams.set('next', next)
    return NextResponse.redirect(target, { status: 303, headers: safeHeaders })
  } catch {
    return fail()
  }
}
