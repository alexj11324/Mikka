// Isolated harness only. Never retain SQL text, parameters or request content.
const { createHash } = require('node:crypto')
const { types } = require('node:util')
const operations = require('./db-query-operations.cjs')
const sources = require('./db-query-unattributed-sources.cjs')
const scopeKeys = Object.freeze([...new Set([...operations, ...sources])])
const scopedNames = new Set(scopeKeys.filter(value => !['unattributed', 'otherScoped', 'noScope'].includes(value)))
const routes = new Set(scopeKeys.filter(value => value.startsWith('/api/') || value.startsWith('/v1/')))
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const actions = new Set(['desktop.session', 'desktop.bootstrap', 'desktop.readBatch', 'workspace.switchWorkspace',
  'execution-settings.getBotModelMenu', 'preferences.getPreferences', 'agents.listDevices',
  'bots.pollBots', 'issues.syncIssueList', 'projects.listProjects', 'teams.listTeams', 'team-relations.listProjectTeams',
  'task-runs.pollTaskRuns', 'task-runs.syncThreadList', 'coordinator.pollBotChatSummaries', 'coordinator.syncCoordinatorChat'])
const commands = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'BEGIN', 'COMMIT', 'ROLLBACK'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LIMITS = Object.freeze({ queries: 8192, contexts: 2048, statements: 512, sqlChars: 32768, bytes: 2 * 1024 * 1024 })
const diagnosticReasons = new Set(['registry_unavailable', 'registry_invalid', 'context_ambiguous', 'context_invalid',
  'context_read_failed', 'context_missing', 'context_limit', 'statement_limit', 'statement_missing', 'statement_size',
  'statement_syntax', 'statement_proxy', 'statement_read_failed', 'diagnostic_failed'])
const unknown = () => ({ status: 'unknown' })
const integer = value => Number.isSafeInteger(value) && value >= 0

function projectContext(value) {
  if (!value) return null
  const { httpInvocationId, invocationId, route, method, rpcAction } = value
  if (typeof httpInvocationId !== 'string' || typeof invocationId !== 'string' || !UUID.test(httpInvocationId) || !UUID.test(invocationId)
    || !routes.has(route) || !methods.has(method) || (rpcAction !== null && !actions.has(rpcAction))
    || (invocationId !== httpInvocationId && rpcAction === null)) return null
  return { status: 'known', httpInvocationId, invocationId, route, method, rpcAction }
}

function readContext(globals = globalThis) {
  const readers = globals[Symbol.for('mikka.requestDiagnosticReaders')]
  if (!(readers instanceof Set) || readers.size < 1 || readers.size > 16) return { reason: 'registry_unavailable' }
  let found
  try {
    for (const reader of readers) {
      if (typeof reader !== 'function') return { reason: 'registry_invalid' }
      const value = reader()
      if (value === undefined) continue
      if (found) return { reason: 'context_ambiguous' }
      found = projectContext(value)
      if (!found) return { reason: 'context_invalid' }
    }
  } catch { return { reason: 'context_read_failed' } }
  return found ? { value: found } : { reason: 'context_missing' }
}

