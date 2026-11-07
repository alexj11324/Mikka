#!/usr/bin/env node
/** One historical candidate, normal owner session, read-only after sign-in and
 * workspace selection. No provider/VM calls, retries, run scans or cleanup writes. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TARGET = Object.freeze({
  source: 'cad613ef0a2c553a94aaf72d44d609c93a603a1b',
  runId: 'f879d6cd-bdbd-4e62-9a17-441f1f763a25', runIdHash: 'cfbe8eb3c7ea6fcb',
  deviceId: '09479c68-dcb4-4735-a91f-e355259c0eef', workspaceId: 'de300001-ece6-4021-8214-c986ea306bde',
})
const ORIGIN = 'https://app.aspectlylabs.com'
const ACCOUNT_HASH = '0049e13c050f799070a7d1a95bb843f2a0519b5e8732bf6986e2e1613b8941c3'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/
const TOTAL_MS = 180000, READ_MS = 150000, REQUEST_MS = 30000, BODY_BYTES = 4 * 1024 * 1024
const hash = value => createHash('sha256').update(value).digest('hex')
const id = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null
const numeric = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null
const choose = (value, choices) => choices.includes(value) ? value : 'unknown'
const RUN_STATES = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing', 'succeeded', 'completed', 'failed', 'stopped', 'cancelled']
const TERMINAL = ['succeeded', 'completed', 'failed', 'stopped', 'cancelled']
const CHUNK_TYPES = ['start', 'finish', 'start-step', 'finish-step', 'abort', 'error', 'data-run-stage', 'text-start', 'text-delta', 'text-end',
  'reasoning-start', 'reasoning-delta', 'reasoning-end', 'tool-input-start', 'tool-input-delta', 'tool-input-available', 'tool-input-error', 'tool-output-available', 'tool-output-error', 'tool-output-denied']
const RPC_CODES = ['authRequired', 'issueNotFound', 'runNotFound', 'deviceNotFound', 'deviceHasActiveRuns', 'workspaceAccessDenied',
  'workspaceNotFound', 'workspaceMembershipSuspended', 'desktop_rpc_failed', 'desktop_rpc_action_unknown', 'desktop_rpc_request_invalid', 'generic']
const LOCAL_CODES = ['account_invalid', 'source_invalid', 'build_mismatch', 'identity_mismatch', 'workspace_mismatch', 'run_mismatch',
  'response_invalid', 'response_too_large', 'read_budget_exhausted', 'total_budget_exhausted', 'request_scope_invalid', 'request_repeated',
  'transport_failed', 'thread_invalid', 'device_list_invalid', 'factory_list_invalid', 'http_refused', 'rpc_refused', 'sign_in_failed', 'sign_out_failed']
const RUNTIME_REASONS = ['runtime_receipt_incomplete', 'official_agent_acceptance_missing', 'extra_runtime_authorization_or_proxy',
  'execution_cycle_missing', 'official_provider_timings_missing', 'host_http_scope_unverified', 'mcp_http_observation_missing',
  'mcp_http_observation_invalid', 'remote_mcp_scope_uncovered', 'mcp_http_observation_incomplete', 'mcp_http_sequence_invalid', 'mcp_catalogue_observation_missing']
const fail = code => { throw Error(code) }
const check = (condition, code) => { if (!condition) fail(code) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Only exact known messages gain a classification; all other text stays a hash. */
export function safeError(value) {
  const text = typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : null
  if (text === null || text === '') return { classification: 'none' }
  const known = {
    'Codex subscription authentication unavailable': 'codex_subscription_auth_unavailable',
    'Codex resumed a different question thread': 'codex_session_mismatch',
    'The Codex session already ended': 'codex_session_ended',
    'Run mailbox requires a verified original Codex thread': 'codex_thread_unverified',
    executionIdentityUnavailable: 'execution_identity_unavailable',
  }
  const classification = Object.hasOwn(known, text) ? known[text] : [...RPC_CODES, ...LOCAL_CODES].includes(text) ? text : 'unknown'
  return { classification, sha256: hash(text), bytes: Buffer.byteLength(text) }
}

function account(value) {
  return { kind: choose(value?.kind, ['api_key', 'subscription', 'native_login', 'local_device', 'e2b']), resourceId: id(value?.resourceId),
    amount: choose(value?.amount, ['provider_unknown', 'metered', 'not_applicable']) }
}

