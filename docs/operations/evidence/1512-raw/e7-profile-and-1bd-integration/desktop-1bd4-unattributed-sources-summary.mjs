import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { OPERATIONS } from './desktop-query-operations-summary.mjs'

// Frozen vocabulary of the test-only counter. Do not retain arbitrary labels.
export const SOURCES = Object.freeze([
  "/api/agent/sessions",
  "/api/computer/events",
  "/api/conversations",
  "/api/pending-actions",
  "/api/settings/preferences",
  "/api/settings/model-order",
  "/api/settings/[read]",
  "/api/devices/enrollment",
  "/api/coordinator/messages",
  "/api/coordinator/stream",
  "/api/coordinator/runtime",
  "/api/coordinator/attention",
  "/api/teams/directory",
  "/api/teams/[teamId]/members",
  "/api/integrations/composio",
  "/api/frontend/oauth-consent",
  "/pages/workspace",
  "/pages/settings",
  "/v1/devices/enroll",
  "/v1/devices/register",
  "/v1/devices/[deviceId]/commands",
  "/v1/devices/[deviceId]/commands/ack",
  "/v1/devices/[deviceId]/computer",
  "/v1/devices/[deviceId]/coordinator",
  "/v1/devices/[deviceId]/fs/requests",
  "/v1/devices/[deviceId]/fs/requests/[requestId]",
  "/v1/devices/[deviceId]/gateway",
  "/v1/devices/[deviceId]/github-token",
  "/v1/devices/[deviceId]/heartbeat",
  "/v1/devices/[deviceId]/repos",
  "/v1/devices/[deviceId]/runs",
  "/v1/devices/[deviceId]/runs/[runId]/attachments/[id]",
  "/v1/devices/[deviceId]/runs/[runId]/claim",
  "/v1/devices/[deviceId]/runs/[runId]/computer-authority",
  "/v1/devices/[deviceId]/runs/[runId]/credentials/login",
  "/v1/devices/[deviceId]/runs/[runId]/subscription-lease",
  "/v1/devices/[deviceId]/runs/[runId]/subscription",
  "/v1/runs/[runId]",
  "/v1/runs/[runId]/captures",
  "/v1/runs/[runId]/captures/[captureId]",
  "/v1/runs/[runId]/captures/[captureId]/complete",
  "/v1/runs/[runId]/checkpoint",
  "/v1/runs/[runId]/complete",
  "/v1/runs/[runId]/decision",
  "/v1/runs/[runId]/events",
  "/v1/runs/[runId]/policy-snapshot",
  "/v1/runs/[runId]/screen",
  "/v1/runs/[runId]/skill-receipt",
  "/v1/runs/[runId]/tool-approval",
  "after:agent-images.revalidate",
  "after:auth-email",
  "after:composio-triggers",
  "after:composio-webhook",
  "after:coordinator-wake",
  "after:device-wake",
  "after:due-timer",
  "after:factory-dispatch-recovery",
  "after:github-webhook",
  "after:group-turn",
  "after:issue-effects",
  "after:linear-issue-sync",
  "after:linear-sync-batch",
  "after:linear-webhook",
  "after:linear-webhook-suggestions",
  "after:live-notify",
  "after:record-time-zone",
  "after:remember-locale",
  "after:run-outcome-judge",
  "after:short-title",
  "after:stop-recordings",
  "after:subagent-start",
  "after:suggestions-bootstrap",
  "after:workflow-wake",
  "otherScoped",
  "noScope",
])
export const PHASES = Object.freeze({
  nativeLogin: ['common-email-authentication', 'native-pkce-and-automatic-renderer-to-public-session', 'workspace-selection-to-usable'],
  webLogin: ['common-email-authentication', 'web-navigation-to-dom-content-loaded', 'workspace-selection-to-usable'],
  'startup-bundled': ['launch-to-usable'], 'startup-hosted': ['launch-to-usable'],
})
const WINDOWS = Object.keys(PHASES)
const count = value => Number.isSafeInteger(value) && value >= 0
const safeCount = value => count(value) ? value : null
const sum = values => values.reduce((a, b) => a + b, 0)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
const vector = (value, keys, total) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && count(value[key]))
  && count(total) && sum(keys.map(key => value[key])) === total ? Object.fromEntries(keys.map(key => [key, value[key]])) : null
