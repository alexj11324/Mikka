#!/usr/bin/env node
import { observeEveSession } from './eve-session.mjs'
/** #1505: real, normal-session repository dispatch. No provider tokens or DB access.
 *
 * SMOKE_OWNER_EMAIL / SMOKE_OWNER_PASSWORD come from the existing prod:/ identity.
 * The issue #1918 owned Codex case opts into its separately authorized actor.
 * The Coordinator is the public repository-dispatch entry. Its tool stream has
 * no server timestamp (tool.at is a text offset), so a live report deliberately
 * remains unaligned until the operator supplies the matching dispatch_timing
 * log. --align-report performs that final, entirely offline step.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRuntimeTiming, runtimeEvidence } from './cloud-startup-evidence.mjs'
import { selectTeamWorkspace } from './team-workspace.mjs'
import { isSmokeAccountEmail } from '../../lib/smoke-account.ts'
import { OWNED_CODEX_ACTOR, isOwnedCodexEmail, ownedCodexAccount, selectOwnedCodexWorkspace } from './owned-codex-actor.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODELS = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' }
const ROUTES = { claude_code: 'claude_code_cli', codex: 'codex_cli' }
const REPOSITORY = 'alexj11324/Mikka-handoff'
const TERMINAL = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled'])
const HANDOFF_TOOLS = new Set(['mcp__mikka__submit', 'mcp__mikka__request_help', 'mcp__mikka__ask_human', 'mcp__mikka__report_blocked'])
// Kept closed like the daemon collector: never copy arbitrary chunk fields.
const STARTUP_PHASES = new Set(['daemon.adapter.model_report', 'daemon.adapter.auth', 'daemon.adapter.auth.gate',
  'daemon.adapter.auth.context', 'daemon.adapter.auth.access', 'daemon.adapter.auth.token', 'daemon.adapter.auth.native_auth',
  'daemon.adapter.auth.refresh', 'daemon.adapter.auth.broker', 'daemon.adapter.workspace.shadow_clone', 'daemon.adapter.workspace.read_tree',
  'daemon.adapter.cli_init', 'daemon.adapter.account_check', 'daemon.adapter.account_check.account_info', 'daemon.adapter.account_check.login'])
const PREPARATION_PHASES = new Set([...STARTUP_PHASES, 'daemon.adapter.cli_init.prewarm'])
const sha = value => createHash('sha256').update(value).digest('hex')
const fail = (code, cause) => { throw new Error(`startup_${code}`, cause ? { cause } : undefined) }
export const STARTUP_FAILURE_PHASES = Object.freeze(['unknown', 'build_pin', 'sign_in', 'session_identity', 'workspace_identity',
  'team_selection', 'workspace_selection', 'bot_create', 'bot_identity', 'timing_configuration', 'profile_selection', 'profile_create', 'profile_validation',
  'chat_model_selection', 'issue_create', 'coordinator_submit', 'coordinator_stream', 'thread_lookup', 'coordinator_stop',
  'subscription_proof', 'bootstrap_publication', 'execution_watch', 'execution_receipt', 'cleanup'])
// These are driver-owned codes, never a prefix rule accepting arbitrary error
// messages. The candidate validator independently projects this same contract.
export const STARTUP_FAILURE_CODES = Object.freeze([
  'aborted', 'action_refused', 'api_refused', 'bot_create_failed', 'bot_invalid', 'build_changed', 'build_mismatch', 'build_missing',
  'bootstrap_publication_failed', 'candidate_target_invalid', 'cleanup_machine_unconfirmed', 'cleanup_scope_mismatch', 'cleanup_terminal_timeout', 'client_required',
  'coordinator_stream_invalid', 'coordinator_stream_too_large', 'coordinator_stream_unavailable', 'daemon_startup_timing_incomplete',
  'diagnostic_bot_required', 'dispatch_not_new', 'dispatch_not_observed', 'dispatch_refused', 'dispatch_run_missing', 'dispatch_timings_required',
  'ended_before_execution_proof', 'execution_device_mismatch', 'execution_timeout', 'factory_list_invalid', 'failed',
  'fixture_required', 'fixture_scope_invalid', 'foreign_origin', 'harness_invalid', 'http_error', 'issue_create_failed',
  'live_capability_missing', 'live_disconnected', 'live_origin_invalid', 'live_scope_missing', 'live_ticket_expired', 'live_ticket_invalid',
  'mode_invalid', 'model_invalid', 'multiple_dispatches', 'node_websocket_required', 'observation_aborted',
  'official_agent_acceptance_missing', 'official_timing_invalid', 'option_invalid', 'origin_invalid', 'placement_mismatch',
  'profile_create_failed', 'profile_source_mismatch', 'request_failed', 'response_invalid', 'rpc_refused', 'runs_invalid',
  'runtime_evidence_failed', 'runtime_evidence_invalid', 'runtime_evidence_required', 'sample_id_invalid', 'session_identity_mismatch',
  'shared_chat_model_ambiguous', 'shared_chat_model_unavailable', 'shared_scope_required', 'shared_subscription_identity_mismatch',
  'shared_subscription_model_missing_or_ambiguous', 'sign_in_failed', 'sign_out_failed', 'smoke_account_required', 'strategy_invalid',
  'subscription_provenance_mismatch', 'test_bot_required', 'threshold_invalid', 'timeout', 'timeout_invalid',
  'timing_variable_cleanup_forbidden', 'timing_variable_create_failed', 'timing_variable_exists', 'timings_invalid',
  'vercel_token_required', 'version_pin_required', 'worker_configuration_invalid', 'worker_configuration_missing', 'worker_pin_invalid',
  'worker_release_changed', 'worker_release_mismatch', 'workflow_run_missing', 'workspace_identity_mismatch', 'workspace_invalid',
  'workspace_restore_failed',
  'owned_account_required', 'owned_actor_model_invalid', 'owned_workspace_mismatch', 'acceptance_actor_invalid',
  'owned_subscription_model_missing_or_ambiguous', 'owned_subscription_identity_mismatch',
  'owned_chat_model_ambiguous', 'owned_chat_model_unavailable',
].map(code => `startup_${code}`))
const failureCodes = new Set(STARTUP_FAILURE_CODES)
export function startupFailure(error, phase = 'unknown') {
  const at = STARTUP_FAILURE_PHASES.includes(phase) ? phase : 'unknown'
  const seen = new Set()
  // Fetch wraps native aborts/timeouts as request_failed/response_invalid. A
  // bounded cause walk preserves their class without exposing any message.
  for (let item = error, depth = 0; item && typeof item === 'object' && depth < 5 && !seen.has(item); item = item.cause, depth++) {
    seen.add(item)
    if (item.name === 'TimeoutError') return { phase: at, code: 'startup_timeout' }
    if (item.name === 'AbortError' || item.code === 'ABORT_ERR') return { phase: at, code: 'startup_aborted' }
  }
  const http = typeof error?.message === 'string' && /^startup_http_([45][0-9]{2})$/.exec(error.message)
  if (http) return { phase: at, code: 'startup_http_error', httpStatus: Number(http[1]) }
  return { phase: at, code: failureCodes.has(error?.message) ? error.message : 'startup_failed' }
}
const safeError = error => {
  const failure = startupFailure(error)
  // Existing cleanup rows already have a closed HTTP-code projection. Keep
  // its numeric status for those consumers; samples use failure directly.
  return failure.httpStatus ? `startup_http_${failure.httpStatus}` : failure.code
}
const assert = (condition, code) => { if (!condition) fail(code) }
const iso = value => new Date(value).toISOString()
const dateValue = value => typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** The transport's actual tagged Date/undefined codec, without server imports. */
export function decodeWire(value) {
  if (Array.isArray(value)) return value.map(decodeWire)
  if (!value || typeof value !== 'object') return value
  if (value.$mikka === 'date') return value.value
  if (value.$mikka === 'undefined') return undefined
  if (value.$mikka === 'object') return Object.fromEntries(value.value.map(([key, item]) => [key, decodeWire(item)]))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeWire(item)]))
}

/** Fixed high half, random low half with a small XOR: accepted by the current
 * TraceIdRatioBasedSampler(0.1), without altering any production sampling rate.
 * The workflow may create its own trace; report these as request trace IDs only. */
