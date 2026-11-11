import { withThreadWorkflowAuthority } from '@/lib/enterprise/execution-authority'
import { RetryableError } from 'workflow'

/** Kept as the provider refresh interval for callers that display deadlines. */
export const MAINTENANCE_FALLBACK_MS = 5 * 60_000

/** Shared persisted reconciliation; pausing no longer abandons ownership. */
export async function maintainThreadMachine(actor: { userId: string; workspaceId: string }, runId: string): Promise<false | number> {
  'use step'
  try {
    const [{ pool }, { reconcileThreadMachine }] = await Promise.all([
      import('@/lib/db'), import('@/lib/cloud-computer/thread-lifecycle'),
    ])
    return await withThreadWorkflowAuthority(actor, runId, () => reconcileThreadMachine(pool, actor, runId))
  } catch (error) {
    const { threadLifecycleErrorKind } = await import('@/lib/cloud-computer/thread-lifecycle-log')
    console.error('Thread machine maintenance unavailable', { runId, name: threadLifecycleErrorKind(error) })
    // The error kind above and the durable row identify recovery.
    // error-cause: raw database/provider messages cannot enter the persisted Workflow log.
    throw new RetryableError('thread_machine_maintenance_unavailable', { retryAfter: '1m' })
  }
}
maintainThreadMachine.maxRetries = 5

/** The final pass has persisted its deadline. Retire only after the recovery
 * owner accepts the handoff, even when this Workflow reaches its cap. */
export async function handOffThreadMachine(_actor: { userId: string; workspaceId: string }, runId: string, _next: number) {
  'use step'
  try {
    await (await import('@/lib/due-timer')).handoffRunRecoveryTimer()
  } catch (error) {
    const { threadLifecycleErrorKind } = await import('@/lib/cloud-computer/thread-lifecycle-log')
    console.error('Thread machine handoff unavailable', { runId, name: threadLifecycleErrorKind(error) })
    // The durable claim remains due after this failed handoff.
    // error-cause: persist a sanitized retry code, never a provider/Workflow SDK response body.
    throw new RetryableError('thread_machine_maintenance_unavailable', { retryAfter: '1m' })
  }
}
handOffThreadMachine.maxRetries = 5
