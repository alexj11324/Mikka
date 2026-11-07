import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'

export const REPORTS = ['lifecycle.json', 'parity/parity.json', 'smoke.json', 'native-crypto.json', 'mac-acceptance-package.json']
const WINDOWS = ['nativeLogin', 'webLogin', 'startup-bundled', 'startup-hosted']
const PHASES = {
  nativeLogin: ['common-email-authentication', 'native-pkce-and-automatic-renderer-to-public-session', 'workspace-selection-to-usable'],
  webLogin: ['common-email-authentication', 'web-navigation-to-dom-content-loaded', 'workspace-selection-to-usable'],
  'startup-bundled': ['launch-to-usable'], 'startup-hosted': ['launch-to-usable'],
}
const ACTIONS = new Set(['bots.pollBots', 'coordinator.pollBotChatSummaries', 'coordinator.syncCoordinatorChat',
  'desktop.bootstrap', 'desktop.readBatch', 'desktop.session', 'execution-settings.getBotModelMenu',
  'issues.syncIssueList', 'projects.listProjects', 'task-runs.pollTaskRuns', 'task-runs.syncThreadList',
  'team-relations.listProjectTeams', 'teams.listTeams'])
const ROUTES = ['/api/desktop/rpc', '/api/rpc']
const RPC_COUNTS = ['startedInWindow', 'completedInWindow', 'crossesStart', 'crossesEnd', 'completionNotObserved', 'completionWithoutStart']
const CLEANUP_STAGES = ['browser-close', 'electron-close', 'daemon-drain', 'native-resources', 'fixtures', 'workspace-generated-name', 'lease-release']
const RESOURCE_TABLES = ['desktop_auth_requests', 'device_token_devices', 'device_management_commands', 'device_repos', 'agents', 'device_tokens', 'device_enrollments', 'devices']
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const bool = value => typeof value === 'boolean' ? value : null
const label = (value, allowed) => allowed.includes(value) ? value : 'unknown'
const sha = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const sum = values => values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null
const delta = (a, b) => a !== null && b !== null ? a - b : null

export function readReports(directory) {
  const reports = {}, files = {}
  for (const name of REPORTS) {
    let bytes
    try { bytes = fs.readFileSync(path.join(directory, name)) } catch { fail('REPORT_READ_FAILED') }
    if (bytes.length > 4 * 1024 * 1024) fail('REPORT_TOO_LARGE')
    try { reports[name] = JSON.parse(bytes) } catch { fail('REPORT_JSON_INVALID') }
    files[name] = { bytes: bytes.length, sha256: sha(bytes) }
  }
  return { reports, files }
}

