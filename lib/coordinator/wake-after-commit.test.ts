import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let callbacks: Array<() => Promise<void>> = [], owners: string[] = []
let observed: (() => void) | undefined
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../default-model-config.ts', { defaultModelConfigured: () => false })
stub('../run-test-fixture.ts', { runTestFixture: () => undefined })
stub('../db/commit-effects.ts', { afterDatabaseCommit: (_executor: object, _key: string, work: () => Promise<void>) => { callbacks.push(work) } })
stub('../db/request-scope.ts', { withoutDatabaseClient: <T>(work: () => T) => work() })
stub('../background.ts', { afterJob: (_name: string, work: () => Promise<unknown>) => { void work() } })
stub('./wake.ts', { wakeCoordinator: async (owner: string) => { owners.push(owner); observed?.() } })
let notifications: typeof import('./wake-after-commit')
before(async () => { notifications = await import('./wake-after-commit') })
beforeEach(() => { callbacks = []; owners = []; observed = undefined; notifications.coordinatorWakeTransport.wake = undefined })
const nextWake = () => new Promise<void>(resolve => { observed = resolve })

test('without a server default, a committed inbox write still reaches the per-bot readiness check', { timeout: 5000 }, async () => {
  notifications.wakeCoordinatorAfterCommit({}, 'alice')
  assert.equal(callbacks.length, 1)
  assert.deepEqual(owners, [], 'nothing wakes before the transaction commits')
  const delivered = nextWake()
  await callbacks[0]()
  await delivered
  assert.deepEqual(owners, ['alice'])
})

test('already-committed writes notify; delivered or background events do not queue a wake', { timeout: 5000 }, async () => {
  const delivered = nextWake()
  notifications.wakeCoordinatorSoon('alice')
  await delivered
  assert.deepEqual(owners, ['alice'])
  notifications.wakeCoordinatorAfterCommit({}, 'alice', { tier: 'background' })
  notifications.wakeCoordinatorAfterCommit({}, 'alice', { deliveredAt: new Date() })
  assert.deepEqual(callbacks, [])
})
