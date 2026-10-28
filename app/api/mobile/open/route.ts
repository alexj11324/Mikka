import { randomBytes, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { withRequestLog } from '@/lib/request-log'
import { auth } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { mobileWebTarget } from '@/lib/mobile-web-target'
import { handoffSessionCookie, openHandoff, sealHandoff } from '@/lib/mobile-handoff'
import en from '@/messages/en.json'
import zh from '@/messages/zh-CN.json'

export const dynamic = 'force-dynamic'
const pendingCookie = 'mikka-mobile-handoff'
const path = withBasePath('/api/mobile/open')
const safeHeaders = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff' }
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const same = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const cookieOptions = (request: Request) => ({ httpOnly: true, secure: new URL(request.url).protocol === 'https:', sameSite: 'strict' as const, path, maxAge: 60 })

/** Consume the native token, but never sign in merely by following a link. */
async function handleGET(request: Request) {
  const url = new URL(request.url)
  const target = mobileWebTarget(url.searchParams.get('to'))
  const token = url.searchParams.get('token')
  if (!token) return NextResponse.redirect(new URL(withBasePath(target), url.origin), { status: 303, headers: safeHeaders })
  try {
    const { headers, response: session } = await auth.api.verifyOneTimeToken({ body: { token }, headers: request.headers, returnHeaders: true })
    const csrf = randomBytes(32).toString('base64url')
    const state = sealHandoff({ cookies: headers.getSetCookie(), target, origin: url.origin, csrf, expires: Date.now() + 60_000 }, (await auth.$context).secret)
    if (state.length > 3500) throw new Error('Mobile handoff cookie exceeds browser limit')
    const copy = (request.headers.get('accept-language')?.startsWith('zh') ? zh : en).MobileHandoff
    const html = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(copy.title)}</title><main><h1>${escape(copy.title)}</h1><p>${escape(session.user.email)}</p><form method="post" action="${escape(path)}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">${escape(copy.confirm)}</button></form><a href="${escape(withBasePath(target))}">${escape(copy.cancel)}</a></main></html>`
    const result = new NextResponse(html, { headers: { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' } })
    result.cookies.set(pendingCookie, state, cookieOptions(request))
    return result
  } catch {
    return NextResponse.redirect(new URL(withBasePath(target), url.origin), { status: 303, headers: safeHeaders })
  }
}

/** Same-origin, browser-bound confirmation; recheck session revocation before copying cookies. */
async function handlePOST(request: Request) {
  const url = new URL(request.url)
  if (request.headers.get('origin') !== url.origin) return new NextResponse(null, { status: 403, headers: safeHeaders })
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${pendingCookie}=`))?.slice(pendingCookie.length + 1)
  const state = cookie ? openHandoff(cookie, (await auth.$context).secret) : null
  const form = await request.formData().catch(() => null)
  const csrf = form?.get('csrf')
  if (!state || state.origin !== url.origin || typeof csrf !== 'string' || !same(state.csrf, csrf)) return new NextResponse(null, { status: 403, headers: safeHeaders })
  const session = await auth.api.getSession({ headers: new Headers({ cookie: handoffSessionCookie(state.cookies) }), query: { disableCookieCache: true } })
  if (!session) return new NextResponse(null, { status: 403, headers: safeHeaders })
  const response = NextResponse.redirect(new URL(withBasePath(mobileWebTarget(state.target)), url.origin), { status: 303, headers: safeHeaders })
  // Expire only this ephemeral credential, preserving session revocation semantics.
  response.cookies.set(pendingCookie, '', { ...cookieOptions(request), maxAge: 0 })
  for (const value of state.cookies) response.headers.append('set-cookie', value)
  return response
}
export const GET = withRequestLog('/api/mobile/open', handleGET)
export const POST = withRequestLog('/api/mobile/open', handlePOST)