export function summarize(reports, expected) {
  if (!/^[a-f0-9]{40}$/.test(expected.source ?? '') || !/^[a-f0-9]{40}$/.test(expected.harnessRevision ?? '')
    || !/^[a-f0-9]{64}$/.test(expected.harnessSha256 ?? '')) fail('EXPECTED_IDENTITY_INVALID')
  const lifecycle = reports['lifecycle.json'], parity = reports['parity/parity.json'], smoke = reports['smoke.json']
  const crypto = reports['native-crypto.json'], pkg = reports['mac-acceptance-package.json']
  if (!REPORTS.every(name => reports[name]?.version === 1)) fail('REPORT_VERSION_INVALID')
  if (![lifecycle.revision, smoke.revision, crypto.revision, parity.appRevision,
    lifecycle.renderers?.bundled?.revision, lifecycle.renderers?.hosted?.revision].every(value => value === expected.source)) fail('SOURCE_IDENTITY_MISMATCH')
  if (parity.harnessRevision !== expected.harnessRevision || parity.harnessSha256 !== expected.harnessSha256) fail('HARNESS_IDENTITY_MISMATCH')
  if (!isDeepStrictEqual(crypto.package, pkg)) fail('PACKAGE_REPORT_MISMATCH')
  const issues = [], note = (code, window, kind) => issues.push({ code, ...(window ? { window } : {}), ...(kind ? { kind } : {}) })
  const q = lifecycle.queryCounts
  if (q?.source?.revision !== undefined && q.source.revision !== expected.source) fail('COUNTER_SOURCE_MISMATCH')
  if (!q || q.version !== 1 || q.source?.revision !== expected.source) note('COUNTER_SOURCE_UNAVAILABLE')
  const snapshots = [], windows = {}
  for (const name of WINDOWS) {
    const raw = q?.windows?.[name], phases = PHASES[name], checkpoints = raw?.checkpoints
    let valid = true
    const bad = code => { valid = false; note(code, name) }
    if (raw?.status !== 'complete') bad('WINDOW_INCOMPLETE')
    if (name.startsWith('startup-') && raw?.pair !== 1) bad('STARTUP_NOT_FIRST_PAIR')
    const expectedWindowPhase = name.startsWith('startup-') ? 'authenticated-launch-to-usable-workspace' : 'ordinary-login-to-usable-workspace'
    if (raw?.phase !== expectedWindowPhase) bad('WINDOW_PHASE_INVALID')
    if (!Array.isArray(checkpoints) || checkpoints.length !== phases.length + 1
      || !checkpoints.every((entry, index) => entry.phase === (index === 0 ? 'before' : phases[index - 1]))) bad('CHECKPOINTS_INCOMPLETE')
    const points = Array.isArray(checkpoints) ? checkpoints.map(entry => entry?.snapshot) : []
    snapshots.push(...points)
    const segments = phases.map((phase, index) => {
      const segment = raw?.segments?.[index], before = points[index], after = points[index + 1]
      const calls = count(segment?.queryCalls), unknown = count(segment?.unknownReadings)
      if (segment?.phase !== phase || calls === null || unknown !== 0) bad('SEGMENT_UNAVAILABLE')
      if (!before || !after || count(before.queryCalls) === null || count(after.queryCalls) === null
        || calls !== after.queryCalls - before.queryCalls
        || Date.parse(segment?.startedAt) !== before.endedAt || Date.parse(segment?.finishedAt) !== after.endedAt) bad('SEGMENT_CHECKPOINT_MISMATCH')
      return { phase, queryCalls: calls, unknownReadings: unknown }
    })
    if (!Array.isArray(raw?.segments) || raw.segments.length !== phases.length) bad('SEGMENTS_INCOMPLETE')
    const total = count(raw?.total?.queryCalls), unknown = count(raw?.total?.unknownReadings)
    if (total === null || unknown !== 0) bad('TOTAL_UNAVAILABLE')
    if (points.length !== phases.length + 1 || total !== delta(count(points.at(-1)?.queryCalls), count(points[0]?.queryCalls))
      || total !== sum(segments.map(segment => segment.queryCalls))
      || Date.parse(raw?.total?.startedAt) !== points[0]?.endedAt || Date.parse(raw?.total?.finishedAt) !== points.at(-1)?.endedAt) bad('TOTAL_CHECKPOINT_MISMATCH')
    windows[name] = { status: label(raw?.status, ['complete', 'incomplete']), queryCalls: total, unknownReadings: unknown,
      ...(name.startsWith('startup-') ? { pair: count(raw?.pair) } : {}), valid, segments }
  }
  const snapshotsKnown = snapshots.length === 12 && snapshots.every(s => s && ['pid', 'startedAt', 'endedAt', 'queryCalls', 'unknownReadings'].every(key => count(s[key]) !== null))
  const same = key => snapshotsKnown ? snapshots.every(s => s[key] === snapshots[0][key]) : null
  const ordered = snapshotsKnown ? [...snapshots].sort((a, b) => a.endedAt - b.endedAt) : []
  const integrity = { expectedCheckpointCount: 12, observedCheckpointCount: snapshots.length,
    pid: count(q?.source?.pid), pidConsistent: snapshotsKnown ? same('pid') && snapshots[0].pid === q?.source?.pid && q?.source?.pid > 0 : null,
    processStartConsistent: same('startedAt'), runtimeConsistent: snapshotsKnown ? snapshots.every(s => s.runtime === q?.source?.runtime) && ['next', 'nitro'].includes(q?.source?.runtime) : null,
    cumulativeQueriesNondecreasing: snapshotsKnown ? ordered.every((s, index) => index === 0 || s.queryCalls >= ordered[index - 1].queryCalls) : null,
    unknownReadingsAllZero: snapshotsKnown ? snapshots.every(s => s.unknownReadings === 0) : null }
  const consistent = snapshotsKnown && [integrity.pidConsistent, integrity.processStartConsistent, integrity.runtimeConsistent,
    integrity.cumulativeQueriesNondecreasing, integrity.unknownReadingsAllZero].every(value => value === true)
  if (!consistent) note('COUNTER_INTEGRITY_UNCONFIRMED')
  const compare = (a, b, login) => ({ first: windows[a].queryCalls, second: windows[b].queryCalls,
    difference: delta(windows[a].queryCalls, windows[b].queryCalls),
    firstNotAboveSecond: consistent && windows[a].valid && windows[b].valid && (!login || q?.login?.comparable === true)
      ? windows[a].queryCalls <= windows[b].queryCalls : null })

  const actionRows = (value, window, kind) => {
    if (!Array.isArray(value)) { note('RPC_ACTIONS_UNAVAILABLE', window, kind); return null }
    if (value.length > 128) { note('RPC_ACTIONS_OVERSIZED', window, kind); return null }
    return value.map(row => {
      const action = row?.rpcAction === null ? null : ACTIONS.has(row?.rpcAction) ? row.rpcAction : 'unknown'
      const route = label(row?.route, ROUTES)
      if (action === 'unknown' || route === 'unknown') note('RPC_LABEL_UNKNOWN', window, kind)
      const counts = Object.fromEntries(RPC_COUNTS.map(key => [key, count(row?.[key])]))
      if (Object.values(counts).includes(null)) note('RPC_COUNT_UNAVAILABLE', window, kind)
      const statuses = Array.isArray(row?.statusCounts) ? row.statusCounts.map(s => ({
        status: Number.isInteger(s.status) && s.status >= 100 && s.status <= 599 ? s.status : null, count: count(s.count),
      })) : null
      if (!statuses || statuses.some(s => s.status === null || s.count === null)) note('RPC_STATUS_UNAVAILABLE', window, kind)
      return { route, action, ...counts, statusCounts: statuses }
    })
  }
  const rpc = (raw, kind) => ({ status: label(raw?.status, ['complete', 'incomplete']),
    reportedReasonCount: Array.isArray(raw?.reasons) ? raw.reasons.length : null,
    duplicateRecords: count(raw?.duplicateRecords), conflictingInvocations: count(raw?.conflictingInvocations),
    windows: Object.fromEntries(WINDOWS.map(name => {
      const value = raw?.windows?.[name], actions = actionRows(value?.actions, name, kind)
      const complete = raw?.status === 'complete' && value?.status === 'complete'
      if (!complete) note('RPC_EVIDENCE_INCOMPLETE', name, kind)
      const totals = Object.fromEntries(RPC_COUNTS.map(key => [key, actions && complete ? sum(actions.map(row => row[key])) : null]))
      return [name, { status: label(value?.status, ['complete', 'incomplete']), totals, actions,
        segmentStatus: label(value?.segmentStatus, ['complete', 'incomplete']), segments: PHASES[name].map((phase, index) => ({ phase,
          actions: value?.segments?.[index]?.phase === phase ? actionRows(value.segments[index].actions, name, kind) : null })) }]
    })) })
  const checks = rows => Array.isArray(rows) ? { total: rows.length, passed: rows.filter(row => row.result === 'passed').length,
    failed: rows.filter(row => row.result === 'failed').length, unknown: rows.filter(row => !['passed', 'failed'].includes(row.result)).length } : null
  const cleanup = report => ({ result: label(report.cleanup, ['passed', 'failed']),
    stages: Array.isArray(report.cleanupStages) ? report.cleanupStages.map(stage => ({ stage: label(stage.stage, CLEANUP_STAGES), result: label(stage.result, ['passed', 'failed']) })) : null,
    nativeCleaned: bool(report.nativeCleanup?.cleaned), reportedResourceCounts: Object.fromEntries(RESOURCE_TABLES.map(key => [key, count(report.nativeCleanup?.counts?.[key])])),
    workspaceName: { captured: bool(report.workspaceNameCleanup?.captured), restored: bool(report.workspaceNameCleanup?.restored),
      ownerMatchesSealedBaseline: bool(report.workspaceNameCleanup?.ownerMatchesSealedBaseline), peerMatchesSealedBaseline: bool(report.workspaceNameCleanup?.peerMatchesSealedBaseline) },
    accountObservation: { observed: bool(report.accountObservation?.observed), state: label(report.accountObservation?.state, ['released', 'quarantined', 'blocked', 'leased']),
      blocked: report.accountObservation?.blockedReason === null ? false : typeof report.accountObservation?.blockedReason === 'string' ? true : null,
      ownerBeforeMatchesBaseline: bool(report.accountObservation?.owner?.matchesSealedBaselineBefore), ownerAfterMatchesBaseline: bool(report.accountObservation?.owner?.matchesSealedBaselineAfter),
      peerBeforeMatchesBaseline: bool(report.accountObservation?.peer?.matchesSealedBaselineBefore), peerAfterMatchesBaseline: bool(report.accountObservation?.peer?.matchesSealedBaselineAfter) } })
  const physical = rpc(q?.rpcActions, 'physical'), logical = rpc(q?.rpcActions?.logical, 'logical')
  const loginActionStarts = view => {
    const native = view.windows.nativeLogin, web = view.windows.webLogin
    if (view.status !== 'complete' || native.status !== 'complete' || web.status !== 'complete' || !native.actions || !web.actions) return null
    if ([...native.actions, ...web.actions].some(row => row.action === 'unknown' || row.route === 'unknown' || row.startedInWindow === null)) return null
    const names = new Set([...native.actions, ...web.actions].map(row => row.action))
    return [...names].map(action => {
      const total = rows => sum(rows.filter(row => row.action === action).map(row => row.startedInWindow))
      const n = total(native.actions), w = total(web.actions)
      return { action, native: n, web: w, difference: delta(n, w) }
    })
  }
  return { version: 1, kind: 'desktop_native_evidence_summary', source: { source: expected.source,
    harnessRevision: expected.harnessRevision, harnessSha256: expected.harnessSha256, identityMatched: true },
    queryCounts: { scope: 'whole_primary_api_process', subtractPkceOrBackground: false, startupScope: 'first_pair_only',
      loginComparableReported: bool(q?.login?.comparable), integrity, windows,
      comparisons: { loginNativeVsWeb: compare('nativeLogin', 'webLogin', true), startupBundledVsHosted: compare('startup-bundled', 'startup-hosted', false) },
      rpcActions: { measurement: 'HTTP_and_logical_action_counts_not_per_action_SQL', physical, logical,
        loginActionStartsAcrossRoutes: { physical: loginActionStarts(physical), logical: loginActionStarts(logical) } } },
    lifecycle: { result: label(lifecycle.result, ['passed', 'failed']), checks: checks(lifecycle.checks), cleanup: cleanup(lifecycle) },
    parity: { result: label(parity.result, ['passed', 'failed']), total: Array.isArray(parity.screens) ? parity.screens.length : null,
      passed: Array.isArray(parity.screens) ? parity.screens.filter(screen => screen.passed === true).length : null,
      pageErrorCount: Array.isArray(parity.pageErrors) ? parity.pageErrors.length : null, cleanup: cleanup(parity) },
    smoke: { result: label(smoke.result, ['passed', 'failed']), checks: checks(smoke.checks), cleanup: cleanup(smoke) },
    nativeCrypto: { passed: bool(crypto.passed), sameImmutablePackage: bool(crypto.sameImmutablePackage), distinctProcesses: count(crypto.distinctProcesses), cleanup: label(crypto.cleanup, ['passed', 'failed']) },
    package: { passed: bool(pkg.passed), signatureVerifiedStrictDeep: bool(pkg.signatureVerifiedStrictDeep) },
    issues: [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()], productionAcceptance: null }
}

