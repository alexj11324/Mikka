import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readReports, summarize, comparison } from './desktop-native-summary.mjs'

const directory = new URL('./evidence/desktop-191fcce/', import.meta.url).pathname
const expected = { source: 'a5be42ddee7690de2c2ce11574a47cac0f482a79',
  harnessRevision: 'a5be42ddee7690de2c2ce11574a47cac0f482a79', harnessSha256: '36ed7202e05b11cafb1c5f2f2264c9a6ad4c536672b455ad3c1378fc2e56ae7a' }
const { reports, files } = readReports(directory)
const fresh = () => structuredClone(reports)

test('reconciles the real saved 191 login and first startup pair without subtracting PKCE or background', () => {
  const result = summarize(reports, expected), q = result.queryCounts
  assert.deepEqual(q.comparisons.loginNativeVsWeb, { first: 208, second: 161, difference: 47, firstNotAboveSecond: false })
  assert.deepEqual(q.comparisons.startupBundledVsHosted, { first: 173, second: 200, difference: -27, firstNotAboveSecond: true })
  assert.deepEqual(q.windows.nativeLogin.segments.map(value => value.queryCalls), [19, 17, 172])
  assert.deepEqual(q.windows.webLogin.segments.map(value => value.queryCalls), [19, 0, 142])
  assert.equal(q.integrity.observedCheckpointCount, 12)
  assert.equal(q.integrity.pidConsistent, true)
  assert.equal(q.integrity.unknownReadingsAllZero, true)
  assert.equal(q.rpcActions.physical.windows.nativeLogin.totals.startedInWindow, 16)
  assert.equal(q.rpcActions.logical.windows.nativeLogin.totals.startedInWindow, 22)
  assert.equal(q.rpcActions.physical.windows.webLogin.totals.startedInWindow, 13)
  assert.equal(q.rpcActions.logical.windows.webLogin.totals.startedInWindow, 13)
  assert.equal(result.lifecycle.cleanup.accountObservation.state, 'released')
  assert.equal(result.lifecycle.cleanup.accountObservation.ownerAfterMatchesBaseline, true)
  assert.equal(result.parity.passed, 100)
  assert.deepEqual(result.issues, [])
  assert.equal(result.productionAcceptance, null)
})

test('rejects source, counter source, harness hash and embedded package mismatch', () => {
  for (const [mutate, code] of [
    [r => { r['smoke.json'].revision = '0'.repeat(40) }, 'SOURCE_IDENTITY_MISMATCH'],
    [r => { r['lifecycle.json'].queryCounts.source.revision = '0'.repeat(40) }, 'COUNTER_SOURCE_MISMATCH'],
    [r => { r['parity/parity.json'].harnessSha256 = '0'.repeat(64) }, 'HARNESS_IDENTITY_MISMATCH'],
    [r => { r['native-crypto.json'].package.passed = false }, 'PACKAGE_REPORT_MISMATCH'],
  ]) { const r = fresh(); mutate(r); assert.throws(() => summarize(r, expected), { code }) }
})

test('keeps missing SQL and RPC observations unknown rather than replacing them with zero', () => {
  const r = fresh(), q = r['lifecycle.json'].queryCounts
  delete q.windows.nativeLogin.total.queryCalls
  delete q.rpcActions.logical.windows.nativeLogin.actions
  const result = summarize(r, expected)
  assert.equal(result.queryCounts.windows.nativeLogin.queryCalls, null)
  assert.equal(result.queryCounts.comparisons.loginNativeVsWeb.firstNotAboveSecond, null)
  assert.equal(result.queryCounts.rpcActions.logical.windows.nativeLogin.totals.startedInWindow, null)
  assert.ok(result.issues.some(issue => issue.code === 'TOTAL_UNAVAILABLE'))
  assert.ok(result.issues.some(issue => issue.code === 'RPC_ACTIONS_UNAVAILABLE'))
  q.rpcActions.logical.windows.nativeLogin.actions = []
  q.rpcActions.logical.windows.nativeLogin.status = 'incomplete'
  assert.equal(summarize(r, expected).queryCounts.rpcActions.logical.windows.nativeLogin.totals.startedInWindow, null)
})

test('refuses a comparison conclusion when PID, unknown readings, first-pair identity or checkpoint deltas disagree', () => {
  for (const mutate of [
    q => { q.windows.nativeLogin.checkpoints[1].snapshot.pid++ },
    q => { q.windows.nativeLogin.checkpoints[1].snapshot.unknownReadings++ },
    q => { q.windows.nativeLogin.total.queryCalls-- },
  ]) {
    const r = fresh(); mutate(r['lifecycle.json'].queryCounts)
    const result = summarize(r, expected)
    assert.equal(result.queryCounts.comparisons.loginNativeVsWeb.firstNotAboveSecond, null)
    assert.ok(result.issues.length > 0)
  }
  const r = fresh(); r['lifecycle.json'].queryCounts.windows['startup-bundled'].pair = 2
  assert.equal(summarize(r, expected).queryCounts.comparisons.startupBundledVsHosted.firstNotAboveSecond, null)
})

test('outputs closed labels and numbers without names, URLs, error text or arbitrary source properties', () => {
  const r = fresh(), canary = 'private-canary@example.invalid?token=NOT_A_REAL_SECRET'
  r['lifecycle.json'].privatePayload = canary
  r['lifecycle.json'].workspaceNameCleanup.initialName = canary
  r['lifecycle.json'].queryCounts.rpcActions.windows.nativeLogin.actions[0].rpcAction = canary
  r['lifecycle.json'].accountObservation.blockedReason = canary
  const result = summarize(r, { ...expected, arbitrary: canary })
  assert.equal(JSON.stringify(result).includes(canary), false)
  assert.equal(result.queryCounts.rpcActions.physical.windows.nativeLogin.actions[0].action, 'unknown')
  assert.ok(result.issues.some(issue => issue.code === 'RPC_LABEL_UNKNOWN'))
})

test('compares saved summaries without equating unknown RPC rows or SQL counts with zero', () => {
  const before = summarize(reports, expected), after = structuredClone(before)
  after.queryCounts.windows.nativeLogin.queryCalls = null
  after.queryCounts.rpcActions.logical.windows.nativeLogin.actions = null
  after.queryCounts.rpcActions.logical.windows.nativeLogin.totals.startedInWindow = null
  const diff = comparison(after, before)
  assert.equal(diff.windows.nativeLogin.difference, null)
  assert.equal(diff.actions.logical.nativeLogin.startedDifference, null)
  assert.deepEqual(diff.actions.logical.nativeLogin.actionStarts, [])
  assert.equal(diff.productionAcceptance, null)
  assert.deepEqual(readReports(directory).files, files, 'the five original JSON files remain byte-for-byte unchanged')
})
