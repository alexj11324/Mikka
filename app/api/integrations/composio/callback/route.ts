import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { after, NextRequest, NextResponse } from 'next/server'
import { auth, authBaseURL } from '@/lib/auth'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { cannotRevokeComposioAccount, getComposio, isComposioToolkit } from '@/lib/composio'
import { COMPOSIO_REPLACE_COOKIE, disconnectComposioAccount } from '@/lib/composio-accounts'
import { listComposioPages } from '@/lib/composio-pagination'
import { isComposioCallbackVerifierConfigured } from '@/lib/composio-config'
import { COMPOSIO_AUTH_CALLBACK_PATH } from '@/lib/auth-return'
import { bootstrapSuggestions } from '@/lib/suggestions/sources'

const SESSION_COOKIE = 'mikka_composio_session_uri'
const CALLBACK_PATH = withBasePath(COMPOSIO_AUTH_CALLBACK_PATH)
const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }

function clearSessionCookie(response: NextResponse) {
  for (const name of [SESSION_COOKIE, COMPOSIO_REPLACE_COOKIE]) {
    response.cookies.set(name, '', { path: CALLBACK_PATH, maxAge: 0, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' })
  }
  return response
}

function integrationRedirect(request: NextRequest, result: string) {
  const url = new URL(withBasePath(`/?settings=integrations&composio=${result}`), request.url)
  return NextResponse.redirect(url)
}

async function handleGET(request: NextRequest) {
  if (!isComposioCallbackVerifierConfigured(authBaseURL, BASE_PATH)) {
    return new Response('Composio callback verifier is not configured.', { status: 503, headers: noStore })
  }

  const sessionUri = request.nextUrl.searchParams.get('session_uri') ?? request.cookies.get(SESSION_COOKIE)?.value
  if (!sessionUri || sessionUri.length > 4096) {
    return new Response('Invalid Composio callback.', { status: 400, headers: noStore })
  }

  const session = await auth.api.getSession({ headers: request.headers })

  noteLogUser(session?.user?.id)
  if (!session?.user) {
    const params = new URLSearchParams({ next: COMPOSIO_AUTH_CALLBACK_PATH })
    const response = NextResponse.redirect(new URL(withBasePath(`/sign-in?${params}`), request.url))
    response.cookies.set(SESSION_COOKIE, sessionUri, {
      path: CALLBACK_PATH,
      maxAge: 600,
      httpOnly: true,
      sameSite: 'lax',
      secure: request.nextUrl.protocol === 'https:',
    })
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    response.headers.set('Referrer-Policy', noStore['Referrer-Policy'])
    return response
  }

  const composio = getComposio()
  if (!composio) {
    const response = integrationRedirect(request, 'callback-failed')
    clearSessionCookie(response)
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    return response
  }

  try {
    const completed = await composio.connectedAccounts.completeAuth({ userId: session.user.id, sessionUri })
    // A reconnect: retire the account this connection replaces, only if it is
    // the person's own account on the same toolkit.
    const replaced = request.cookies.get(COMPOSIO_REPLACE_COOKIE)?.value
    if (replaced && replaced !== completed.connectedAccountId) {
      try {
        const items = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [session.user.id], cursor }))
        const old = items.find(item => item.id === replaced && item.toolkit.slug === completed.toolkitSlug && isComposioToolkit(item.toolkit.slug))
        if (old) await disconnectComposioAccount(composio.connectedAccounts, old.id, cannotRevokeComposioAccount)
      } catch (error) {
        console.error('Composio reconnect could not retire the old account', { error: error instanceof Error ? error.name : 'unknown' })
      }
    }
    // Subscribe the new account's triggers and write the first briefing from what is there now.
    const userId = session.user.id
    const timeZone = request.headers.get('x-vercel-ip-timezone')
    after(() => bootstrapSuggestions(userId, 'composio', timeZone))
    const response = integrationRedirect(request, 'connected')
    clearSessionCookie(response)
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    return response
  } catch {
    const response = integrationRedirect(request, 'callback-failed')
    clearSessionCookie(response)
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    return response
  }
}

export const GET = withRequestLog('/api/integrations/composio/callback', handleGET)