export function sampledRequestTrace() {
  const a = randomBytes(4).readUInt32BE(), small = randomBytes(4).readUInt32BE() & 0x0fffffff
  const b = (a ^ small) >>> 0
  const traceId = `0000000000000000${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
  const parentId = randomBytes(8).toString('hex')
  return { traceId, traceparent: `00-${traceId}-${parentId}-01` }
}

export function parseOptions(args, env = process.env) {
  const options = { origin: env.MIKKA_ACCEPTANCE_BASE_URL ?? 'https://app.aspectlylabs.com',
    workspace: env.MIKKA_ACCEPTANCE_WORKSPACE_ID, runs: 3, harness: 'both', mode: 'baseline',
    strategy: 'official', maxStartupMs: 5000, timeoutMs: 240000, expectedBuild: env.MIKKA_EXPECTED_BUILD,
    revision: env.MIKKA_EXPECTED_DEPLOYMENT_SHA, expectedWorkerSha: env.MIKKA_EXPECTED_WORKER_SHA,
    expectedWorkerSource: env.MIKKA_EXPECTED_WORKER_SOURCE, output: '.cache/acceptance/cloud-startup.json' }
  const names = { origin: 'origin', workspace: 'workspace', runs: 'runs', harness: 'harness', mode: 'mode', strategy: 'strategy',
    'max-startup-ms': 'maxStartupMs', 'timeout-ms': 'timeoutMs', 'expected-build': 'expectedBuild', revision: 'revision', output: 'output',
    'device-id': 'deviceId', 'agent-id': 'agentId', 'bot-id': 'botId', 'align-report': 'alignReport', 'dispatch-timings': 'dispatchTimings',
    'expected-worker-sha': 'expectedWorkerSha', 'expected-worker-source': 'expectedWorkerSource',
    'runtime-evidence': 'runtimeEvidence', 'official-timing': 'officialTiming' }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') return { help: true }
    const key = names[args[i].replace(/^--/, '')]
    assert(args[i].startsWith('--') && key && args[i + 1] && !args[i + 1].startsWith('--'), 'option_invalid')
    options[key] = args[++i]
  }
  if (options.alignReport) { assert(options.dispatchTimings, 'dispatch_timings_required'); return options }
  for (const key of ['runs', 'maxStartupMs', 'timeoutMs']) options[key] = Number(options[key])
  assert(!options.workspace || UUID.test(options.workspace), 'workspace_invalid')
  assert(['both', 'claude_code', 'codex'].includes(options.harness), 'harness_invalid')
  assert(['baseline', 'acceptance', 'candidate'].includes(options.mode), 'mode_invalid')
  options.runtimeEvidence ??= options.mode === 'acceptance' ? 'required' : 'optional'
  options.officialTiming ??= options.mode === 'acceptance' ? 'enabled' : 'disabled'
  assert(['required', 'optional'].includes(options.runtimeEvidence), 'runtime_evidence_invalid')
  assert(['enabled', 'disabled'].includes(options.officialTiming), 'official_timing_invalid')
  assert(options.officialTiming !== 'enabled' || options.runtimeEvidence === 'required', 'runtime_evidence_required')
  assert(['official', 'derived', 'pool', 'combined'].includes(options.strategy), 'strategy_invalid')
  assert(Number.isInteger(options.runs) && options.runs >= (options.mode === 'candidate' ? 1 : 3) && options.runs <= 20, 'runs_invalid')
  assert(Number.isSafeInteger(options.maxStartupMs) && options.maxStartupMs > 0 && options.maxStartupMs <= 60000, 'threshold_invalid')
  assert(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1000 && options.timeoutMs <= 600000, 'timeout_invalid')
  assert(!options.botId || UUID.test(options.botId), 'bot_invalid')
  assert((!options.deviceId && !options.agentId) || (UUID.test(options.deviceId ?? '') && UUID.test(options.agentId ?? '')
    && options.harness !== 'both' && options.mode === 'candidate'), 'candidate_target_invalid')
  const target = new URL(options.origin)
  assert(!target.username && !target.password && !target.search && !target.hash && ['/', '/mikka', '/mikka/'].includes(target.pathname), 'origin_invalid')
  assert(target.protocol === 'https:' || (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)), 'origin_invalid')
  options.origin = target.origin
  assert(options.mode !== 'acceptance' || (options.expectedBuild && /^[a-f0-9]{40}$/.test(options.revision ?? '')), 'version_pin_required')
  assert((!options.expectedWorkerSha && !options.expectedWorkerSource) || (/^[a-f0-9]{40}$/.test(options.expectedWorkerSha ?? '')
    && /^[a-f0-9]{40}$/.test(options.expectedWorkerSource ?? '')), 'worker_pin_invalid')
  return options
}

/** Read only the published runtime's public identifiers, never export the
 * Vercel environment listing or any other key's value. These are configuration
 * pins; actual per-run runtime SHA still comes from the startup log evidence. */
export async function readProductionWorkerRelease({ token, fetchImpl = fetch }) {
  assert(token, 'vercel_token_required')
  const { api, PROJECT } = await import('../e2b/publish-template-env.mjs')
  const { envs } = await api(`/v10/projects/${PROJECT}/env`, { token, fetchImpl })
  const keys = ['MIKKA_CLOUD_WORKER_SHA', 'MIKKA_CLOUD_WORKER_SOURCE_COMMIT', 'E2B_BYO_COMPUTER_TEMPLATE', 'E2B_CLAUDE_TEMPLATE', 'E2B_CODEX_TEMPLATE']
  const values = await Promise.all(keys.map(async key => {
    const rows = (envs ?? []).filter(item => item.key === key && item.target?.includes('production') && !item.gitBranch)
    assert(rows.length === 1, 'worker_configuration_missing')
    const { value } = await api(`/v1/projects/${PROJECT}/env/${encodeURIComponent(rows[0].id)}`, { token, fetchImpl })
    assert(typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value), 'worker_configuration_invalid')
    return value
  }))
  assert(/^[a-f0-9]{40}$/.test(values[0]) && /^[a-f0-9]{40}$/.test(values[1]), 'worker_configuration_invalid')
  return { workerSha: values[0], sourceCommit: values[1], templates: { desktop: values[2], claude: values[3], codex: values[4] } }
}

export function createSessionClient(origin, fetchImpl = fetch) {
  const target = new URL(origin)
  assert(target.origin === origin && !target.username && !target.password && (target.protocol === 'https:'
    || (target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))), 'origin_invalid')
  const cookies = new Map()
  async function request(path, init = {}, timeoutMs = 30000) {
    const url = new URL(`/mikka${path}`, origin)
    assert(url.origin === origin && url.pathname.startsWith('/mikka/'), 'foreign_origin')
    let response
    try {
      response = await fetchImpl(url, { ...init, headers: { origin, 'cache-control': 'no-store',
        ...(cookies.size ? { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}), ...init.headers },
        redirect: 'error', signal: init.signal ?? AbortSignal.timeout(timeoutMs) })
    } catch (error) { fail('request_failed', error) }
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0], equals = pair.indexOf('=')
      if (equals < 1) continue
      const key = pair.slice(0, equals), value = pair.slice(equals + 1)
      if (!value || /;\s*max-age=0(?:;|$)/i.test(line)) cookies.delete(key)
      else cookies.set(key, value)
    }
    return response
  }
  async function json(path, init, timeoutMs) {
    const response = await request(path, init, timeoutMs)
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      fail(`http_${response.status}`)
    }
    let body
    try { body = await response.json() } catch (error) { fail('response_invalid', error) }
    assert(!body?.error, 'api_refused')
    return body
  }
  async function rpc(action, args, extra = {}) {
    const response = await json('/api/rpc', { ...post({ version: 1, action, args }), headers: {
      'content-type': 'application/json', 'x-mikka-rpc': '1', ...extra.headers } }, extra.timeoutMs)
    assert(response.ok === true, 'rpc_refused')
    const value = decodeWire(response.result)
    assert(!value?.error && value?.ok !== false, 'action_refused')
    return value?.ok === true && 'data' in value ? value.data : value
  }
  return { request, json, rpc, clear: () => cookies.clear() }
}

/** Only the authorized shared test account is accepted; there is no owner-login fallback. */
export function smokeAcceptanceAccount(env) {
  const email = env.SMOKE_OWNER_EMAIL, password = env.SMOKE_OWNER_PASSWORD
  assert(isSmokeAccountEmail(email) && typeof password === 'string' && password.length > 0, 'smoke_account_required')
  return { email, password }
}

/** Keep trusted IDs in memory. The caller restores the original normal session
 * workspace even if a later membership/session fence rejects the selection. */
export async function selectAcceptanceTeam(client, { ownerId, workspace }, rememberOriginal) {
  const initial = await client.json('/api/workspace')
  assert(typeof ownerId === 'string' && ownerId.length > 0 && initial.currentUserId === ownerId
    && UUID.test(initial.workspace?.id ?? '') && initial.choices?.some(choice => choice.id === initial.workspace.id), 'workspace_identity_mismatch')
  rememberOriginal(initial.workspace.id)
  let selected
  const evidence = await selectTeamWorkspace({ ownerId, json: (path, body) => {
    assert(path.startsWith('/mikka/api/'), 'foreign_origin')
    return client.json(path.slice('/mikka'.length), body === undefined ? undefined : {
      ...post(body), headers: { 'content-type': 'application/json', 'x-mikka-rpc': '1' },
    })
  }, onSelected: value => { selected = value } })
  assert(selected && (!workspace || workspace === selected.workspaceId), 'workspace_identity_mismatch')
  return { ...selected, ownerId, evidence }
}

export async function restoreAcceptanceWorkspace(client, ownerId, workspaceId) {
  const restored = await client.rpc('workspace.switchWorkspace', [workspaceId])
  assert(restored.workspaceId === workspaceId, 'workspace_restore_failed')
  const current = await client.json('/api/workspace'), session = await client.json('/api/auth/get-session')
  assert(current.currentUserId === ownerId && current.workspace?.id === workspaceId && session.user?.id === ownerId, 'workspace_restore_failed')
}

export async function acceptanceBot(client, botId, fixtureId, { issue = 1505, rememberCreated } = {}) {
  assert([1505, 1593].includes(issue), 'fixture_scope_invalid')
  let created = false
  if (!botId) {
    const value = await client.rpc('bots.createBot', [{ name: `测试${issue} ${fixtureId.slice(0, 8)}`, color: 'gris', shape: 'cercle', model: null, repository: null }])
    assert(UUID.test(value.id ?? ''), 'bot_create_failed')
    botId = value.id; created = true
    rememberCreated?.(botId)
  }
  assert(UUID.test(botId), 'bot_invalid')
  // This normal GET only returns bots owned by this session in its selected workspace.
  const bot = await client.json(`/api/bots/${botId}`)
  assert(bot.id === botId && new RegExp(`^测试\\s*${issue}(?:\\s|$)`).test(bot.name ?? ''), 'test_bot_required')
  return { botId, created, retention: 'retained_no_delete_api' }
}

export async function chooseSharedChatModel(client, botId, harness, owned = false) {
  const provider = harness === 'codex' ? 'codex' : 'claude'
  const menu = await client.rpc('execution-settings.getBotModelMenu', [botId])
  // BotModelMenu uses owner only for another member's shared credential;
  // ownSubscriptionOption uses this same undefined-owner contract.
  const matches = (menu.groups ?? []).filter(group => group.kind === 'subscription' && group.provider === provider
    && (owned ? group.owner === undefined : typeof group.owner === 'string' && group.owner.trim().length > 0)).flatMap(group => group.options ?? [])
    .filter(option => option.provider === provider && option.modelId === MODELS[harness] && UUID.test(option.id ?? ''))
  assert(matches.length === 1, owned ? 'owned_chat_model_ambiguous' : 'shared_chat_model_ambiguous')
  const chosen = await client.rpc('execution-settings.chooseBotModel', [botId, matches[0].id]), current = chosen.current
  // A successful choice creates a bot binding; catalogue de-duplication
  // may expose that clone's ID on readback. Chat ownership comes from the
  // selected menu group, independently of the later task's source proof.
  assert(current?.kind === 'subscription' && current.chosen === true && UUID.test(current.id ?? '') && current.fallback === undefined
    && current.provider === provider && current.modelId === MODELS[harness]
    && (current.available === true || current.availability === 'checking'), owned ? 'owned_chat_model_unavailable' : 'shared_chat_model_unavailable')
}

/** A bounded NDJSON read, never a polling loop. Only safe identifiers/times leave. */
async function dispatchThroughCoordinator(client, record, { botId, profileId, deviceId, agentId, timeoutMs, leaseAudit = false, probe }, now) {
  const marker = `STARTUP_OK_${record.sampleId}`
  const toolInput = { issueId: record.issueId, repo: REPOSITORY, target: deviceId ? { deviceId } : 'cloud', profileId,
    // The owned lease probe executes Python; read-only runs intentionally have
    // no native shell. Ordinary startup checks keep their read-only policy.
    ...(agentId ? { agentId } : {}), readOnly: !(leaseAudit || probe),
    note: probe?.instructions ?? `Read one line of README (or list the repository root if absent), then reply ${marker}. Do not modify files, create branches, commit, push, open a PR, send messages, or spawn other agents.` }
  const text = `执行已有测试任务 ${record.issueId}，不要创建另一项任务。请调用一次 dispatch_run，参数如下：${JSON.stringify(toolInput)}。使用已固定模型的指定 Profile，不另传 model，不换 Profile、订阅或电脑。派发完成后只汇报 runId。`
  const trace = sampledRequestTrace()
  record.requestTraceId = trace.traceId
  record.requestTraceScope = 'submission_http_only_workflow_may_use_another_trace'
  record.messageSubmittedAt = iso(now())
  record.phase = 'coordinator_submit'
  await client.rpc('coordinator.sendCoordinatorMessage', [text, null, botId, randomUUID(),
    deviceId ? { kind: 'device', deviceId } : { $mikka: 'undefined' }, null, [], { $mikka: 'undefined' }, profileId],
  { headers: { traceparent: trace.traceparent } })
  record.phase = 'coordinator_stream'
  let selectedCall, completed = false
  await observeEveSession(client, botId, { timeoutMs,
    fail: (code, status, error) => {
      if (status) fail(`http_${status}`, error)
      fail(code === 'identity' ? 'workflow_run_missing' : code === 'too_large' ? 'coordinator_stream_too_large' : code === 'unavailable' ? 'coordinator_stream_unavailable' : 'coordinator_stream_invalid', error)
    },
    onEvent: async (event, sessionId) => {
      record.eveSessionId = sessionId
      // Session id is the durable Workflow run id, not the model's run_ label.
      record.workflowRunId = sessionId
      if (event.type === 'call.requested' && event.data.capability?.name === 'dispatch_run') {
        const input = event.data.input
        if (input?.issueId !== record.issueId || !input.note?.includes(marker)) return false
        assert(input.profileId === profileId, 'placement_mismatch')
        assert(!selectedCall || selectedCall === event.data.callId, 'multiple_dispatches')
        selectedCall = event.data.callId; record.dispatchCallId = selectedCall
        record.dispatchObservedAt ??= iso(now())
      }
      if (event.type !== 'call.settled' || !selectedCall || event.data.callId !== selectedCall) return false
      record.dispatchReturnedAt = iso(now())
      const code = event.data.error?.code ?? event.data.output?.error ?? (event.data.output?.ok === false ? event.data.output.code : undefined)
      if (event.data.outcome !== 'completed' || code) {
        record.dispatchRefusal = { code: typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(code) ? code : 'unavailable' }
        fail('dispatch_refused')
      }
      const result = event.data.output
      assert(result && UUID.test(result.runId ?? ''), 'dispatch_run_missing')
      record.phase = 'thread_lookup'
      const { threads } = await client.rpc('agents.pollIssueThreads', [record.issueId])
      assert(Array.isArray(threads) && threads.length === 1 && UUID.test(threads[0].id ?? '') && threads[0].ownedByCurrentUser === true, 'dispatch_run_missing')
      assert(result.thread === 'new' && result.runId === threads[0].id, 'dispatch_not_new')
      assert(deviceId ? result.placement?.kind === 'device' && result.placement.deviceId === deviceId : result.placement?.kind === 'cloud', 'placement_mismatch')
      record.runId = threads[0].id; record.runIdHash = sha(record.runId).slice(0, 16)
      record.placement = deviceId ? { kind: 'device', deviceId } : { kind: 'cloud' }
      completed = true
      return true
    },
  })
  assert(completed, 'dispatch_not_observed')
}

function readStartupTiming(value, record, names = STARTUP_PHASES) {
  const duration = number => Number.isFinite(number) && number >= 0 && number <= 3_600_000
  const outcome = text => text === 'ok' || text === 'error'
  if (value?.version !== 1 || !/^[a-f0-9]{16}$/.test(value.runIdHash ?? '') || value.runIdHash !== record.runIdHash
    || value.harness !== record.harness || !Object.hasOwn(MODELS, value.harness) || !outcome(value.outcome)
    || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0 || !Number.isSafeInteger(value.endedAt) || value.endedAt < value.startedAt
    || !duration(value.ms) || typeof value.truncated !== 'boolean' || !Array.isArray(value.phases) || value.phases.length > 64) return null
  const phases = []
  for (const phase of value.phases) {
    if (!names.has(phase?.name) || !outcome(phase.outcome) || !duration(phase.ms) || !duration(phase.startMs)
      || !duration(phase.endMs) || phase.endMs < phase.startMs || phase.endMs > value.ms + 0.01
      || Math.abs(phase.ms - (phase.endMs - phase.startMs)) > 0.01) return null
    phases.push({ name: phase.name, startMs: phase.startMs, endMs: phase.endMs, ms: phase.ms, outcome: phase.outcome })
  }
  return { version: 1, runIdHash: value.runIdHash, harness: value.harness, startedAt: value.startedAt, endedAt: value.endedAt,
    ms: value.ms, outcome: value.outcome, phases, truncated: value.truncated }
}


const REPOSITORY_GIT_PHASES = new Set(['clone', 'fetch', 'remote_head', 'remote_refs', 'local'].map(name => `daemon.repository.git.${name}`))
function readRepositoryTiming(value, record) {
  if (value?.source !== 'prepare_run_repository' || value.clock !== 'repository_prepare_monotonic'
    || Object.keys(value).sort().join(',') !== 'clock,endedAt,harness,ms,outcome,phases,runIdHash,source,startedAt,truncated,version'
    || !Array.isArray(value.phases) || value.phases.length > 32
    || value.phases.some(phase => !phase || Object.keys(phase).sort().join(',') !== 'endMs,ms,name,outcome,startMs')) return null
  const timing = readStartupTiming(value, record, REPOSITORY_GIT_PHASES)
  if (!timing || Buffer.byteLength(JSON.stringify(value)) > 8192) return null
  return { ...timing, source: value.source, clock: value.clock }
}

function readPreparationTiming(value, record, stage) {
  if (!['prepared_agent_start', 'bootstrap_claude_start', 'bootstrap_codex_initialize'].includes(value?.source) ||
    value.harness !== (value.source === 'bootstrap_codex_initialize' ? 'codex' : 'claude_code') || !stage) return null
  const timing = readStartupTiming(value, record, PREPARATION_PHASES)
  // The task-owned Promise starts before the stage joins it and settles before
  // that join returns. Never rebase its earlier intervals onto the stage root.
  if (!timing || timing.startedAt > stage.startedAt || timing.endedAt > stage.endedAt) return null
  if (value.source === 'bootstrap_claude_start' && !['oauth_environment', 'ordinary_path', 'unverified'].includes(value.claimAuthentication)) return null
  if (value.source === 'bootstrap_claude_start' && !['oauth_environment', 'oauth_descriptor', 'non_api_key_unspecified', 'unknown'].includes(value.observedAuthSource)) return null
  return { ...timing, source: value.source, ...(value.source === 'bootstrap_claude_start' ? { claimAuthentication: value.claimAuthentication, observedAuthSource: value.observedAuthSource } : {}) }
}

/** Both start paths require actual successful CLI initialization. A provided
 * but invalid/incomplete preparation receipt cannot fall back to old evidence. */
export function hasStartupInitialization(record) {
  const stage = readStartupTiming(record.daemonStartupTiming, record)
  if (record.startupTimingStatus !== 'complete' || !stage || stage.truncated || stage.outcome !== 'ok') return false
  const has = (timing, name) => timing.phases.some(phase => phase.name === name && phase.outcome === 'ok')
  if (record.preparationTimingStatus === undefined || record.preparationTimingStatus === 'unavailable')
    return record.daemonPreparationTiming === undefined && has(stage, 'daemon.adapter.cli_init')
  const prepared = record.preparationTimingStatus === 'complete' && readPreparationTiming(record.daemonPreparationTiming, record, stage)
  return Boolean(prepared && !prepared.truncated && prepared.outcome === 'ok'
    && (prepared.source !== 'bootstrap_claude_start' || (prepared.claimAuthentication === 'ordinary_path' || prepared.claimAuthentication === 'oauth_environment' && prepared.observedAuthSource === 'oauth_environment'))
    && has(prepared, 'daemon.adapter.cli_init.prewarm') && has(prepared, 'daemon.adapter.cli_init'))
}

/** The template gate requires actual adoption. Production measurement keeps
 * recording ordinary fallback honestly through hasStartupInitialization. */
export function bootstrapAdoptionEvidence(record) {
  const stage = readStartupTiming(record.daemonStartupTiming, record)
  const prepared = readPreparationTiming(record.daemonPreparationTiming, record, stage)
  const source = record.harness === 'claude_code' ? 'bootstrap_claude_start' : 'bootstrap_codex_initialize'
  if (record.startupTimingStatus !== 'complete' || record.preparationTimingStatus !== 'complete'
    || !stage || !prepared || stage.truncated || prepared.truncated || stage.outcome !== 'ok' || prepared.outcome !== 'ok'
    || prepared.source !== source || prepared.phases.some(phase => phase.outcome !== 'ok')
    || ['daemon.adapter.cli_init.prewarm', 'daemon.adapter.cli_init'].some(name =>
      prepared.phases.filter(phase => phase.name === name).length !== 1)
    || (record.harness === 'claude_code' && (prepared.claimAuthentication !== 'oauth_environment'
      || prepared.observedAuthSource !== 'oauth_environment'))) return null
  return { version: 1, runIdHash: record.runIdHash, harness: record.harness, source,
    preparationTiming: prepared, startupTiming: stage }
}

/** Failure-only projection of already observed data; it never authorizes adoption.
 * Reuse the strict readers so arbitrary chunk fields cannot reach an artifact. */
export function bootstrapAdoptionDiagnostics(record) {
  if (typeof record?.runIdHash !== 'string' || !/^[a-f0-9]{16}$/.test(record.runIdHash)
    || typeof record.harness !== 'string' || !Object.hasOwn(MODELS, record.harness)) return null
  const stage = readStartupTiming(record.daemonStartupTiming, record)
  const prepared = readPreparationTiming(record.daemonPreparationTiming, record, stage)
  const status = value => ['unavailable', 'invalid', 'incomplete', 'truncated', 'complete'].includes(value) ? value : 'unavailable'
  const source = record.harness === 'claude_code' ? 'bootstrap_claude_start' : 'bootstrap_codex_initialize'
  return {
    version: 1, runIdHash: record.runIdHash, harness: record.harness,
    startupTimingStatus: status(record.startupTimingStatus), preparationTimingStatus: status(record.preparationTimingStatus),
    startupTiming: stage, preparationTiming: prepared,
    adoptionChecks: {
      startupTimingStatus: record.startupTimingStatus === 'complete',
      preparationTimingStatus: record.preparationTimingStatus === 'complete',
      startupReceipt: Boolean(stage), preparationReceipt: Boolean(prepared),
      startupUntruncated: stage?.truncated === false, preparationUntruncated: prepared?.truncated === false,
      startupOutcome: stage?.outcome === 'ok', preparationOutcome: prepared?.outcome === 'ok',
      preparationSource: prepared?.source === source,
      preparationPhases: Boolean(prepared?.phases.every(phase => phase.outcome === 'ok')),
      prewarmPhaseCount: prepared?.phases.filter(phase => phase.name === 'daemon.adapter.cli_init.prewarm').length === 1,
      cliInitPhaseCount: prepared?.phases.filter(phase => phase.name === 'daemon.adapter.cli_init').length === 1,
      claimAuthentication: record.harness !== 'claude_code' || prepared?.claimAuthentication === 'oauth_environment',
      observedAuthSource: record.harness !== 'claude_code' || prepared?.observedAuthSource === 'oauth_environment',
    },
  }
}

/** Re-check the bounded actual timing proof at each publication boundary. */
export function readBootstrapAcceptance(value, record) {
  if (value?.version !== 1 || value.runIdHash !== record.runIdHash || value.harness !== record.harness
    || !/^[a-f0-9]{64}$/.test(value.bootstrapSha256 ?? '') || !/^[a-f0-9]{64}$/.test(value.hintSha256 ?? '')
    || Object.keys(value).sort().join(',') !== 'bootstrapSha256,harness,hintSha256,preparationTiming,runIdHash,source,startupTiming,version') return null
  const adopted = bootstrapAdoptionEvidence({ ...record, startupTimingStatus: 'complete', preparationTimingStatus: 'complete',
    daemonStartupTiming: value.startupTiming, daemonPreparationTiming: value.preparationTiming })
  return adopted && value.source === adopted.source ? { ...adopted,
    bootstrapSha256: value.bootstrapSha256, hintSha256: value.hintSha256 } : null
}

/** Only post-start provider output counts. Stage/usage/state/status and a bare
 * message boundary are daemon activity, not evidence of model execution. */
export function observeChunks(record, detail, observedAt) {
  const stages = record.stages ??= []
  const toolCalls = record.toolCalls ??= []
  // getIssueThread replays the stream. Derive ordering afresh from this read,
  // never from toolCalls retained by an earlier read of the same chunks.
  const toolInputs = new Set()
  const successfulExecutionTools = new Set()
  // A successful handoff is delivery, not evidence that the task was read or
  // executed. Resolve known handoff identities across this replay first: an
  // input-start can omit the name that a later input-available supplies.
  const handoffCalls = new Set()
  const codexNativeCalls = new Map()
  const codexInputs = new Set()
  let codexStarted = false
  for (const { chunk } of detail.chunks ?? []) {
    if (chunk?.type === 'data-run-stage' && chunk.data?.stage === 'agent_start'
      && Number.isFinite(chunk.data.ms) && chunk.data.ok === true) codexStarted = true
    if (['tool-input-start', 'tool-input-available'].includes(chunk?.type)
      && typeof chunk.toolCallId === 'string' && chunk.toolCallId.length > 0 && chunk.toolCallId.length <= 512) {
      const toolCallHash = sha(chunk.toolCallId).slice(0, 16)
      if (HANDOFF_TOOLS.has(chunk.toolName)) handoffCalls.add(toolCallHash)
      // Match the execution pass's first 64 inputs, while accepting a later
      // name for an already admitted call. Never downgrade a known native tool.
      if (record.harness === 'codex' && codexStarted && (codexInputs.has(toolCallHash) || codexInputs.size < 64)) {
        codexInputs.add(toolCallHash)
        if (!codexNativeCalls.has(toolCallHash) && ['bash', 'apply_patch'].includes(chunk.toolName)) codexNativeCalls.set(toolCallHash, chunk.toolName)
      }
    }
  }
  const submittedReplies = new Set()
  let submittedAt = null
  let started = false, reply = '', completedTool = false, replyAfterTool = '', replyVerifiedAfterTool = false
  for (const item of detail.chunks ?? []) {
    const { chunk } = item
    const at = dateValue(item.at)
    if (chunk?.type === 'finish' && chunk.messageMetadata?.mikkaRuntimeTiming !== undefined) {
      const timing = readRuntimeTiming(chunk.messageMetadata.mikkaRuntimeTiming, record)
      if (timing) record.runtimeTiming ??= timing
      if (timing?.agentAccepted) record.agentAccepted ??= { ...timing.agentAccepted, clock: 'daemon_wall_and_monotonic' }
      record.runtimeTimingStatus = record.runtimeTiming ? (record.runtimeTiming.truncated ? 'truncated' : record.runtimeTiming.complete ? 'complete' : 'incomplete') : 'invalid'
      if (record.runtimeTiming) record.runtimeEvidence = runtimeEvidence(record.runtimeTiming, { requireOfficial: record.requireOfficialTiming })
    }
    if (chunk?.type === 'data-run-stage') {
      const data = chunk.data
      if (['repository', 'worktree', 'agent_start'].includes(data?.stage) && Number.isFinite(data.ms) && typeof data.ok === 'boolean') {
        if (!stages.some(stage => stage.stage === data.stage)) stages.push({ stage: data.stage, ms: data.ms, ok: data.ok,
          ...(Number.isFinite(at) ? { storedAt: iso(at) } : {}) })
        if (data.stage === 'repository' && data.repositoryTiming !== undefined) {
          const timing = readRepositoryTiming(data.repositoryTiming, record)
          if (timing) record.daemonRepositoryTiming ??= timing
          record.repositoryTimingStatus = record.repositoryTimingStatus === 'invalid' || !timing ? 'invalid' : record.daemonRepositoryTiming.truncated ? 'truncated' : 'complete'
        }
        if (data.stage === 'agent_start') {
          const timing = readStartupTiming(data.startupTiming, record)
          if (timing) record.daemonStartupTiming ??= timing
          record.startupTimingStatus = record.daemonStartupTiming ? (record.daemonStartupTiming.truncated ? 'truncated' : 'complete')
            : data.startupTiming === undefined ? 'unavailable' : 'invalid'
          if (data.preparationTiming !== undefined) {
            const preparation = readPreparationTiming(data.preparationTiming, record, timing)
            if (preparation) record.daemonPreparationTiming ??= preparation
            record.preparationTimingStatus = record.preparationTimingStatus === 'invalid' || !preparation ? 'invalid'
              : preparation.truncated ? 'truncated' : 'complete'
          } else record.preparationTimingStatus ??= 'unavailable'
        }
        if (data.stage === 'agent_start' && data.ok) {
          started = true
          record.agentStart ??= { storedAt: Number.isFinite(at) ? iso(at) : null, observedAt: iso(observedAt) }
        }
      }
    } else if (started) {
      if (['tool-input-start', 'tool-input-available', 'tool-output-available', 'tool-output-error'].includes(chunk?.type)
        && typeof chunk.toolCallId === 'string' && chunk.toolCallId.length > 0 && chunk.toolCallId.length <= 512) {
        const toolCallHash = sha(chunk.toolCallId).slice(0, 16)
        if (chunk.type === 'tool-input-available' && completedTool && chunk.toolName === 'mcp__mikka__submit'
          && typeof chunk.input?.summary === 'string' && chunk.input.summary.includes(`STARTUP_OK_${record.sampleId}`)) submittedReplies.add(toolCallHash)
        if (chunk.type === 'tool-output-available' && submittedReplies.has(toolCallHash) && Number.isFinite(at)) submittedAt = at
        if (chunk.type.startsWith('tool-input-') && toolInputs.size < 64) toolInputs.add(toolCallHash)
        if (chunk.type === 'tool-output-available' && toolInputs.has(toolCallHash) && !handoffCalls.has(toolCallHash)) {
          const native = codexNativeCalls.get(toolCallHash)
          const succeeded = native === 'bash' ? chunk.output?.exitCode === 0
            : native === 'apply_patch' ? chunk.output?.status === 'completed' : true
          if (succeeded) successfulExecutionTools.add(toolCallHash)
          else successfulExecutionTools.delete(toolCallHash)
        }
        if (chunk.type === 'tool-output-error') successfulExecutionTools.delete(toolCallHash)
        completedTool = successfulExecutionTools.size > 0
        let tool = toolCalls.find(call => call.toolCallHash === toolCallHash)
        if (!tool && chunk.type.startsWith('tool-input-') && toolCalls.length < 64) {
          tool = { toolCallHash, startedAt: Number.isFinite(at) ? iso(at) : null, outcome: 'pending' }; toolCalls.push(tool)
        }
        if (tool && chunk.type.startsWith('tool-output-')) {
          tool.completedAt = Number.isFinite(at) ? iso(at) : null
          tool.outcome = chunk.type === 'tool-output-error' ? 'error' : 'ok'
        }
      }
      const output = ['text-delta', 'reasoning-delta'].includes(chunk?.type) ? chunk.delta : undefined
      if (!record.firstProviderChunk && ((typeof output === 'string' && output.length > 0)
        || ['tool-input-start', 'tool-input-available'].includes(chunk?.type))) {
        record.firstProviderChunk = { type: chunk.type, storedAt: Number.isFinite(at) ? iso(at) : null, observedAt: iso(observedAt),
          ...(typeof output === 'string' ? { bytes: Buffer.byteLength(output), sha256: sha(output) } : {}) }
      }
      if (chunk?.type === 'text-delta' && typeof output === 'string') {
        reply += output
        if (reply.includes(`STARTUP_OK_${record.sampleId}`)) record.replyVerified = true
        reply = reply.slice(-256)
        if (completedTool) {
          replyAfterTool += output
          if (replyAfterTool.includes(`STARTUP_OK_${record.sampleId}`)) replyVerifiedAfterTool = true
          replyAfterTool = replyAfterTool.slice(-256)
        }
      }
    }
  }
  // submit is the normal successful delivery channel. The owner-only summary
  // comes from the persisted report, not from an arbitrary tool input/output.
  // Require this exact, uncontinued run and an observed submit after its read.
  const thread = detail.thread
  if (submittedAt !== null && thread?.id === record.runId && thread.rootRunId === record.runId && thread.latestRunId === record.runId
    && thread.ownedByCurrentUser === true && thread.status === 'succeeded' && thread.error === null && !thread.continuation
    && thread.attempts?.length === 1 && thread.attempts[0].runId === record.runId && thread.attempts[0].status === 'succeeded'
    && thread.detail?.harness === record.harness && thread.detail.summarySource === 'report' && typeof thread.detail.summary === 'string'
    && thread.detail.summary.includes(`STARTUP_OK_${record.sampleId}`)
    && Number.isFinite(dateValue(thread.finishedAt)) && dateValue(thread.finishedAt) >= submittedAt) {
    record.replyVerified = true
    replyVerifiedAfterTool = true
    record.replySource = 'submitted_report'
  }
  record.replyVerifiedAfterTool = replyVerifiedAfterTool
  record.lastStatus = typeof detail.thread?.status === 'string' && /^[a-z_]+$/.test(detail.thread.status) ? detail.thread.status : null
  return Boolean(record.agentStart && record.firstProviderChunk && (!record.requireReply || record.replyVerified)
    && successfulExecutionTools.size >= (record.minToolCalls ?? 0)
    && (!record.requireReplyAfterTool || record.replyVerifiedAfterTool)
    && (!record.requireRuntimeReceipt || record.runtimeTimingStatus === 'complete')
    && (!record.requireTerminal || (detail.thread?.id === record.runId && TERMINAL.has(record.lastStatus))))
}

/** The public detail keeps the original run's status separate from later
 * attempts. Only this server-resolved chain can supply cleanup targets. */
function cleanupAttempts(detail, runId) {
  const attempts = detail.thread?.attempts
  assert(detail.thread?.id === runId && Array.isArray(attempts) && attempts.length > 0
    && attempts.every(attempt => UUID.test(attempt?.runId ?? '') && typeof attempt.status === 'string')
    && new Set(attempts.map(attempt => attempt.runId)).size === attempts.length
    && attempts.some(attempt => attempt.runId === runId), 'cleanup_scope_mismatch')
  return attempts
}

/** One live owner channel per server-reported scope. Reads happen on pushes,
 * once on connection (to cover the opening race), and once at the deadline. */
export async function watchRun(client, record, timeoutMs, WebSocketImpl, now, cleanupRunIds, hooks = {}) {
  const sockets = new Map(), timers = new Set()
  const watchedRunIds = new Set([record.runId])
  const extraScopes = new Set()
  let closed = false, reading = false, dirty = false, deadline = false, settle, refreshWork
  let readsStarted = 0, readsCompleted = 0, lastCompletedAt = null, readInFlight = false, liveObserver, outcomeSettled = false
  const outcome = new Promise((resolve, reject) => { settle = {
    resolve: () => { outcomeSettled = true; resolve() },
    reject: error => { outcomeSettled = true; reject(error) },
  } })
  const abort = () => settle.reject(new Error('startup_observation_aborted'))
  if (hooks.signal?.aborted) abort()
  else hooks.signal?.addEventListener('abort', abort, { once: true })
  const observed = async detail => {
    if (hooks.observe) return hooks.observe(detail, {
      checkActive: () => { if (closed || hooks.signal?.aborted) fail('observation_aborted') },
      watchRun: id => { assert(UUID.test(id ?? ''), 'live_scope_missing'); watchedRunIds.add(id) },
      watchScope: id => { assert(UUID.test(id ?? ''), 'live_scope_missing'); extraScopes.add(id) },
    })
    if (!cleanupRunIds) return observeChunks(record, detail, now())
    const attempts = cleanupAttempts(detail, record.runId)
    for (const attempt of attempts) { cleanupRunIds.add(attempt.runId); watchedRunIds.add(attempt.runId) }
    return attempts.every(attempt => TERMINAL.has(attempt.status))
  }
  const later = (work, ms) => { const timer = setTimeout(() => { timers.delete(timer); work() }, ms); timers.add(timer); return timer }
  const reject = error => { if (!closed) settle.reject(error) }
  const kick = () => {
    if (closed) return
    dirty = true
    if (!reading) refreshWork = refresh().catch(reject)
  }
  async function connect(workspaceId) {
    if (closed || sockets.has(workspaceId)) return
    const ticket = await client.json(`/api/live/ticket?workspace=${workspaceId}`)
    if (closed) return
    const url = new URL(ticket.url)
    assert(['wss:', 'ws:'].includes(url.protocol) && !url.username && !url.password && typeof ticket.protocol === 'string'
      && Number.isFinite(ticket.expiresAt) && ticket.expiresAt > now(), 'live_ticket_invalid')
    assert(url.protocol === 'wss:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'live_origin_invalid')
    url.searchParams.set('revisions', '1')
    const socket = new WebSocketImpl(url, ticket.protocol)
    sockets.set(workspaceId, socket)
    const timeline = { openedAt: null, readyAt: null, lastNotificationAt: null }
    const failLive = code => reject(new Error(`startup_${code}`))
    const disconnected = (event, close) => {
      if (closed || outcomeSettled) return
      // Freeze only the first observed transport fault. No event bodies, tickets
      // or identifiers leave; later callbacks cannot rewrite the failure.
      if (!liveObserver) {
        const firstFailure = { event, at: iso(now()), scopeHash: sha(workspaceId).slice(0, 16),
          readyState: Number.isInteger(socket.readyState) && socket.readyState >= 0 && socket.readyState <= 3 ? socket.readyState : null }
        if (event === 'close') {
          if (Number.isInteger(close?.code) && close.code >= 0 && close.code <= 65535) firstFailure.code = close.code
          if (typeof close?.wasClean === 'boolean') firstFailure.wasClean = close.wasClean
        }
        liveObserver = record.liveObserver = { version: 1, firstFailure, ...timeline,
          detailReads: { started: readsStarted, completed: readsCompleted, lastCompletedAt, inFlightAtFailure: readInFlight },
          shutdownAt: null }
      }
      failLive('live_disconnected')
    }
    socket.onclose = event => disconnected('close', event)
    socket.onerror = () => disconnected('error')
    socket.onmessage = message => {
      if (closed || message.data === 'pong' || typeof message.data !== 'string' || message.data.length > 2048) return
      let value
      try { value = JSON.parse(message.data) } catch { return }
      if (value.type === 'live_ready') {
        if (!Array.isArray(value.kinds) || !value.kinds.includes('thread') || !value.kinds.includes('run')) return failLive('live_capability_missing')
        timeline.readyAt ??= iso(now())
        kick(); return
      }
      if ((['thread', 'run'].includes(value.kind) && watchedRunIds.has(value.id))
        || (value.kind === 'issue_threads' && value.id === record.issueId)
        || hooks.matches?.(value)) { timeline.lastNotificationAt = iso(now()); kick() }
    }
    socket.onopen = () => {
      timeline.openedAt ??= iso(now())
      const heartbeat = () => { if (closed) return; if (socket.readyState === 1) socket.send('ping'); later(heartbeat, 30000) }
      later(heartbeat, 30000)
    }
    later(() => { if (!closed) failLive('live_ticket_expired') }, Math.max(1, ticket.expiresAt - now()))
  }
  async function refresh() {
    reading = true
    try {
      do {
        dirty = false
        const finalRead = deadline
        readsStarted++; readInFlight = true
        let detail
        try {
          detail = await client.rpc('agents.getIssueThread', [record.issueId, record.runId])
          readsCompleted++; lastCompletedAt = iso(now())
        } finally { readInFlight = false }
        if (closed) return
        record.detailReads = (record.detailReads ?? 0) + 1
        record.runCreatedAt ??= detail.thread?.createdAt ?? null
        if (await observed(detail)) { settle.resolve(); return }
        if (closed) return
        if (finalRead) fail(cleanupRunIds ? 'cleanup_terminal_timeout' : 'execution_timeout')
        // A deadline that arrived during an observer is serialized behind it;
        // exactly one final read uses the same active/closed fences.
        if (deadline) { dirty = true; continue }
        if (!cleanupRunIds && !hooks.allowTerminal && TERMINAL.has(record.lastStatus)) fail('ended_before_execution_proof')
        const scopes = [...new Set([...extraScopes, ...(detail.live?.runs ?? []).filter(run => watchedRunIds.has(run.id)).map(run => run.workspaceId)])]
        assert(scopes.length && scopes.every(id => UUID.test(id ?? '')), 'live_scope_missing')
        for (const scope of scopes) await connect(scope)
      } while (dirty && !closed)
    } finally { reading = false }
  }
  later(() => { deadline = true; kick() }, timeoutMs)
  if (!hooks.signal?.aborted) kick()
  try { await outcome }
  finally {
    closed = true
    if (liveObserver) liveObserver.shutdownAt = iso(now())
    hooks.signal?.removeEventListener('abort', abort)
    for (const timer of timers) clearTimeout(timer)
    for (const socket of sockets.values()) { socket.onclose = socket.onerror = socket.onmessage = socket.onopen = null; socket.close() }
    // Hooks check the active fence after every bounded read. Finish that last
    // read before the caller starts resource cleanup or serializes its report.
    await refreshWork
  }
}

function safeIdentity(identity) {
  if (!identity || identity.version !== 1) return null
  return { version: 1, requesterHash: sha(String(identity.requester)).slice(0, 16),
    executionPrincipalHash: sha(String(identity.executionPrincipal)).slice(0, 16),
    model: identity.billingAccount?.model?.kind ?? null, runtime: identity.billingAccount?.runtime?.kind ?? null,
    subscriptionAccess: identity.resourceBindings?.filter(resource => resource.kind === 'subscription').map(resource => resource.access) ?? [] }
}

export async function subscriptionProof(client, record, scope, profile) {
  const owned = scope.actor === OWNED_CODEX_ACTOR
  const payerId = owned ? scope.ownerId : scope.adminId, access = owned ? 'owner' : 'workspace_share'
  const evidence = await client.json(`/api/runs/${record.runId}/evidence`), run = evidence.run
  assert(run?.id === record.runId && run.issueId === record.issueId && run.harness === record.harness
    && run.model === MODELS[record.harness] && run.credentialType === 'subscription'
    && run.subscriptionRoute === ROUTES[record.harness] && run.agentProfile?.profileId === record.profileId,
  'subscription_provenance_mismatch')
  const identity = run.executionIdentity
  const device = identity?.resourceBindings?.find(resource => resource.kind === 'device')
  assert(UUID.test(device?.id ?? '') && identity.billingAccount?.model?.kind === 'subscription'
    && (record.placement.kind === 'cloud' ? identity.billingAccount?.runtime?.kind === 'e2b'
      : device.id === record.placement.deviceId), 'execution_device_mismatch')
  const subscriptions = identity.resourceBindings.filter(resource => resource.kind === 'subscription')
  const subscription = subscriptions[0], payer = identity.billingAccount.model
  assert(identity.version === 1 && identity.requester === scope.ownerId && identity.executionPrincipal === scope.ownerId
    && identity.botId === scope.botId && identity.botOwner === scope.ownerId && identity.outputOwner === scope.ownerId
    && identity.workspaceId === scope.workspaceId && identity.personalResourcePolicy === 'requester_only'
    && device.ownerId === scope.ownerId && device.access === 'owner'
    && identity.billingAccount.runtime.ownerId === scope.ownerId
    && identity.billingAccount.runtime.resourceId === (record.placement.kind === 'cloud' ? scope.ownerId : device.id)
    && subscriptions.length === 1 && UUID.test(subscription?.id ?? '')
    && subscription.ownerId === payerId && subscription.access === access
    && /^(0|[1-9][0-9]*)$/.test(subscription.revision ?? '')
    && payer.ownerId === payerId && payer.resourceId === subscription.id
    && run.agentProfile.version === profile.version && run.agentProfile.digest === profile.digest && run.agentProfile.source === 'explicit',
  owned ? 'owned_subscription_identity_mismatch' : 'shared_subscription_identity_mismatch')
  record.execution = { harness: run.harness, model: run.model, credentialType: run.credentialType,
    deviceId: device.id, subscriptionRoute: run.subscriptionRoute, identity: safeIdentity(identity),
    [owned ? 'ownedScope' : 'sharedScope']: { verified: true, requesterHash: sha(scope.ownerId).slice(0, 16), payerHash: sha(payerId).slice(0, 16),
      workspaceHash: owned ? scope.evidence.workspaceHash : scope.evidence.teamWorkspaceHash, connectionHash: sha(profile.model.source.connectionId).slice(0, 16),
      bindingHash: sha(subscription.id).slice(0, 16), connectionRevision: subscription.revision,
      profileVersion: profile.version, profileDigest: profile.digest, access } }
}

export async function cleanupCase(client, record, target, { timeoutMs = 60000, WebSocketImpl = globalThis.WebSocket, now = Date.now, preserveIssue = false } = {}) {
  const cleanup = record.cleanup ??= { status: 'running', errors: [] }
  const runIds = new Set(record.runId ? [record.runId] : [])
  let runsEnded = true, machinesEnded = true
  const step = async (name, operation) => {
    try { await operation(); cleanup[name] = true; return true }
    catch (error) { cleanup.errors.push({ step: name, code: safeError(error) }); return false }
  }
  const factoryCancelled = !record.issueId || await step('factoryCancelled', async () => {
    const listing = await client.json(`/api/factory/tasks?issueId=${record.issueId}`)
    assert(listing.issueId === record.issueId && Array.isArray(listing.tasks), 'factory_list_invalid')
    for (const item of listing.tasks) {
      assert(item.issueId === record.issueId && UUID.test(item.id), 'cleanup_scope_mismatch')
      const snapshot = await client.json(`/api/factory/tasks/${item.id}`)
      assert(snapshot.task?.issueId === record.issueId, 'cleanup_scope_mismatch')
      for (const attempt of snapshot.attempts ?? []) if (UUID.test(attempt.runId ?? '')) runIds.add(attempt.runId)
      if (!['passed', 'cancelled', 'revoked'].includes(snapshot.task.status)) await client.json(`/api/factory/tasks/${item.id}`, post({
        binding: { taskId: item.id, revision: snapshot.task.revision }, eventId: randomUUID(), action: 'cancel', reason: '测试 1505 startup measurement complete; stop only this test task.' }))
    }
  })
  // A normal stop on the original run also stops its later attempts. Keep any
  // discovered child IDs for failure recovery without issuing duplicate stops.
  const initialRunIds = [...runIds], chainRoots = [], handledRunIds = new Set()
  for (const runId of initialRunIds) {
    if (handledRunIds.has(runId)) continue
    chainRoots.push(runId)
    const stopped = await step(`runStopped_${runId}`, async () => {
      const ended = detail => {
        const attempts = cleanupAttempts(detail, runId)
        for (const attempt of attempts) { runIds.add(attempt.runId); handledRunIds.add(attempt.runId) }
        return attempts.every(attempt => TERMINAL.has(attempt.status))
      }
      const detail = await client.rpc('agents.getIssueThread', [record.issueId, runId])
      if (ended(detail)) return
      try { await client.rpc('agents.stopRun', [runId]) }
      catch (error) {
        // Completion racing a stop legitimately returns runChainEnded (409).
        // Confirm the owned run ended; never swallow an unrelated stop error.
        const latest = await client.rpc('agents.getIssueThread', [record.issueId, runId])
        if (!ended(latest)) throw error
        return
      }
      // An accepted stop only records stopRequestedAt. Both placements must
      // observe the complete server-resolved chain's real terminal update.
      await watchRun(client, { issueId: record.issueId, runId },
        Math.min(timeoutMs, 60000), WebSocketImpl, now, runIds)
    })
    if (!stopped) runsEnded = false
  }
  if (target === 'cloud') {
    cleanup.machines = []
    // An adopted old row is already ended and no longer owns the sandbox.
    // End every discovered attempt through the normal owner API; its response
    // is acknowledged only after provider retirement (or a no-resource row).
    for (const runId of runIds) {
      const receipt = { runId, requestedAt: iso(now()), outcome: 'unconfirmed' }
      cleanup.machines.push(receipt)
      const ended = await step(`machineEnded_${runId}`, async () => {
        try {
          const result = await client.json(`/api/threads/${runId}/machine`, post({ action: 'end' }), 120000)
          assert(result?.runId === runId && result.state === 'ended', 'cleanup_machine_unconfirmed')
          receipt.outcome = 'ended'; receipt.state = result.state
        } catch (error) { receipt.outcome = 'failed'; receipt.code = safeError(error); throw error }
        finally { receipt.finishedAt = iso(now()) }
      })
      if (!ended) machinesEnded = false
    }
    // This is one bounded readback per resolved chain, not a poll. It sees the
    // latest owner, including an adopted VM, and maps ended-with-resources to
    // error. A null/ended view alone never substitutes for the end receipts.
    for (const runId of chainRoots) {
      const verified = await step(`machineVerified_${runId}`, async () => {
        const machine = await client.rpc('agents.getThreadMachine', [record.issueId, runId])
        const view = { runId, observedAt: iso(now()), kind: ['cloud', 'laptop', 'server'].includes(machine?.kind) ? machine.kind : null,
          state: ['online', 'offline', 'starting', 'running', 'paused', 'restore', 'ended', 'error'].includes(machine?.state) ? machine.state : null,
          sandboxIdHash: typeof machine?.cloud?.sandboxId === 'string' ? sha(machine.cloud.sandboxId).slice(0, 16) : null }
        cleanup.machineViews ??= []
        cleanup.machineViews.push(view)
        assert(machine?.kind === 'cloud' && machine.state === 'ended' && machine.cloud === null, 'cleanup_machine_unconfirmed')
      })
      if (!verified) machinesEnded = false
    }
  }
  // Failed Factory cancellation can leave a producer able to create another
  // attempt. Keep the issue accessible for recovery even if known runs ended.
  if (record.issueId && !preserveIssue && runsEnded && factoryCancelled && machinesEnded) await step('taskDeleted', async () => {
    const { issue } = await client.rpc('issues.getIssue', [record.issueId])
    assert(issue?.id === record.issueId && issue.title === record.title, 'cleanup_scope_mismatch')
    await client.rpc('issue-operations.setIssueDeleted', [{ id: issue.id, revision: issue.revision }])
  })
  if (preserveIssue) cleanup.taskRetained = true
  if (preserveIssue || !runsEnded || !factoryCancelled || !machinesEnded || cleanup.errors.length) cleanup.retainedFixture = { issueId: record.issueId, runIds: [...runIds] }
  cleanup.status = cleanup.errors.length ? 'failed' : 'passed'
}

/** One owned repository task, for the candidate-template CI gate as well as the
 * production measurement. The caller supplies a normal authenticated client
 * {request, json, rpc}, a dedicated test Bot and an authorized fixed Profile.
 * Profiles, account sessions and candidate devices remain the caller's scope.
 * Returns sanitized evidence even on failure, after cleaning only this issue. */
export async function runSubscriptionCase({ client, botId, profileId, profile, scope, harness, model = MODELS[harness],
  deviceId, agentId, sourceCommit, expectedBuild, repository = REPOSITORY, titlePrefix = '测试 1505',
  sampleId = randomUUID(), timeoutMs = 240000, requireReply = true, minToolCalls = deviceId ? 0 : 1,
  runtimeEvidence: runtimeEvidenceMode = 'optional', officialTiming = 'disabled',
  now = Date.now, WebSocketImpl = globalThis.WebSocket, pinBuild, leaseAudit = false, onCandidateRunQueued, createCaseProbe, onFixture }) {
  assert(client && ['request', 'json', 'rpc'].every(key => typeof client[key] === 'function'), 'client_required')
  assert(UUID.test(botId ?? '') && UUID.test(profileId ?? ''), 'fixture_required')
  const owned = scope?.actor === OWNED_CODEX_ACTOR
  assert(scope?.ownerId && (owned ? scope.evidence?.kind === 'personal' && scope.evidence.membershipVerified === true
    : scope.adminId && scope.ownerId !== scope.adminId) && scope.botId === botId
    && UUID.test(scope.workspaceId ?? '') && profile?.id === profileId && /^[a-f0-9]{64}$/.test(profile.digest ?? ''),
  owned ? 'owned_workspace_mismatch' : 'shared_scope_required')
  assert(Object.hasOwn(MODELS, harness) && model === MODELS[harness], 'model_invalid')
  assert(!owned || harness === 'codex', 'owned_actor_model_invalid')
  assert(repository === REPOSITORY && titlePrefix.includes('测试') && titlePrefix.length <= 80, 'fixture_scope_invalid')
  assert(/^[A-Za-z0-9_-]{1,80}$/.test(sampleId), 'sample_id_invalid')
  assert((!deviceId && !agentId) || (UUID.test(deviceId ?? '') && UUID.test(agentId ?? '')), 'candidate_target_invalid')
  assert(onCandidateRunQueued === undefined || typeof onCandidateRunQueued === 'function' && deviceId && agentId, 'candidate_target_invalid')
  const record = { sampleId, harness, requestedModel: model, title: `${titlePrefix} ${sampleId} ${harness}`,
    profileId, requireReply, minToolCalls, requireRuntimeReceipt: runtimeEvidenceMode === 'required' || Boolean(deviceId), requireAgentAcceptance: Boolean(deviceId), requireTerminal: Boolean(deviceId) || leaseAudit, requireOfficialTiming: officialTiming === 'enabled',
    requireReplyAfterTool: minToolCalls > 0 && (Boolean(deviceId) || runtimeEvidenceMode === 'required' || leaseAudit),
    stages: [], status: 'running', phase: 'build_pin', ...(sourceCommit ? { sourceCommit } : {}) }
  const pin = pinBuild ?? (async () => {
    const { build } = await client.json('/api/version')
    assert(typeof build === 'string' && (!expectedBuild || build === expectedBuild), 'build_mismatch')
    assert(!record.build || build === record.build, 'build_changed'); record.build = build
  })
  let initialPinPassed = false, finalPinAttempted = false, probe
  try {
    if (createCaseProbe) {
      probe = await createCaseProbe({ client, record, scope, now })
      assert(typeof probe?.instructions === 'string' && probe.instructions.length > 0 && probe.instructions.length <= 10000
        && ['createIssue', 'observe', 'afterRelease'].every(key => typeof probe[key] === 'function'), 'fixture_scope_invalid')
      record.requireReplyAfterTool = true
    }
    await pin()
    initialPinPassed = true
    record.phase = 'session_identity'
    const identity = await client.json('/api/auth/get-session')
    assert(identity.user?.id === scope.ownerId && (owned ? isOwnedCodexEmail(identity.user.email) : isSmokeAccountEmail(identity.user.email)), 'session_identity_mismatch')
    record.phase = 'workspace_identity'
    const workspace = await client.json('/api/workspace')
    assert(workspace.currentUserId === scope.ownerId && workspace.workspace?.id === scope.workspaceId, 'workspace_identity_mismatch')
    record.phase = 'bot_identity'
    const bot = await client.json(`/api/bots/${botId}`)
    assert(bot.id === botId && /^测试\s*1505(?:\s|$)/.test(bot.name ?? ''), 'test_bot_required')
    record.phase = 'chat_model_selection'
    await chooseSharedChatModel(client, botId, harness, owned)
    record.phase = 'issue_create'
    const leaseDriver = leaseAudit ? await import('./cloud-lease-audit.mjs') : null
    const leaseInstructions = leaseDriver ? await leaseDriver.leaseAuditInstructions(sampleId, harness) : ''
    const issueInput = { title: record.title, status: 'todo', priority: 'low', content: {
      type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Read one line of README in ${REPOSITORY} and reply STARTUP_OK_${sampleId}. Read only; no files, branches, commits, PRs, external messages, or additional agents.\n${leaseInstructions}` }] }],
    } }
    const created = probe ? await probe.createIssue(issueInput) : await client.rpc('issues.saveIssue', [issueInput])
    assert(UUID.test(created.issue?.id ?? ''), 'issue_create_failed'); record.issueId = created.issue.id
    await onFixture?.({ kind: 'issue', id: record.issueId, profileId })
    await dispatchThroughCoordinator(client, record, { botId, profileId, deviceId, agentId, timeoutMs, leaseAudit, probe }, now)
    await onFixture?.({ kind: 'run', id: record.runId, issueId: record.issueId, profileId })
    record.phase = 'coordinator_stop'
    await client.rpc('coordinator.stopCoordinatorTurn', [botId])
    record.coordinatorStopped = true
    record.phase = 'subscription_proof'
    await subscriptionProof(client, record, scope, profile)
    if (onCandidateRunQueued) {
      record.phase = 'bootstrap_publication'
      try {
        record.bootstrapPublication = await onCandidateRunQueued({ runId: record.runId, issueId: record.issueId,
          deviceId, agentId, workspaceId: scope.workspaceId, harness, model })
        const published = record.bootstrapPublication
        assert(published?.version === 1 && published.runId === record.runId && published.harness === harness
          && /^[a-f0-9]{64}$/.test(published.bootstrapSha256 ?? '') && /^[a-f0-9]{64}$/.test(published.hintSha256 ?? ''), 'bootstrap_publication_failed')
      } catch (error) { fail('bootstrap_publication_failed', error) }
    }
    record.phase = 'execution_watch'
    await watchRun(client, record, timeoutMs, WebSocketImpl, now, undefined, leaseDriver || probe ? {
      ...(probe?.signal ? { signal: probe.signal } : {}),
      observe: async (detail, live) => {
        const complete = observeChunks(record, detail, now())
        if (leaseDriver) record.leaseAudit = leaseDriver.leaseAuditReceipt(detail.chunks, record.runId, harness)
        const probeComplete = probe ? await probe.observe(detail, live) : true
        return complete && probeComplete
      },
    } : undefined)
    record.phase = 'subscription_proof'
    await subscriptionProof(client, record, scope, profile)
    record.phase = 'build_pin'
    finalPinAttempted = true
    await pin()
    record.phase = 'execution_receipt'
    if (runtimeEvidenceMode === 'required') assert(record.runtimeEvidence?.status === 'passed', 'runtime_evidence_failed')
    if (record.requireAgentAcceptance) assert(record.runtimeTiming?.agentAccepted?.kind === (harness === 'claude_code' ? 'claude_user_ack' : 'codex_turn_start_ack'), 'official_agent_acceptance_missing')
    if (!deviceId && (runtimeEvidenceMode === 'required' || officialTiming === 'enabled')) assert(hasStartupInitialization(record), 'daemon_startup_timing_incomplete')
    record.observed = { messageToAgentStartMs: dateValue(record.agentStart.observedAt) - dateValue(record.messageSubmittedAt),
      toolObservedToAgentStartMs: dateValue(record.agentStart.observedAt) - dateValue(record.dispatchObservedAt),
      toolObservedToFirstProviderMs: dateValue(record.firstProviderChunk.observedAt) - dateValue(record.dispatchObservedAt),
      warning: 'tool stream reception can lag dispatch; these are observations, not the <=5s gate' }
    record.credentialRoute = 'subscription'
    record.status = 'execution_proved_awaiting_server_timing'
  } catch (error) {
    record.status = 'failed'; record.failure = startupFailure(error, record.phase); record.error = record.failure.code
  }
  finally {
    // A failed execution still needs its closing version observation. Keep the
    // original failure, and do not repeat a pin already attempted on success.
    if (initialPinPassed && !finalPinAttempted) {
      try { await pin() }
      catch (error) { record.versionPinFailure = startupFailure(error, 'build_pin'); record.status = 'failed' }
    }
    if (record.messageSubmittedAt && !record.coordinatorStopped) {
      try { await client.rpc('coordinator.stopCoordinatorTurn', [botId]); record.coordinatorStopped = true }
      catch (error) {
        record.status = 'failed'; record.stopFailure = startupFailure(error, 'coordinator_stop'); record.stopError = record.stopFailure.code
        record.failure ??= record.stopFailure; record.error ??= record.failure.code
      }
    }
    await cleanupCase(client, record, deviceId ? 'device' : 'cloud', { timeoutMs, WebSocketImpl, now, ...(probe ? { preserveIssue: true } : {}) })
    if (probe) {
      try { await probe.afterRelease() }
      catch (error) {
        record.status = 'failed'
        record.cleanup.status = 'failed'
        record.cleanup.errors.push({ step: 'case_probe_after_release', code: safeError(error) })
      }
    }
    if (record.cleanup.status !== 'passed' && !record.failure) {
      record.failure = startupFailure(new Error(record.cleanup.errors[0]?.code), 'cleanup'); record.error = record.failure.code
    }
  }
  return record
}

