import { meetsMinimumVersion } from '@mikka/protocol/version'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const PATH = /^(?:\/[A-Za-z0-9._~-]{1,100}){0,5}$/
const MAX_BODY = 64 * 1024
export const MOBILE_SERVER_PROTOCOL = 1
export const CLOUD_API_URL = 'https://app.aspectlylabs.com/mikka'

export type ServerSignIn = { google: boolean; github: boolean; apple: boolean; email: boolean }
export type MobileServer = {
  url: string; name: string; version: string | null; edition: 'cloud' | 'community'
  signIn: ServerSignIn; mobileReady: boolean
}
export type ServerProbe =
  | { status: 'ok'; server: MobileServer }
  | { status: 'invalid_address' | 'https_required' | 'unreachable' | 'not_mikka' | 'mobile_not_ready' }
  | { status: 'server_update_required'; version: string | null }
  | { status: 'app_update_required'; minimum: string | null }

/** Same address contract as the desktop: one exact origin and a base path. */
export function serverAddress(input: unknown): URL | 'invalid_address' | 'https_required' {
  if (typeof input !== 'string') return 'invalid_address'
  const text = input.trim()
  if (!text || text.length > 2048 || /\s|\\/.test(text)) return 'invalid_address'
  // URL normalizes dot segments; reject their original spelling before parsing.
  if (/(?:\/|%2f)(?:\.|%2e){1,2}(?:\/|%2f|$|[?#])/i.test(text)) return 'invalid_address'
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`) } catch { return 'invalid_address' }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) return 'https_required'
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return 'invalid_address'
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/.test(url.hostname)) return 'invalid_address'
  const path = url.pathname.replace(/\/+$/, '')
  if (!PATH.test(path) || path.split('/').some(part => part === '.' || part === '..')) return 'invalid_address'
  return new URL(`${url.origin}${path}`)
}

export const serverUrl = (url: URL) => `${url.origin}${url.pathname.replace(/\/+$/, '')}`
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null

function discovery(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const name = text(body.name, 200), version = text(body.version, 100)
  const edition = body.edition === 'cloud' || body.edition === 'community' ? body.edition : null
  const basePath = typeof body.basePath === 'string' ? body.basePath.replace(/\/+$/, '') : null
  const range = body.desktopProtocol as { min?: number; max?: number } | undefined
  if (!name || !version || !edition || basePath === null || !PATH.test(basePath) || basePath.split('/').some(part => part === '.' || part === '..')) return null
  if (!range || !Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max) || range.min! < 0 || range.min! > range.max!) return null
  const methods = body.signIn as Partial<ServerSignIn> | undefined
  if (!methods || ['google', 'github', 'email'].some(key => typeof methods[key as keyof ServerSignIn] !== 'boolean')) return null
  return { name, version, edition: edition as MobileServer['edition'], basePath, min: range.min!, max: range.max!, signIn: { ...methods, apple: methods.apple === true } as ServerSignIn,
    minimum: text(body.minDesktopVersion, 100), mobileReady: body.mobileReady === true }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  if (response.status >= 300 && response.status < 400 || response.redirected || !response.headers.get('content-type')?.includes('application/json')) return null
  if (Number(response.headers.get('content-length')) > MAX_BODY) return null
  const body = await response.text()
  if (new TextEncoder().encode(body).byteLength >= MAX_BODY) return null
  try { const value: unknown = JSON.parse(body); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null } catch { return null }
}

/** A user-initiated, credential-free probe. The response cannot change origin.
 * Root and /mikka are tried once; a timeout is a deadline, never a retry loop. */
export async function probeMobileServer(input: unknown, options: {
  fetch: typeof fetch; appVersion: string; signal?: AbortSignal; timeoutMs?: number
}): Promise<ServerProbe> {
  const address = serverAddress(input)
  if (typeof address === 'string') return { status: address }
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort)
  if (options.signal?.aborted) abort()
  const timer = setTimeout(abort, options.timeoutMs ?? 10_000)
  const get = (url: string) => options.fetch(url, { headers: { accept: 'application/json', 'x-mikka-client': 'mobile',
    'x-mikka-client-version': options.appVersion, 'x-mikka-desktop-protocol': String(MOBILE_SERVER_PROTOCOL) },
  redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal })
  let reachable = false
  const legacyBases: string[] = []
  const paths = address.pathname === '/' ? ['', '/mikka'] : [address.pathname.replace(/\/+$/, '')]
  try {
    for (const path of paths) {
      if (controller.signal.aborted) break
      const base = `${address.origin}${path}`
      let response: Response
      try { response = await get(`${base}/api/desktop/discovery`) } catch { continue }
      reachable = true
      const body = await readJson(response).catch(() => null)
      const error = body?.error
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : error
      if (response.status === 426 || code === 'desktop_client_update_required') return { status: 'app_update_required', minimum: text(body?.minDesktopVersion, 100) }
      const found = response.ok ? discovery(body) : null
      if (found) {
        if (address.pathname !== '/' && found.basePath !== path) return { status: 'not_mikka' }
        if (found.max < MOBILE_SERVER_PROTOCOL) return { status: 'server_update_required', version: found.version }
        let belowMinimum = false
        try { belowMinimum = !!found.minimum && !meetsMinimumVersion(options.appVersion, found.minimum) }
        catch { return { status: 'not_mikka' } }
        if (found.min > MOBILE_SERVER_PROTOCOL || belowMinimum) return { status: 'app_update_required', minimum: found.minimum }
        if (!found.mobileReady) return { status: 'mobile_not_ready' }
        return { status: 'ok', server: { url: `${address.origin}${found.basePath}`, name: found.name, version: found.version,
          edition: found.edition, signIn: found.signIn, mobileReady: true } }
      }
      legacyBases.push(base)
    }
    for (const base of legacyBases) {
      if (controller.signal.aborted) break
      try {
        const legacy = await readJson(await get(`${base}/api/version`))
        if (legacy && typeof legacy.build === 'string' && 'minDesktopVersion' in legacy) {
          return { status: 'server_update_required', version: null }
        }
      } catch { /* This candidate did not identify a legacy server. */ }
    }
    return { status: reachable ? 'not_mikka' : 'unreachable' }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

/** Tickets may point to an operator's own gateway, so its origin is not fixed. */
export function liveSocketUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === 'wss:' || url.protocol === 'ws:' && LOOPBACK.has(url.hostname))
  } catch { return false }
}
