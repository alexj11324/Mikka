import { expect, it } from 'vitest'
import { SubscriptionCallTiming, currentSubscriptionWorkerTiming, withSubscriptionTiming, withSubscriptionWorkerTiming } from './subscription-worker-timing'

it('distinguishes unobserved stages, observed zero and canceled identity work', () => {
  let now = 100
  const call = new SubscriptionCallTiming(() => now)
  const worker = call.startWorker('prepare')!
  expect(worker.snapshot().identityLoginCalls).toBeNull()
  const identityDone = worker.beginIdentity()
  worker.identityMode('custody_token')
  const loginDone = worker.phase('identityLogin')
  expect(worker.snapshot().identityLoginMs).toBeNull()
  now = 107; loginDone(); loginDone()
  now = 109; identityDone(); worker.configWrite()
  worker.terminal({ version: 1, readCalls: 0, readMs: null, authorizeMs: 0 }, true)
  now = 111; worker.settle('result')
  expect(worker.snapshot()).toMatchObject({ startedMs: 0, settledMs: 11, identityMs: 9, spawnToConfigWriteMs: 9, identityLoginCalls: 1, identityLoginMs: 7, parentProjectionReadCalls: 0, parentProjectionReadMs: null, goState: 'reported', go: { readCalls: 0, readMs: null, authorizeMs: 0 } })
  const cancelled = call.startWorker('executeStream')!
  const finishIdentity = cancelled.beginIdentity(), finishRead = cancelled.phase('parentProjectionRead')
  cancelled.settle('cancelled')
  const stopped = cancelled.snapshot()
  now = 300; finishRead(); finishIdentity(); cancelled.phase('identityLogin')(); cancelled.terminal({ version: 1, rpcBodyMs: 100 }, true)
  expect(cancelled.snapshot()).toEqual(stopped)
  expect(stopped).toMatchObject({ goState: 'missing', identityMs: null, parentProjectionReadCalls: 1, parentProjectionReadMs: null })
})

it('allows only bounded fixed numeric Go fields and never retains an injected value', () => {
  for (const value of [null, [], 'fixture-private', { version: 2 }, { version: 1, token: 'fixture-private' }, { version: 1, readMs: -1 }, { version: 1, rpcBodyMs: Infinity }, { version: 1, rpcBodyMs: NaN }, { version: 1, rpcBodyMs: 3_600_001 }, { version: 1, readCalls: 0.5 }, { version: 1, readCalls: 1_000_001 }, { version: 1, accessReadBackend: { toString: () => 'vault', value: 'fixture-private' } }]) {
    const call = new SubscriptionCallTiming(() => 0), worker = call.startWorker('prepare')!
    worker.terminal(value, true)
    expect(worker.snapshot()).toMatchObject({ goState: 'invalid' })
    expect(worker.snapshot().go).toBeUndefined()
    expect(JSON.stringify(call.snapshot())).not.toContain('fixture-private')
  }
  const call = new SubscriptionCallTiming(() => 0)
  call.startWorker('fixture-private')!.terminal(undefined, false)
  for (let n = 0; n < 19; n++) call.startWorker('prepare')
  expect(call.snapshot().workers).toHaveLength(16)
  expect(call.snapshot().overflow).toBe(4)
  expect(call.snapshot().workers[0]).toMatchObject({ method: 'unobserved', goState: 'missing' })
  expect(JSON.stringify(call.snapshot())).not.toContain('fixture-private')
})

it('captures independent identity scopes across concurrent calls without storing their inputs', async () => {
  const one = new SubscriptionCallTiming(), two = new SubscriptionCallTiming()
  let release!: () => void
  const gate = { promise: new Promise<void>(resolve => { release = resolve }), resolve: () => release() }
  const first = withSubscriptionTiming(one, async () => {
    const worker = one.startWorker('prepare')!, done = worker.beginIdentity()
    await withSubscriptionWorkerTiming(worker, async () => {
      const phaseDone = currentSubscriptionWorkerTiming()!.phase('identityLogin')
      await gate.promise
      expect(currentSubscriptionWorkerTiming()).toBe(worker)
      phaseDone()
    })
    done(); worker.settle('result')
  })
  await withSubscriptionTiming(two, async () => {
    const worker = two.startWorker('executeStream')!, done = worker.beginIdentity()
    await withSubscriptionWorkerTiming(worker, async () => {
      currentSubscriptionWorkerTiming()!.phase('parentProjectionRead')()
      gate.resolve()
      await Promise.resolve()
      expect(currentSubscriptionWorkerTiming()).toBe(worker)
    })
    done(); worker.settle('result')
  })
  await first
  expect(one.snapshot().workers[0]).toMatchObject({ ordinal: 1, identityLoginCalls: 1, parentProjectionReadCalls: 0 })
  expect(two.snapshot().workers[0]).toMatchObject({ ordinal: 1, identityLoginCalls: 0, parentProjectionReadCalls: 1 })
  expect(currentSubscriptionWorkerTiming()).toBeUndefined()
})

it('a broken observation clock stays missing without changing the callback result', () => {
  const call = new SubscriptionCallTiming(() => { throw new Error('fixture clock') })
  const result = withSubscriptionTiming(call, () => {
    const worker = call.startWorker('prepare')!, done = worker.beginIdentity()
    worker.phase('identityLogin')(); done(); worker.settle('result')
    return 7
  })
  expect(result).toBe(7)
  expect(call.snapshot().workers[0]).toMatchObject({ startedMs: null, settledMs: null, identityMs: null, identityLoginMs: null })
})