export async function runCloudStartup(options, { env = process.env, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now,
  readWorkerRelease = () => readProductionWorkerRelease({ token: env.VERCEL_TEAM_TOKEN, fetchImpl }), onCandidateRunQueued, createCaseProbe, caseProfileInstructions, onFixture } = {}) {
  const actor = options.actor ?? 'shared_smoke', owned = actor === OWNED_CODEX_ACTOR
  assert(owned || actor === 'shared_smoke', 'acceptance_actor_invalid')
  assert(!owned || options.harness === 'codex', 'owned_actor_model_invalid')
  const { email, password } = owned ? ownedCodexAccount(env) : smokeAcceptanceAccount(env)
  assert(typeof WebSocketImpl === 'function', 'node_websocket_required')
  const client = createSessionClient(options.origin, fetchImpl), fixtureId = randomUUID()
  const report = { schemaVersion: 1, issue: 1505, actor, fixtureId, startedAt: iso(now()), mode: options.mode,
    origin: options.origin, repository: REPOSITORY, requestedStrategy: options.strategy,
    strategyEvidence: 'operator_label_requires_template_or_pool_log_evidence', revision: options.revision ?? null,
    target: options.deviceId ? 'candidate_device' : 'cloud', maxStartupMs: options.maxStartupMs,
    timingMethod: 'dispatch_run_entry to later of agent_start database receipt and actual official task acceptance; missing entry boundary is legacy lower-bound evidence only',
    executionGate: options.runtimeEvidence === 'required' ? 'later_of_agent_start_and_actual_official_cli_acceptance' : 'legacy_agent_start_actual_ack_unavailable',
    samples: [], cleanup: { errors: [] }, status: 'running', phase: 'build_pin' }
  const profiles = new Map()
  let botId = options.botId, loggedIn = false, testBotValidated = false, timingVariableId, scope, originalWorkspaceId, ownerId
  const pin = async () => {
    const { build } = await client.json('/api/version')
    assert(typeof build === 'string' && build.length <= 200, 'build_missing')
    assert(!options.expectedBuild || build === options.expectedBuild, 'build_mismatch')
    assert(!report.build || report.build === build, 'build_changed')
    report.build = build
    if (options.expectedWorkerSha) {
      const release = await readWorkerRelease()
      assert(release.workerSha === options.expectedWorkerSha && release.sourceCommit === options.expectedWorkerSource, 'worker_release_mismatch')
      assert(!report.workerRelease || JSON.stringify(release) === JSON.stringify(report.workerRelease.configuration), 'worker_release_changed')
      report.workerRelease ??= { configuration: release, evidence: 'production_configuration_pin_requires_per_run_runtime_log_confirmation', checks: 0 }
      report.workerRelease.checks++
    }
  }
  try {
    await pin()
    report.phase = 'sign_in'
    const login = await client.request('/api/auth/sign-in/email', post({ email, password, rememberMe: false }))
    assert(login.ok, 'sign_in_failed'); loggedIn = true
    report.phase = 'session_identity'
    const identity = await client.json('/api/auth/get-session')
    assert(identity.user?.email?.toLowerCase() === email.toLowerCase() && typeof identity.user.id === 'string' && identity.user.id.length > 0, 'session_identity_mismatch')
    ownerId = identity.user.id
    report.accountHash = sha(identity.user.id).slice(0, 16)
    report.phase = owned ? 'workspace_selection' : 'team_selection'
    scope = await (owned ? selectOwnedCodexWorkspace : selectAcceptanceTeam)(client, { ownerId, workspace: options.workspace }, value => { originalWorkspaceId = value })
    if (owned) report.workspace = scope.evidence
    else report.team = scope.evidence
    report.phase = 'timing_configuration'
    if (options.officialTiming === 'enabled') {
      if (options.mode === 'candidate') {
        assert(UUID.test(options.deviceId ?? '') && UUID.test(options.agentId ?? ''), 'candidate_target_invalid')
        // acceptance-daemon opts in through the trusted host; the real CLI/MCP
        // receipt still gates success. The runner closes its per-run collector,
        // and this path owns no workspace variable requiring admin deletion.
        report.officialTiming = { enabled: true, source: 'trusted_host', scope: 'candidate_device', variableCreated: false, cleaned: true }
      } else if (options.mode === 'acceptance') {
        // An operator pins this dedicated Bot/repository in a short-lived
        // deployment window. The existing authorized claim opts in matching
        // read-only subscription tasks; this member writes no workspace env.
        // The window covers that Bot/repository, not one uniquely granted run.
        assert(UUID.test(options.botId ?? ''), 'diagnostic_bot_required')
        report.officialTiming = { enabled: true, source: 'trusted_claim', scope: 'dedicated_bot_repository_window',
          botId: options.botId, variableCreated: false, cleaned: true }
      } else {
        const listed = await client.rpc('workspace-secrets.listSecrets', [scope.workspaceId])
        assert(listed?.role === 'admin', 'timing_variable_cleanup_forbidden')
        assert(Array.isArray(listed.secrets) && !listed.secrets.some(item => item.name === 'CLOUD_STARTUP_TIMING'), 'timing_variable_exists')
        const created = await client.rpc('workspace-secrets.createSecret', [{ name: 'CLOUD_STARTUP_TIMING', kind: 'env', value: '1',
          note: `测试1505 ${fixtureId}`, scope: { type: 'repository', repository: REPOSITORY } }, scope.workspaceId])
        assert(UUID.test(created.id ?? ''), 'timing_variable_create_failed')
        timingVariableId = created.id
        report.officialTiming = { enabled: true, variableId: timingVariableId, scope: 'acceptance_repository_only' }
      }
    }
    report.phase = 'bot_create'
    const fixture = await acceptanceBot(client, botId, fixtureId)
    botId = fixture.botId
    if (fixture.created) await onFixture?.({ kind: 'bot', id: botId })
    if (fixture.created) report.createdBotId = botId
    report.botRetention = fixture.retention
    scope.botId = botId
    testBotValidated = true
    report.botId = botId
    report.phase = 'profile_selection'
    const order = await client.rpc('model-order.getModelOrder', [scope.workspaceId])
    const harnesses = options.harness === 'both' ? ['claude_code', 'codex'] : [options.harness]
    for (const harness of harnesses) {
      let phase = 'profile_selection'
      try {
        const candidates = (order.candidates ?? []).filter(item => item.harness === harness && item.model === MODELS[harness]
          && item.source?.kind === 'subscription' && UUID.test(item.source.connectionId ?? ''))
        assert(candidates.length === 1 && candidates[0].credentialOwnerId === (owned ? scope.ownerId : scope.adminId),
          owned ? 'owned_subscription_model_missing_or_ambiguous' : 'shared_subscription_model_missing_or_ambiguous')
        const candidate = candidates[0]
        phase = 'profile_create'
        const created = await client.json('/api/factory/agent-profiles', post({ workspaceId: scope.workspaceId, requestId: randomUUID(), profile: {
          name: `测试1505 ${fixtureId.slice(0, 8)} ${harness}`, description: 'Temporary startup measurement', enabled: true,
          harness, model: { mode: 'fixed', harness, model: MODELS[harness], source: candidate.source }, effort: 'low', roles: [],
          instructions: caseProfileInstructions ?? 'This is a read-only startup test. Do not modify files, commit, push, create a PR, send external messages, or spawn agents.', skills: [],
        } }))
        phase = 'profile_validation'
        assert(UUID.test(created.profile?.id ?? '') && Number.isInteger(created.profile.version) && created.profile.version > 0, 'profile_create_failed')
        profiles.set(harness, created.profile)
        await onFixture?.({ kind: 'profile', id: created.profile.id, harness, workspaceId: scope.workspaceId })
        assert(/^[a-f0-9]{64}$/.test(created.profile.digest ?? '') && created.profile.harness === harness
          && created.profile.model?.mode === 'fixed' && created.profile.model.harness === harness && created.profile.model.model === MODELS[harness]
          && created.profile.model.source?.kind === 'subscription' && created.profile.model.source.connectionId === candidate.source.connectionId, 'profile_source_mismatch')
      } catch (error) {
        const failure = startupFailure(error, phase)
        profiles.set(harness, { ...profiles.get(harness), error: failure.code, failure })
      }
    }
    for (let index = 0; index < options.runs; index++) {
      const harness = harnesses[index % harnesses.length], sampleId = `${fixtureId.slice(0, 8)}_${index + 1}`
      const profile = profiles.get(harness)
      if (profile?.error) {
        report.samples.push({ sampleId, harness, status: 'failed', error: profile.error, failure: profile.failure, cleanup: { status: 'passed', errors: [] } })
        continue
      }
      report.phase = 'profile_validation'
      const sample = await runSubscriptionCase({ client, ...options, botId, profileId: profile.id, profile, scope, harness, sampleId,
        sourceCommit: options.revision, pinBuild: pin, now, WebSocketImpl, onCandidateRunQueued, createCaseProbe, onFixture })
      report.samples.push(sample)
      const versionFailure = sample.versionPinFailure?.code ?? (['startup_build_mismatch', 'startup_build_changed',
        'startup_worker_release_mismatch', 'startup_worker_release_changed'].includes(sample.error) ? sample.error : null)
      if (versionFailure) {
        report.batchAborted = 'version_pin_changed'
        report.phase = 'build_pin'
        fail(versionFailure.slice('startup_'.length))
      }
    }
    report.phase = 'build_pin'
    await pin()
  } catch (error) { report.failure = startupFailure(error, report.phase); report.error = report.failure.code }
  finally {
    if (loggedIn) {
      if (timingVariableId) {
        try { await client.rpc('workspace-secrets.deleteSecret', [{ id: timingVariableId }, scope.workspaceId]); report.officialTiming.cleaned = true }
        catch (error) { report.cleanup.errors.push({ step: 'timing_variable_delete', id: timingVariableId, code: safeError(error) }) }
      }
      for (const profile of profiles.values()) if (profile.id) {
        try { await client.json(`/api/factory/agent-profiles/${profile.id}`, { ...post({ workspaceId: scope.workspaceId, version: profile.version }), method: 'DELETE' }) }
        catch (error) { report.cleanup.errors.push({ step: 'profile_archive', id: profile.id, code: safeError(error) }) }
      }
      if (testBotValidated) {
        try { await client.rpc('coordinator.stopCoordinatorTurn', [botId]) }
        catch (error) { report.cleanup.errors.push({ step: 'stop_test_bot', code: safeError(error) }) }
      }
      if (originalWorkspaceId) {
        try { await restoreAcceptanceWorkspace(client, ownerId, originalWorkspaceId); report.cleanup.workspaceRestored = true }
        catch (error) { report.cleanup.errors.push({ step: 'workspace_restore', code: safeError(error) }) }
      }
      try { const response = await client.request('/api/auth/sign-out', post({})); assert(response.ok, 'sign_out_failed') }
      catch (error) { report.cleanup.errors.push({ step: 'sign_out', code: safeError(error) }) }
    }
    client.clear()
  }
  report.finishedAt = iso(now())
  report.status = report.error || report.cleanup.errors.length || report.samples.length !== options.runs
    || report.samples.some(sample => sample.status === 'failed' || sample.cleanup.status !== 'passed') ? 'failed'
      : options.mode === 'candidate' && report.samples.every(sample => sample.replyVerified) ? 'candidate_subscription_proved'
        : 'awaiting_server_timings'
  return report
}

