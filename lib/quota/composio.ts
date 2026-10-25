import { randomUUID } from 'node:crypto'
import { executeComposioAction, type ComposioActionName, type ComposioActionClient, type ComposioActionResult } from '@/lib/composio-actions'
import { QuotaStore } from './store'
import { QuotaError, quotaFailure } from './errors'

/** Production and controlled-HTTP tests share this path. The deadline covers
 * the entire SDK operation; cancellation reaches its actual HTTP transport. */
export async function budgetedComposioAction(store: QuotaStore, userId: string, action: ComposioActionName, input: unknown,
  createClient: () => ComposioActionClient | null, operationKey: string = randomUUID(), options: { leaseMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ComposioActionResult> {
  const leaseMs = options.leaseMs ?? 300000, timeoutMs = options.timeoutMs ?? 270000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= leaseMs) throw new QuotaError('quotaInvalidDeadline', 400)
  let quota: Awaited<ReturnType<QuotaStore['activate']>>
  try {
    const pending = await store.reserve({ ownerId: userId, resource: 'composio.action', key: operationKey, binding: { action, input }, leaseMs })
    // Activation admits one preparation owner. Duplicate callers cannot perform
    // unmetered parallel account/schema fetches against the same logical key.
    quota = await store.activate(userId, pending.id)
  } catch (error) {
    if (error instanceof QuotaError) return { error: error.code }
    throw error
  }
  const deadline = Math.min(Date.now() + timeoutMs, quota.expires_at.getTime() - (leaseMs - timeoutMs))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Composio operation deadline exceeded', 'TimeoutError')), Math.max(0, deadline - Date.now()))
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
  let invoked = false, observedFailure: unknown
  const checkDeadline = () => {
    signal.throwIfAborted()
    if (Date.now() >= deadline) throw new DOMException('Composio operation deadline exceeded', 'TimeoutError')
  }
  try {
    checkDeadline()
    const result = await executeComposioAction(userId, action, input, createClient(), {
      signal,
      beforeExecute: async () => {
        checkDeadline()
        // This SDK hook runs after its own schema/file preflight, immediately
        // before dispatch. It does not renew or extend the original lease.
        await store.revalidate(userId, quota.id)
        checkDeadline()
        invoked = true
      },
      onFailure: async error => { observedFailure = error },
    })
    const rejection = observedFailure ? quotaFailure(observedFailure) : undefined
    const outcome = !invoked ? 'refunded' : observedFailure ? rejection!.outcome : 'error' in result ? 'uncertain' : 'settled'
    await store.finish(userId, quota.id, outcome, undefined, rejection?.retryAfter)
    if (observedFailure instanceof QuotaError) return { error: observedFailure.code }
    if (observedFailure && signal.aborted) return { error: 'integrationTimedOut' }
    return result
  } catch (error) {
    const failure = quotaFailure(error)
    await store.finish(userId, quota.id, invoked ? failure.outcome : 'refunded', undefined, failure.retryAfter)
    if (error instanceof QuotaError) return { error: error.code }
    if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) return { error: 'integrationTimedOut' }
    throw error
  } finally { clearTimeout(timer) }
}
