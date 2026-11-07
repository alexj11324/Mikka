import { defaultModelConfigured } from '@/lib/default-model-config'
import { afterDatabaseCommit } from '../db/commit-effects'
import { runTestFixture } from '../run-test-fixture'

/** Tests replace `wake` here to observe wakes without a Coordinator runtime. */
export const coordinatorWakeTransport: { wake?: (userId: string) => Promise<unknown> } = {}

/** Same condition as coordinatorEnabled (lib/coordinator/wake.ts), without loading the runtime. */
const enabled = () => Boolean(coordinatorWakeTransport.wake || defaultModelConfigured() || runTestFixture('mock') !== undefined)

const wake = async (userId: string) => {
  if (coordinatorWakeTransport.wake) return coordinatorWakeTransport.wake(userId)
  const { wakeCoordinator } = await import('./wake')
  return wakeCoordinator(userId)
}

const pending = (event: { tier?: string | null; deliveredAt?: unknown }) => !event.deliveredAt && event.tier !== 'background'

/**
 * Starts the owner's Coordinator wake once this transaction commits, for a
 * pending inbox row (#1212). The row is the durable outbox; this replaces the
 * minute sweep as the thing that notices it. One wake per owner per commit;
 * nothing on rollback; never fails the write. A wake while a turn holds the
 * chat defers, and that turn's lease release wakes it again (store.releaseLease).
 */
export function wakeCoordinatorAfterCommit(executor: object, userId: string, event: { tier?: string | null; deliveredAt?: unknown } = {}) {
  if (!pending(event) || !enabled()) return
  try {
    afterDatabaseCommit(executor, `coordinator-wake:${userId}`, async () => {
      const { afterJob } = await import('../background')
      afterJob('after:coordinator-wake', () => wake(userId), { orRun: true })
    })
  } catch { /* an executor without commit tracking: the slow reconciliation sweep recovers it */ }
}

/** wakeCoordinatorAfterCommit after the current request, for a write that has already committed. */
export function wakeCoordinatorSoon(userId: string) {
  if (!enabled()) return
  void import('../background').then(({ afterJob }) => afterJob('after:coordinator-wake', () => wake(userId), { orRun: true })).catch(() => {})
}
