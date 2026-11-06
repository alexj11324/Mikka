/** Content-free acceptance projections. Unknown keys never reach the report. */
const ENDPOINTS = new Set(['policy_snapshot', 'permission_check', 'permission_request', 'server_decision', 'computer_authority',
  'subscription_context', 'provider_proxy', 'credential_lease', 'credential_refresh', 'github_credential_lease', 'github_credential_refresh',
  'run_telemetry', 'device_control', 'run_control', 'task_data', 'mailbox_operation', 'storage_transfer', 'other_run_request'])
const PHASES = new Set(['preparing', 'executing', 'finishing'])
const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'other'])
const EVENTS = new Set(['claude_code.api_request', 'claude_code.api_error', 'claude_code.tool_result',
  'codex.api_request', 'codex.websocket_request', 'codex.tool_result'])
const ms = value => Number.isFinite(value) && value >= 0 && value <= 86_400_000
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
const epoch = value => Number.isSafeInteger(value) && value > 0
const outcome = value => ['ok', 'error', 'unknown'].includes(value)

export function readOfficialCliTiming(value, record) {
  if (value?.version !== 1 || value.source !== 'official_cli_otlp' || value.runIdHash !== record.runIdHash || value.harness !== record.harness
    || value.collection !== 'best_effort' || value.flush !== 'not_confirmed' || typeof value.cliExitObserved !== 'boolean'
    || typeof value.truncated !== 'boolean' || !epoch(value.startedAt) || !epoch(value.endedAt) || value.endedAt < value.startedAt
    || !['batches', 'recordsReceived', 'duplicates', 'rejectedBatches', 'invalidEvents', 'ignoredRecords'].every(key => count(value[key]))
    || !Array.isArray(value.events) || value.events.length > 256) return null
  const events = []
  for (const event of value.events) {
    if (!EVENTS.has(event?.name) || !event.name.startsWith(`${record.harness}.`) || !['provider', 'tool'].includes(event.kind)
      || event.kind !== (event.name.endsWith('.tool_result') ? 'tool' : 'provider') || !epoch(event.receivedAt)
      || !(event.eventAt === null || (Number.isFinite(event.eventAt) && event.eventAt > 0)) || !ms(event.durationMs)
      || ![null, 'claude-haiku-5-5', 'gpt-6-luna', 'other'].includes(event.model) || !outcome(event.outcome)
      || !(event.status === null || (Number.isInteger(event.status) && event.status >= 100 && event.status <= 599))
      || !(event.attempt === null || count(event.attempt)) || !(event.sequence === null || count(event.sequence))) return null
    events.push({ name: event.name, kind: event.kind, receivedAt: event.receivedAt, eventAt: event.eventAt,
      durationMs: event.durationMs, model: event.model, outcome: event.outcome, status: event.status, attempt: event.attempt, sequence: event.sequence })
  }
  return { version: 1, source: 'official_cli_otlp', runIdHash: value.runIdHash, harness: value.harness,
    startedAt: value.startedAt, endedAt: value.endedAt, collection: value.collection, flush: value.flush,
    cliExitObserved: value.cliExitObserved, batches: value.batches, recordsReceived: value.recordsReceived, duplicates: value.duplicates,
    rejectedBatches: value.rejectedBatches, invalidEvents: value.invalidEvents, ignoredRecords: value.ignoredRecords, truncated: value.truncated, events }
}