export function projectEvidence(value, ownerId) {
  const run = value?.run
  check(run?.id === TARGET.runId && hash(run.id).slice(0, 16) === TARGET.runIdHash, 'run_mismatch')
  const authority = run.executionIdentity
  const bindings = Array.isArray(authority?.resourceBindings) ? authority.resourceBindings : []
  return { status: choose(run.status, RUN_STATES), issueId: id(run.issueId), botId: id(run.botId),
    harness: choose(run.harness, ['codex', 'claude_code']), model: choose(run.model, ['gpt-6-luna', 'claude-haiku-5-5']),
    credentialType: choose(run.credentialType, ['subscription', 'api_key', 'unknown']),
    subscriptionRoute: choose(run.subscriptionRoute, ['codex_cli', 'claude_code_cli']),
    agentProfile: { id: id(run.agentProfile?.profileId), version: numeric(run.agentProfile?.version),
      digest: /^[a-f0-9]{64}$/.test(run.agentProfile?.digest ?? '') ? run.agentProfile.digest : null },
    authority: { basis: 'historical_frozen_provenance_not_current_revalidation', version: authority?.version === 1 ? 1 : null,
      requesterMatchesSession: typeof ownerId === 'string' && authority?.requester === ownerId,
      executionPrincipalMatchesSession: typeof ownerId === 'string' && authority?.executionPrincipal === ownerId,
      outputOwnerMatchesSession: typeof ownerId === 'string' && authority?.outputOwner === ownerId,
      workspaceMatchesTarget: authority?.workspaceId === TARGET.workspaceId,
      deviceMatchesTarget: bindings.some(row => row?.kind === 'device' && row.id === TARGET.deviceId && row.ownerId === ownerId && row.access === 'owner'),
      bindings: bindings.slice(0, 64).map(row => ({ kind: choose(row?.kind, ['device', 'subscription', 'api_key', 'e2b', 'mcp']), id: id(row?.id),
        ownerMatchesSession: row?.ownerId === ownerId, access: choose(row?.access, ['owner', 'workspace_share']),
        revision: /^[0-9]{1,20}$/.test(row?.revision ?? '') ? row.revision : null, grantId: id(row?.grantId), workspaceId: id(row?.workspaceId) })),
      bindingsTruncated: bindings.length > 64, modelBilling: account(authority?.billingAccount?.model), runtimeBilling: account(authority?.billingAccount?.runtime) } }
}

/** Reproduce cad613 observeChunks' ordering and bounds, with unknown reply
 * proof when the real expected marker is absent/ambiguous in the run prompt. */
