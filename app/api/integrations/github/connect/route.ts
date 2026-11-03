import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { withRequestLog } from '@/lib/request-log'
import { githubAuthorizeURL, githubConnectConfigured, sealGitHubSecret, startGitHubConnect } from '@/lib/github/connection'
import { GITHUB_PLUGIN_PATH } from '@/lib/github/connect-callback'
import { claimConnectIntent, isIntentToken, startLoopbackIntent } from '@/lib/github/connect-intent'
import { pool } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * Plugins → GitHub → Link GitHub: GitHub authorization for this signed-in user only.
 * From the desktop app it carries `intent`, a one-time token naming the app's
 * account (lib/github/connect-intent.ts). An app with a loopback return goes
 * straight to GitHub; for an older one the system browser must be signed in as
 * that account, and otherwise nothing is linked and both sides say so.
 */
async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  const intent = new URL(request.url).searchParams.get('intent')
  const plugin = (reason?: string) => {
    const back = new URL(GITHUB_PLUGIN_PATH, request.url)
    if (reason) back.searchParams.set('github', 'link-failed')
    if (reason && reason !== 'failed') back.searchParams.set('reason', reason)
    if (reason === 'browser-account' && intent) back.searchParams.set('intent', intent)
    return NextResponse.redirect(back)
  }
  // A desktop app that takes the return on its loopback: the link is for the app's
  // account whatever this browser is signed in as, so it goes straight to GitHub.
  if (intent !== null && githubConnectConfigured()) {
    const loopback = await startLoopbackIntent(pool, intent, { authorizeURL: githubAuthorizeURL, seal: sealGitHubSecret })
    if (loopback?.kind === 'github') return NextResponse.redirect(loopback.url)
    if (loopback?.kind === 'expired') return plugin('expired')
  }
  // The desktop opens this in the system browser, which may not be signed in yet:
  // sign in there and come back to the GitHub page, which offers to go on.
  if (!session?.user) {
    const next = '/?section=plugins&app=github' + (isIntentToken(intent) ? `&intent=${intent}` : '')
    return NextResponse.redirect(new URL(withBasePath(`/sign-in?next=${encodeURIComponent(next)}`), request.url))
  }
  if (!githubConnectConfigured()) return plugin('failed')
  if (intent !== null) {
    const claim = await claimConnectIntent(pool, intent, session.user.id)
    if (claim.kind === 'expired') return plugin('expired')
    if (claim.kind === 'otherAccount') return plugin('browser-account')
  }
  const { url, cookie } = startGitHubConnect(session.user.id)
  const response = NextResponse.redirect(url)
  response.cookies.set(cookie.name, cookie.value, cookie.options)
  return response
}

export const GET = withRequestLog('/api/integrations/github/connect', handleGET)
