import { noteLogUser, withRequestLog } from '@/lib/request-log'
import { after, NextRequest, NextResponse } from 'next/server'
import { auth, authBaseURL } from '@/lib/auth'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { getComposio, readComposioAccountEmail, renameComposioAccount, retireComposioAccount } from '@/lib/composio'
import { chooseComposioDefault, listComposioAccountRecords, noteComposioEmailAttempt, saveComposioAccountEmail } from '@/lib/composio-account-store'
import { followUpComposioConnect } from '@/lib/composio-connect'
import { COMPOSIO_FLOW_COOKIE, composioFlowCookieOptions, decodeComposioFlow } from '@/lib/composio-flow'
import { listComposioPages } from '@/lib/composio-pagination'
import { isComposioCallbackVerifierConfigured } from '@/lib/composio-config'
import { COMPOSIO_AUTH_CALLBACK_PATH } from '@/lib/auth-return'
import { bootstrapSuggestions } from '@/lib/suggestions/sources'

const SESSION_COOKIE = 'mikka_composio_session_uri'
const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }

function clearSessionCookie(request: NextRequest, response: NextResponse) {
  // The same options they were set with, so `secure` matches and the browser drops them.
  for (const name of [SESSION_COOKIE, COMPOSIO_FLOW_COOKIE]) response.cookies.set(name, '', composioFlowCookieOptions(request.url, 0))
  return response
}

/** Back to where the connect started (a validated same-origin path), or Settings › 连接. */
function integrationRedirect(request: NextRequest, result: string) {
  const returnTo = decodeComposioFlow(request.cookies.get(COMPOSIO_FLOW_COOKIE)?.value)?.returnTo ?? '/?settings=integrations'
  const url = new URL(withBasePath(returnTo), request.url)
  url.searchParams.set('composio', result)
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
    response.cookies.set(SESSION_COOKIE, sessionUri, composioFlowCookieOptions(request.url, 600))
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    response.headers.set('Referrer-Policy', noStore['Referrer-Policy'])
    return response
  }

  const composio = getComposio()
  if (!composio) {
    const response = integrationRedirect(request, 'callback-failed')
    clearSessionCookie(request, response)
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    return response
  }

  try {
    const completed = await composio.connectedAccounts.completeAuth({ userId: session.user.id, sessionUri })
    const userId = session.user.id
    const flow = decodeComposioFlow(request.cookies.get(COMPOSIO_FLOW_COOKIE)?.value)
    try {
      const [items, records] = await Promise.all([
        listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [userId], cursor })),
        listComposioAccountRecords(userId),
      ])
      // A reconnect retires the account it replaces only when this callback
      // completes the link that reconnect started; the old account's name and
      // default move to the new one. The email is read either way.
      await followUpComposioConnect({
        items,
        records,
        addedId: completed.connectedAccountId,
        replaceId: flow?.link === completed.connectedAccountId ? flow.replace : null,
      }, {
        readEmail: (toolkit, accountId) => readComposioAccountEmail(composio, userId, toolkit, accountId),
        saveEmail: (toolkit, accountId, email) => saveComposioAccountEmail(userId, toolkit, accountId, email),
        noteAttempt: (toolkit, accountId) => noteComposioEmailAttempt(userId, toolkit, accountId),
        rename: (accountId, alias) => renameComposioAccount(composio, accountId, alias),
        retire: accountId => retireComposioAccount(composio, userId, accountId),
        chooseDefault: (toolkit, accountId) => chooseComposioDefault(userId, toolkit, accountId),
        log: (step, error) => console.error('Composio connect follow-up failed', { step, error: error instanceof Error ? error.name : 'unknown' }),
      })
    } catch (error) {
      console.error('Composio connect follow-up failed', { step: 'list', error: error instanceof Error ? error.name : 'unknown' })
    }
    // Subscribe the new account's triggers and write the first briefing from what is there now.
    const timeZone = request.headers.get('x-vercel-ip-timezone')
    after(() => bootstrapSuggestions(userId, 'composio', timeZone))
    const response = integrationRedirect(request, 'connected')
    clearSessionCookie(request, response)
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    return response
  } catch {
    const response = integrationRedirect(request, 'callback-failed')
    clearSessionCookie(request, response)
    response.headers.set('Cache-Control', noStore['Cache-Control'])
    return response
  }
}

export const GET = withRequestLog('/api/integrations/composio/callback', handleGET)
