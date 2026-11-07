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
const MCP_OPERATIONS = new Set(['decision_catalogue', 'decision_record'])

/** The child reports its physical fetches, not prompt/tool contents. Received
 * generations can be complete; the official CLI's whole generation inventory
 * is not observable here and must never be inferred from an empty receipt. */
export function readMcpHttpTiming(value, record) {
  if (![1, 2, 3].includes(value?.version) || value.source !== 'mikka_mcp_physical_fetch' || value.scope !== 'observed_mikka_mcp_children'
    || value.generationCoverage !== 'unverified' || value.allFirstPartyHttpComplete !== false
    || !Number.isInteger(value.remoteMcpServerCount) || value.remoteMcpServerCount < 0 || value.remoteMcpServerCount > 64
    || value.childPathAuditVersion !== (value.version === 3 ? 2 : 1)
    || value.version === 3 && !(value.expectedCatalogueSha256 === null || typeof value.expectedCatalogueSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.expectedCatalogueSha256))
    || value.runIdHash !== record.runIdHash || value.harness !== record.harness
    || !/^[a-f0-9]{16}$/.test(value.runIdHash ?? '') || !['claude_code', 'codex'].includes(value.harness)
    || !epoch(value.startedAt) || !epoch(value.endedAt) || value.endedAt < value.startedAt
    || value.expectedChildren !== 1 || !count(value.observedChildren) || value.observedChildren > 8
    || !count(value.closedChildren) || value.closedChildren > value.observedChildren
    || typeof value.observedComplete !== 'boolean' || typeof value.childLifecycleComplete !== 'boolean'
    || typeof value.truncated !== 'boolean' || !count(value.rejectedEvents)
    || !Array.isArray(value.children) || value.children.length !== value.observedChildren
    || !Array.isArray(value.requests) || value.requests.length > 128) return null
  const children = [], requests = [], seen = new Set()
  for (const child of value.children) {
    if (child?.child !== children.length + 1 || !epoch(child.startedAt) || child.startedAt < value.startedAt || child.startedAt > value.endedAt
      || !(child.closedAt === null || epoch(child.closedAt) && child.closedAt >= child.startedAt && child.closedAt <= value.endedAt)
      || !['lastSequence', 'sent', 'completed', 'lost'].every(key => count(child[key])) || child.lastSequence < 1
      || child.completed > child.sent) return null
    let catalogue
    if (value.version === 3) {
      catalogue = child.catalogue
      if (catalogue !== null && (!catalogue || typeof catalogue !== 'object' || Array.isArray(catalogue)
        || Object.keys(catalogue).length !== 3 || Object.keys(catalogue).some(key => !['source', 'sha256', 'readyAt'].includes(key))
        || catalogue.source !== 'claim' || value.expectedCatalogueSha256 === null || catalogue.sha256 !== value.expectedCatalogueSha256
        || !epoch(catalogue.readyAt) || catalogue.readyAt < child.startedAt || catalogue.readyAt > (child.closedAt ?? value.endedAt))) return null
      if (catalogue !== null) catalogue = { source: 'claim', sha256: catalogue.sha256, readyAt: catalogue.readyAt }
    }
    children.push({ child: child.child, startedAt: child.startedAt, closedAt: child.closedAt,
      lastSequence: child.lastSequence, sent: child.sent, completed: child.completed, lost: child.lost,
      ...(value.version === 3 ? { catalogue } : {}) })
  }
  if (children.filter(child => child.closedAt !== null).length !== value.closedChildren) return null
  for (const request of value.requests) {
    const child = children.find(child => child.child === request?.child)
    const key = `${request?.child}:${request?.sequence}`
    if (!child || !count(request.sequence) || request.sequence < 1 || seen.has(key) || !MCP_OPERATIONS.has(request.operation)
      || !epoch(request.startedAt) || request.startedAt < child.startedAt || request.startedAt > (child.closedAt ?? value.endedAt)
      || !['ok', 'error', 'pending'].includes(request.outcome)
      || !(request.status === null || Number.isInteger(request.status) && request.status >= 100 && request.status <= 599)
      || (request.outcome === 'pending' ? request.endedAt !== null || request.durationMs !== null || request.status !== null
        : !epoch(request.endedAt) || request.endedAt < request.startedAt || request.endedAt > (child.closedAt ?? value.endedAt)
          || !ms(request.durationMs) || request.outcome !== (request.status >= 200 && request.status < 300 ? 'ok' : 'error'))) return null
    let body
    if (value.version >= 2) {
      if (!Object.hasOwn(request, 'body')) return null
      body = request.body
      if (body !== null) {
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 3 || Object.keys(body).some(key => !['endedAt', 'durationMs', 'outcome'].includes(key))
          || request.endedAt === null || request.status === null
          || !epoch(body.endedAt) || body.endedAt < request.endedAt || body.endedAt > (child.closedAt ?? value.endedAt)
          || !ms(body.durationMs) || body.durationMs < request.durationMs
          || !['read', 'error'].includes(body.outcome)) return null
        body = { endedAt: body.endedAt, durationMs: body.durationMs, outcome: body.outcome }
      }
    }
    seen.add(key)
    requests.push({ child: request.child, sequence: request.sequence, operation: request.operation,
      startedAt: request.startedAt, endedAt: request.endedAt, durationMs: request.durationMs, status: request.status, outcome: request.outcome,
      ...(value.version >= 2 ? { body } : {}) })
  }
  const matched = children.every(child => {
      const sent = requests.filter(request => request.child === child.child).sort((a, b) => a.sequence - b.sequence)
      return sent.length === child.sent && child.completed === sent.filter(request => request.outcome !== 'pending').length
        && child.lastSequence === 1 + child.sent + child.completed + (child.closedAt === null ? 0 : 1)
          + sent.filter(request => request.body != null).length
          + (child.catalogue ? 1 : 0)
        && sent.every((request, index) => request.sequence === index + 1)
  })
  const complete = value.observedChildren >= value.expectedChildren && value.rejectedEvents === 0 && !value.truncated
    && children.every(child => child.lost === 0 && child.sent === child.completed) && matched
  const lifecycleComplete = complete && value.closedChildren === value.observedChildren
  if (value.observedComplete && !complete || value.childLifecycleComplete && !lifecycleComplete) return null
  return { version: value.version, source: value.source, scope: value.scope, generationCoverage: 'unverified',
    allFirstPartyHttpComplete: false, remoteMcpServerCount: value.remoteMcpServerCount, childPathAuditVersion: value.childPathAuditVersion,
    ...(value.version === 3 ? { expectedCatalogueSha256: value.expectedCatalogueSha256 } : {}),
    runIdHash: value.runIdHash, harness: value.harness, startedAt: value.startedAt, endedAt: value.endedAt,
    expectedChildren: 1, observedChildren: value.observedChildren, closedChildren: value.closedChildren,
    observedComplete: value.observedComplete && complete, childLifecycleComplete: value.childLifecycleComplete && lifecycleComplete,
    rejectedEvents: value.rejectedEvents, truncated: value.truncated, children, requests }
}