// SHA256/12 is the existing statementId format, but its input here is a
// literal-free structure. It is NOT the production raw-text statement ID.
// This deliberately supports only a small common SQL subset, not a parser.
function statementStructure(first) {
  if (types.isProxy(first)) return { reason: 'statement_proxy' }
  let text
  try { text = typeof first === 'string' ? first : first && Object.getOwnPropertyDescriptor(first, 'text')?.value }
  catch { return { reason: 'statement_read_failed' } }
  if (typeof text !== 'string') return { reason: 'statement_missing' }
  if (!text.length || text.length > LIMITS.sqlChars) return { reason: 'statement_size' }
  if (/'|--|\/\*|\*\/|\\|\$(?:[A-Za-z_]\w*)?\$|[^\x20-\x7e\r\n\t]/.test(text)) return { reason: 'statement_syntax' }
  // Reject unusual quoted identifiers rather than interpreting escapes or
  // treating a literal inside an identifier as safe SQL text.
  let invalid = false
  const normalized = text.replace(/"(?:[^"]|"")*"/g, token => {
    if (!/^"[A-Za-z_][A-Za-z_0-9]*"$/.test(token)) invalid = true
    return token
  })
  if (invalid || (normalized.match(/"/g)?.length ?? 0) % 2) return { reason: 'statement_syntax' }
  if (/(?:^|[^\w$])(?:0[xob][0-9a-f_]+|\d[\d_]*_\d)/i.test(normalized)) return { reason: 'statement_syntax' }
  const canonical = normalized.replace(/(?<![$\w"])-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?\b/g, '?').replace(/\s+/g, ' ').trim().replace(/;$/, '').trim()
  const command = /^[A-Za-z]+/.exec(canonical)?.[0].toUpperCase()
  if (!commands.has(command) || canonical.includes(';') || /\$(?![1-9][0-9]*\b)/.test(canonical)
    || (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(command) && canonical.toUpperCase() !== command)) return { reason: 'statement_syntax' }
  const parameters = [...canonical.matchAll(/\$([1-9][0-9]*)\b/g)].map(match => Number(match[1]))
  if (parameters.some(value => value > 65535)) return { reason: 'statement_syntax' }
  return { value: { status: 'known', normalizedStructureId: createHash('sha256').update(canonical).digest('hex').slice(0, 12),
    command, parameterCount: new Set(parameters).size } }
}

function createQueryDiagnostics({ globals = globalThis, limits = LIMITS } = {}) {
  let active = false, finished = false, startQueryCalls = null, endQueryCalls = null, droppedQueries = 0
  let contexts = [unknown()], statements = [unknown()], queries = [], reasons = {}
  let contextIds = new Map(), statementIds = new Map()
  const reason = key => { reasons[key] = (reasons[key] ?? 0) + 1 }
  const intern = (table, ids, value, maximum, overflow) => {
    const key = JSON.stringify(value)
    if (ids.has(key)) return ids.get(key)
    if (table.length >= maximum) { reason(overflow); return 0 }
    const id = table.length; table.push(value); ids.set(key, id); return id
  }
  return {
    checkpoint(sequence) { if (!active && !finished) { active = true; startQueryCalls = endQueryCalls = sequence } },
    reset() {
      active = finished = false; startQueryCalls = endQueryCalls = null; droppedQueries = 0
      contexts = [unknown()]; statements = [unknown()]; queries = []; reasons = {}; contextIds = new Map(); statementIds = new Map()
    },
    record(sequence, first, operation) {
      if (!active) return
      endQueryCalls = sequence
      if (queries.length >= limits.queries) { droppedQueries++; return }
      let contextId = 0, statementId = 0
      const scope = scopeKeys.indexOf(operation == null ? 'noScope' : scopedNames.has(operation) ? operation : 'otherScoped')
      try {
        const context = readContext(globals)
        if (context.value) contextId = intern(contexts, contextIds, context.value, limits.contexts, 'context_limit')
        else reason(context.reason)
      } catch { reason('context_read_failed') }
      try {
        const statement = statementStructure(first)
        if (statement.value) statementId = intern(statements, statementIds, statement.value, limits.statements, 'statement_limit')
        else reason(statement.reason)
      } catch { reason('diagnostic_failed') }
      queries.push([sequence, contextId, statementId, scope])
    },
    finish(identity, sequence) {
      if (!finished) { active = false; finished = true; if (startQueryCalls !== null) endQueryCalls = sequence }
      return { version: 1, ...identity, startQueryCalls, endQueryCalls, droppedQueries,
        overflow: droppedQueries > 0 || Boolean(reasons.context_limit || reasons.statement_limit),
        reasons: { ...reasons }, contexts, statements, queries }
    },
  }
}

const unavailable = reason => ({ version: 1, status: 'unavailable', reasons: [reason] })
const phases = {
  nativeLogin: ['before', 'common-email-authentication', 'native-pkce-and-automatic-renderer-to-public-session', 'workspace-selection-to-usable'],
  webLogin: ['before', 'common-email-authentication', 'web-navigation-to-dom-content-loaded', 'workspace-selection-to-usable'],
  'startup-bundled': ['before', 'launch-to-usable'], 'startup-hosted': ['before', 'launch-to-usable'],
}

// Read the already-existing completion log once. Only identities referenced by
// captured queries and their batch siblings are selected; no mixed log escapes.
function invocationReceipts(text, contexts) {
  const parents = new Set(contexts.filter(value => value.status === 'known').map(value => value.httpInvocationId))
  const entries = new Map(), reasons = new Set()
  for (const line of text.split('\n')) {
    let value
    try { value = JSON.parse(line) } catch { continue }
    const logical = ['rpc_action_started', 'rpc_action'].includes(value?.msg)
    if (!logical && !['api_request_started', 'api_request'].includes(value?.msg)) continue
    if (!parents.has(logical ? value.httpInvocationId : value.invocationId)) continue
    const complete = ['api_request', 'rpc_action'].includes(value.msg)
    const context = projectContext({ ...value, httpInvocationId: logical ? value.httpInvocationId : value.invocationId,
      rpcAction: value.rpcAction ?? null })
    const timestamp = value.timestamp
    if (!context || typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
      || !Number.isFinite(Date.parse(timestamp)) || (complete && (!Number.isInteger(value.status) || value.status < 100 || value.status > 599))) {
      reasons.add('receipt_invalid'); continue
    }
    if (!entries.has(value.invocationId) && entries.size >= LIMITS.contexts * 2) { reasons.add('receipt_limit'); continue }
    const entry = entries.get(value.invocationId) ?? { ...context }
    if (entry.httpInvocationId !== context.httpInvocationId || entry.route !== context.route || entry.method !== context.method
      || (logical && entry.rpcAction !== context.rpcAction)) entry.conflict = true
    const field = complete ? 'completedAt' : 'startedAt'
    const itemCount = integer(value.rpcItemCount) && value.rpcItemCount <= 16 ? value.rpcItemCount : undefined
    if (entry[field] && (entry[field] !== timestamp || (complete && (entry.httpStatus !== value.status
      || entry.rpcAction !== context.rpcAction || entry.rpcItemCount !== itemCount)))) entry.conflict = true
    entry[field] = timestamp
    if (complete) {
      entry.httpStatus = value.status; entry.rpcAction = context.rpcAction
      if (itemCount !== undefined) entry.rpcItemCount = itemCount
    }
    entries.set(value.invocationId, entry)
  }
  for (const value of entries.values()) {
    if (value.conflict || (value.startedAt && value.completedAt && value.startedAt > value.completedAt)) reasons.add('receipt_conflict')
    if (!value.startedAt || !value.completedAt) reasons.add('receipt_unpaired')
    if (value.invocationId !== value.httpInvocationId) {
      const parent = entries.get(value.httpInvocationId)
      if (!parent || parent.route !== value.route || parent.method !== value.method
        || parent.rpcAction !== 'desktop.readBatch' || !parent.startedAt || !parent.completedAt
        || value.startedAt < parent.startedAt || value.completedAt > parent.completedAt) reasons.add('receipt_parent_mismatch')
    } else if (value.rpcAction === 'desktop.readBatch') {
      if (value.rpcItemCount !== [...entries.values()].filter(child => child.invocationId !== child.httpInvocationId && child.httpInvocationId === value.invocationId).length) reasons.add('receipt_batch_count')
    }
  }
  let unmatchedQueryContexts = 0
  for (const value of contexts.filter(value => value.status === 'known')) {
    const entry = entries.get(value.invocationId)
    if (!entry || entry.httpInvocationId !== value.httpInvocationId || entry.route !== value.route || entry.method !== value.method
      || (value.rpcAction !== null && value.rpcAction !== entry.rpcAction)) {
      unmatchedQueryContexts++; reasons.add('query_receipt_mismatch')
    }
  }
  return { status: reasons.size ? 'incomplete' : 'complete', reasons: [...reasons], unmatchedQueryContexts,
    unpairedInvocations: [...entries.values()].filter(value => !value.startedAt || !value.completedAt).length,
    conflictingInvocations: [...entries.values()].filter(value => value.conflict).length, invocations: [...entries.values()] }
}

function projectQueryDiagnostics(raw, windows, expected, log = '') {
  if (!raw || raw.version !== 1 || raw.pid !== expected.pid || raw.runtime !== expected.runtime || !integer(raw.startedAt)
    || !integer(raw.startQueryCalls) || !integer(raw.endQueryCalls) || raw.endQueryCalls < raw.startQueryCalls
    || !integer(raw.droppedQueries) || !Array.isArray(raw.queries) || raw.queries.length > LIMITS.queries
    || raw.queries.length + raw.droppedQueries !== raw.endQueryCalls - raw.startQueryCalls
    || !Array.isArray(raw.contexts) || raw.contexts.length < 1 || raw.contexts.length > LIMITS.contexts
    || !Array.isArray(raw.statements) || raw.statements.length < 1 || raw.statements.length > LIMITS.statements
    || !raw.reasons || typeof raw.reasons !== 'object' || Array.isArray(raw.reasons)
    || Object.entries(raw.reasons).some(([key, value]) => !diagnosticReasons.has(key) || !integer(value))
    || typeof raw.overflow !== 'boolean' || raw.overflow !== (raw.droppedQueries > 0 || Boolean(raw.reasons.context_limit || raw.reasons.statement_limit))) return unavailable('diagnostic_payload_invalid')
  const contexts = raw.contexts.map((value, index) => index === 0 && value?.status === 'unknown' ? unknown()
    : value?.status === 'known' ? projectContext(value) : null)
  const statements = raw.statements.map((value, index) => {
    if (index === 0 && value?.status === 'unknown') return unknown()
    const { status, normalizedStructureId, command, parameterCount } = value ?? {}
    return status === 'known' && typeof normalizedStructureId === 'string' && /^[a-f0-9]{12}$/.test(normalizedStructureId) && commands.has(command)
      && integer(parameterCount) && parameterCount <= 65535
      ? { status: 'known', normalizedStructureId, command, parameterCount } : null
  })
  if (contexts.includes(null) || statements.includes(null) || raw.queries.some((row, index) => !Array.isArray(row) || row.length !== 4
    || !row.every(integer) || row[0] !== raw.startQueryCalls + index + 1 || row[1] >= contexts.length || row[2] >= statements.length
    || row[3] >= scopeKeys.length || scopeKeys[row[3]] === 'unattributed')) return unavailable('diagnostic_payload_invalid')
  const selected = [], measured = {}
  for (const [name, names] of Object.entries(phases)) {
    const window = windows[name], points = window?.checkpoints
    if (window?.status !== 'complete' || !Array.isArray(points) || points.length !== names.length || points.some((point, index) =>
      point.phase !== names[index] || point.snapshot?.pid !== raw.pid || point.snapshot?.runtime !== raw.runtime
      || point.snapshot?.startedAt !== raw.startedAt || !integer(point.snapshot?.queryCalls)
      || (index && point.snapshot.queryCalls < points[index - 1].snapshot.queryCalls))) {
      measured[name] = { status: 'unavailable', reasons: ['query_checkpoints_invalid'] }; continue
    }
    const from = points[0].snapshot.queryCalls, to = points.at(-1).snapshot.queryCalls
    const rows = raw.queries.filter(row => row[0] > from && row[0] <= to)
    const unknownContextQueries = rows.filter(row => !row[1]).length, unknownStatementQueries = rows.filter(row => !row[2]).length
    const uncapturedQueries = to - from - rows.length
    const reasons = []
    if (from < raw.startQueryCalls || to > raw.endQueryCalls || uncapturedQueries) reasons.push('query_capture_incomplete')
    if (unknownContextQueries) reasons.push('query_context_unknown')
    if (unknownStatementQueries) reasons.push('statement_structure_unknown')
    const counts = Object.fromEntries(operations.map(key => [key, 0])), sourceCounts = Object.fromEntries(sources.map(key => [key, 0]))
    for (const row of rows) {
      const scope = scopeKeys[row[3]], operation = operations.includes(scope) ? scope : 'unattributed'
      counts[operation]++
      if (operation === 'unattributed') sourceCounts[scope]++
    }
    if (!uncapturedQueries && points[0].snapshot.queryOperations && points.at(-1).snapshot.queryOperations
      && operations.some(key => counts[key] !== points.at(-1).snapshot.queryOperations[key] - points[0].snapshot.queryOperations[key])) reasons.push('operation_counter_mismatch')
    if (!uncapturedQueries && points[0].snapshot.unattributedSources && points.at(-1).snapshot.unattributedSources
      && sources.some(key => sourceCounts[key] !== points.at(-1).snapshot.unattributedSources[key] - points[0].snapshot.unattributedSources[key])) reasons.push('source_counter_mismatch')
    selected.push(...rows)
    measured[name] = { status: reasons.length ? 'incomplete' : 'complete', reasons, fromQueryCalls: from, toQueryCalls: to,
      expectedQueries: to - from, capturedQueries: rows.length, uncapturedQueries, unknownContextQueries, unknownStatementQueries,
      segments: points.slice(1).map((point, index) => ({ phase: point.phase, fromQueryCalls: points[index].snapshot.queryCalls, toQueryCalls: point.snapshot.queryCalls })),
      queries: rows.map(row => [...row]) }
  }
  const used = new Set(selected.map(row => row[1]).filter(Boolean))
  const receipts = invocationReceipts(log, contexts.filter((_, index) => used.has(index)))
  return { version: 1, status: !raw.overflow && Object.values(measured).every(value => value.status === 'complete') && receipts.status === 'complete' ? 'complete' : 'incomplete',
    source: { pid: raw.pid, runtime: raw.runtime, startedAt: raw.startedAt },
    boundary: 'SQL calls belong to (before.queryCalls, after.queryCalls]; completion times never choose a SQL window. IDs show ALS origin, including inherited background work; a captured null action is never backfilled. Structure equality proves neither equal parameters nor redundant work.',
    columns: ['queryCalls', 'context', 'statement', 'scope'], scopeKeys, contexts, statements,
    capture: { fromQueryCalls: raw.startQueryCalls, toQueryCalls: raw.endQueryCalls, droppedQueries: raw.droppedQueries,
      overflow: raw.droppedQueries > 0 || Boolean(raw.overflow), reasons: { ...raw.reasons } }, receipts, windows: measured }
}

module.exports = { LIMITS, scopeKeys, readContext, statementStructure, createQueryDiagnostics, projectQueryDiagnostics }
