import 'server-only'
import { NextResponse } from 'next/server'
import { auth, authBaseURL } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { completeGitHubConnect, GITHUB_CALLBACK_PATH, GITHUB_CONNECT_COOKIE, githubConnectUser } from './connection'

/** Plugins → GitHub. */
export const GITHUB_PLUGIN_PATH = withBasePath('/?section=plugins&app=github')

function cookieValue(request: Request, name: string) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

/** Finishes a Plugins → GitHub connection that returned on the shared GitHub
 * callback; null hands every other request (including GitHub sign-in) to Better Auth. */
export async function handleGitHubConnectCallback(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== GITHUB_CALLBACK_PATH) return null
  const starter = githubConnectUser(url.searchParams.get('state'), cookieValue(request, GITHUB_CONNECT_COOKIE))
  if (!starter) return null
  const done = (result: 'connected' | 'link-failed') => {
    const destination = new URL(GITHUB_PLUGIN_PATH, authBaseURL ?? url.origin)
    if (result === 'link-failed') destination.searchParams.set('github', 'link-failed')
    const response = NextResponse.redirect(destination)
    response.cookies.set(GITHUB_CONNECT_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', path: GITHUB_CALLBACK_PATH, maxAge: 0 })
    return response
  }
  const code = url.searchParams.get('code')
  if (!code || code.length > 512) return done('link-failed')
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (session?.user.id !== starter) return done('link-failed')
    await completeGitHubConnect(starter, code)
    return done('connected')
  } catch {
    return done('link-failed')
  }
}
