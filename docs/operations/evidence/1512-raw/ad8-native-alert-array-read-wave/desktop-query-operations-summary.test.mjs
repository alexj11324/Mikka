import assert from 'node:assert/strict'
import test from 'node:test'
import { OPERATIONS, projectOperations } from './desktop-query-operations-summary.mjs'

function fixture() {
  const windows = {}, counts = Object.fromEntries(OPERATIONS.map(key => [key, 0]))
  const totals = {}, baseWindows = {}
  let endedAt = 1000
  const snapshot = () => ({ endedAt: endedAt++, queryCalls: Object.values(counts).reduce((a, b) => a + b, 0), queryOperations: { ...counts } })
  for (const [name, amounts] of Object.entries({ nativeLogin: [2, 3, 4], webLogin: [2, 0, 3], 'startup-bundled': [7], 'startup-hosted': [6] })) {
    const checkpoints = [{ snapshot: snapshot() }], segments = []
    for (const amount of amounts) {
      counts[OPERATIONS[0]] += amount
      checkpoints.push({ snapshot: snapshot() })
      segments.push({ queryCalls: amount, queryOperations: Object.fromEntries(OPERATIONS.map((key, index) => [key, index ? 0 : amount])) })
    }
    totals[name] = amounts.reduce((a, b) => a + b, 0)
    windows[name] = { checkpoints, segments, total: { queryCalls: totals[name],
      queryOperations: Object.fromEntries(OPERATIONS.map((key, index) => [key, index ? 0 : totals[name]])) } }
    baseWindows[name] = { valid: true }
  }
  const base = { source: { source: 'a'.repeat(40) }, queryCounts: { windows: baseWindows,
    integrity: Object.fromEntries(['pidConsistent', 'processStartConsistent', 'runtimeConsistent', 'cumulativeQueriesNondecreasing', 'unknownReadingsAllZero'].map(key => [key, true])),
    comparisons: { loginNativeVsWeb: { difference: 4, firstNotAboveSecond: false }, startupBundledVsHosted: { difference: 1, firstNotAboveSecond: false } } } }
  return { lifecycle: { queryCounts: { windows } }, base }
}

test('partitions preserve all 12 snapshots, 8 segments, 4 totals and both full-window differences', () => {
  const { lifecycle, base } = fixture(), result = projectOperations(lifecycle, base)
  assert.equal(result.valid, true)
  assert.equal(result.rows.length, 17)
  assert.equal(result.comparisons.loginNativeVsWeb.operationDifference, 4)
  assert.equal(result.comparisons.startupBundledVsHosted.operationDifference, 1)
  assert.equal(result.productionAcceptance, null)
})

test('a missing partition remains unavailable instead of being fabricated as zero', () => {
  const { lifecycle, base } = fixture()
  delete lifecycle.queryCounts.windows.nativeLogin.checkpoints[1].snapshot.queryOperations
  const result = projectOperations(lifecycle, base)
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(issue => issue.code === 'SNAPSHOT_UNAVAILABLE'))
  assert.ok(result.rows.every(row => row.nativeLogin === null && row.loginDifference === null))
})

test('a relabelled segment with an unchanged SQL total fails the original snapshot differences', () => {
  const { lifecycle, base } = fixture(), counts = lifecycle.queryCounts.windows.nativeLogin.segments[0].queryOperations
  counts[OPERATIONS[0]]--
  counts[OPERATIONS[1]]++
  const result = projectOperations(lifecycle, base)
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(issue => issue.code === 'SEGMENT_CHECKPOINT_MISMATCH'))
})

test('unknown operation labels and unconfirmed base counter identity cannot validate', () => {
  const { lifecycle, base } = fixture()
  lifecycle.queryCounts.windows.webLogin.total.queryOperations.unregistered = 0
  base.queryCounts.integrity.pidConsistent = false
  const result = projectOperations(lifecycle, base)
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(issue => issue.code === 'TOTAL_INVALID'))
  assert.ok(result.issues.some(issue => issue.code === 'BASE_COUNTER_INTEGRITY_UNCONFIRMED'))
  assert.ok(result.rows.every(row => row.loginDifference === null && row.startupDifference === null))
})

test('operation differences must match the independently reported complete-window comparison', () => {
  const { lifecycle, base } = fixture()
  base.queryCounts.comparisons.loginNativeVsWeb.difference = 5
  const result = projectOperations(lifecycle, base)
  assert.equal(result.valid, false)
  assert.equal(result.comparisons.loginNativeVsWeb.partitionMatchesOriginal, false)
  assert.ok(result.issues.some(issue => issue.code === 'COMPARISON_TOTAL_MISMATCH'))
})