/** Match unambiguously, never infer a dispatch timestamp from a tool preview.
 * Input is a JSON array of sanitized dispatch_timing log objects; no Vercel
 * credentials, request headers or raw application log envelopes are needed. */
export function alignServerTimings(report, timings) {
  assert(Array.isArray(timings), 'timings_invalid')
  const clean = timings.filter(item => item?.msg === 'dispatch_timing' && (typeof item.workflowRunId === 'string' || item.workflowRunId === null)
    && Number.isSafeInteger(item.startedAt) && Number.isSafeInteger(item.endedAt) && item.endedAt >= item.startedAt
    && Number.isFinite(item.totalMs) && item.failed === false)
  for (const sample of report.samples) {
    if (!sample.agentStart || !sample.firstProviderChunk) continue
    const owned = timings.filter(item => item?.msg === 'cloud_startup_timing' && item.stage === 'cloud.thread.ensure'
      && item.runIdHash === sample.runIdHash && Number.isSafeInteger(item.startedAt) && Number.isSafeInteger(item.endedAt))
    const containsOwnedRun = item => owned.some(run => run.startedAt >= item.startedAt && run.endedAt <= item.endedAt)
    // Native Eve business tools execute on the product API host, outside the
    // agent Workflow world. A null runtime id requires the owned run's exact
    // server interval; session names and runner reception clocks cannot replace it.
    let matching = clean.filter(item => item.workflowRunId === sample.workflowRunId
      || sample.eveSessionId && item.workflowRunId === null && containsOwnedRun(item))
    // One durable workflow can dispatch several chat turns. Correlate using
    // the owned run's server-side ensure interval, never runner wall clocks.
    if (matching.length > 1) {
      if (owned.length) matching = matching.filter(containsOwnedRun)
    }
    if (matching.length !== 1) { sample.timing = { status: 'unavailable', reason: matching.length ? 'ambiguous_dispatch' : 'dispatch_log_missing' }; continue }
    const log = matching[0], end = dateValue(sample.agentStart.storedAt), provider = dateValue(sample.firstProviderChunk.storedAt)
    if (![end, provider].every(Number.isFinite) || end < log.startedAt || provider < end) {
      sample.timing = { status: 'unavailable', reason: 'clock_or_receipt_invalid' }; continue
    }
    // Anchor to the database's conservative stage receipt and add only the
    // later CLI event's same-process monotonic offset. Never subtract clocks
    // on different machines to manufacture a faster execution time.
    const runtime = sample.runtimeTiming
    const acceptedKind = runtime?.harness === 'claude_code' ? 'claude_user_ack' : 'codex_turn_start_ack'
    const acceptanceOffset = runtime?.agentAccepted?.kind === acceptedKind && Number.isFinite(runtime.executionStartMs)
      ? Math.max(0, runtime.agentAccepted.ms - runtime.executionStartMs) : null
    const executionEnd = acceptanceOffset === null ? end : end + acceptanceOffset
    const dispatchBoundary = log.boundary === 'dispatch_run_entry' ? 'dispatch_run_entry' : 'legacy_dispatch_body'
    sample.timing = { status: 'aligned', source: 'server_dispatch_log_to_database_receipt', stepId: log.stepId ?? null,
      dispatchBoundary, dispatchBoundaryVerified: dispatchBoundary === 'dispatch_run_entry',
      dispatchStartedAt: iso(log.startedAt), dispatchEndedAt: iso(log.endedAt), dispatchCallMs: log.totalMs,
      dispatchToAgentStartMs: end - log.startedAt, dispatchToFirstProviderChunkMs: provider - log.startedAt,
      actualAgentAcceptance: acceptanceOffset === null ? 'unavailable_on_legacy_worker' : 'official_event_observed',
      ...(acceptanceOffset === null ? {} : { agentAcceptanceAfterStageMs: acceptanceOffset,
        dispatchToExecutionStartMs: executionEnd - log.startedAt, executionTimeSource: 'stage_database_receipt_plus_monotonic_offset_upper_bound' }),
      phases: Array.isArray(log.phases) ? log.phases.filter(phase => /^[A-Za-z0-9_.]+$/.test(phase.phase ?? '') && Number.isFinite(phase.ms))
        .map(({ phase, ms }) => ({ phase, ms })) : [], withinTarget: dispatchBoundary === 'dispatch_run_entry'
          && acceptanceOffset !== null && executionEnd - log.startedAt <= report.maxStartupMs }
  }
  const complete = !report.error && !report.cleanup.errors.length && report.samples.length > 0
    && report.samples.every(sample => sample.status !== 'failed' && sample.execution?.credentialType === 'subscription' && sample.agentStart
      && (!sample.requireRuntimeReceipt || sample.runtimeEvidence?.status === 'passed')
      && sample.firstProviderChunk && sample.cleanup?.status === 'passed' && (report.mode === 'candidate'
        ? sample.replyVerified : sample.timing?.status === 'aligned'))
  report.status = !complete ? 'failed' : report.mode === 'baseline' ? 'baseline_recorded'
    : report.mode === 'candidate' ? 'candidate_subscription_proved'
      : report.target === 'cloud' && report.samples.length >= 3 && report.samples.every(sample => sample.timing.withinTarget) ? 'passed' : 'failed'
  return report
}

