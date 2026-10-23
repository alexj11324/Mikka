import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { NextRequest, NextResponse } from 'next/server'
import { getPathname } from '@/i18n/navigation'
import { routing } from '@/i18n/routing'
import { auth } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { completeGoogleLink } from '@/lib/google-link'

async function handleGET(request: NextRequest) {
  const requestedLocale = request.nextUrl.searchParams.get('locale')
  const locale = routing.locales.includes(requestedLocale as typeof routing.locales[number])
    ? requestedLocale as typeof routing.locales[number]
    : routing.defaultLocale
  const redirectResult = (status: 'linked' | 'failed') => {
    const path = getPathname({ locale, href: '/' })
    return NextResponse.redirect(new URL(withBasePath(`${path}?settings=integrations&google=${status}`), request.url), {
      headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    })
  }

  const session = await auth.api.getSession({ headers: request.headers })

  noteLogUser(session?.user?.id)
  if (!session?.user) return redirectResult('failed')

  try {
    const accounts = await auth.api.listUserAccounts({ headers: request.headers })
    const context = await auth.$context
    const linked = await completeGoogleLink(session.user.id, accounts, (userId, data) => context.internalAdapter.updateUser(userId, data))
    if (!linked) return redirectResult('failed')
    return redirectResult('linked')
  } catch {
    return redirectResult('failed')
  }
}

export const GET = withRequestLog('/api/integrations/google/callback', handleGET)