const equalDelta = (row, before, after, keys) => row && before && after && keys.every(key => row[key] === after[key] - before[key])
const nonzero = value => value ? SOURCES.filter(source => value[source] !== 0).map(source => ({ source, queryCalls: value[source] })) : null

export function summarizeUnattributed(lifecycle, expectedSource) {
  if (!/^[a-f0-9]{40}$/.test(expectedSource ?? '')) fail('EXPECTED_SOURCE_INVALID')
  if (lifecycle?.version !== 1 || lifecycle.revision !== expectedSource
    || lifecycle.renderers?.bundled?.revision !== expectedSource || lifecycle.renderers?.hosted?.revision !== expectedSource) fail('SOURCE_IDENTITY_MISMATCH')
  const q = lifecycle.queryCounts
  if (!q || q.version !== 1 || q.source?.revision !== expectedSource) fail('COUNTER_SOURCE_MISMATCH')
  const issues = [], snapshots = [], windows = {}, internals = {}
  let sourcePresence = 0, sourceRows = 0, snapshotCount = 0, segmentCount = 0, totalCount = 0
  const note = (category, window, code, kind, index) => issues.push({ category, window, code, ...(kind ? { kind } : {}), ...(index === undefined ? {} : { index }) })
  const row = (value, window, kind, index) => {
    const operations = vector(value?.queryOperations, OPERATIONS, value?.queryCalls)
    if (!operations || value?.unknownReadings !== 0) note('base', window, 'ORIGINAL_PARTITION_INVALID', kind, index)
    sourceRows++
    const present = value && Object.hasOwn(value, 'unattributedSources')
    if (present) sourcePresence++
    const sources = present ? vector(value.unattributedSources, SOURCES, operations?.unattributed) : null
    if (!sources) note('sources', window, present ? 'SOURCE_PARTITION_INVALID' : 'SOURCE_PARTITION_UNAVAILABLE', kind, index)
    return { queryCalls: safeCount(value?.queryCalls), unattributed: operations?.unattributed ?? null, operations, sources }
  }
  if (!q.windows || Object.keys(q.windows).length !== WINDOWS.length || !WINDOWS.every(key => Object.hasOwn(q.windows, key))) note('base', null, 'WINDOW_SET_INVALID')
  for (const window of WINDOWS) {
    const raw = q.windows?.[window], phases = PHASES[window], startIssues = issues.length
    const checkpoints = Array.isArray(raw?.checkpoints) ? raw.checkpoints : []
    const segments = Array.isArray(raw?.segments) ? raw.segments : []
    if (raw?.status !== 'complete' || raw.phase !== (window.startsWith('startup-') ? 'authenticated-launch-to-usable-workspace' : 'ordinary-login-to-usable-workspace')
      || window.startsWith('startup-') && raw.pair !== 1) note('base', window, 'WINDOW_INVALID')
    if (checkpoints.length !== phases.length + 1 || segments.length !== phases.length) note('base', window, 'WINDOW_SHAPE_INVALID')
    const points = checkpoints.slice(0, phases.length + 1).map((entry, index) => {
      snapshotCount++
      const value = entry?.snapshot, result = row(value, window, 'snapshot', index)
      if (entry?.phase !== (index === 0 ? 'before' : phases[index - 1]) || value?.version !== 1
        || !['pid', 'startedAt', 'endedAt', 'instrumentedClients', 'queryCalls', 'pgProtocolReceiveBytes', 'pgProtocolSendBytes',
          'activeConnections', 'closedConnections', 'unknownReadings'].every(key => count(value?.[key]))
        || value.pid <= 0 || value.instrumentedClients < 1 || value.endedAt < value.startedAt) note('base', window, 'SNAPSHOT_INVALID', 'snapshot', index)
      const point = { ...result, pid: value?.pid, runtime: value?.runtime, startedAt: value?.startedAt, endedAt: value?.endedAt }
      snapshots.push(point)
      return point
    })
    const deltaRow = (value, before, after, kind, index) => {
      const result = row(value, window, kind, index)
      if (!before || !after || result.queryCalls !== after.queryCalls - before.queryCalls
        || timestamp(value?.startedAt) !== before.endedAt || timestamp(value?.finishedAt) !== after.endedAt
        || !count(value?.durationMs) || value.durationMs !== after.endedAt - before.endedAt
        || !equalDelta(result.operations, before.operations, after.operations, OPERATIONS)) note('base', window, 'DELTA_CHECKPOINT_MISMATCH', kind, index)
      if (result.sources && !equalDelta(result.sources, before?.sources, after?.sources, SOURCES)) note('sources', window, 'SOURCE_DELTA_MISMATCH', kind, index)
      return result
    }
    const measuredSegments = phases.map((phase, index) => {
      segmentCount++
      const value = segments[index]
      if (value?.phase !== phase) note('base', window, 'SEGMENT_PHASE_INVALID', 'segment', index)
      return { phase, ...deltaRow(value, points[index], points[index + 1], 'segment', index) }
    })
    totalCount++
    const total = deltaRow(raw?.total, points[0], points.at(-1), 'total')
    if (total.queryCalls !== sum(measuredSegments.map(x => x.queryCalls ?? NaN))
      || !total.operations || OPERATIONS.some(key => total.operations[key] !== sum(measuredSegments.map(x => x.operations?.[key] ?? NaN)))) note('base', window, 'TOTAL_SEGMENTS_MISMATCH')
    if (total.sources && SOURCES.some(key => total.sources[key] !== sum(measuredSegments.map(x => x.sources?.[key] ?? NaN)))) note('sources', window, 'SOURCE_TOTAL_SEGMENTS_MISMATCH')
    internals[window] = { total, segments: measuredSegments }
    windows[window] = { queryCalls: total.queryCalls, unattributed: total.unattributed,
      ...(window.startsWith('startup-') ? { pair: raw?.pair === 1 ? 1 : null } : {}),
      baseValid: !issues.slice(startIssues).some(x => x.category === 'base'),
      status: issues.length === startIssues ? 'complete' : 'incomplete',
      nonzeroSources: total.sources ? nonzero(total.sources) : null,
      segments: measuredSegments.map(({ phase, queryCalls, unattributed, sources }) => ({ phase, queryCalls, unattributed, nonzeroSources: nonzero(sources) })) }
  }
  const identity = snapshots.length === 12 && count(q.source.pid) && q.source.pid > 0 && ['nitro', 'next'].includes(q.source.runtime)
    && snapshots.every(point => point.pid === q.source.pid && point.runtime === q.source.runtime && point.startedAt === snapshots[0].startedAt)
  if (!identity) note('base', null, 'COUNTER_IDENTITY_INVALID')
  const ordered = [...snapshots].sort((a, b) => a.endedAt - b.endedAt)
  const monotonic = keys => ordered.length === 12 && ordered.every((point, index) => point[keys]
    && (index === 0 || Object.keys(point[keys]).every(key => point[keys][key] >= ordered[index - 1][keys]?.[key])))
  const originalMonotonic = monotonic('operations')
  if (!originalMonotonic) note('base', null, 'ORIGINAL_CUMULATIVE_DECREASE')
  const sourcesMonotonic = sourcePresence === sourceRows ? monotonic('sources') : null
  if (sourcesMonotonic === false) note('sources', null, 'SOURCE_CUMULATIVE_DECREASE')
  if (snapshotCount !== 12 || segmentCount !== 8 || totalCount !== 4) note('base', null, 'EVIDENCE_COUNTS_INVALID')
  const baseValid = !issues.some(issue => issue.category === 'base')
  const valid = issues.length === 0
  const status = valid ? 'complete' : baseValid && sourcePresence === 0 && sourceRows === 24 ? 'unavailable' : 'incomplete'
  // Never expose partial vectors as validated differences, or replace missing
  // legacy fields with zero. Original full totals remain available separately.
  for (const window of WINDOWS) {
    if (!valid) {
      windows[window].nonzeroSources = null
      for (const segment of windows[window].segments) segment.nonzeroSources = null
      if (status === 'unavailable') windows[window].status = 'unavailable'
    }
  }
  const compare = (first, second) => ({
    queryDifference: baseValid ? first.queryCalls - second.queryCalls : null,
    unattributedDifference: baseValid ? first.unattributed - second.unattributed : null,
    sources: valid ? SOURCES.filter(key => first.sources[key] !== 0 || second.sources[key] !== 0)
      .map(source => ({ source, first: first.sources[source], second: second.sources[source], difference: first.sources[source] - second.sources[source] })) : null,
    sourceDifferenceSum: valid ? sum(SOURCES.map(key => first.sources[key] - second.sources[key])) : null,
  })
  const comparisons = Object.fromEntries([
    ['loginNativeVsWeb', 'nativeLogin', 'webLogin'], ['startupBundledVsHosted', 'startup-bundled', 'startup-hosted'],
  ].map(([name, first, second]) => [name, { first, second, ...compare(internals[first].total, internals[second].total),
    segments: internals[first].segments.map((entry, index) => ({ firstPhase: entry.phase, secondPhase: internals[second].segments[index].phase,
      ...compare(entry, internals[second].segments[index]) })) }]))
  return { version: 1, kind: 'desktop_unattributed_sources_summary', status, valid, source: expectedSource,
    scope: 'whole_primary_api_process', subtractPkceOrBackground: false, startupScope: 'first_pair_only',
    vocabulary: { keys: 75, sourceFileSha256: '0eeb18be931fdc4d8ddb908dff9a0b4a94a6596a992fcc9a1c5fd635a935a0bb', keysSha256: sha(JSON.stringify(SOURCES)) },
    integrity: { baseValid, counterIdentityMatched: identity, snapshots: snapshotCount, segments: segmentCount, totals: totalCount,
      originalCumulativeNondecreasing: originalMonotonic, sourceCumulativeNondecreasing: sourcesMonotonic,
      refinementRowsPresent: sourcePresence, refinementRowsExpected: 24 },
    windows, comparisons, issues, productionAcceptance: null,
    limitations: ['Lifecycle revision is checked; checkout and harness identity require their separate artifact receipts.',
      'Closed source counts do not retain SQL, request bodies, IDs or arbitrary route values.',
      'Legacy missing refinement is unavailable, not zero; whole-window totals are never reduced.'] }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [input, source, output] = process.argv.slice(2)
    if (process.argv.length !== 5 || !input || !output) fail('ARGUMENTS_INVALID')
    const bytes = fs.readFileSync(input)
    if (bytes.length > 4 * 1024 * 1024) fail('REPORT_TOO_LARGE')
    let lifecycle
    try { lifecycle = JSON.parse(bytes) } catch { fail('REPORT_JSON_INVALID') }
    const result = summarizeUnattributed(lifecycle, source)
    result.input = { bytes: bytes.length, sha256: sha(bytes) }
    const encoded = Buffer.from(JSON.stringify(result, null, 2) + '\n')
    fs.writeFileSync(output, encoded, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ status: result.status, bytes: encoded.length, sha256: sha(encoded), source,
      integrity: result.integrity, productionAcceptance: null }))
    if (!result.valid) process.exitCode = result.status === 'unavailable' ? 2 : 1
  } catch (error) {
    const codes = ['EXPECTED_SOURCE_INVALID', 'SOURCE_IDENTITY_MISMATCH', 'COUNTER_SOURCE_MISMATCH', 'ARGUMENTS_INVALID', 'REPORT_TOO_LARGE', 'REPORT_JSON_INVALID']
    console.error(JSON.stringify({ status: 'invalid', code: codes.includes(error?.code) ? error.code : 'UNATTRIBUTED_SUMMARY_FAILED' }))
    process.exitCode = 1
  }
}