export function comparison(current, previous) {
  if (previous?.version !== 1 || previous.kind !== 'desktop_native_evidence_summary' || !/^[a-f0-9]{40}$/.test(previous.source?.source ?? '')) fail('COMPARISON_SUMMARY_INVALID')
  const windows = Object.fromEntries(WINDOWS.map(name => [name, { previous: count(previous.queryCounts?.windows?.[name]?.queryCalls),
    current: count(current.queryCounts.windows[name].queryCalls), difference: delta(count(current.queryCounts.windows[name].queryCalls), count(previous.queryCounts?.windows?.[name]?.queryCalls)) }]))
  const actions = {}
  for (const kind of ['physical', 'logical']) actions[kind] = Object.fromEntries(WINDOWS.map(name => {
    const before = previous.queryCounts?.rpcActions?.[kind]?.windows?.[name], after = current.queryCounts.rpcActions[kind].windows[name]
    const byKey = rows => new Map(rows?.map(row => [JSON.stringify([row.route, row.action]), row]))
    const a = byKey(before?.actions), b = byKey(after.actions), rows = []
    if (Array.isArray(before?.actions) && Array.isArray(after.actions)) for (const key of new Set([...a.keys(), ...b.keys()])) {
      const old = a.get(key), next = b.get(key), row = next ?? old
      if (!ROUTES.includes(row.route) || row.action !== null && !ACTIONS.has(row.action)) continue
      const knownRows = rows => rows.every(value => ROUTES.includes(value.route) && (value.action === null || ACTIONS.has(value.action)) && count(value.startedInWindow) !== null)
      const complete = before.status === 'complete' && after.status === 'complete' && knownRows(before.actions) && knownRows(after.actions)
      const priorCount = old ? count(old.startedInWindow) : complete ? 0 : null, nextCount = next ? count(next.startedInWindow) : complete ? 0 : null
      rows.push({ route: row.route, action: row.action, previous: priorCount, current: nextCount, difference: delta(nextCount, priorCount) })
    }
    return [name, { startedDifference: delta(count(after.totals.startedInWindow), count(before?.totals?.startedInWindow)), actionStarts: rows }]
  }))
  return { previousSource: previous.source.source, currentSource: current.source.source, windows, actions, productionAcceptance: null }
}

