import { COORDINATOR_MODEL } from '../coordinator/model'

/*
 * Configuration of the sole model egress, LiteLLM. Pure:
 * reads only the environment passed in.
 */
type Env = Record<string, string | undefined>

/**
 * The internal model service used by every application model request.
 * Provider keys stay behind this server boundary; the task receives only a
 * run-scoped Mikka gateway token. Missing configuration fails closed.
 */
export function gatewayLiteLlm(env: Env = process.env): { url: string; masterKey: string } | null {
  const raw = env.MIKKA_LITELLM_URL?.trim(), masterKey = env.MIKKA_LITELLM_MASTER_KEY?.trim()
  if (!raw || !masterKey) return null
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return { url: url.href.replace(/\/+$/, '').replace(/\/v1$/, ''), masterKey }
  } catch { return null }
}

// The self-hosted picker uses a catalogue-shaped ID for the configured default alias.
export const SELF_HOSTED_DEFAULT_CATALOG_ID = 'mikka/default'

export function managedLiteLlmModel(model: string): string {
  if (model === SELF_HOSTED_DEFAULT_CATALOG_ID) return COORDINATOR_MODEL
  return model.includes('/') ? `mikka-credits/${model}` : model
}

/** Where a run's CLI reaches the gateway, under this server's own origin and base path. */
export const GATEWAY_PATHS = { anthropic: '/api/model-gateway/anthropic', openai: '/api/model-gateway/openai/v1' } as const
