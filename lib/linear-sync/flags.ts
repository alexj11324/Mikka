/** One global switch: never evaluate this flag against a person or team. */
export const LINEAR_SYNC_FLAG = 'mikka-linear-sync'
export const LINEAR_SYNC_DISTINCT_ID = 'mikka-linear-sync-service'
export const LINEAR_SYNC_FLAG_CACHE_MS = 30_000

/** Shared by Next and Workers; importing this module never loads a database. */
export function createLinearSyncGate({
  fetcher,
  now = Date.now,
  cacheMs = LINEAR_SYNC_FLAG_CACHE_MS,
  timeoutMs = 2_000,
}: { fetcher?: typeof fetch; now?: () => number; cacheMs?: number; timeoutMs?: number } = {}) {
  let cached: { token: string; enabled: boolean; expires: number } | undefined
  let pending: { token: string; promise: Promise<boolean> } | undefined

  return async (token: string | undefined): Promise<boolean> => {
    if (!token) return false
    if (cached?.token === token && now() < cached.expires) return cached.enabled
    if (pending?.token === token) return pending.promise
    const started = now()
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const evaluate = async () => {
      try {
        return await Promise.race([
          (async () => {
            const response = await (fetcher ?? globalThis.fetch)('https://us.i.posthog.com/flags?v=2', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'user-agent': 'posthog-node/mikka-linear-sync' },
              body: JSON.stringify({ api_key: token, distinct_id: LINEAR_SYNC_DISTINCT_ID }),
              cache: 'no-store', redirect: 'error', signal: controller.signal,
            })
            if (!response.ok) return false
            const result = await response.json() as {
              errorsWhileComputingFlags?: boolean
              quotaLimited?: string[]
              flags?: Record<string, { enabled?: unknown; variant?: unknown }>
            }
            const flag = result.flags?.[LINEAR_SYNC_FLAG]
            return result.errorsWhileComputingFlags === false && !result.quotaLimited?.includes('feature_flags') &&
              flag?.enabled === true && flag.variant == null
          })(),
          new Promise<false>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false) }, timeoutMs) }),
        ])
      } catch {
        // Never reuse stale true or log upstream errors (they may contain tokens).
        return false
      } finally {
        clearTimeout(timer)
      }
    }
    const promise = evaluate().then(enabled => {
      cached = { token, enabled, expires: started + cacheMs }
      return enabled
    })
    pending = { token, promise }
    try { return await promise }
    finally { if (pending?.promise === promise) pending = undefined }
  }
}

const gate = createLinearSyncGate()

/** Missing configuration, flag, network, quota or evaluation result means off. */
export function linearSyncEnabled(token = process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  return gate(token)
}

export function linearSyncDisabledResponse() {
  // Ask Linear to retry; do not acknowledge or persist a delivery while paused.
  return Response.json({ error: 'Linear sync is disabled', disabled: true }, { status: 503, headers: { 'retry-after': '60' } })
}
