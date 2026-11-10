/** Pure JSON codec shared with the bundled renderer. No server dependencies. */
export const DESKTOP_RPC_VERSION = 1 as const
export const DESKTOP_RPC_PREVIOUS_VERSION = 0 as const
export const UPDATE_REQUIRED = 'desktop_client_update_required' as const

export type Wire =
  | null | boolean | number | string
  | Wire[] | { [key: string]: Wire }

/** Ordinary JSON stays compact. Only special values and tag collisions expand. */
export function encode(value: unknown): Wire {
  if (value === undefined) return { $mikka: 'undefined' }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date && Number.isFinite(value.getTime())) return { $mikka: 'date', value: value.toISOString() }
  if (Array.isArray(value)) return value.map(encode)
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value).map(([key, item]) => [key, encode(item)] as [string, Wire])
    return Object.hasOwn(value, '$mikka') ? { $mikka: 'object', value: entries } : Object.fromEntries(entries)
  }
  throw new TypeError('desktop_rpc_value_invalid')
}

export function decode(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new TypeError('desktop_rpc_value_invalid')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(entry => decode(entry, depth + 1))
  if (typeof value !== 'object' || value === null) throw new TypeError('desktop_rpc_value_invalid')
  const item = value as Record<string, unknown>
  if (!Object.hasOwn(item, '$mikka')) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, decode(entry, depth + 1)]))
  if (item.$mikka === 'undefined' && Object.keys(item).length === 1) return undefined
  if (Object.keys(item).length !== 2 || !('value' in item)) throw new TypeError('desktop_rpc_value_invalid')
  if (item.$mikka === 'date' && typeof item.value === 'string') {
    const date = new Date(item.value)
    if (Number.isFinite(date.getTime()) && date.toISOString() === item.value) return date
  }
  if (item.$mikka === 'form' && Array.isArray(item.value) && item.value.length <= 32) {
    const form = new FormData()
    for (const pair of item.value) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || pair[0].length > 200) throw new TypeError('desktop_rpc_value_invalid')
      if (typeof pair[1] === 'string') form.append(pair[0], pair[1])
      else {
        const file = pair[1] as Record<string, unknown> | null
        if (!file || typeof file.name !== 'string' || file.name.length > 200 || typeof file.type !== 'string' || file.type.length > 100
          || typeof file.data !== 'string' || file.data.length > 300_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new TypeError('desktop_rpc_value_invalid')
        const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0))
        form.append(pair[0], new Blob([bytes], { type: file.type }), file.name)
      }
    }
    return form
  }
  if (item.$mikka === 'object' && Array.isArray(item.value)) {
    const result: Record<string, unknown> = {}
    const seen = new Set<string>()
    for (const pair of item.value) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || seen.has(pair[0])) throw new TypeError('desktop_rpc_value_invalid')
      seen.add(pair[0])
      Object.defineProperty(result, pair[0], { value: decode(pair[1], depth + 1), enumerable: true, writable: true, configurable: true })
    }
    return result
  }
  throw new TypeError('desktop_rpc_value_invalid')
}

/** The only binary action argument is the existing, bounded avatar upload. */
export async function encodeArgs(args: unknown[]): Promise<Wire> {
  return Promise.all(args.map(async value => {
    if (!(value instanceof FormData)) return encode(value)
    const entries: Wire[] = []
    for (const [key, item] of value.entries()) {
      if (typeof item === 'string') entries.push([key, item])
      else {
        if (item.size > 200 * 1024) throw new TypeError('desktop_rpc_value_invalid')
        const bytes = new Uint8Array(await item.arrayBuffer())
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        entries.push([key, { name: item.name, type: item.type, data: btoa(binary) }])
      }
    }
    return { $mikka: 'form', value: entries }
  }))
}

export type DesktopUser = {
  id: string
  name: string
  email: string
  image: string | null
  emailVerified: boolean
}
export type DesktopSession = { user: DesktopUser; session: { id: string } }
export type DesktopFeatures = { flags: Record<string, boolean>; cloudComputer: boolean }
export type DesktopConfig = {
  edition?: 'community' | 'cloud'
  googleEnabled: boolean
  githubEnabled: boolean
  emailEnabled: boolean
  features: DesktopFeatures
  daemonPackageName: string
}
export type DesktopBootstrap = DesktopSession & DesktopConfig & {
  onboarding: boolean
  computer: 'none' | 'ask'
  cacheWorkspace: { workspaceId: string; role: 'admin' | 'member' } | null
  /** Routing only; the Live ticket endpoint rechecks current authority. */
  liveHomeWorkspaceId: string | null
}
