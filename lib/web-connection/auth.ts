import { withBasePath } from '@/lib/base-path'
import { desktopAuthState } from '@/lib/desktop-auth'

export type WebAuthFlow = { state: string; callback: string }

/** Parsing carries no authority: every server endpoint validates the configured exact callback. */
export function webAuthFlow(query: Record<string, string | string[] | undefined>): WebAuthFlow | null {
  const state = desktopAuthState(query.web_state)
  const callback = query.web_callback
  if (query.web !== '1' || !state || typeof callback !== 'string' || callback.length > 2048) return null
  try {
    const url = new URL(callback)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api/web/complete')) return null
    return { state, callback }
  } catch { return null }
}

export function webAuthQuery(flow: WebAuthFlow): Record<string, string> {
  return { web: '1', web_state: flow.state, web_callback: flow.callback }
}
export function webAuthSignInPath(flow: WebAuthFlow): string {
  return withBasePath(`/sign-in?${new URLSearchParams(webAuthQuery(flow))}`)
}
export function webAuthReturnPath(flow: WebAuthFlow): string {
  return withBasePath(`/api/web/return?${new URLSearchParams(flow)}`)
}
