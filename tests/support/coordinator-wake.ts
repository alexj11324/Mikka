import assert from 'node:assert/strict'
import { mock, type TestContext } from 'node:test'

/**
 * Database writer suites own admission/receipt/notification state, not the
 * Coordinator consumer. Keep its real inbox and after-COMMIT producer, and
 * observe both direct wakes and deferred wakes without starting that runtime.
 * wake-event-driven.db.test.ts separately exercises the wake contract.
 */
export async function isolateCoordinatorWakes(t: Pick<TestContext, 'after'>) {
  const { coordinatorWakeTransport } = await import('../../lib/coordinator/wake-after-commit')
  const previousWake = coordinatorWakeTransport.wake
  const calls: string[] = []
  const observe = async (ownerId: string) => { calls.push(ownerId) }
  coordinatorWakeTransport.wake = observe
  let unexpectedReadiness = 0
  const runtime = mock.module(new URL('../../lib/coordinator/wake.ts', import.meta.url).href, {
    cache: true,
    namedExports: {
      wakeCoordinator: observe,
      coordinatorEnabled: () => {
        unexpectedReadiness++
        throw new Error('Coordinator readiness is outside this database writer fixture')
      },
    },
  })
  const background = await import('../../lib/background')
  const running: Promise<unknown>[] = []
  const scheduler = mock.module(new URL('../../lib/background.ts', import.meta.url).href, {
    cache: true,
    namedExports: {
      ...background,
      afterJob: ((label, work, options) => background.afterJob(label, work, label === 'after:coordinator-wake'
        ? { ...options, schedule: run => { running.push(Promise.resolve(run())) } }
        : options)) satisfies typeof background.afterJob,
    },
  })
  const flush = async () => {
    // Join the cached import used by already-committed wake producers before
    // draining their observed jobs. No sleep or polling, and no lost callbacks.
    await import('../../lib/background')
    await Promise.all(running.splice(0))
  }
  t.after(async () => {
    try { await flush() }
    finally {
      scheduler.restore()
      runtime.restore()
      if (previousWake === undefined) delete coordinatorWakeTransport.wake
      else coordinatorWakeTransport.wake = previousWake
    }
    assert.equal(unexpectedReadiness, 0, 'the writer must not depend on a fabricated Coordinator readiness result')
  })
  return { calls, flush }
}
