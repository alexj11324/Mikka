import { boundedJson } from '../../cloudflare/bounded-json.mjs'

export function credentialRuntimeEnvironment(env: Record<string, string | undefined> = process.env) {
  if (env.CREDENTIAL_RUNTIME === undefined) return null
  const environment = env.CREDENTIAL_ENVIRONMENT
  if (env.CREDENTIAL_RUNTIME !== 'cloudflare' || typeof environment !== 'string' || !environment) {
    throw new Error('CREDENTIAL_RUNTIME_INVALID')
  }
  return environment
}

/** The container's outbound intercept fixes the signer entrypoint and workload. */
export async function cloudflareCredentialToken() {
  if (!credentialRuntimeEnvironment()) throw new Error('CREDENTIAL_RUNTIME_INVALID')
  const response = await fetch('https://identity.internal/token', {
    method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error('CREDENTIAL_IDENTITY_UNAVAILABLE')
  }
  const data = await boundedJson(response, 16_384)
  if (!data || typeof data.token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.token)) {
    throw new Error('CREDENTIAL_IDENTITY_INVALID')
  }
  return data.token
}
