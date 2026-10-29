/** One global switch: never evaluate this flag against a person or team. */
export const LINEAR_SYNC_FLAG = 'mikka-linear-sync'
export const LINEAR_SYNC_DISTINCT_ID = 'mikka-linear-sync-service'
export const LINEAR_SYNC_FLAG_CACHE_MS = 30_000
export type LinearSyncState = 'enabled' | 'disabled' | 'unavailable'

/** Shared by Next and Workers; importing this module never loads a database. */
export function createLinearSyncGate({
  fetcher,
  now = Date.now,
  cacheMs = LINEAR_SYNC_FLAG_CACHE_MS,
  timeoutMs = 2_000,
}: { fetcher?: typeof fetch; now?: () => number; cacheMs?: number; timeoutMs?: number } = {}) {
  let cached: { token: string; state: LinearSyncState; expires: number } | undefined
  let pending: { token: string; promise: Promise<LinearSyncState> } | undefined

  return async (token: string | undefined): Promise<LinearSyncState> => {
    if (!token) return 'unavailable'
    if (cached?.token === token && now() < cached.expires) return cached.state
    if (pending?.token === token) return pending.promise
    const started = now()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const evaluate = async (): Promise<LinearSyncState> => {
      try {
        return await Promise.race([
          (async (): Promise<LinearSyncState> => {
            const response = await (fetcher ?? globalThis.fetch)('https://us.i.posthog.com/flags?v=2', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'user-agent': 'posthog-node/mikka-linear-sync' },
              body: JSON.stringify({ api_key: token, distinct_id: LINEAR_SYNC_DISTINCT_ID }),
              cache: 'no-store', redirect: 'error', signal: controller.signal,
            })
            if (!response.ok) return 'unavailable'
            const result = await response.json() as {
              errorsWhileComputingFlags?: boolean
              quotaLimited?: string[]
              flags?: Record<string, { enabled?: unknown; variant?: unknown }>
            }
            if (result.errorsWhileComputingFlags !== false || result.quotaLimited?.includes('feature_flags') ||
              !result.flags || typeof result.flags !== 'object' || Array.isArray(result.flags)) return 'unavailable'
            const flag = result.flags[LINEAR_SYNC_FLAG]
            if (flag === undefined) return 'disabled'
            if (!flag || typeof flag !== 'object' || Array.isArray(flag) || flag.variant != null) return 'unavailable'
            if (flag.enabled === false) return 'disabled'
            return flag.enabled === true ? 'enabled' : 'unavailable'
          })(),
          new Promise<LinearSyncState>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('unavailable') }, timeoutMs) }),
        ])
      } catch {
        // Never reuse stale true or log upstream errors (they may contain tokens).
        return 'unavailable'
      } finally {
        clearTimeout(timer)
      }
    }
    const promise = evaluate().then(state => {
      cached = { token, state, expires: started + cacheMs }
      return state
    })
    pending = { token, promise }
    try { return await promise }
    finally { if (pending?.promise === promise) pending = undefined }
  }
}

const gate = createLinearSyncGate()

export function linearSyncState(token = process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  return gate(token)
}

/** Missing configuration, flag, network, quota or evaluation result means off. */
export async function linearSyncEnabled(token = process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  return await linearSyncState(token) === 'enabled'
}

export function linearSyncDisabledResponse() {
  // Evaluation/configuration failures request retries rather than losing events.
  return Response.json({ error: 'Linear sync is disabled', disabled: true }, { status: 503, headers: { 'retry-after': '60' } })
}
