import { desktopWebTarget } from '../../../../lib/desktop-web-target'
import { remoteBase } from './bundled-policy'

interface BrowserHandoff {
  serverUrl: string
  auth: { scope(): string | null; request(path: string, init?: RequestInit): Promise<Response> }
  openExternal(url: string): Promise<void>
}

/** Mint only in main and send the one-use token straight to the system browser.
 * The existing browser handoff names the account and requires a browser-bound
 * confirmation before setting cookies. Neither the token nor those cookies
 * are returned to the renderer. False means an ordinary external app URL. */
export async function openBundledWebPage(value: string, options: BrowserHandoff): Promise<boolean> {
  const base = remoteBase(options.serverUrl)
  let url: URL
  try { url = new URL(value) } catch { return false }
  const prefix = base.pathname.replace(/\/$/, '')
  if (url.origin !== base.origin || url.username || url.password || url.hash ||
    (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))) return false
  const target = desktopWebTarget(`${url.pathname.slice(prefix.length) || '/'}${url.search}`)
  if (!target) return false
  const scope = options.auth.scope()
  if (!scope) throw new Error('desktop_session_expired')
  const response = await options.auth.request('/api/auth/one-time-token/generate', { signal: AbortSignal.timeout(15_000) })
  const result: unknown = await response.json().catch(() => null)
  if (scope !== options.auth.scope()) throw new Error('desktop_session_changed')
  const token = result && typeof result === 'object' && 'token' in result ? result.token : null
  if (!response.ok || typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('desktop_rpc_request_rejected')
  const browser = new URL(`${prefix}/api/mobile/open`, base.origin)
  browser.search = new URLSearchParams({ to: target, token }).toString()
  await options.openExternal(browser.href)
  return true
}
