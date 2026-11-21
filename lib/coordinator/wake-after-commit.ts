import { afterDatabaseCommit } from '../db/commit-effects'

/** Tests replace `wake` here to observe wakes without a Coordinator runtime. */
export const coordinatorWakeTransport: { wake?: (userId: string) => Promise<unknown> } = {}

const wake = async (userId: string) => {
  const { withoutDatabaseClient } = await import('../db/request-scope')
  // The commit observer and Next after() retain the writer's async context.
  // Keep its database/authority scope, but never reuse its released SQL client
  // or finished transaction for the independent inbox consumer.
  return withoutDatabaseClient(async () => {
    if (coordinatorWakeTransport.wake) return coordinatorWakeTransport.wake(userId)
    const { wakeCoordinator } = await import('./wake')
    return wakeCoordinator(userId)
  })
}

const pending = (event: { tier?: string | null; deliveredAt?: unknown }) => !event.deliveredAt && event.tier !== 'background'

/**
 * Starts the owner's Coordinator wake once this transaction commits, for a
 * pending inbox row (#1212). The row is the durable outbox; this replaces the
 * minute sweep as the thing that notices it. One wake per owner per commit;
 * nothing on rollback; never fails the write. Eve owns per-session queueing
 * after the committed product event has been delivered.
 */
export function wakeCoordinatorAfterCommit(executor: object, userId: string, event: { tier?: string | null; deliveredAt?: unknown } = {}) {
  if (!pending(event)) return
  try {
    afterDatabaseCommit(executor, `coordinator-wake:${userId}`, async () => {
      const { afterJob } = await import('../background')
      afterJob('after:coordinator-wake', () => wake(userId), { orRun: true })
    })
  } catch { /* an executor without commit tracking: the slow reconciliation sweep recovers it */ }
}

/** wakeCoordinatorAfterCommit after the current request, for a write that has already committed. */
export function wakeCoordinatorSoon(userId: string) {
  // The selected bot model and the person's cloud binding are checked after the write,
  // when the committed binding can be read; never query inside this callback.
  void import('../background').then(({ afterJob }) => afterJob('after:coordinator-wake', () => wake(userId), { orRun: true })).catch(() => {})
}
