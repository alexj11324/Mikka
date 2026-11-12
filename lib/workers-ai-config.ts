type Env = Record<string, string | undefined>

export function workersAiFallback(env: Env = process.env): boolean {
  const route = env.MIKKA_HOSTED_MODEL_FALLBACK
  if (route === undefined || route === 'vercel-gateway') return false
  if (route === 'cloudflare-workers-ai') return true
  throw Error('invalid_hosted_model_fallback')
}

export function workersAiEndpoint(env: Env = process.env): string | null {
  const account = env.CLOUDFLARE_WORKERS_AI_ACCOUNT_ID
  return account && /^[a-f0-9]{32}$/.test(account) ? `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1` : null
}

/** The account URL remains the admission-policy identity for either transport. */
export function workersAiTransport(env: Env = process.env) {
  const endpoint = workersAiEndpoint(env)
  if (!endpoint) return null
  const capability = env.MIKKA_WORKERS_AI_CAPABILITY
  if (capability !== undefined) {
    if (!/^[0-9a-f-]{72}$/.test(capability)) return null
    return { endpoint, baseURL: 'https://workers-ai.internal/v1', key: capability }
  }
  const key = env.CLOUDFLARE_WORKERS_AI_TOKEN?.trim()
  return key ? { endpoint, baseURL: endpoint, key } : null
}
