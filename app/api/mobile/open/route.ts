import { randomBytes, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { withRequestLog } from '@/lib/request-log'
import { auth } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { isCloudEdition } from '@/lib/edition'
import { isTaskReference, mobileTaskTarget } from '@/lib/mobile-task-handoff'
import { webConnectionEnabled, webConnectionURL } from '@/lib/web-connection/policy'
import { mobileWebTarget } from '@/lib/mobile-web-target'
import { handoffSessionCookie, openHandoff, sealHandoff } from '@/lib/mobile-handoff'
import { mobileWebWorkspace, MobileWebScopeError } from '@/lib/mobile-web-scope'
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
    // HTTP router mode prevents nextCookies() from mutating the ambient Next
    // response before the person confirms. Direct auth.api calls run that hook.
    const exchanged = await auth.handler(new Request(new URL(withBasePath('/api/auth/one-time-token/verify'), url.origin), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: url.origin }, body: JSON.stringify({ token }),
    }))
    if (!exchanged.ok) throw new Error('Mobile handoff token unavailable')
    const session = await exchanged.json() as { user: { id: string; email: string } }
    const workspaceId = await mobileWebWorkspace(session.user.id, target)
    const headers = exchanged.headers
    const csrf = randomBytes(32).toString('base64url')
    const state = sealHandoff({ cookies: headers.getSetCookie(), target, workspaceId, origin: url.origin, csrf, expires: Date.now() + 60_000 }, (await auth.$context).secret)
    if (state.length > 3500) throw new Error('Mobile handoff cookie exceeds browser limit')
    const copy = (request.headers.get('accept-language')?.startsWith('zh') ? zh : en).MobileHandoff
    const html = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(copy.title)}</title><main><h1>${escape(copy.title)}</h1><p>${escape(session.user.email)}</p><form method="post" action="${escape(path)}"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">${escape(copy.confirm)}</button></form><a href="${escape(withBasePath(target))}">${escape(copy.cancel)}</a></main></html>`
    // Browsers send Origin: null on even a same-origin form POST under no-referrer.
    // An origin-only referrer retains the CSRF origin check and never includes the native token or target.
    const result = new NextResponse(html, { headers: { ...safeHeaders, 'Referrer-Policy': 'strict-origin', 'Content-Type': 'text/html; charset=utf-8' } })
    result.cookies.set(pendingCookie, state, cookieOptions(request))
    return result
  } catch (error) {
    if (error instanceof MobileWebScopeError) return new NextResponse(null, { status: 403, headers: safeHeaders })
    return NextResponse.redirect(new URL(withBasePath(target), url.origin), { status: 303, headers: safeHeaders })
  }
}

/** Same-origin, browser-bound confirmation; recheck session revocation before copying cookies. */
async function handlePOST(request: Request) {
  const url = new URL(request.url)
  if (request.headers.get('origin') !== url.origin) return new NextResponse(null, { status: 403, headers: safeHeaders })
  if (request.headers.get('content-type')?.split(';')[0] === 'application/json') return claimTask(request, url.origin)
  const cookie = request.headers.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${pendingCookie}=`))?.slice(pendingCookie.length + 1)
  const state = cookie ? openHandoff(cookie, (await auth.$context).secret) : null
  const form = await request.formData().catch(() => null)
  const csrf = form?.get('csrf')
  if (!state || state.origin !== url.origin || typeof csrf !== 'string' || !same(state.csrf, csrf)) return new NextResponse(null, { status: 403, headers: safeHeaders })
  const session = await auth.api.getSession({ headers: new Headers({ cookie: handoffSessionCookie(state.cookies) }), query: { disableCookieCache: true } })
  if (!session) return new NextResponse(null, { status: 403, headers: safeHeaders })
  let workspaceId: string | null
  try { workspaceId = await mobileWebWorkspace(session.user.id, state.target) }
  catch { return new NextResponse(null, { status: 403, headers: safeHeaders }) }
  if (workspaceId !== (state.workspaceId ?? null)) return new NextResponse(null, { status: 403, headers: safeHeaders })
  const task = mobileTaskTarget(state.target)
  let destination = new URL(withBasePath(mobileWebTarget(state.target)), url.origin)
  if (task) {
    const server = new URL(withBasePath('/'), url.origin).href.replace(/\/$/, '')
    const client = isCloudEdition() ? server : webConnectionEnabled() && webConnectionURL()
    if (!client) return new NextResponse(null, { status: 403, headers: safeHeaders })
    const ref = randomBytes(32).toString('base64url')
    const { internalAdapter } = await auth.$context
    const stored = await internalAdapter.reserveVerificationValue({ identifier: taskKey(url.origin, session.user.id, ref),
      value: task, expiresAt: new Date(Date.now() + 5 * 60_000) })
    if (!stored) return new NextResponse(null, { status: 409, headers: safeHeaders })
    destination = new URL(client)
    destination.hash = new URLSearchParams({ mobileTask: ref, server }).toString()
  }
  // Keep form-action 'self': Chromium also applies it to cross-origin POST
  // redirects. Finish the local form first, then make an ordinary GET with no referrer.
  let response: NextResponse
  if (destination.origin === url.origin) {
    response = NextResponse.redirect(destination, { status: 303, headers: safeHeaders })
  } else {
    const href = escape(destination.href)
    const copy = (request.headers.get('accept-language')?.startsWith('zh') ? zh : en).MobileHandoff
    const html = `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0; url=${href}"><title>${escape(copy.title)}</title><main><a href="${href}">${escape(copy.confirm)}</a></main></html>`
    response = new NextResponse(html, { headers: { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' } })
  }
  // Expire only this ephemeral credential, preserving session revocation semantics.
  response.cookies.set(pendingCookie, '', { ...cookieOptions(request), maxAge: 0 })
  if (workspaceId) response.cookies.set('mikka-workspace', workspaceId, { httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', path: '/', maxAge: 31536000 })
  for (const value of state.cookies) response.headers.append('set-cookie', value)
  return response
}
// The identifier is scoped to the origin and authenticated user. A different
// browser account cannot consume or learn another account's navigation target.
const taskKey = (origin: string, user: string, ref: string) => 'mikka:mobile-task:' + JSON.stringify([origin, user, ref])

async function claimTask(request: Request, origin: string) {
  const value = await request.json().catch(() => null)
  if (!isTaskReference(value?.ref)) return new NextResponse(null, { status: 400, headers: safeHeaders })
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  if (!session) return new NextResponse(null, { status: 401, headers: safeHeaders })
  const { internalAdapter } = await auth.$context
  const stored = await internalAdapter.consumeVerificationValue(taskKey(origin, session.user.id, value.ref))
  const target = mobileTaskTarget(stored?.value)
  if (!target) return new NextResponse(null, { status: 404, headers: safeHeaders })
  const issueId = new URLSearchParams(target.slice(2)).get('issue')!
  const { issueForUser } = await import('@/lib/issue-access')
  const issue = await issueForUser(session.user, issueId, false, undefined, { withoutBody: true })
  if (!issue || issue.ownershipState !== 'bound' || !issue.workspaceId) return new NextResponse(null, { status: 404, headers: safeHeaders })
  // TaskDetail and its immutable Factory receipt check their own grants again.
  return NextResponse.json({ target, workspaceId: issue.workspaceId, userId: session.user.id }, { headers: safeHeaders })
}

export const GET = withRequestLog('/api/mobile/open', handleGET)
export const POST = withRequestLog('/api/mobile/open', handlePOST)
