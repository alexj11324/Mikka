import { posthogConfig } from '@/lib/posthog-config'
import { deploymentStage } from '../deployment-stage.mjs'

// Settings for the server's PostHog traces (docs/operations/tracing.md). Read once
// when instrumentation.ts registers tracing; nothing here touches the network.

export const SERVICE_NAME = 'mikka-web'
/** Share of request traces kept when MIKKA_TRACE_SAMPLE_RATE is unset. */
export const DEFAULT_SAMPLE_RATE = 0.1

export type TraceEnvironment = 'production' | 'preview' | 'dev'
type Env = Record<string, string | undefined>

export function traceEnvironment(env: Env = process.env): TraceEnvironment {
  const stage = deploymentStage(env)
  if (stage === 'production' || stage === 'preview') return stage
  return 'dev'
}

/**
 * Head sampling rate between 0 and 1. Tests, CI and `next build` always get 0
 * (no tracer at all); otherwise MIKKA_TRACE_SAMPLE_RATE, default 10%.
 * Vercel sets CI during its build only, so a deployment's functions still trace.
 */
export function traceSampleRate(env: Env = process.env): number {
  if (env.NODE_ENV === 'test' || env.NEXT_PHASE === 'phase-production-build') return 0
  if (env.CI && !env.VERCEL) return 0
  const raw = env.MIKKA_TRACE_SAMPLE_RATE?.trim()
  if (!raw) return DEFAULT_SAMPLE_RATE
  const rate = Number(raw)
  return Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : DEFAULT_SAMPLE_RATE
}

export type TraceSettings = { endpoint: string; token: string; sampleRate: number; environment: TraceEnvironment; version?: string }

/** Null when tracing must stay off: no project token, or a sample rate of 0. */
export function traceSettings(env: Env = process.env, token = posthogConfig.token): TraceSettings | null {
  const sampleRate = traceSampleRate(env)
  if (!token || sampleRate <= 0) return null
  return {
    // MIKKA_TRACE_ENDPOINT points a local check at a mock collector.
    endpoint: env.MIKKA_TRACE_ENDPOINT?.trim() || `${posthogConfig.apiHost}/i/v1/traces`,
    token,
    sampleRate,
    environment: traceEnvironment(env),
    version: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || undefined,
  }
}

/** Public ingestion configuration piggybacks on authenticated device registration; no extra request. */
export function daemonTraceSettings(env: Env = process.env, token = posthogConfig.token): { endpoint: string; projectToken: string; sampleRate: number; environment: TraceEnvironment } | undefined {
  const settings = traceSettings(env, token)
  // Only a public project ingestion token may leave the server, never a personal management key.
  if (!settings || !/^phc_[A-Za-z0-9_-]{8,128}$/.test(settings.token)) return undefined
  let endpoint: URL
  try { endpoint = new URL(settings.endpoint) } catch { return undefined }
  const posthog = endpoint.protocol === 'https:' && ['us.i.posthog.com', 'eu.i.posthog.com'].includes(endpoint.hostname)
    && !endpoint.port && endpoint.pathname === '/i/v1/traces'
  // Test collectors are allowed only on the local development server, never distributed by production.
  const local = env.NODE_ENV === 'development' && endpoint.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  if ((!posthog && !local) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined
  return { endpoint: endpoint.href, projectToken: settings.token, sampleRate: settings.sampleRate, environment: settings.environment }
}
