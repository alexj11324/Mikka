import 'server-only'
import { after } from 'next/server'
import { PostHog } from 'posthog-node'
import { gatedFeatureEnabled } from '@/lib/feature-flags'
import { posthogConfig } from '@/lib/posthog-config'

// PostHog on the server, for per-person flags and LLM usage. It uses the same
// project as the browser (NEXT_PUBLIC_POSTHOG_KEY) and the same distinct id,
// the Mikka user id (components/posthog-analytics.tsx). POSTHOG_SECRET_KEY, a
// project secret or personal API key, lets flags be evaluated locally from
// polled definitions; without it each uncached check asks PostHog. Without the
// project key there is no client: every flag reads off and nothing is sent.

/** How long a person's flag value is reused before PostHog is asked again. */
export const FLAG_CACHE_MS = 5 * 60_000
const FLAG_TIMEOUT_MS = 2_000
const CACHE_MAX = 5_000

/** The part of the PostHog client this module uses, so tests can pass a fake. */
export interface ServerPostHog {
  getFeatureFlag(key: string, distinctId: string, options?: { sendFeatureFlagEvents?: boolean }): Promise<boolean | string | undefined>
  capture(message: { distinctId: string; event: string; properties?: Record<string, unknown> }): void
  flush(): Promise<void>
}

let client: ServerPostHog | null | undefined

function serverPostHog(): ServerPostHog | null {
  if (client !== undefined) return client
  client = posthogConfig.token
    ? new PostHog(posthogConfig.token, { host: posthogConfig.apiHost, secretKey: process.env.POSTHOG_SECRET_KEY || undefined, featureFlagsPollingInterval: FLAG_CACHE_MS, flushAt: 20, flushInterval: 10_000 })
    : null
  return client
}

const flagCache = new Map<string, { enabled: boolean; at: number }>()

/**
 * Whether the person's flag is exactly true, cached for FLAG_CACHE_MS so the
 * ingest and cron paths do not ask PostHog per message. Fails closed: no
 * client, an error, a timeout or any other value reads off. Never throws.
 */
export async function serverFlagEnabled(key: string, userId: string, { posthog = serverPostHog(), now = Date.now(), timeoutMs = FLAG_TIMEOUT_MS }: { posthog?: ServerPostHog | null; now?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const cacheKey = `${key}|${userId}`
  const cached = flagCache.get(cacheKey)
  if (cached && now - cached.at < FLAG_CACHE_MS) return cached.enabled
  let enabled = false
  if (posthog) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        posthog.getFeatureFlag(key, userId, { sendFeatureFlagEvents: false }),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs) }),
      ])
      enabled = gatedFeatureEnabled(value)
    } catch (error) {
      console.error('PostHog flag check failed', error instanceof Error ? error.message : error)
    } finally {
      clearTimeout(timer)
    }
  }
  if (flagCache.size >= CACHE_MAX) flagCache.clear()
  flagCache.set(cacheKey, { enabled, at: now })
  return enabled
}

/** Forgets cached flag values; for tests. */
export function clearFlagCache() {
  flagCache.clear()
}

export interface Generation { model: string; inputTokens: number; outputTokens: number; latencyMs: number; span: string }

/**
 * Records one model call as a PostHog LLM analytics event, so cost per person
 * shows in PostHog. Only the model, token counts and timing: never the prompt
 * or the answer. Best effort: queued and flushed after the response; never
 * waits on PostHog and never throws.
 */
export function captureGeneration(userId: string, generation: Generation, { posthog = serverPostHog() }: { posthog?: ServerPostHog | null } = {}) {
  if (!posthog) return
  try {
    posthog.capture({ distinctId: userId, event: '$ai_generation', properties: {
      $ai_model: generation.model, $ai_provider: 'vercel-ai-gateway', $ai_span_name: generation.span,
      $ai_input_tokens: generation.inputTokens, $ai_output_tokens: generation.outputTokens, $ai_latency: generation.latencyMs / 1000,
      app: 'mikka',
    } })
    const flush = () => posthog.flush().catch(() => {})
    try { after(flush) } catch { void flush() }
  } catch (error) {
    console.error('PostHog capture failed', error instanceof Error ? error.message : error)
  }
}
