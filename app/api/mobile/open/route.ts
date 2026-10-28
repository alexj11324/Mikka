import { NextResponse } from 'next/server'
import { withRequestLog } from '@/lib/request-log'
import { auth } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { appOrigin } from '@/lib/mcp/resource'
import { mobileWebTarget } from '@/lib/mobile-web-target'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/mobile/open?token=<one-time token>&to=<path>`: the iOS app opens a
 * web page signed in as the person. The browser the app opens does not share
 * the app's keychain cookie, so the app first asks better-auth for a
 * one-minute, single-use token (`/api/auth/one-time-token/generate`); this
 * exchanges it for the session cookie and goes to `to` (mobileWebTarget).
 * A used or expired token goes to the page anyway, where sign-in asks.
 */
async function handleGET(request: Request) {
  const url = new URL(request.url)
  const target = new URL(withBasePath(mobileWebTarget(url.searchParams.get('to'))), appOrigin ?? url.origin)
  const response = NextResponse.redirect(target, { status: 303, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } })
  const token = url.searchParams.get('token')
  if (!token) return response
  try {
    const { headers } = await auth.api.verifyOneTimeToken({ body: { token }, headers: request.headers, returnHeaders: true })
    for (const cookie of headers.getSetCookie()) response.headers.append('set-cookie', cookie)
  } catch {
    // Used or expired: the page asks the person to sign in.
  }
  return response
}

export const GET = withRequestLog('/api/mobile/open', handleGET)