export function readRuntimeTiming(value, record) {
  if (value?.version !== 1 || value.source !== 'http_server_link' || value.window !== 'run_launch_to_agent_exit'
    || value.runIdHash !== record.runIdHash || value.harness !== record.harness || !/^[a-f0-9]{16}$/.test(value.runIdHash ?? '')
    || !['claude_code', 'codex'].includes(value.harness) || typeof value.complete !== 'boolean' || typeof value.truncated !== 'boolean'
    || !epoch(value.startedAt) || !epoch(value.endedAt) || value.endedAt < value.startedAt || !ms(value.ms)
    || !(value.executionStartMs === null || ms(value.executionStartMs)) || !(value.executionEndMs === null || ms(value.executionEndMs))
    || (value.executionStartMs !== null && value.executionEndMs !== null && value.executionEndMs < value.executionStartMs)
    || !['providerOutputChunks', 'toolCallsStarted', 'toolCallsCompleted', 'toolCallsFailed'].every(key => count(value[key]))
    || value.toolCallsCompleted > value.toolCallsStarted || value.toolCallsFailed > value.toolCallsCompleted
    || !Array.isArray(value.requests) || value.requests.length > 128 || !Array.isArray(value.counts) || value.counts.length > 114) return null
  const requests = [], counts = [], seen = new Set()
  for (const request of value.requests) {
    if (!ENDPOINTS.has(request?.endpoint) || !PHASES.has(request.phase) || !METHODS.has(request.method) || typeof request.shared !== 'boolean'
      || request.sequence !== requests.length + 1 || !ms(request.startMs) || request.startMs > value.ms + 0.01
      || !['ok', 'error', 'pending'].includes(request.outcome)
      || (request.outcome === 'pending' ? request.endMs !== null || request.ms !== null
        : !ms(request.endMs) || !ms(request.ms) || request.endMs < request.startMs || request.endMs > value.ms + 0.01
          || Math.abs(request.ms - (request.endMs - request.startMs)) > 0.01)) return null
    requests.push({ sequence: request.sequence, endpoint: request.endpoint, phase: request.phase, method: request.method, shared: request.shared,
      startMs: request.startMs, endMs: request.endMs, ms: request.ms, outcome: request.outcome })
  }
  for (const item of value.counts) {
    const key = `${item?.phase}:${item?.endpoint}:${item?.shared}`
    if (!ENDPOINTS.has(item?.endpoint) || !PHASES.has(item.phase) || typeof item.shared !== 'boolean' || seen.has(key)
      || !['started', 'completed', 'errors'].every(key => count(item[key])) || item.completed > item.started || item.errors > item.completed || !ms(item.ms)) return null
    seen.add(key)
    const matching = requests.filter(request => request.phase === item.phase && request.endpoint === item.endpoint && request.shared === item.shared)
    if (!value.truncated && (item.started !== matching.length || item.completed !== matching.filter(request => request.outcome !== 'pending').length
      || item.errors !== matching.filter(request => request.outcome === 'error').length)) return null
    counts.push({ endpoint: item.endpoint, phase: item.phase, shared: item.shared, started: item.started, completed: item.completed, errors: item.errors, ms: item.ms })
  }
  if (!value.truncated && counts.reduce((sum, item) => sum + item.started, 0) !== requests.length) return null
  const accepted = value.agentAccepted
  if (accepted !== undefined && (!epoch(accepted?.at) || !ms(accepted.ms) || accepted.ms > value.ms + 0.01
    || !(value.harness === 'codex' ? accepted.kind === 'codex_turn_start_ack' : ['claude_user_ack', 'claude_system_init', 'claude_first_event'].includes(accepted.kind)))) return null
  const officialCliTiming = value.officialCliTiming === undefined ? undefined : readOfficialCliTiming(value.officialCliTiming, record)
  return { version: 1, source: 'http_server_link', window: value.window, runIdHash: value.runIdHash, harness: value.harness,
    startedAt: value.startedAt, endedAt: value.endedAt, ms: value.ms, executionStartMs: value.executionStartMs, executionEndMs: value.executionEndMs,
    complete: value.complete, truncated: value.truncated, requests, counts, providerOutputChunks: value.providerOutputChunks,
    ...(accepted ? { agentAccepted: { kind: accepted.kind, at: accepted.at, ms: accepted.ms } } : {}),
    toolCallsStarted: value.toolCallsStarted, toolCallsCompleted: value.toolCallsCompleted, toolCallsFailed: value.toolCallsFailed,
    ...(officialCliTiming ? { officialCliTiming } : {}), ...(officialCliTiming === null ? { officialCliTimingStatus: 'invalid' } : {}) }
}

/** Full physical-send coverage proves the absence of per-operation Mikka auth.
 * Observed official events describe provider durations; their delivery is best
 * effort, so their count is never represented as a complete provider census. */
export function runtimeEvidence(receipt, { requireOfficial = false } = {}) {
  if (!receipt?.complete || receipt.truncated || receipt.executionStartMs === null || receipt.executionEndMs === null)
    return { status: 'unavailable', reason: 'runtime_receipt_incomplete' }
  if (!receipt.agentAccepted || (receipt.harness === 'claude_code' && receipt.agentAccepted.kind !== 'claude_user_ack')) return { status: 'unavailable', reason: 'official_agent_acceptance_missing' }
  const forbidden = new Set(['policy_snapshot', 'permission_check', 'permission_request', 'server_decision', 'computer_authority',
    'subscription_context', 'provider_proxy', 'credential_lease', 'github_credential_lease', 'other_run_request'])
  // An official task ACK can arrive just before the existing UI stage returns.
  // Include sends after that real ACK, even while the phase still says preparing.
  const extras = receipt.counts.filter(item => item.started > 0 && ((item.phase === 'executing' && forbidden.has(item.endpoint))
    || item.endpoint === 'provider_proxy'))
  const earlyRequests = receipt.requests.filter(item => item.phase === 'preparing' && item.startMs >= receipt.agentAccepted.ms
    && forbidden.has(item.endpoint) && item.endpoint !== 'provider_proxy')
  extras.push(...receipt.counts.flatMap(item => {
    const matching = earlyRequests.filter(request => request.phase === item.phase && request.endpoint === item.endpoint && request.shared === item.shared)
    return matching.length ? [{ ...item, started: matching.length, completed: matching.filter(request => request.outcome !== 'pending').length,
      errors: matching.filter(request => request.outcome === 'error').length, ms: matching.reduce((sum, request) => sum + (request.ms ?? 0), 0) }] : []
  }))
  const refresh = receipt.counts.filter(item => ['credential_refresh', 'github_credential_refresh'].includes(item.endpoint))
  const official = receipt.officialCliTiming
  const providerEvents = official?.events.filter(event => event.kind === 'provider') ?? []
  const toolEvents = official?.events.filter(event => event.kind === 'tool') ?? []
  const base = { extraRemoteCalls: extras.reduce((sum, item) => sum + item.started, 0), extras, backgroundCredentialRefresh: refresh,
    observedProviderEvents: providerEvents.length, observedToolEvents: toolEvents.length,
    officialDelivery: official ? 'best_effort_not_a_complete_call_count' : 'unavailable' }
  if (extras.length) return { ...base, status: 'failed', reason: 'extra_runtime_authorization_or_proxy' }
  if (receipt.toolCallsCompleted < 1 || receipt.providerOutputChunks < 1) return { ...base, status: 'unavailable', reason: 'execution_cycle_missing' }
  if (requireOfficial && (!official || official.truncated || official.rejectedBatches || official.invalidEvents || providerEvents.length < 1))
    return { ...base, status: 'unavailable', reason: 'official_provider_timings_missing' }
  return { ...base, status: 'passed', basis: 'all_mikka_http_sends_during_execution_counted' }
}
