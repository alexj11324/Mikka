import { NextRequest, NextResponse } from 'next/server'
import { auth, authBaseURL } from '@/lib/auth'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { getComposio } from '@/lib/composio'
import { isComposioCallbackVerifierConfigured } from '@/lib/composio-config'
import { COMPOSIO_AUTH_CALLBACK_PATH } from '@/lib/auth-return'

const SESSION_COOKIE = 'mikka_composio_session_uri'
const CALLBACK_PATH = withBasePath(COMPOSIO_AUTH_CALLBACK_PATH)
const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }

function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, '', { path: CALLBACK_PATH, maxAge: 0, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' })
  return response
}

function integrationRedirect(request: NextRequest, result: string) {
  const url = new URL(withBasePath(`/?settings=integrations&composio=${result}`), request.url)
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest) {
  if (!isComposioCallbackVerifierConfigured(authBaseURL, BASE_PATH)) {
    return new Response('Composio callback verifier is not configured.', { status: 503, headers: noStore })
  }

  const sessionUri = request.nextUrl.searchParams.get('session_uri') ?? request.cookies.get(SESSION_COOKIE)?.value
  if (!sessionUri || sessionUri.length > 4096) {
    return new Response('Invalid Composio callback.', { status: 400, headers: noStore })
  }

  const session = await auth.api.getSession({ headers: request.headers })
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
    await composio.connectedAccounts.completeAuth({ userId: session.user.id, sessionUri })
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
