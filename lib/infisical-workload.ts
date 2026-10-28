import 'server-only'
import { classifyUniversalAuthRejection, type UniversalAuthRejection } from './infisical-auth-diagnostics'

export type InfisicalWorkloadFailure = { kind: 'http'; status: number } & UniversalAuthRejection

// Identity credentials remain in the application process. Only the resulting
// short-lived token is passed to the private, scoped worker over stdin.
export async function infisicalWorkloadToken(origin: string, clientId: string, clientSecret: string, signal?: AbortSignal, fetcher: typeof fetch = fetch, onFailure?: (failure: InfisicalWorkloadFailure) => void): Promise<string> {
  try {
    const base = new URL(origin)
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error()
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
    return token
  } catch {
    // Never expose a provider response, client secret, or token in errors.
    throw new Error('infisical_identity_unavailable')
  }
}
