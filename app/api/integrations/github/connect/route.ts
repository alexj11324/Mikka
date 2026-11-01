import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { withRequestLog } from '@/lib/request-log'
import { githubConnectConfigured, startGitHubConnect } from '@/lib/github/connection'
import { GITHUB_PLUGIN_PATH } from '@/lib/github/connect-callback'

export const runtime = 'nodejs'

/** Plugins → GitHub → Link GitHub: GitHub authorization for this signed-in user only. */
async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  // The desktop opens this in the system browser, which may not be signed in yet:
  // sign in there and come back to the GitHub page.
  if (!session?.user) return NextResponse.redirect(new URL(withBasePath(`/sign-in?next=${encodeURIComponent('/?section=plugins&app=github')}`), request.url))
  if (!githubConnectConfigured()) {
    const back = new URL(GITHUB_PLUGIN_PATH, request.url)
    back.searchParams.set('github', 'link-failed')
    return NextResponse.redirect(back)
  }
  const { url, cookie } = startGitHubConnect(session.user.id)
  const response = NextResponse.redirect(url)
  response.cookies.set(cookie.name, cookie.value, cookie.options)
  return response
}

export const GET = withRequestLog('/api/integrations/github/connect', handleGET)
