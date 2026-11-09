import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { PINNED_HISTORY, F42606137512_HISTORY, F42606137512_RELEASE_MODE, F42606137512_BINDING, F42606137512_INPUTS,
  loadF42606137512AllocationScope, loadAllocationScope, loadFailedAllocationScope } from './cleanup-allocations.mjs'
import { f42606137512ModelOrderCleanupPlan, modelOrderCleanupPlan,
  failedReleaseModelOrderCleanupPlan, sameModelOrder } from './model-order-cleanup.ts'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = process.env.MIKKA_1503_ACTUAL_REPORT_DIR ?? 'issue1503-inputs/factory'
const buffers = await Promise.all(['claude-code-delivery.json', 'codex-delivery.json'].map(name => readFile(resolve(directory, name))))
for (const [index, pin] of F42606137512_INPUTS.entries()) {
  assert.equal(buffers[index].length, pin.bytes, 'test input must be the admitted original bytes')
  assert.equal(digest(buffers[index]), pin.sha256, 'test input must be the admitted original SHA')
}
const raws = buffers.map(bytes => JSON.parse(bytes.toString('utf8')))
const initialBytes = await readFile(new URL('./initial-model-order.json', import.meta.url))
assert.equal(digest(initialBytes), '56799739844af6bbab8ce3922f848d9d83f35c42b62a2483db1c6f620d25a480')
const initial = JSON.parse(initialBytes.toString('utf8'))
const config = JSON.parse(await readFile(new URL('./failed-release-42606137512.json', import.meta.url), 'utf8'))
const latestPath = 'latest-original-codex'
const readOriginal = async path => path === latestPath ? buffers[1]
  : buffers[F42606137512_INPUTS.findIndex(pin => pin.path === path)]
const now = Date.parse('2026-11-09T11:14:00.000Z')
const clone = value => structuredClone(value)
const rawDigest = value => digest(JSON.stringify(value))

test('F426: exact originals retain both FAIL states and all five distinct runs above H17', async () => {
  const before = raws.map(rawDigest)
  const scope = await loadF42606137512AllocationScope(config, latestPath, readOriginal)
  assert.equal(scope.mode, F42606137512_RELEASE_MODE)
  assert.equal(scope.acceptancePassed, false)
  assert.equal(scope.allocations.length, 22)
  assert.deepEqual(scope.allocations.slice(0, 17), F42606137512_HISTORY)
  assert.deepEqual(scope.allocations.slice(17).map(row => row.runId).sort(),
    F42606137512_INPUTS.flatMap(row => row.runIds).sort())
  assert.equal(new Set(scope.allocations.map(row => row.runId)).size, 22)
  assert.ok(scope.allocations.slice(17).every(row => row.operationId === null && row.lookup === 'operation_metadata'))
  assert.deepEqual(scope.sourceReports.map(row => row.status), ['failed', 'failed'])
  assert.equal(scope.latestFailedRawSha256, F42606137512_INPUTS[1].sha256)
  assert.deepEqual(raws.map(rawDigest), before)
})

test('F426: pending, changed source, hash or historical scope is rejected before reading any input', async () => {
  for (const change of [
    item => { item.source = null },
    item => { item.source.workflowRunId += 1 },
    item => { item.source.fixtureSha256 = '0'.repeat(64) },
    item => { item.failedReports[1].sha256 = null },
    item => { item.failedReports[1].runIds.pop() },
    item => { item.historicalAllocations.pop() },
    item => { item.mode = 'failed_release' },
  ]) {
    const altered = clone(config); change(altered); let reads = 0
    await assert.rejects(loadF42606137512AllocationScope(altered, latestPath, async () => {
      reads++; return buffers[0]
    }), /f42606137512_allocation_scope_invalid/)
    assert.equal(reads, 0)
  }
})

test('F426: byte changes and swapped reports cannot authorize allocations', async () => {
  await assert.rejects(loadF42606137512AllocationScope(config, latestPath,
    async path => path === F42606137512_INPUTS[0].path ? Buffer.concat([buffers[0], Buffer.from('\n')]) : readOriginal(path)),
  /f42606137512_raw_sha_mismatch/)
  await assert.rejects(loadF42606137512AllocationScope(config, latestPath,
    async path => path === F42606137512_INPUTS[0].path ? buffers[1] : readOriginal(path)),
  /f42606137512_raw_sha_mismatch/)
})

test('F426: latest must be the exact later Codex original, not the first leg or re-encoded JSON', async () => {
  for (const wrong of [buffers[0], Buffer.from(JSON.stringify(raws[1]))]) {
    await assert.rejects(loadF42606137512AllocationScope(config, latestPath,
      async path => path === latestPath ? wrong : readOriginal(path)), /f42606137512_latest_mismatch/)
  }
})

