import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { context, trace } from '@opentelemetry/api'

const PHASES = new Set(['authorize', 'binding', 'selection', 'admit_before', 'access', 'admit_after', 'connection', 'prepare', 'context', 'native_auth', 'provider_headers', 'request'] as const)
type Phase = typeof PHASES extends Set<infer Name> ? Name : never
type Outcome = 'ok' | 'error'
const elapsed = (start: number) => Math.max(0, Math.round((performance.now() - start) * 1_000) / 1_000)

/** Every native call retains a content-free timing receipt even when its OTel
 * trace is unsampled. This measures existing work; it performs no request or
 * database operation. provider_headers includes the upstream time to headers. */
export function subscriptionNativeTiming(operation: 'http' | 'context' | 'request' | 'lease', runId?: string,
  log: (line: string) => void = line => console.info(line)) {
  const startedAt = Date.now(), started = performance.now()
  const runIdHash = runId ? createHash('sha256').update(runId).digest('hex').slice(0, 16) : null
  const phases: { phase: Phase; startMs: number; ms: number; outcome: Outcome }[] = []
  let closed = false, truncated = false
  return {
    async measure<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
      const phaseStarted = performance.now()
      let outcome: Outcome = 'ok'
      try { return await work() }
      catch (error) { outcome = 'error'; throw error }
      finally {
        if (!closed && PHASES.has(phase)) {
          if (phases.length < 32) phases.push({ phase, startMs: Math.max(0, Math.round((phaseStarted - started) * 1_000) / 1_000), ms: elapsed(phaseStarted), outcome })
          else truncated = true
        }
      }
    },
    end(outcome: Outcome) {
      if (closed) return
      closed = true
      try {
        const span = trace.getSpan(context.active())?.spanContext()
        log(JSON.stringify({ msg: 'subscription_native_timing', operation, runIdHash, startedAt, endedAt: Date.now(), ms: elapsed(started), outcome, phases, truncated,
          ...(span && /^[a-f0-9]{32}$/.test(span.traceId) ? { traceId: span.traceId, spanId: span.spanId } : {}) }))
      } catch { /* Diagnostics cannot replace the operation's result or error. */ }
    },
  }
}

export async function measureSubscriptionNative<T>(operation: 'context' | 'request' | 'lease', runId: string | undefined,
  work: (timing: ReturnType<typeof subscriptionNativeTiming>) => Promise<T>): Promise<T> {
  const timing = subscriptionNativeTiming(operation, runId)
  let outcome: Outcome = 'ok'
  try { return await work(timing) }
  catch (error) { outcome = 'error'; throw error }
  finally { timing.end(outcome) }
}
