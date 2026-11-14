import 'server-only'
import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { resolveAppOrigin } from '@/lib/auth-config'
import { withBasePath } from '@/lib/base-path'
import { completeGitHubConnect, exchangeGitHubCode, GITHUB_CALLBACK_PATH, GITHUB_CONNECT_COOKIE, githubConnectUser, unsealGitHubSecret } from './connection'
import { finishLoopbackIntent, isLoopbackState } from './connect-intent'
import { pool } from '@/lib/db'

/** Plugins → GitHub. */
export const GITHUB_PLUGIN_PATH = withBasePath('/?section=plugins&app=github')

function cookieValue(request: Request, name: string) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')) }
      // Malformed browser cookies cannot block the shared Better Auth callback.
      // Fail closed on the first matching cookie rather than picking a duplicate.
      catch { return undefined }
    }
  }
  return undefined
}

/** Finishes a Plugins → GitHub connection that returned on the shared GitHub
 * callback; null hands every other request (including GitHub sign-in) to Better Auth. */
export async function handleGitHubConnectCallback(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== GITHUB_CALLBACK_PATH) return null
  // A desktop link (lib/github/connect-intent.ts): its state names the link, not this browser's session.
  const state = url.searchParams.get('state')
  if (isLoopbackState(state)) {
    const code = url.searchParams.get('code')
    const finished = await finishLoopbackIntent(pool, state, code && code.length <= 512 ? code : null, { exchange: exchangeGitHubCode, unseal: unsealGitHubSecret })
    if (finished) return NextResponse.redirect(finished.returnURL)
  }
  const starter = githubConnectUser(url.searchParams.get('state'), cookieValue(request, GITHUB_CONNECT_COOKIE))
  if (!starter) return null
  /** Why a link failed, when the callback can tell: cancelled on GitHub, or the Mikka account changed meanwhile. */
  const done = (result: 'connected' | 'link-failed', reason?: 'cancelled' | 'account') => {
    const destination = new URL(GITHUB_PLUGIN_PATH, resolveAppOrigin(process.env) ?? url.origin)
    if (result === 'link-failed') destination.searchParams.set('github', 'link-failed')
    if (result === 'link-failed' && reason) destination.searchParams.set('reason', reason)
    const response = NextResponse.redirect(destination)
    response.cookies.set(GITHUB_CONNECT_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', path: GITHUB_CALLBACK_PATH, maxAge: 0 })
    return response
  }
  const code = url.searchParams.get('code')
  if (!code || code.length > 512) return done('link-failed', url.searchParams.get('error') === 'access_denied' ? 'cancelled' : undefined)
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (session?.user.id !== starter) return done('link-failed', 'account')
    await completeGitHubConnect(starter, code)
    return done('connected')
  } catch {
    return done('link-failed')
  }
}
