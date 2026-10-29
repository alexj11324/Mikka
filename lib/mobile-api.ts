import 'server-only'
import { NextResponse } from 'next/server'
import { auth, MOBILE_APP_ORIGIN } from '@/lib/auth'
import { appOrigin } from '@/lib/mcp/resource'

/**
 * Shared pieces of the iOS app's API (app/api/mobile). The app signs in with
 * better-auth's Expo plugin, which sends the session cookie as a header, so
 * these routes read the session the same way the web's do.
 */
export const NO_STORE = { 'Cache-Control': 'private, no-store' }

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

export async function mobileUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  return session?.user ?? null
}

/**
 * A write from the app or from this site. The app sends no Origin (or its own
 * scheme); a browser always sends one, so a cross-site form is refused. The
 * site's own origin is the request's or the configured one (behind a proxy
 * the request may carry an internal host).
 */
export function writeAllowed(request: Request) {
  const origin = request.headers.get('origin') ?? request.headers.get('expo-origin')
  return !origin || origin === new URL(request.url).origin || origin === appOrigin || origin.startsWith(MOBILE_APP_ORIGIN)
}

export const unauthorized = () => json({ error: 'authRequired' }, 401)
export const forbiddenOrigin = () => json({ error: 'originNotAllowed' }, 403)