/** This is evidence for the audited business-only child paths. It does not
 * claim to enumerate every generation spawned by the official CLI. Missing
 * child_close is retained as incomplete lifecycle coverage, not an auth call. */
export function mcpBusinessEvidence(value, record) {
  const timing = value === undefined ? undefined : readMcpHttpTiming(value, record)
  const unknown = { allFirstPartyHttpComplete: false, generationCoverage: 'unverified' }
  if (!timing) return { ...unknown, status: 'unavailable', reason: value === undefined ? 'mcp_http_observation_missing' : 'mcp_http_observation_invalid' }
  const base = { ...unknown, source: timing.source, scope: timing.scope, childPathAuditVersion: timing.childPathAuditVersion,
    remoteMcpServerCount: timing.remoteMcpServerCount, observedChildren: timing.observedChildren, closedChildren: timing.closedChildren,
    observedComplete: timing.observedComplete, childLifecycleComplete: timing.childLifecycleComplete,
    observedPhysicalSends: timing.requests.length,
    observedCatalogueSends: timing.requests.filter(request => request.operation === 'decision_catalogue').length,
    observedPreparedCatalogues: timing.children.filter(child => child.catalogue !== undefined && child.catalogue !== null).length,
    observedDecisionSends: timing.requests.filter(request => request.operation === 'decision_record').length,
    pendingObservedSends: timing.requests.filter(request => request.outcome === 'pending').length }
  if (timing.remoteMcpServerCount !== 0) return { ...base, status: 'unavailable', reason: 'remote_mcp_scope_uncovered' }
  if (timing.rejectedEvents || timing.truncated || timing.children.some(child => child.lost > 0))
    return { ...base, status: 'unavailable', reason: 'mcp_http_observation_incomplete' }
  for (const child of timing.children) {
    const requests = timing.requests.filter(request => request.child === child.child).sort((a, b) => a.sequence - b.sequence)
    if (requests.length !== child.sent || requests.filter(request => request.outcome !== 'pending').length !== child.completed
      || child.lastSequence !== 1 + child.sent + child.completed + (child.closedAt === null ? 0 : 1)
        + requests.filter(request => request.body != null).length
        + (child.catalogue ? 1 : 0)
      || requests.some((request, index) => request.sequence !== index + 1))
      return { ...base, status: 'unavailable', reason: 'mcp_http_sequence_invalid' }
  }
  if (timing.expectedCatalogueSha256 && base.observedCatalogueSends !== 0)
    return { ...base, status: 'unavailable', reason: 'mcp_prepared_catalogue_conflict' }
  if (!timing.requests.some(request => request.operation === 'decision_catalogue' && request.outcome !== 'pending')
    && !timing.children.some(child => child.catalogue?.sha256 === timing.expectedCatalogueSha256 && timing.expectedCatalogueSha256))
    return { ...base, status: 'unavailable', reason: 'mcp_catalogue_observation_missing' }
  return { ...base, status: 'observed' }
}

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
    || (value.scope !== undefined && value.scope !== 'daemon_http_server_link_and_task_fetch')
    || (value.allFirstPartyHttpComplete !== undefined && value.allFirstPartyHttpComplete !== false)
    || (value.scope === undefined) !== (value.allFirstPartyHttpComplete === undefined)
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
  const mcpHttpTiming = value.mcpHttpTiming === undefined ? undefined : readMcpHttpTiming(value.mcpHttpTiming, record)
  return { version: 1, source: 'http_server_link', window: value.window, runIdHash: value.runIdHash, harness: value.harness,
    ...(value.scope ? { scope: value.scope, allFirstPartyHttpComplete: false } : {}),
    startedAt: value.startedAt, endedAt: value.endedAt, ms: value.ms, executionStartMs: value.executionStartMs, executionEndMs: value.executionEndMs,
    complete: value.complete, truncated: value.truncated, requests, counts, providerOutputChunks: value.providerOutputChunks,
    ...(accepted ? { agentAccepted: { kind: accepted.kind, at: accepted.at, ms: accepted.ms } } : {}),
    toolCallsStarted: value.toolCallsStarted, toolCallsCompleted: value.toolCallsCompleted, toolCallsFailed: value.toolCallsFailed,
    ...(officialCliTiming ? { officialCliTiming } : {}), ...(officialCliTiming === null ? { officialCliTimingStatus: 'invalid' } : {}),
    ...(mcpHttpTiming ? { mcpHttpTiming } : {}), ...(mcpHttpTiming === null ? { mcpHttpTimingStatus: 'invalid' } : {}) }
}

