import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { OPERATIONS } from './desktop-query-operations-summary.mjs'
import { PHASES, SOURCES, summarizeUnattributed } from './desktop-unattributed-sources-summary.mjs'

const source = 'a'.repeat(40)
const counts = (keys, values = {}) => ({ ...Object.fromEntries(keys.map(key => [key, 0])), ...values })
function fixture() {
  const operations = counts(OPERATIONS), sources = counts(SOURCES), windows = {}
  let endedAt = 1000
  const snapshot = () => ({ version: 1, pid: 123, runtime: 'nitro', startedAt: 100, endedAt: endedAt += 100,
    instrumentedClients: 1, queryCalls: Object.values(operations).reduce((a, b) => a + b, 0),
    pgProtocolReceiveBytes: 0, pgProtocolSendBytes: 0, activeConnections: 0, closedConnections: 0, unknownReadings: 0,
    queryOperations: { ...operations }, unattributedSources: { ...sources } })
  const makeDelta = (before, after) => ({ startedAt: new Date(before.endedAt).toISOString(), finishedAt: new Date(after.endedAt).toISOString(),
    durationMs: after.endedAt - before.endedAt, queryCalls: after.queryCalls - before.queryCalls, unknownReadings: 0,
    queryOperations: Object.fromEntries(OPERATIONS.map(key => [key, after.queryOperations[key] - before.queryOperations[key]])),
    unattributedSources: Object.fromEntries(SOURCES.map(key => [key, after.unattributedSources[key] - before.unattributedSources[key]])) })
  const additions = {
    nativeLogin: [
      [{ '/api/auth/[...all]': 3 }, {}],
      [{ '/api/desktop/exchange': 8 }, { '/api/devices/enrollment': 2 }],
      [{ '/actions/threads/poll': 1 }, { '/api/settings/model-order': 3, noScope: 2 }],
    ],
    webLogin: [[{ '/api/auth/[...all]': 3 }, {}], [{}, {}], [{ '/actions/threads/poll': 1 }, { '/api/settings/model-order': 3 }]],
    'startup-bundled': [[{ '/actions/threads/poll': 4 }, { 'after:live-notify': 2 }]],
    'startup-hosted': [[{ '/actions/threads/poll': 6 }, { 'after:live-notify': 1 }]],
  }
  for (const [window, phases] of Object.entries(PHASES)) {
    const checkpoints = [{ phase: 'before', snapshot: snapshot() }], segments = []
    for (const [index, phase] of phases.entries()) {
      const [op, src] = additions[window][index]
      for (const [key, amount] of Object.entries(op)) operations[key] += amount
      for (const [key, amount] of Object.entries(src)) { sources[key] += amount; operations.unattributed += amount }
      const point = snapshot()
      segments.push({ phase, ...makeDelta(checkpoints.at(-1).snapshot, point) })
      checkpoints.push({ phase, snapshot: point })
    }
    windows[window] = { status: 'complete',
      phase: window.startsWith('startup-') ? 'authenticated-launch-to-usable-workspace' : 'ordinary-login-to-usable-workspace',
      ...(window.startsWith('startup-') ? { pair: 1 } : {}), checkpoints, segments,
      total: makeDelta(checkpoints[0].snapshot, checkpoints.at(-1).snapshot) }
  }
  return { version: 1, revision: source, renderers: { bundled: { revision: source }, hosted: { revision: source } },
    queryCounts: { version: 1, source: { revision: source, pid: 123, runtime: 'nitro' }, windows },
    prompt: 'PRIVATE_BODY_CANARY', token: 'PRIVATE_TOKEN_CANARY' }
}
const allRows = value => Object.values(value.queryCounts.windows).flatMap(window => [
  ...window.checkpoints.map(point => point.snapshot), ...window.segments, window.total,
])

test('valid 12 snapshots, 8 segments and 4 totals retain full counts and source differences', () => {
  const result = summarizeUnattributed(fixture(), source)
  assert.equal(result.status, 'complete')
  assert.equal(result.valid, true)
  assert.equal(result.integrity.snapshots, 12)
  assert.equal(result.integrity.segments, 8)
  assert.equal(result.integrity.totals, 4)
  assert.equal(result.integrity.refinementRowsPresent, 24)
  assert.deepEqual(Object.values(result.windows).map(x => x.queryCalls), [19, 7, 6, 7])
  assert.equal(result.comparisons.loginNativeVsWeb.queryDifference, 12)
  assert.equal(result.comparisons.loginNativeVsWeb.unattributedDifference, 4)
  assert.equal(result.comparisons.loginNativeVsWeb.sourceDifferenceSum, 4)
  assert.deepEqual(result.windows.nativeLogin.segments[0].nonzeroSources, [])
  assert.equal(result.comparisons.loginNativeVsWeb.segments[1].sourceDifferenceSum, 2)
  assert.equal(result.comparisons.startupBundledVsHosted.queryDifference, -1)
  assert.equal(result.productionAcceptance, null)
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false)
})