export function projectThread(detail, evidenceApi) {
  check(detail?.thread?.id === TARGET.runId && Array.isArray(detail.chunks) && detail.chunks.length <= 10000, 'thread_invalid')
  const thread = detail.thread, types = {}, tools = new Map(), inputs = new Set(), stages = [], errors = []
  const markers = typeof thread.prompt === 'string' ? [...new Set(thread.prompt.match(/\bSTARTUP_OK_[a-f0-9]{8}_1\b/g) ?? [])] : []
  const marker = markers.length === 1 ? markers[0] : null
  let started = false, provider = false, completedTool = false, reply = '', afterTool = '', verified = false, verifiedAfter = false
  let runtime, runtimeSeen = false
  for (const item of detail.chunks) {
    const chunk = item?.chunk, type = choose(chunk?.type, CHUNK_TYPES)
    types[type] = (types[type] ?? 0) + 1
    if (type === 'error' && errors.length < 8) errors.push(safeError(chunk.errorText))
    if (type === 'finish' && chunk.messageMetadata?.mikkaRuntimeTiming !== undefined) {
      runtimeSeen = true
      runtime ??= evidenceApi.readRuntimeTiming(chunk.messageMetadata.mikkaRuntimeTiming, { runIdHash: TARGET.runIdHash, harness: 'codex' }) ?? undefined
    }
    if (type === 'data-run-stage') {
      const data = chunk.data
      if (['repository', 'worktree', 'agent_start'].includes(data?.stage) && Number.isFinite(data.ms) && typeof data.ok === 'boolean') {
        if (!stages.some(row => row.stage === data.stage)) stages.push({ stage: data.stage, ok: data.ok,
          ms: data.ms >= 0 && data.ms <= 3600000 ? data.ms : null })
        if (data.stage === 'agent_start' && data.ok) started = true
      }
    } else if (started) {
      if (['tool-input-start', 'tool-input-available', 'tool-output-available', 'tool-output-error'].includes(type)
        && typeof chunk.toolCallId === 'string' && chunk.toolCallId.length > 0 && chunk.toolCallId.length <= 512) {
        const key = hash(chunk.toolCallId).slice(0, 16)
        if (type.startsWith('tool-input-') && inputs.size < 64) inputs.add(key)
        if (type === 'tool-output-available' && inputs.has(key)) completedTool = true
        if (!tools.has(key) && type.startsWith('tool-input-') && tools.size < 64) tools.set(key, 'pending')
        if (tools.has(key) && type.startsWith('tool-output-')) tools.set(key, type === 'tool-output-error' ? 'error' : 'ok')
      }
      const delta = ['text-delta', 'reasoning-delta'].includes(type) ? chunk.delta : undefined
      if (typeof delta === 'string' && delta.length > 0 || ['tool-input-start', 'tool-input-available'].includes(type)) provider = true
      if (type === 'text-delta' && typeof delta === 'string' && marker !== null) {
        reply += delta; if (reply.includes(marker)) verified = true; reply = reply.slice(-256)
        if (completedTool) { afterTool += delta; if (afterTool.includes(marker)) verifiedAfter = true; afterTool = afterTool.slice(-256) }
      }
    }
  }
  const runtimeStatus = runtime ? runtime.truncated ? 'truncated' : runtime.complete ? 'complete' : 'incomplete' : runtimeSeen ? 'invalid' : 'missing'
  const authorization = evidenceApi.runtimeEvidence(runtime, { requireOfficial: true })
  const successfulTools = [...tools.values()].filter(value => value === 'ok').length
  const proof = { agentStart: started, providerOutput: provider, successfulTool: successfulTools >= 1,
    replyMarker: marker === null ? null : verified, replyAfterTool: marker === null ? null : verifiedAfter,
    runtimeReceipt: runtimeStatus === 'complete', terminalRoot: TERMINAL.includes(thread.status) }
  const attempts = Array.isArray(thread.attempts) ? thread.attempts : []
  return { status: 'read', rootStatus: choose(thread.status, RUN_STATES), rootRunId: id(thread.rootRunId), latestRunId: id(thread.latestRunId),
    attempts: attempts.slice(0, 64).map(row => ({ runId: id(row?.runId), status: choose(row?.status, RUN_STATES), stopping: row?.stopping === true })),
    attemptsTruncated: attempts.length > 64,
    continuation: thread.continuation ? { runId: id(thread.continuation.id), status: choose(thread.continuation.status, RUN_STATES), stopping: thread.continuation.stopping === true } : null,
    error: safeError(thread.error), chunkErrors: errors, chunks: { total: detail.chunks.length, types }, stages,
    toolCounts: { observed: tools.size, successful: successfulTools, failed: [...tools.values()].filter(value => value === 'error').length },
    proof: { ...proof, markerBasis: marker === null ? 'unknown' : 'unique_expected_marker_in_run_prompt',
      missing: Object.keys(proof).filter(key => proof[key] === false), unknown: Object.keys(proof).filter(key => proof[key] === null),
      complete: Object.values(proof).every(value => value === true) },
    runtime: { receipt: runtimeStatus, officialAgentAccepted: runtime?.agentAccepted?.kind === 'codex_turn_start_ack',
      authorization: choose(authorization?.status, ['passed', 'failed', 'unavailable']),
      reason: authorization?.reason === undefined ? null : choose(authorization.reason, RUNTIME_REASONS),
      observedProviderEvents: numeric(authorization?.observedProviderEvents), extraRemoteCalls: numeric(authorization?.extraRemoteCalls),
      hostAuthorizationComplete: authorization?.hostAuthorizationComplete === true, allFirstPartyHttpComplete: false } }
}

