import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deliverWake, MAX_WAKE_ATTEMPTS, type WakeClaim } from './wake-recovery'

const claim = (attempt: number): WakeClaim => ({ userId: 'u', botId: 'b', ids: ['e1'], leaseUntil: new Date(0), attempt })
const deps = (start: () => Promise<void>, waking = true) => {
  const told: number[] = []
  return { told, deps: {
    triage: async () => {}, hasWaking: async () => waking, start, failed: async () => {},
    exhausted: async (value: WakeClaim) => { told.push(value.attempt) },
  } }
}
const broken = async () => { throw new Error('start failed') }

test('only the last failed attempt tells the person; earlier ones retry quietly', async () => {
  const early = deps(broken)
  assert.equal(await deliverWake(claim(MAX_WAKE_ATTEMPTS - 1), early.deps), 'failed')
  assert.deepEqual(early.told, [])
  const last = deps(broken)
  assert.equal(await deliverWake(claim(MAX_WAKE_ATTEMPTS), last.deps), 'failed')
  assert.deepEqual(last.told, [MAX_WAKE_ATTEMPTS])
})

test('a last attempt still waiting on triage gives up too; one that starts says nothing', async () => {
  const pending = deps(async () => {}, false)
  assert.equal(await deliverWake(claim(MAX_WAKE_ATTEMPTS), pending.deps), 'deferred')
  assert.deepEqual(pending.told, [MAX_WAKE_ATTEMPTS])
  const started = deps(async () => {})
  assert.equal(await deliverWake(claim(MAX_WAKE_ATTEMPTS), started.deps), 'started')
  assert.deepEqual(started.told, [])
})

test('a failing notice never changes the wake outcome', async () => {
  const { deps: base } = deps(broken)
  assert.equal(await deliverWake(claim(MAX_WAKE_ATTEMPTS), { ...base, exhausted: async () => { throw new Error('push down') } }), 'failed')
})
