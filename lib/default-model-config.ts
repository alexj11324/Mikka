import { workersAiFallback, workersAiTransport } from './workers-ai-config'
import { isCloudEdition } from './edition'

type Env = Record<string, string | undefined>
export function selfHostedDefaultModelConfig(env: Env = process.env) {
  if (isCloudEdition(env)) return null
  const raw = env.MIKKA_DEFAULT_MODEL_BASE_URL?.trim(), apiKey = env.MIKKA_DEFAULT_MODEL_API_KEY?.trim(), modelId = env.MIKKA_DEFAULT_MODEL_ID?.trim()
  if (!raw || !apiKey || !modelId) return null
  try {
    const url = new URL(raw)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return { baseURL: url.href.replace(/\/+$/, ''), apiKey, modelId }
  } catch { return null }
}

/** Configuration readiness, without loading a model SDK or asking a provider. */
export function defaultModelConfigured(env: Env = process.env): boolean {
  const fallback = workersAiFallback(env)
    ? workersAiTransport(env)
    : env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN || (isCloudEdition(env) && env.VERCEL === '1')
  return Boolean(selfHostedDefaultModelConfig(env) || (env.ZEROCAT_API_KEY && env.ZEROCAT_BASE_URL?.trim().replace(/\/+$/, '') === 'https://zero.cat/v1') || fallback)
}
