import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readReports, summarize } from './desktop-native-summary.mjs'

export const OPERATIONS = Object.freeze([
  '/api/auth/[...all]', '/api/desktop/begin', '/api/desktop/return',
  '/api/desktop/exchange', '/api/desktop/rpc', '/api/rpc',
  '/api/workspace', '/api/workspace/switcher', '/api/live/ticket',
  '/actions/coordinator/chat', '/actions/coordinator/poll', '/actions/coordinator/summaries',
  '/actions/threads/poll', '/actions/task-runs/read', '/actions/issues/poll',
  '/actions/projects/list', 'unattributed',
])
const WINDOWS = ['nativeLogin', 'webLogin', 'startup-bundled', 'startup-hosted']
const EXPECTED_SEGMENTS = [3, 3, 1, 1]
const count = x => Number.isSafeInteger(x) && x >= 0
const equal = (a, b) => a && b && OPERATIONS.every(key => a[key] === b[key])
const subtract = (a, b) => Object.fromEntries(OPERATIONS.map(key => [key, a[key] - b[key]]))
const sum = vector => OPERATIONS.reduce((total, key) => total + vector[key], 0)

export function projectOperations(lifecycle, base) {
  const issues = [], windows = {}, snapshots = []
  const note = (window, code, index) => issues.push({ window, code, ...(index === undefined ? {} : { index }) })
  function vector(row, window, kind, index) {
    const value = row?.queryOperations
    if (value === undefined) { note(window, `${kind}_UNAVAILABLE`, index); return null }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== OPERATIONS.length
      || !OPERATIONS.every(key => Object.hasOwn(value, key) && count(value[key]))
      || !count(row?.queryCalls) || !count(sum(value)) || sum(value) !== row.queryCalls) {
      note(window, `${kind}_INVALID`, index); return null
    }
    return Object.fromEntries(OPERATIONS.map(key => [key, value[key]]))
  }
  for (const [windowIndex, name] of WINDOWS.entries()) {
    const raw = lifecycle?.queryCounts?.windows?.[name]
    const expectedSegments = EXPECTED_SEGMENTS[windowIndex]
    const points = Array.isArray(raw?.checkpoints) ? raw.checkpoints : []
    const segments = Array.isArray(raw?.segments) ? raw.segments : []
    const startIssues = issues.length
    if (points.length !== expectedSegments + 1 || segments.length !== expectedSegments) note(name, 'SHAPE_INVALID')
    const vectors = points.map((entry, i) => {
      const result = vector(entry?.snapshot, name, 'SNAPSHOT', i)
      if (result) snapshots.push({ endedAt: entry.snapshot.endedAt, counts: result })
      return result
    })
    const segmentVectors = segments.map((entry, i) => {
      const result = vector(entry, name, 'SEGMENT', i)
      if (!vectors[i] || !vectors[i + 1] || !equal(result, subtract(vectors[i + 1], vectors[i]))) note(name, 'SEGMENT_CHECKPOINT_MISMATCH', i)
      return result
    })
    const total = vector(raw?.total, name, 'TOTAL')
    if (!vectors[0] || !vectors.at(-1) || !equal(total, subtract(vectors.at(-1), vectors[0]))) note(name, 'TOTAL_CHECKPOINT_MISMATCH')
    const segmentSum = segmentVectors.every(Boolean)
      ? Object.fromEntries(OPERATIONS.map(key => [key, segmentVectors.reduce((n, entry) => n + entry[key], 0)])) : null
    if (!equal(total, segmentSum)) note(name, 'TOTAL_SEGMENT_MISMATCH')
    if (base.queryCounts.windows[name]?.valid !== true) note(name, 'BASE_WINDOW_INVALID')
    windows[name] = { queryCalls: count(raw?.total?.queryCalls) ? raw.total.queryCalls : null,
      snapshotCount: points.length, segmentCount: segments.length, valid: issues.length === startIssues,
      queryOperations: total, segments: segmentVectors.map((entry, index) => ({ index, queryOperations: entry })) }
  }
  const ordered = [...snapshots].sort((a, b) => a.endedAt - b.endedAt)
  const monotonic = ordered.length === 12 && ordered.every((entry, index) => index === 0
    || OPERATIONS.every(key => entry.counts[key] >= ordered[index - 1].counts[key]))
  if (!monotonic) note(null, 'CUMULATIVE_OPERATIONS_INVALID')
  const integrity = base.queryCounts.integrity
  const baseValid = [integrity.pidConsistent, integrity.processStartConsistent, integrity.runtimeConsistent,
    integrity.cumulativeQueriesNondecreasing, integrity.unknownReadingsAllZero].every(value => value === true)
  if (!baseValid) note(null, 'BASE_COUNTER_INTEGRITY_UNCONFIRMED')
  const diff = (first, second, key) => windows[first].valid && windows[second].valid && baseValid && monotonic
    ? windows[first].queryOperations[key] - windows[second].queryOperations[key] : null
  const rows = OPERATIONS.map(operation => ({ operation,
    ...Object.fromEntries(WINDOWS.map(window => [window, windows[window].valid ? windows[window].queryOperations[operation] : null])),
    loginDifference: diff('nativeLogin', 'webLogin', operation),
    startupDifference: diff('startup-bundled', 'startup-hosted', operation) }))
  const differenceSum = key => rows.every(row => row[key] !== null) ? rows.reduce((n, row) => n + row[key], 0) : null
  const comparisons = Object.fromEntries([
    ['loginNativeVsWeb', 'loginDifference'], ['startupBundledVsHosted', 'startupDifference'],
  ].map(([name, key]) => {
    const original = base.queryCounts.comparisons[name], actual = differenceSum(key)
    if (actual !== null && actual !== original.difference) note(null, 'COMPARISON_TOTAL_MISMATCH')
    return [name, { originalDifference: original.difference, operationDifference: actual,
      partitionMatchesOriginal: actual === null ? null : actual === original.difference,
      firstNotAboveSecond: original.firstNotAboveSecond }]
  }))
  return { version: 1, kind: 'desktop_query_operations_projection', source: base.source,
    scope: 'whole_primary_api_process', subtractPkceOrBackground: false, startupScope: 'first_pair_only',
    expected: { windows: 4, snapshots: 12, segments: 8, totals: 4, operationKeys: 17 },
    integrity: { ...integrity, cumulativeOperationsNondecreasing: monotonic }, windows, rows, comparisons,
    valid: issues.length === 0, issues, productionAcceptance: null }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, source, harnessRevision, harnessSha256, output] = process.argv.slice(2)
    if (process.argv.length !== 7) throw new Error('ARGUMENTS_INVALID')
    const input = readReports(directory), base = summarize(input.reports, { source, harnessRevision, harnessSha256 })
    const projection = projectOperations(input.reports['lifecycle.json'], base)
    projection.files = input.files
    const bytes = Buffer.from(JSON.stringify(projection, null, 2) + '\n')
    fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ status: projection.valid ? 'valid' : 'incomplete', issues: projection.issues,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), comparisons: projection.comparisons }))
    if (!projection.valid) process.exitCode = 1
  } catch { console.error(JSON.stringify({ status: 'invalid', code: 'OPERATIONS_PROJECTION_FAILED' })); process.exitCode = 1 }
}