test('F426: this source is not admitted by final PASS or old F186 allocation modes', async () => {
  await assert.rejects(loadAllocationScope(config, latestPath, readOriginal), /allocation_scope_invalid/)
  await assert.rejects(loadFailedAllocationScope(config, latestPath, readOriginal), /failed_allocation_scope_invalid/)
})

test('F426: actual eight-entry false-to-true then true-to-true restoration is preserved', () => {
  const before = raws.map(rawDigest), initialBefore = rawDigest(initial)
  const plan = f42606137512ModelOrderCleanupPlan(initial, raws, now)
  assert.equal(plan.materialized.entries.length, 8)
  assert.equal(plan.materialized.customized, true)
  assert.equal(plan.currentDefault.entries.length, 8)
  assert.equal(plan.currentDefault.customized, false)
  assert.ok(sameModelOrder(plan.materialized, raws[1].restoredOrder))
  assert.equal(plan.latest, raws[1])
  assert.equal(raws[0].originalOrder.customized, false)
  assert.equal(raws[0].cleanup.find(row => row.kind === 'effective_model_order_restored').customizedFlagPreserved, false)
  assert.deepEqual(raws.map(rawDigest), before)
  assert.equal(rawDigest(initial), initialBefore)
})

test('F426: old F186 and final PASS model gates continue to reject these failures', () => {
  assert.throws(() => modelOrderCleanupPlan(initial, raws[1], now), /cleanup_model_order_receipt_mismatch/)
  assert.throws(() => failedReleaseModelOrderCleanupPlan(initial, raws, now), /cleanup_failed_model_order_receipt_mismatch/)
})

test('F426: changing original model credentials, order or customized state cannot restore a different baseline', () => {
  for (const change of [
    rows => { rows[0].originalOrder.entries.reverse() },
    rows => { rows[1].restoredOrder.entries[0].source.connectionId = 'unrelated-connection' },
    rows => { rows[0].originalOrder.customized = true },
    rows => { rows[1].restoredOrder.customized = false },
  ]) {
    const altered = clone(raws); change(altered)
    assert.throws(() => f42606137512ModelOrderCleanupPlan(initial, altered, now),
      /cleanup_f42606137512_model_order_receipt_mismatch/)
  }
})

test('F426: an absent or falsified restoration flag is not a successful cleanup receipt', () => {
  for (const change of [
    rows => { rows[0].cleanup = rows[0].cleanup.filter(row => row.kind !== 'effective_model_order_restored') },
    rows => { rows[0].cleanup.find(row => row.kind === 'effective_model_order_restored').customizedFlagPreserved = true },
    rows => { rows[1].cleanup.find(row => row.kind === 'effective_model_order_restored').customizedFlagPreserved = false },
  ]) {
    const altered = clone(raws); change(altered)
    assert.throws(() => f42606137512ModelOrderCleanupPlan(initial, altered, now),
      /cleanup_f42606137512_model_order_receipt_mismatch/)
  }
})

test('F426: another APP, marker, status or writer window cannot reuse this model plan', () => {
  for (const patch of [{ expectedSha: '0'.repeat(40) }, { marker: 'another-run-1' },
    { status: 'passed' }, { completedAt: '2026-11-09T11:14:00.000Z' }, { completedAt: null }]) {
    const altered = clone(raws); Object.assign(altered[1], patch)
    assert.throws(() => f42606137512ModelOrderCleanupPlan(initial, altered, now),
      /cleanup_f42606137512_model_order_receipt_mismatch/)
  }
})

test('F426: historical initial hash and the existing future-time guard remain mandatory', () => {
  const altered = clone(initial); altered.originalOrder.entries.reverse()
  assert.throws(() => f42606137512ModelOrderCleanupPlan(altered, raws, now), /cleanup_model_order_receipt_mismatch/)
  assert.throws(() => f42606137512ModelOrderCleanupPlan(initial, raws,
    Date.parse(raws[1].completedAt) - 30_001), /cleanup_model_order_receipt_mismatch/)
})

test('F426: current or locked state must exactly match the materialized snapshot, including its flag', () => {
  const plan = f42606137512ModelOrderCleanupPlan(initial, raws, now)
  const changed = clone(plan.materialized); changed.entries.reverse()
  assert.equal(sameModelOrder(changed, plan.materialized), false)
  assert.equal(sameModelOrder({ ...plan.materialized, customized: false }, plan.materialized), false)
  assert.equal(sameModelOrder({ ...plan.currentDefault, customized: true }, plan.currentDefault), false)
})
