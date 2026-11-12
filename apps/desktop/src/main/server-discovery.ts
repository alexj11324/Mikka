import { meetsMinimumVersion } from '@mikka/protocol/version'
import { remoteBase } from './bundled-policy'

/** The wire version this app sends as `x-mikka-desktop-protocol` (bundled-auth.ts). */
export const DESKTOP_PROTOCOL = 1
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
const MAX_BODY = 64 * 1024

export interface ServerSignIn { google: boolean; github: boolean; email: boolean }
export interface DiscoveredServer {
  /** origin + base path, no trailing slash: every request of this server's accounts goes under it. */
  url: string
  name: string
  version: string
  edition: 'cloud' | 'community'
  signIn: ServerSignIn
}
export type ServerProbe =
  | { status: 'ok'; server: DiscoveredServer }
  | { status: 'invalid_address' | 'https_required' | 'unreachable' | 'not_mikka' }
  | { status: 'server_update_required'; version: string | null }
  | { status: 'app_update_required'; minimum: string | null }

/** `https://host/path` without a trailing slash; the one spelling every comparison uses. */
export function canonicalServerUrl(value: string | URL): string {
  const url = remoteBase(String(value))
  // One named host or IP literal: no wildcard or other characters URL parsing lets through.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$|^\[[0-9a-f:.]+\]$/.test(url.hostname)) throw new Error('Invalid desktop server / 桌面服务地址无效')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** Typed input to a candidate base. A bare host means HTTPS; plain HTTP only for this computer. */
export function serverAddress(input: unknown): URL | 'invalid_address' | 'https_required' {
  if (typeof input !== 'string') return 'invalid_address'
  const text = input.trim()
  if (!text || text.length > 2048 || /\s/.test(text)) return 'invalid_address'
  let url: URL
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`) } catch { return 'invalid_address' }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) return 'https_required'
  try { return new URL(canonicalServerUrl(url)) } catch { return 'invalid_address' }
}

const PATH = /^(?:\/[A-Za-z0-9._~-]{1,100}){0,5}$/
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null

/** #1556's discovery document. Both an object and a list form are read for the
 * protocol range and sign-in methods, so the server keeps one source of truth. */
export function parseDiscovery(value: unknown): { name: string; version: string; edition: 'cloud' | 'community'; basePath: string; protocol: [number, number]; signIn: ServerSignIn; minDesktopVersion: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const name = text(body.name, 200), version = text(body.version, 100)
  const edition = body.edition === 'cloud' || body.edition === 'community' ? body.edition : null
  const basePath = typeof body.basePath === 'string' ? body.basePath.replace(/\/+$/, '') : null
  if (!name || !version || !edition || basePath === null || !PATH.test(basePath) || basePath.split('/').some(part => part === '.' || part === '..')) return null
  const range = body.desktopProtocol
  let protocol: [number, number] | null = null
  if (Array.isArray(range) && range.length && range.length <= 100 && range.every(Number.isSafeInteger)) protocol = [Math.min(...range as number[]), Math.max(...range as number[])]
  else if (range && typeof range === 'object' && Number.isSafeInteger((range as { min?: unknown }).min) && Number.isSafeInteger((range as { max?: unknown }).max)) protocol = [(range as { min: number }).min, (range as { max: number }).max]
  if (!protocol || protocol[0] > protocol[1]) return null
  const methods = body.signIn
  const has = (key: keyof ServerSignIn) => Array.isArray(methods) ? methods.includes(key) : !!methods && typeof methods === 'object' && (methods as Record<string, unknown>)[key] === true
  if (!methods || typeof methods !== 'object') return null
  return { name, version, edition, basePath, protocol, signIn: { google: has('google'), github: has('github'), email: has('email') }, minDesktopVersion: text(body.minDesktopVersion, 100) }
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('application/json')) return null
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY) return null
  const body = await response.text()
  if (body.length > MAX_BODY) return null
  try { return JSON.parse(body) } catch { return null }
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/**
 * One read of the server before it is accepted. The accepted base is exactly
 * the origin that answered plus the base path it reported; redirects are not
 * followed, so an answer can never move the account to another origin.
 */
export async function probeServer(input: unknown, options: { fetch: Fetcher; appVersion: string; enforceMinimum: boolean; timeoutMs?: number }): Promise<ServerProbe> {
  const address = serverAddress(input)
  if (typeof address === 'string') return { status: address }
  const get = (url: string) => options.fetch(url, { headers: { accept: 'application/json', 'x-mikka-client': 'desktop', 'x-mikka-client-version': options.appVersion, 'x-mikka-desktop-protocol': String(DESKTOP_PROTOCOL) }, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) })
  const paths = address.pathname === '/' || address.pathname === '' ? ['', '/mikka'] : [address.pathname]
  let reachable = false
  let olderMikka: string | null | undefined
  for (const path of paths) {
    const base = `${address.origin}${path}`
    let response: Response
    try { response = await get(`${base}/api/desktop/discovery`) } catch { continue }
    reachable = true
    const body = await readJson(response).catch(() => null) as Record<string, unknown> | null
    // #1415's fixed answer to an app the server no longer serves.
    const error = body && typeof body === 'object' ? body.error : null
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : error
    if (response.status === 426 || code === 'desktop_client_update_required') return { status: 'app_update_required', minimum: text(body?.minDesktopVersion, 100) }
    const discovery = response.ok ? parseDiscovery(body) : null
    if (discovery) {
      if (address.pathname !== '/' && discovery.basePath !== path) return { status: 'not_mikka' }
      const [min, max] = discovery.protocol
      if (max < DESKTOP_PROTOCOL) return { status: 'server_update_required', version: discovery.version }
      if (min > DESKTOP_PROTOCOL) return { status: 'app_update_required', minimum: discovery.minDesktopVersion }
      if (options.enforceMinimum && discovery.minDesktopVersion && !meetsMinimumVersion(options.appVersion, discovery.minDesktopVersion)) return { status: 'app_update_required', minimum: discovery.minDesktopVersion }
      return { status: 'ok', server: { url: canonicalServerUrl(`${address.origin}${discovery.basePath}`), name: discovery.name, version: discovery.version, edition: discovery.edition, signIn: discovery.signIn } }
    }
    // A Mikka server from before the discovery read still answers /api/version.
    if (olderMikka === undefined) {
      try {
        const legacy = await readJson(await get(`${base}/api/version`)) as Record<string, unknown> | null
        // Its `build` is a commit, not a version a person upgrades from: say only that it is too old.
        if (legacy && typeof legacy === 'object' && typeof legacy.build === 'string' && 'minDesktopVersion' in legacy) olderMikka = null
      } catch { /* not this path */ }
    }
  }
  if (olderMikka !== undefined) return { status: 'server_update_required', version: olderMikka }
  return { status: reachable ? 'not_mikka' : 'unreachable' }
}
