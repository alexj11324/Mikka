import createMiddleware from 'next-intl/middleware'
import { NextResponse, type NextRequest } from 'next/server'
import { waitForPreviewReady } from './lib/preview-ready.mjs'
import { routing } from './i18n/routing'

const localize = createMiddleware(routing)
let ready: Promise<boolean> | undefined

export default async function proxy(request: NextRequest) {
  if (process.env.NODE_ENV === 'development' && process.env.PREVIEW_READY_FILE) {
    ready ??= waitForPreviewReady(process.env.PREVIEW_READY_FILE)
    if (!await ready) {
      ready = undefined
      return new NextResponse('Preview 接口预编译未完成，请检查启动日志后重试。', {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '5', 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }
  }
  if (process.env.NODE_ENV === 'production') {
    const localePrefix = request.nextUrl.pathname.match(/^\/(en|zh-CN)(?=\/)/)?.[0] ?? ''
    const pathname = request.nextUrl.pathname.slice(localePrefix.length)
    if (pathname === '/preview' || pathname === '/preview/settings') {
      const destination = request.nextUrl.clone()
      destination.pathname = `${localePrefix}${pathname === '/preview' ? '/' : '/settings/members'}`
      destination.search = ''
      if (pathname === '/preview/settings') {
        const workspace = request.nextUrl.searchParams.get('workspace')
        if (workspace !== null) destination.searchParams.set('workspace', workspace)
        if (request.nextUrl.searchParams.get('invite') === '1') destination.searchParams.set('invite', '1')
      }
      return NextResponse.redirect(destination)
    }
  }
  return localize(request)
}

export const config = {
  // Pages only. `/api` (better-auth and device SSH), `/v1` (daemon API),
  // `/_next` and dotted static assets must reach their own routes untouched.
  // '/' is listed on its own: under the base path the app root is /mikka, which
  // the catch-all pattern (/mikka/...) does not match.
  matcher: ['/', '/((?!api|v1|trpc|_next|_vercel|__nextjs|.*\\..*).*)'],
}
