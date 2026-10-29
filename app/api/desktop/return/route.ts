import { headers } from 'next/headers'
import { NextResponse } from 'next/server'

import { auth } from '@/lib/auth'
import { safeAuthReturn } from '@/lib/auth-return'
import { withBasePath } from '@/lib/base-path'
import { desktopAuthState } from '@/lib/desktop-auth'
import en from '@/messages/en.json'
import zh from '@/messages/zh-CN.json'

export const dynamic = 'force-dynamic'

const safeHeaders = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)

/**
 * OAuth lands here in the system browser after the provider callback. The
 * browser holds the web session; the desktop app does not. Mint a one-minute,
 * single-use token and hand it to the app's custom protocol, together with the
 * nonce the app stored before opening the browser. The app exchanges the token
 * for its own session cookie; the token never becomes an app credential.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const state = desktopAuthState(url.searchParams.get('state')) ?? ''
  const next = safeAuthReturn(url.searchParams.get('next') ?? '/')
  const fail = () => {
    const query = new URLSearchParams({ oauth: 'failed' })
    if (state) query.set('desktop', '1')
    if (state) query.set('desktop_state', state)
    if (state) query.set('desktop_next', next)
    return NextResponse.redirect(new URL(withBasePath(`/sign-in?${query}`), url.origin), { status: 303, headers: safeHeaders })
  }

  if (!state) return fail()

  const requestHeaders = await headers()
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) return fail()

  try {
    const { token } = await auth.api.generateOneTimeToken({ headers: requestHeaders })
    if (!token) return fail()
    const deepLink = `mikka-desktop://auth?${new URLSearchParams({ token, state, next })}`
    const chinese = request.headers.get('accept-language')?.startsWith('zh')
    const copy = (chinese ? zh : en).DesktopHandoff
    const html = `<!doctype html><html lang="${chinese ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(copy.returnTitle)}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f4;color:#1c1917}main{max-width:28rem;padding:2rem;text-align:center}a{display:inline-block;margin-top:1rem;padding:.7rem 1.2rem;border-radius:.75rem;background:#1c1917;color:#fff;text-decoration:none}</style><main><h1>${escapeHtml(copy.returnTitle)}</h1><p>${escapeHtml(copy.returnBody)}</p><a href="${escapeHtml(deepLink)}">${escapeHtml(copy.openApp)}</a></main><script>location.replace(${JSON.stringify(deepLink)})</script></html>`
    return new NextResponse(html, { headers: { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' } })
  } catch {
    return fail()
  }
}
