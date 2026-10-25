import { CredentialError } from './contracts'

type Credentials = { clientId: string; clientSecret: string } | undefined
/** Server-side only, owned by runtime.ts. No credential/token is persisted or logged. */
export function universalAuthTokenProvider(options: {
  origin: string; credentials: () => Credentials; fetch?: typeof fetch; now?: () => number
}) {
  const origin = new URL(options.origin)
  if (origin.protocol !== 'https:' || origin.origin !== options.origin) throw new CredentialError('vault_configuration_invalid', 503)
  const now = options.now ?? (() => performance.now())
  let credentials: Credentials
  let cached: { value: string; refreshAt: number } | undefined
  let flight: Promise<string> | undefined
  let issuedToken: string | undefined
  let generation = 0
  let denied = false
  let retryAt = 0
  const failure = () => new CredentialError('vault_auth_unavailable', 503)
  function reset(next: Credentials) {
    credentials = next && { ...next }; cached = undefined; flight = undefined
    generation++; issuedToken = undefined; denied = false; retryAt = 0
  }
  async function getAccessToken(): Promise<string> {
    const next = options.credentials()
    if (next?.clientId !== credentials?.clientId || next?.clientSecret !== credentials?.clientSecret) reset(next)
    if (!next?.clientId || !next.clientSecret || denied || now() < retryAt) throw failure()
    if (flight) return flight
    if (cached && now() < cached.refreshAt) return cached.value
    // Fresh official login before expiry also avoids the renewable token's maximum TTL.
    // Never use the previous token after a refresh failure, even if it is not yet expired.
    cached = undefined
    const epoch = generation
    const startedAt = now()
    const task = (async () => {
      try {
        const response = await (options.fetch ?? fetch)(new URL('/api/v1/auth/universal-auth/login', origin), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
        })
        if (!response.ok) {
          if ((response.status === 401 || response.status === 403) && epoch === generation) denied = true
          await response.body?.cancel(); throw failure()
        }
        const data = await response.json()
        // Require bounded short-lived credentials; do not silently accept default 30-day tokens.
        if (typeof data.accessToken !== 'string' || !data.accessToken || data.accessToken.length > 16384 || /[\s\0]/.test(data.accessToken) ||
          data.tokenType !== 'Bearer' || !Number.isSafeInteger(data.expiresIn) || data.expiresIn < 30 || data.expiresIn > 3600) throw failure()
        const refreshAt = startedAt + data.expiresIn * 1000 - Math.min(60000, data.expiresIn * 100)
        const current = options.credentials()
        if (epoch !== generation || denied || now() >= refreshAt || current?.clientId !== next.clientId || current?.clientSecret !== next.clientSecret) throw failure()
        issuedToken = data.accessToken
        cached = { value: data.accessToken, refreshAt }
        return cached.value
      } catch {
        if (epoch === generation) { cached = undefined; retryAt = now() + 30000 }
        throw failure() // Never retain upstream response, request, or error cause.
      }
    })()
    flight = task
    try { return await task } finally { if (flight === task) flight = undefined }
  }
  function rejectAccessToken(token: string) {
    // Retained across same-identity refresh, cleared on credential rotation even while
    // the new login is in flight. Cache presence cannot identify token ownership.
    if (issuedToken !== token) return
    cached = undefined; denied = true; generation++
  }
  return { getAccessToken, rejectAccessToken }
}
