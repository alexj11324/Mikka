import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { modelOrderCleanupPlan, sameModelOrder } from './model-order-cleanup'

const initial = JSON.parse(readFileSync(new URL('./initial-model-order.json', import.meta.url), 'utf8'))
const now = Date.parse('2026-11-07T02:00:00Z')
const newestModels = ['claude-opus-5-5', 'gpt-6.1-sol', 'claude-haiku-5-5', 'claude-sonnet-5-5',
  'claude-fable-5-1', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna']
const newDefault = { ...structuredClone(initial.originalOrder),
  entries: initial.originalOrder.entries.filter((entry: any) => newestModels.includes(entry.model)) }
function receipt(order = initial.originalOrder) {
  return { issue: 1503, phase: 'delivery', workspaceId: initial.workspaceId, repository: initial.repository,
    marker: 'later-successful-driver', status: 'passed', startedAt: '2026-11-07T01:40:00Z', completedAt: '2026-11-07T01:50:00Z',
    originalOrder: structuredClone(order), restoredOrder: { ...structuredClone(order), customized: true },
    cleanup: [{ kind: 'effective_model_order_restored' }] }
}

test('a latest successful driver with the old 22 entries restores the new eight defaults without rewriting either receipt', () => {
  const before = JSON.stringify(initial), latest = receipt(), latestBefore = JSON.stringify(latest)
  const plan = modelOrderCleanupPlan(initial, latest, now)
  assert.equal(plan.materialized.entries.length, 22)
  assert.deepEqual(plan.currentDefault.entries.map(entry => entry.model), newestModels)
  assert.equal(plan.currentDefault.customized, false)
  assert.equal(sameModelOrder(plan.currentDefault, initial.originalOrder), false, 'the old cleanup comparison would reject the real current default')
  assert.equal(JSON.stringify(initial), before)
  assert.equal(JSON.stringify(latest), latestBefore)
})

test('a driver that started with the new default is guarded by its own eight-entry restoration receipt', () => {
  const latest = receipt(newDefault)
  const plan = modelOrderCleanupPlan(initial, latest, now)
  assert.equal(plan.materialized.entries.length, 8)
  assert.ok(sameModelOrder(latest.restoredOrder, plan.materialized))
  assert.ok(sameModelOrder(newDefault, plan.currentDefault))
  assert.equal(sameModelOrder({ ...initial.originalOrder, customized: true }, plan.materialized), false)
})

test('custom order, credential, setting and incomplete restoration changes are not the known default migration', () => {
  const mutations = [
    (latest: any) => { latest.restoredOrder.entries.reverse() },
    (latest: any) => { latest.originalOrder.entries[0].source.connectionId = 'another-owner-connection'; latest.restoredOrder.entries[0].source.connectionId = 'another-owner-connection' },
    (latest: any) => { latest.originalOrder.location = 'local'; latest.restoredOrder.location = 'local' },
    (latest: any) => { latest.originalOrder.entries.pop(); latest.restoredOrder.entries.pop() },
    (latest: any) => { latest.cleanup = [] },
  ]
  for (const mutate of mutations) {
    const latest = receipt(newDefault); mutate(latest)
    assert.throws(() => modelOrderCleanupPlan(initial, latest, now), /cleanup_model_order_receipt_mismatch/)
  }
})

test('the initial hash, latest success and the existing receipt time window remain mandatory', () => {
  const changedInitial = structuredClone(initial); changedInitial.originalOrder.entries.reverse()
  assert.throws(() => modelOrderCleanupPlan(changedInitial, receipt(), now), /cleanup_model_order_receipt_mismatch/)
  for (const patch of [{ status: 'failed' }, { startedAt: '2026-11-06T19:21:10Z' },
    { completedAt: '2026-11-07T02:00:31Z' }, { completedAt: '2026-11-07T01:39:59Z' }, { workspaceId: 'another-workspace' }]) {
    assert.throws(() => modelOrderCleanupPlan(initial, { ...receipt(), ...patch }, now), /cleanup_model_order_receipt_mismatch/)
  }
})

test('current/locked snapshots and resolved defaults reject concurrent or new catalogue changes', () => {
  const { materialized, currentDefault } = modelOrderCleanupPlan(initial, receipt(), now)
  assert.ok(sameModelOrder({ ...materialized, entries: materialized.entries.map((entry, index) => ({ ...entry, id: `db-${index}` })) }, materialized))
  const concurrent = structuredClone(materialized); concurrent.entries.reverse()
  assert.equal(sameModelOrder(concurrent, materialized), false)
  assert.equal(sameModelOrder({ ...materialized, customized: false }, materialized), false)
  const changedCatalogue = structuredClone(currentDefault); changedCatalogue.entries[0].model = 'claude-opus-5-10'
  assert.equal(sameModelOrder(changedCatalogue, currentDefault), false)
  assert.equal(sameModelOrder({ ...currentDefault, customized: true }, currentDefault), false)
  assert.equal(sameModelOrder(null, currentDefault), false)
})