async function body(response) {
  check(response.body, 'response_invalid')
  const reader = response.body.getReader(), parts = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      check(size <= BODY_BYTES, 'response_too_large')
      parts.push(part.value)
    }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { fail('response_invalid') }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function diagnose({ sourceApi, evidenceApi, env = process.env, fetchImpl = fetch, now = () => performance.now(), startedAt = now() } = {}) {
  const globalAbort = new AbortController(), used = new Set()
  const timer = setTimeout(() => globalAbort.abort(), Math.max(1, TOTAL_MS - (now() - startedAt))); timer.unref?.()
  let cleanupPhase = false, loginAttempted = false, issueId = null, client
  const report = { version: 1, target: TARGET, status: 'running', requests: [], cleanup: { signOut: 'not_started', cookiesCleared: false } }
  const fetchBounded = async (url, options) => {
    const parsed = new URL(url), method = options.method ?? 'GET'
    check(parsed.origin === ORIGIN && options.redirect === 'error', 'request_scope_invalid')
    const allowed = method === 'GET' && ['/mikka/api/version', '/mikka/api/auth/get-session', `/mikka/api/runs/${TARGET.runId}/evidence`].includes(parsed.pathname) && !parsed.search
      || method === 'GET' && issueId !== null && parsed.pathname === '/mikka/api/factory/tasks' && parsed.search === `?issueId=${issueId}`
      || method === 'POST' && ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out', '/mikka/api/rpc'].includes(parsed.pathname) && !parsed.search
    check(allowed, 'request_scope_invalid')
    let key = `${method}:${parsed.pathname}`
    if (parsed.pathname === '/mikka/api/rpc') {
      const payload = JSON.parse(options.body)
      const valid = { 'workspace.switchWorkspace': [TARGET.workspaceId], 'agents.getIssueThread': [issueId, TARGET.runId], 'agents.listDevices': [] }
      check(Object.hasOwn(valid, payload.action) && JSON.stringify(payload.args) === JSON.stringify(valid[payload.action]) && payload.version === 1, 'request_scope_invalid')
      key += `:${payload.action}`
    }
    check(!used.has(key), 'request_repeated'); used.add(key)
    const remaining = (cleanupPhase ? TOTAL_MS : READ_MS) - (now() - startedAt)
    check(remaining > 0 && !globalAbort.signal.aborted, cleanupPhase ? 'total_budget_exhausted' : 'read_budget_exhausted')
    const requestAbort = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(REQUEST_MS, remaining))))
    try { return await fetchImpl(url, { ...options, signal: AbortSignal.any([globalAbort.signal, requestAbort, ...(options.signal ? [options.signal] : [])]) }) }
    catch { fail('transport_failed') }
  }
  const rpc = async (action, args) => {
    const value = await read(action, '/api/rpc', { ...post({ version: 1, action, args }), headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1' } })
    check(value.ok === true, 'rpc_refused')
    const decoded = sourceApi.decodeWire(value.result)
    if (decoded?.error || decoded?.ok === false) {
      const text = typeof decoded.error === 'string' ? decoded.error : decoded.error?.code
      report.requests.at(-1).error = safeError(text)
      throw Error(RPC_CODES.includes(text) ? text : 'rpc_refused')
    }
    return decoded?.ok === true && Object.hasOwn(decoded, 'data') ? decoded.data : decoded
  }
  const read = async (step, path, init) => {
    const response = await client.request(path, init, REQUEST_MS)
    const receipt = { step, status: response.status }; report.requests.push(receipt)
    const value = await body(response)
    if (!response.ok || value?.error) {
      receipt.error = safeError(typeof value?.error === 'string' ? value.error : value?.error?.code)
      throw Error(RPC_CODES.includes(receipt.error.classification) ? receipt.error.classification : 'http_refused')
    }
    return value
  }
  try {
    const email = env.ACME_DEMO_EMAIL
    check(typeof email === 'string' && hash(email.toLowerCase()) === ACCOUNT_HASH && typeof env.ACME_DEMO_PASSWORD === 'string' && env.ACME_DEMO_PASSWORD.length > 0, 'account_invalid')
    client = sourceApi.createSessionClient(ORIGIN, fetchBounded)
    const version = await read('version', '/api/version')
    report.build = typeof version.build === 'string' && SHA.test(version.build) ? version.build : null
    check(version.build === TARGET.source, 'build_mismatch')
    loginAttempted = true
    const login = await client.request('/api/auth/sign-in/email', post({ email, password: env.ACME_DEMO_PASSWORD, rememberMe: false }), REQUEST_MS)
    report.requests.push({ step: 'sign_in', status: login.status }); await login.body?.cancel()
    check(login.ok, 'sign_in_failed')
    const identity = await read('identity', '/api/auth/get-session')
    check(typeof identity.user?.id === 'string' && typeof identity.user?.email === 'string' && hash(identity.user.email.toLowerCase()) === ACCOUNT_HASH, 'identity_mismatch')
    const workspace = await rpc('workspace.switchWorkspace', [TARGET.workspaceId])
    check(workspace?.workspaceId === TARGET.workspaceId, 'workspace_mismatch')
    report.identity = { matched: true, workspaceId: TARGET.workspaceId }
    report.evidence = projectEvidence(await read('evidence', `/api/runs/${TARGET.runId}/evidence`), identity.user.id)
    issueId = report.evidence.issueId
    try { report.thread = projectThread(await rpc('agents.getIssueThread', [issueId, TARGET.runId]), evidenceApi) }
    catch (error) { report.thread = { status: 'unavailable', error: safeError(error) } }
    try {
      const devices = await rpc('agents.listDevices', [])
      check(Array.isArray(devices), 'device_list_invalid')
      const matches = devices.filter(row => row?.id === TARGET.deviceId)
      check(matches.length <= 1, 'device_list_invalid')
      const device = matches[0]
      report.device = { status: 'read', present: Boolean(device), ...(device ? { id: TARGET.deviceId, enabled: typeof device.enabled === 'boolean' ? device.enabled : null,
        online: typeof device.online === 'boolean' ? device.online : null, harnesses: [...new Set((Array.isArray(device.harnesses) ? device.harnesses : []).map(row => choose(row?.harness, ['codex', 'claude_code'])))],
        lastSeenAt: typeof device.lastSeenAt === 'string' && Number.isFinite(Date.parse(device.lastSeenAt)) ? new Date(device.lastSeenAt).toISOString() : null } : {}) }
    } catch (error) { report.device = { status: 'unavailable', error: safeError(error) } }
    if (issueId && (report.thread.status !== 'read' || !report.thread.proof.complete || report.thread.continuation)) {
      try {
        const factory = await read('factory', `/api/factory/tasks?issueId=${issueId}`)
        check(factory.issueId === issueId && Array.isArray(factory.tasks) && factory.tasks.length <= 64
          && factory.tasks.every(row => id(row?.id) && row.issueId === issueId), 'factory_list_invalid')
        report.factory = { status: 'read', tasks: factory.tasks.map(row => ({ id: id(row?.id), issueMatchesTarget: row?.issueId === issueId,
          status: choose(row?.status, ['pending', 'running', 'waiting', 'blocked', 'passed', 'failed', 'cancelled', 'revoked']), revision: numeric(row?.revision) })) }
      } catch (error) { report.factory = { status: 'unavailable', error: safeError(error) } }
    }
    report.status = report.thread.status === 'read' && report.device.status === 'read' ? 'complete' : 'partial'
  } catch (error) { report.status = 'blocked'; report.error = safeError(error) }
  finally {
    cleanupPhase = true
    if (loginAttempted && client) {
      try {
        const response = await client.request('/api/auth/sign-out', post({}), REQUEST_MS)
        report.requests.push({ step: 'sign_out', status: response.status }); await response.body?.cancel()
        check(response.ok, 'sign_out_failed'); report.cleanup.signOut = 'ok'
      } catch (error) { report.cleanup.signOut = 'failed'; report.cleanup.error = safeError(error); report.status = 'blocked' }
    }
    client?.clear(); report.cleanup.cookiesCleared = true
    clearTimeout(timer); globalAbort.abort()
    report.elapsedMs = Math.max(0, Math.round(now() - startedAt))
  }
  return report
}

async function loadFixedSource() {
  const source = resolve('source')
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    check(head === TARGET.source, 'source_invalid')
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'scripts/acceptance/cloud-startup.mjs', 'scripts/acceptance/cloud-startup-evidence.mjs'], { cwd: source, timeout: 5000, stdio: 'ignore' })
    return { sourceApi: await import(pathToFileURL(resolve(source, 'scripts/acceptance/cloud-startup.mjs')).href),
      evidenceApi: await import(pathToFileURL(resolve(source, 'scripts/acceptance/cloud-startup-evidence.mjs')).href) }
  } catch { fail('source_invalid') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let report
  const startedAt = performance.now()
  try { check(process.argv.length === 3, 'source_invalid'); report = await diagnose({ ...await loadFixedSource(), startedAt }) }
  catch (error) { report = { version: 1, target: TARGET, status: 'blocked', error: safeError(error), cleanup: { signOut: 'not_started', cookiesCleared: true } } }
  try {
    check(process.argv.length === 3, 'source_invalid')
    await writeFile(resolve(process.argv[2]), `${JSON.stringify(report)}\n`, { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ event: 'candidate_readonly_diagnostic', status: report.status, signOut: report.cleanup.signOut }))
  } catch { console.error('candidate_diagnostic_receipt_write_failed'); process.exitCode = 1 }
  if (report.status !== 'complete') process.exitCode = 1
}
