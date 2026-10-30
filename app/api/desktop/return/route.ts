import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { and, eq, gt, isNull } from 'drizzle-orm'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { desktopAuthRequests } from '@/lib/db/schema'
import { safeAuthReturn } from '@/lib/auth-return'
import { withBasePath } from '@/lib/base-path'
import { DESKTOP_AUTH_EXCHANGE_TTL_MS, desktopAuthState, desktopLoopbackCallback } from '@/lib/desktop-auth'
import { newExchangeCode, sha256Hex } from '@/lib/desktop-auth-server'

export const dynamic = 'force-dynamic'

const safeHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
}

/**
 * OAuth lands here in the system browser after the provider callback. The
 * browser holds the web session; the desktop app does not. Bind the pending
 * request to this person, park a one-minute sign-in token on it and send the
 * Electron loopback listener a one-time code. The desktop trades the code and
 * its verifier for the token, then the token for its own session cookie.
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

  const stateHash = sha256Hex(state)
  try {
    // Mint the sign-in token with this browser's session, then bind the
    // pending row to this person exactly once. A row someone else already
    // bound, a used or expired row, or a different callback all fail.
    const { token } = await auth.api.generateOneTimeToken({ headers: requestHeaders })
    if (!token) return fail()
    const code = newExchangeCode()
    const now = new Date()
    const bound = await db.update(desktopAuthRequests).set({
      userId: session.user.id,
      boundAt: now,
      codeHash: sha256Hex(code),
      token,
      expiresAt: new Date(now.getTime() + DESKTOP_AUTH_EXCHANGE_TTL_MS),
    })
      .where(and(eq(desktopAuthRequests.stateHash, stateHash), eq(desktopAuthRequests.callback, callback), isNull(desktopAuthRequests.boundAt), isNull(desktopAuthRequests.usedAt), gt(desktopAuthRequests.expiresAt, now)))
      .returning({ stateHash: desktopAuthRequests.stateHash })
    if (!bound.length) return fail()
    // The loopback gets a code, never the token: only the desktop that holds
    // the verifier can trade it (/api/desktop/exchange).
    const target = new URL(callback)
    target.searchParams.set('code', code)
    target.searchParams.set('state', state)
    target.searchParams.set('next', next)
    return NextResponse.redirect(target, { status: 303, headers: safeHeaders })
  } catch {
    return fail()
  }
}