test('legacy absence remains unavailable with original totals and no synthetic zeros', () => {
  const value = fixture()
  for (const row of allRows(value)) delete row.unattributedSources
  const result = summarizeUnattributed(value, source)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.valid, false)
  assert.equal(result.integrity.baseValid, true)
  assert.equal(result.integrity.sourceCumulativeNondecreasing, null)
  assert.equal(result.comparisons.loginNativeVsWeb.queryDifference, 12)
  assert.equal(result.comparisons.loginNativeVsWeb.sourceDifferenceSum, null)
  assert.ok(Object.values(result.windows).every(x => x.nonzeroSources === null))
})

test('one missing refinement is incomplete instead of a valid zero or legacy report', () => {
  const value = fixture()
  delete value.queryCounts.windows.nativeLogin.segments[1].unattributedSources
  const result = summarizeUnattributed(value, source)
  assert.equal(result.status, 'incomplete')
  assert.equal(result.integrity.refinementRowsPresent, 23)
  assert.equal(result.comparisons.loginNativeVsWeb.sources, null)
})

test('invalid, negative, fractional, extra and missing source fields never leak input values', () => {
  const missing = counts(SOURCES); delete missing.noScope
  for (const replacement of [null, [], missing, { ...counts(SOURCES), PRIVATE_LABEL_CANARY: 0 },
    counts(SOURCES, { noScope: -1 }), counts(SOURCES, { noScope: 0.5 }), counts(SOURCES, { noScope: Number.MAX_SAFE_INTEGER + 1 })]) {
    const value = fixture()
    value.queryCounts.windows.nativeLogin.checkpoints[0].snapshot.unattributedSources = replacement
    const result = summarizeUnattributed(value, source)
    assert.equal(result.status, 'incomplete')
    assert.ok(result.issues.some(x => x.code === 'SOURCE_PARTITION_INVALID'))
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false)
  }
})

test('relabelled segments cannot preserve a passing result merely by retaining the sum', () => {
  const value = fixture(), row = value.queryCounts.windows.nativeLogin.segments[2].unattributedSources
  row['/api/settings/model-order']--; row.noScope++
  const result = summarizeUnattributed(value, source)
  assert.equal(result.valid, false)
  assert.ok(result.issues.some(x => x.code === 'SOURCE_DELTA_MISMATCH'))
})

test('a cross-window subcounter reset is rejected even when each local delta and original partition match', () => {
  const value = fixture()
  for (const { snapshot } of value.queryCounts.windows.webLogin.checkpoints) {
    snapshot.unattributedSources['/api/settings/model-order']--
    snapshot.unattributedSources.noScope++
  }
  const result = summarizeUnattributed(value, source)
  assert.equal(result.integrity.baseValid, true)
  assert.equal(result.integrity.sourceCumulativeNondecreasing, false)
  assert.ok(result.issues.some(x => x.code === 'SOURCE_CUMULATIVE_DECREASE'))
})

test('time, PID, original partition, first-pair and shape discrepancies retain incomplete evidence', () => {
  for (const mutate of [
    v => { v.queryCounts.windows.nativeLogin.segments[0].finishedAt = new Date(0).toISOString() },
    v => { v.queryCounts.windows.nativeLogin.checkpoints[0].snapshot.pid++ },
    v => { v.queryCounts.windows.nativeLogin.total.queryOperations.unattributed++ },
    v => { v.queryCounts.windows['startup-bundled'].pair = 2 },
    v => { v.queryCounts.windows.webLogin.checkpoints.pop() },
  ]) {
    const value = fixture(); mutate(value)
    const result = summarizeUnattributed(value, source)
    assert.equal(result.status, 'incomplete')
    assert.equal(result.integrity.baseValid, false)
    assert.equal(result.comparisons.loginNativeVsWeb.queryDifference, null)
  }
})

test('source identity must match lifecycle, both renderers and the counter', () => {
  assert.throws(() => summarizeUnattributed(fixture(), 'invalid'), /EXPECTED_SOURCE_INVALID/)
  for (const mutate of [v => { v.revision = 'b'.repeat(40) }, v => { v.renderers.hosted.revision = 'b'.repeat(40) },
    v => { v.queryCounts.source.revision = 'b'.repeat(40) }]) {
    const value = fixture(); mutate(value)
    assert.throws(() => summarizeUnattributed(value, source), /SOURCE_IDENTITY_MISMATCH|COUNTER_SOURCE_MISMATCH/)
  }
})

test('the CLI leaves original bytes intact and creates only a private closed projection', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mikka-unattributed-reader-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const input = path.join(directory, 'lifecycle.json'), output = path.join(directory, 'summary.json')
  const original = JSON.stringify(fixture())
  writeFileSync(input, original)
  const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('./desktop-unattributed-sources-summary.mjs', import.meta.url)), input, source, output], { encoding: 'utf8' })
  assert.equal(JSON.parse(stdout).status, 'complete')
  assert.equal(readFileSync(input, 'utf8'), original)
  assert.equal(readFileSync(output, 'utf8').includes('PRIVATE_'), false)
  assert.equal(statSync(output).mode & 0o777, 0o600)
})