/** Count the host's authorization/proxy entry points and check the fixed child
 * business-path audit. Child business sends are observed, not a complete count
 * of all CLI generations; official provider delivery is best effort too. */
export function runtimeEvidence(receipt, { requireOfficial = false } = {}) {
  if (!receipt?.complete || receipt.truncated || receipt.executionStartMs === null || receipt.executionEndMs === null)
    return { status: 'unavailable', reason: 'runtime_receipt_incomplete', allFirstPartyHttpComplete: false }
  if (!receipt.agentAccepted || (receipt.harness === 'claude_code' && receipt.agentAccepted.kind !== 'claude_user_ack'))
    return { status: 'unavailable', reason: 'official_agent_acceptance_missing', allFirstPartyHttpComplete: false }
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
  const childBusiness = receipt.mcpHttpTimingStatus === 'invalid'
    ? { status: 'unavailable', reason: 'mcp_http_observation_invalid', allFirstPartyHttpComplete: false, generationCoverage: 'unverified' }
    : mcpBusinessEvidence(receipt.mcpHttpTiming, receipt)
  const base = { extraRemoteCalls: extras.reduce((sum, item) => sum + item.started, 0), extras, backgroundCredentialRefresh: refresh,
    hostAuthorizationComplete: true, allFirstPartyHttpComplete: false, childBusiness,
    observedProviderEvents: providerEvents.length, observedToolEvents: toolEvents.length,
    officialDelivery: official ? 'best_effort_not_a_complete_call_count' : 'unavailable' }
  if (extras.length) return { ...base, status: 'failed', reason: 'extra_runtime_authorization_or_proxy' }
  if (receipt.toolCallsCompleted < 1 || receipt.providerOutputChunks < 1) return { ...base, status: 'unavailable', reason: 'execution_cycle_missing' }
  if (requireOfficial && (!official || official.truncated || official.rejectedBatches || official.invalidEvents || providerEvents.length < 1))
    return { ...base, status: 'unavailable', reason: 'official_provider_timings_missing' }
  if (childBusiness.status !== 'observed') return { ...base, status: 'unavailable', reason: childBusiness.reason }
  if (receipt.scope !== 'daemon_http_server_link_and_task_fetch' || receipt.allFirstPartyHttpComplete !== false)
    return { ...base, status: 'unavailable', reason: 'host_http_scope_unverified' }
  return { ...base, status: 'passed', basis: 'host_authorization_census_and_closed_mcp_business_paths' }
}
