/*
 * Configuration of the Mikka model gateway (decision 2026-11-15-2000). Pure:
 * reads only the environment passed in.
 */
type Env = Record<string, string | undefined>

/**
 * The internal LiteLLM sidecar that converts a CLI's protocol for a provider
 * that speaks only Chat Completions, or null when this deployment has none.
 * It is reachable only from the Mikka API and stores no user key: each request
 * carries the key and base URL it needs.
 */
export function gatewayLiteLlm(env: Env = process.env): { url: string; masterKey: string } | null {
  const raw = env.MIKKA_LITELLM_URL?.trim(), masterKey = env.MIKKA_LITELLM_MASTER_KEY?.trim()
  if (!raw || !masterKey) return null
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return { url: url.href.replace(/\/+$/, ''), masterKey }
  } catch { return null }
}

/** Where a run's CLI reaches the gateway, under this server's own origin and base path. */
export const GATEWAY_PATHS = { anthropic: '/api/model-gateway/anthropic', openai: '/api/model-gateway/openai/v1' } as const
