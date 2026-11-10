import 'server-only'
import { createHash } from 'node:crypto'
import { classifyUniversalAuthRejection, type UniversalAuthRejection } from './infisical-auth-diagnostics'
import { currentSubscriptionWorkerTiming } from '../packages/daemon/src/subscription-worker-timing'

export type InfisicalWorkloadFailure = { kind: 'http'; status: number } & UniversalAuthRejection

// Identity credentials remain in the application process. Only the resulting
// short-lived token is passed to the private, scoped worker over stdin.
export async function infisicalWorkloadToken(origin: string, clientId: string, clientSecret: string, signal?: AbortSignal, fetcher: typeof fetch = fetch, onFailure?: (failure: InfisicalWorkloadFailure) => void): Promise<string> {
  return (await loginWorkload(origin, clientId, clientSecret, signal, fetcher, onFailure)).token
}

function workloadOrigin(origin: string): URL {
  if (!URL.canParse(origin)) throw new Error('infisical_identity_unavailable')
  const base = new URL(origin)
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('infisical_identity_unavailable')
  return base
}

async function loginWorkload(origin: string, clientId: string, clientSecret: string, signal?: AbortSignal, fetcher: typeof fetch = fetch, onFailure?: (failure: InfisicalWorkloadFailure) => void): Promise<{ token: string; expiresIn: unknown }> {
  let timingDone: (() => void) | undefined
  try {
    const base = workloadOrigin(origin)
    timingDone = currentSubscriptionWorkerTiming()?.phase('identityLogin')
    const response = await fetcher(new URL('/api/v1/auth/universal-auth/login', base), {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }), signal: AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])])
    })
    if (!response.ok) {
      if (onFailure) {
        const diagnostic = await classifyUniversalAuthRejection(response, [clientId, clientSecret])
        try { onFailure({ kind: 'http', status: response.status, ...diagnostic }) } catch { /* Observation cannot change denial. */ }
      } else {
        // Do not retain a possibly sensitive upstream failure body.
        void response.body?.cancel().catch(() => {})
      }
      throw new Error()
    }
    const data: unknown = await response.json()
    const token = (data as { accessToken?: unknown } | null)?.accessToken
    if (typeof token !== 'string' || token.length < 1 || token.length > 16384) throw new Error()
    return { token, expiresIn: (data as { expiresIn?: unknown }).expiresIn }
  } catch {
    // Never expose a provider response, client secret, or token in errors.
    throw new Error('infisical_identity_unavailable')
  } finally { timingDone?.() }
}

/** A process-local machine-token cache used only by the parent snapshot reader.
 * No projection, permission result, in-flight request, timer or renewal is retained.
 */
export function createSnapshotWorkloadTokenCache(now: () => number = () => performance.now()) {
  const entries = new Map<string, { token: string; expiresAt: number }>()
  const lease = (key: string, entry: { token: string; expiresAt: number }) => ({
    token: entry.token,
    invalidate() { if (entries.get(key) === entry) entries.delete(key) },
  })
  return {
    async get(origin: string, clientId: string, clientSecret: string, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
      // Check before lookup too: a cancelled caller must never receive a cache hit.
      if (signal?.aborted) throw new Error('infisical_identity_unavailable')
      const base = workloadOrigin(origin)
      const key = JSON.stringify([base.origin, clientId, createHash('sha256').update(clientSecret).digest('hex')])
      const started = now()
      for (const [key, entry] of entries) if (entry.expiresAt <= started) entries.delete(key)
      const cached = entries.get(key)
      if (cached) return lease(key, cached)
      // Deliberately not single-flight: one caller's cancellation cannot own
      // another caller's login. Concurrent misses retain the old fresh behavior.
      const result = await loginWorkload(origin, clientId, clientSecret, signal, fetcher)
      if (signal?.aborted) throw new Error('infisical_identity_unavailable')
      const ttl = result.expiresIn
      // Issuer TTL starts no later than the request, not when its response arrives.
      // A one-second margin and a 60-second local cap never extend that TTL.
      const expiresAt = typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0
        ? started + Math.min(ttl, 60) * 1000 - 1000 : started
      const entry = { token: result.token, expiresAt }
      if (expiresAt > now()) {
        entries.delete(key)
        while (entries.size >= 8) entries.delete(entries.keys().next().value!)
        entries.set(key, entry)
      }
      return lease(key, entry)
    },
  }
}