const HELP = `Cloud startup acceptance (#1505)\n\nNormal live run (SMOKE_OWNER_EMAIL/PASSWORD in environment, verified shared team selected automatically):\n  node scripts/acceptance/cloud-startup.mjs --runs 6 --harness both --mode baseline --strategy official --output report.json\n\nProduction acceptance also requires --expected-build BUILD --revision COMMIT.\n--expected-worker-sha HASH --expected-worker-source COMMIT uses VERCEL_TEAM_TOKEN for read-only configuration pins before and after each run. Actual runtime SHA requires the corresponding startup log evidence.\n--strategy official|derived|pool|combined is an operator label, not template proof.\n--mode candidate --runs 1 --harness codex --device-id UUID --agent-id UUID validates a candidate's normal subscription path; it is not cloud latency acceptance.\n\nOffline alignment after extracting matching dispatch_timing logs:\n  node scripts/acceptance/cloud-startup.mjs --align-report report.json --dispatch-timings timings.json --output aligned.json\n\nOptions: --origin HTTPS_ORIGIN --workspace UUID (optional verified-team pin) --bot-id UUID --timeout-ms 240000 --max-startup-ms 5000\nNo login credentials, cookies, provider output, or live tickets are written.\n`

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let output
  try {
    const options = parseOptions(process.argv.slice(2))
    if (options.help) console.log(HELP)
    else {
      output = resolve(options.output)
      let report = options.alignReport
        ? alignServerTimings(JSON.parse(await readFile(options.alignReport, 'utf8')), JSON.parse(await readFile(options.dispatchTimings, 'utf8')))
        : await runCloudStartup(options)
      if (!options.alignReport && options.dispatchTimings) report = alignServerTimings(report, JSON.parse(await readFile(options.dispatchTimings, 'utf8')))
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
      console.log(JSON.stringify({ status: report.status, samples: report.samples.length, report: output }))
      if (report.status === 'failed' || (options.mode === 'acceptance' && report.status !== 'passed')) process.exitCode = 1
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: safeError(error), ...(output ? { report: output } : {}) }))
    process.exitCode = 1
  }
}