function main(argv) {
  const allowed = new Set(['reports', 'source', 'harness-revision', 'harness-sha256', 'output', 'compare']), args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '')
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || !argv[i + 1] || Object.hasOwn(args, key)) fail('ARGUMENTS_INVALID')
    args[key] = argv[i + 1]
  }
  if (!['reports', 'source', 'harness-revision', 'harness-sha256', 'output'].every(key => args[key])) fail('ARGUMENTS_INVALID')
  const input = readReports(args.reports), result = summarize(input.reports, { source: args.source, harnessRevision: args['harness-revision'], harnessSha256: args['harness-sha256'] })
  result.files = input.files
  if (args.compare) {
    let bytes, prior
    try { bytes = fs.readFileSync(args.compare); prior = JSON.parse(bytes) } catch { fail('COMPARISON_READ_FAILED') }
    result.comparison = { fileSha256: sha(bytes), ...comparison(result, prior) }
  }
  const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n')
  try { fs.writeFileSync(args.output, bytes, { flag: 'wx', mode: 0o600 }) } catch { fail('OUTPUT_WRITE_FAILED') }
  console.log(JSON.stringify({ result: 'summarized', bytes: bytes.length, sha256: sha(bytes), source: result.source,
    comparisons: result.queryCounts.comparisons, issueCount: result.issues.length, productionAcceptance: null }))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) {
    const codes = ['REPORT_READ_FAILED', 'REPORT_TOO_LARGE', 'REPORT_JSON_INVALID', 'EXPECTED_IDENTITY_INVALID', 'REPORT_VERSION_INVALID',
      'SOURCE_IDENTITY_MISMATCH', 'HARNESS_IDENTITY_MISMATCH', 'PACKAGE_REPORT_MISMATCH', 'COUNTER_SOURCE_MISMATCH', 'COMPARISON_SUMMARY_INVALID',
      'ARGUMENTS_INVALID', 'COMPARISON_READ_FAILED', 'OUTPUT_WRITE_FAILED']
    console.error(JSON.stringify({ result: 'invalid', code: codes.includes(error?.code) ? error.code : 'SUMMARY_FAILED' }))
    process.exitCode = 1
  }
}
