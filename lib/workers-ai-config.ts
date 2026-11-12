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
