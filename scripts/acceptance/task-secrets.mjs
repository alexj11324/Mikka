#!/usr/bin/env node
import { observeEveSession } from './eve-session.mjs'
/** #1712: normal smoke-owner native Git/gh and both official subscriptions.
 * The additional HTTP leg runs the exact data-plane/bridge source against an
 * isolated random key in a disposable E2B fixture. It is not production-store
 * or production-claim canary evidence. A separately selected manual canary
 * mode uses one new private synthetic entry in an operator-reserved window.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chooseSharedChatModel, cleanupCase, createSessionClient, observeChunks, restoreAcceptanceWorkspace,
  sampledRequestTrace, selectAcceptanceTeam, smokeAcceptanceAccount, startupFailure, subscriptionProof, watchRun } from './cloud-startup.mjs'
import { CASES, issueInventory } from './run-observability.mjs'
import { isExactNativeCommand } from './thread-lifecycle.mjs'
import { buildFixtureBundles, createIsolatedFixture } from './task-secrets-fixture.mjs'
import { assertDriverAttestation, attestAcceptance } from './task-secrets-ci.mjs'
import { canaryWindow, createProductionCanary } from './task-secrets-production-canary.mjs'

export const ORIGIN = 'https://app.aspectlylabs.com'
export const REPOSITORY = 'alexj11324/Mikka-handoff'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const TERMINAL = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Error(`task_secrets_${code}`) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const FAILURE_CODES = new Set(['configuration', 'main_workflow_required', 'build_mismatch', 'source_mismatch', 'worker_pin',
  'sign_in', 'identity', 'owner_busy', 'response', 'paid_fallback_enabled', 'github_unavailable', 'subscription_unavailable',
  'profile', 'bot', 'issue', 'dispatch', 'multiple_dispatches', 'thread', 'receipt', 'canary_visible', 'runtime',
  'fixture', 'cleanup', 'production_canary_requires_review', 'failed',
  'canary_window', 'canary_database_unavailable', 'canary_scope', 'canary_idle_unverified',
  'canary_metadata', 'canary_fixture', 'canary_create', 'canary_cleanup', 'canary_revocation'])
export const safeFailure = error => {
  const own = /^task_secrets_([a-z_]+)$/.exec(error?.message ?? '')?.[1]
  return own && FAILURE_CODES.has(own) ? `task_secrets_${own}` : startupFailure(error).code
}

export function productionCanaryPlan() {
  return { executed: false, requiresSeparateReview: true,
    changes: ['create_one_owner_private_synthetic_protected_secret', 'configure_fixture_https_method_path_policy',
      'rotate_only_own_fixture_value', 'delete_only_created_fixture_ids'],
    impact: 'effective_secret_changes_stop_the_owners_active_runs_including_other_workspaces',
    prerequisites: ['full_owner_database_idle_read_before_each_write', 'reserved_owner_window', 'serialized_acceptance',
      'exact_served_build_and_worker', 'explicit_manual_production_canary_selection'],
    cleanup: 'stop_and_retire_owned_test_runs_then_delete_only_recorded_synthetic_secret_ids_and_verify_absence',
    excluded: ['vault_changes', 'real_credential_rotation', 'permission_changes', 'shared_secret_changes', 'direct_exposure'] }
}

export function readOptions(args = [], env = process.env, releaseAttestation) {
  check(args.every(item => ['--execute', '--production-canary'].includes(item)) && new Set(args).size === args.length, 'configuration')
  check(env.GITHUB_ACTIONS === 'true' && ['workflow_dispatch', 'workflow_run'].includes(env.GITHUB_EVENT_NAME)
    && env.GITHUB_REF === 'refs/heads/main', 'main_workflow_required')
  if (env.GITHUB_EVENT_NAME === 'workflow_run') assertDriverAttestation(env, releaseAttestation)
  const sourceCommit = env.APPLICATION_SHA
  check(SHA.test(sourceCommit ?? '') && sourceCommit === env.GITHUB_SHA, 'source_mismatch')
  const modelCase = env.TASK_SECRETS_MODEL_CASE ?? 'all'
  check(['all', 'claude', 'codex'].includes(modelCase), 'configuration')
  const execute = args.includes('--execute')
  const productionCanary = args.includes('--production-canary')
  if (productionCanary) check(execute && env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'configuration')
  if (env.GITHUB_EVENT_NAME === 'workflow_run') check(execute && modelCase === 'all' && !args.includes('--production-canary'), 'configuration')
  const workerSha = env.EXPECTED_WORKER_SHA, workerSourceCommit = env.EXPECTED_WORKER_SOURCE_SHA
  const templates = { claude_code: env.EXPECTED_CLAUDE_TEMPLATE, codex: env.EXPECTED_CODEX_TEMPLATE }
  if (execute) check(SHA.test(workerSha ?? '') && SHA.test(workerSourceCommit ?? '')
    && Object.values(templates).every(value => /^[A-Za-z0-9_-]{1,128}$/.test(value ?? '')), 'worker_pin')
  return { execute, sourceCommit, workerSha, workerSourceCommit, templates, modelCase,
    ...(env.GITHUB_EVENT_NAME === 'workflow_run' ? { releaseAttestation } : {}),
    productionCanary, ...(productionCanary ? { canaryWindow: canaryWindow(env) } : {}), timeoutMs: 480_000,
    reportPath: resolve('production-task-secrets-report/report.json') }
}

export function nativeCommand(config, bundleSha256) {
  check(UUID.test(config.caseId ?? '') && ['claude_code', 'codex'].includes(config.harness)
    && config.repository === REPOSITORY && DIGEST.test(bundleSha256), 'configuration')
  const origin = new URL(config.fixtureOrigin)
  check(origin.protocol === 'https:' && origin.origin === config.fixtureOrigin
    && /^[a-zA-Z0-9.-]+\.(?:e2b\.app|e2b\.dev)$/.test(origin.hostname), 'fixture')
  // Hash-check before running. The source contains only reviewed test code;
  // capabilities arrive later over the one-use run-bound fixture grant.
  return `python3 - <<'MIKKA_1712_PY'\n` + [
    'import hashlib, json, pathlib, subprocess, tempfile, urllib.request',
    `url = ${JSON.stringify(`${config.fixtureOrigin}/client.mjs`)}`,
    'with urllib.request.urlopen(url, timeout=20) as response:',
    '    assert response.status == 200',
    '    source = response.read(4194305)',
    `assert len(source) <= 4194304 and hashlib.sha256(source).hexdigest() == ${JSON.stringify(bundleSha256)}`,
    "with tempfile.TemporaryDirectory(prefix='mikka-1712-native-') as directory:",
    "    target = pathlib.Path(directory) / 'probe.mjs'",
    '    target.write_bytes(source)',
    `    subprocess.run(['node', str(target), ${JSON.stringify(JSON.stringify(config))}], check=True, timeout=300)`,
  ].join('\n') + '\nMIKKA_1712_PY'
}

function toolText(value) {
  if (typeof value === 'string') return value
  if (value?.exitCode !== undefined) return typeof value.output === 'string' ? value.output : null
  if (Array.isArray(value)) return value.filter(item => item?.type === 'text').map(item => item.text).join('\n')
  return null
}
const finite = value => Number.isFinite(value) && value >= 0 && value <= 1_000_000
const scan = value => value && typeof value.matched === 'boolean' && typeof value.truncated === 'boolean'
  && ['files', 'bytes', 'unavailable'].every(name => Number.isSafeInteger(value[name]) && value[name] >= 0)
  ? { matched: value.matched, truncated: value.truncated, files: value.files, bytes: value.bytes, unavailable: value.unavailable,
    scope: 'own_environment_parent_process_runtime_homes_worktree_bounded_scan' } : null

/** Only an exact native shell input/output pair counts, never model prose.
 * Every retained property is selected; arbitrary tool result keys are dropped. */
export function nativeReceipt(detail, expected, command) {
  const inputs = new Map(), receipts = []
  for (const item of detail.chunks ?? []) {
    const chunk = item.chunk, id = chunk?.toolCallId
    if (typeof id !== 'string' || id.length > 500) continue
    if (UUID.test(id.slice(0, 36)) && id[36] === ':' && id.slice(0, 36) !== expected.runId) continue
    if (chunk.type === 'tool-input-available' && ['bash', 'shell'].includes(chunk.toolName?.toLowerCase())
      && isExactNativeCommand(chunk.input?.command, command)) inputs.set(id, true)
    if (chunk.type !== 'tool-output-available' || !inputs.has(id)) continue
    const text = toolText(chunk.output)
    if (typeof text !== 'string' || text.length > 64_000) continue
    for (const line of text.split('\n').filter(line => line.startsWith('MIKKA_1712_NATIVE '))) {
      let value
      try { value = JSON.parse(line.slice('MIKKA_1712_NATIVE '.length)) } catch { continue }
      if (value.caseId !== expected.caseId || value.harness !== expected.harness || value.runId !== expected.runId) continue
      const before = scan(value.before), after = scan(value.after), git = value.github, http = value.http
      const production = expected.deliveryMode === 'production_claim' && expected.phase === 'fresh_claim'
      const branch = `acceptance/1712/${expected.caseId}/${expected.harness}`
      check(value.version === 1 && value.status === 'passed' && value.productionStoreMutated === production
        && before && after && !before.matched && !after.matched
        && value.runtime?.workerSha === expected.workerSha && value.runtime?.sourceCommit === expected.workerSourceCommit
        && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(value.runtime.node ?? ''), 'receipt')
      check(git?.branch === branch && git.filename === `acceptance-1712-${expected.caseId}.txt` && git.cleanup === true
        && SHA.test(git.commit ?? '') && SHA.test(git.defaultBranchBefore ?? '') && git.defaultBranchAfter === git.defaultBranchBefore
        && Number.isSafeInteger(git.draftPrNumber) && git.draftPrNumber > 0 && DIGEST.test(git.fileSha256 ?? '')
        && Number.isSafeInteger(git.fileBytes) && git.fileBytes > 0 && git.fileBytes < 1000
        && /^[a-f0-9]{16}$/.test(git.githubActorHash ?? '')
        && ['cloneMs', 'fetchMs', 'pushMs', 'draftPrMs'].every(name => finite(git.times?.[name])), 'receipt')
      const negativeCases = production ? ['method', 'path', 'echo', 'redirect', 'origin', 'authOverride']
        : ['method', 'path', 'echo', 'redirect', 'origin', 'authOverride', 'expired', 'crossRun', 'rotatedKey']
      if (production) check(http?.scope === 'production_store_actual_claim_inherited_bridge' && http.samples === 10
        && http.productionClaimTested === true && http.productionStoreRotationTested === true
        && http.sdk?.ordinaryTransport === true && http.sdk.customFetch === false && http.sdk.retries === 0
        && DIGEST.test(http.sdk.responseSha256 ?? '') && http.sdk.responseSha256 === expected.sdkResponseSha256 && http.sdk.finishReason === 'stop'
        && http.sdk.inputTokens === 2 && http.sdk.outputTokens === 3, 'receipt')
      else check(http?.scope === 'isolated_key_and_canary_real_egress_and_bridge_code' && http.samples === 10
        && http.productionClaimTested === false && http.productionStoreRotationTested === false
        && http.statuses?.expired === 410 && http.statuses.rotatedKey === 401, 'receipt')
      check(negativeCases.every(name => Number.isSafeInteger(http.statuses?.[name]) && http.statuses[name] >= 400 && http.statuses[name] <= 599)
        && ['direct', 'protected'].every(mode => finite(http[mode]?.p50Ms) && finite(http[mode]?.p95Ms)), 'receipt')
      receipts.push({ version: 1, caseId: expected.caseId, runId: expected.runId, harness: expected.harness,
        status: 'passed', nativeToolCallHash: hash(id).slice(0, 16), commandSha256: hash(command),
        runtime: { workerSha: value.runtime.workerSha, sourceCommit: value.runtime.sourceCommit, node: value.runtime.node },
        before, after, github: { branch, filename: git.filename, cleanup: true, commit: git.commit,
          defaultBranchBefore: git.defaultBranchBefore, defaultBranchAfter: git.defaultBranchAfter,
          draftPrNumber: git.draftPrNumber, fileSha256: git.fileSha256, fileBytes: git.fileBytes, githubActorHash: git.githubActorHash,
          times: Object.fromEntries(['cloneMs', 'fetchMs', 'pushMs', 'draftPrMs'].map(name => [name, git.times[name]])) },
        http: { scope: http.scope, client: production ? 'ordinary_installed_sdk_and_node_fetch' : 'node_fetch_base_url_dummy_key', samples: 10,
          baseline: 'same_fixture_public_unauthenticated_https_route', productionClaimTested: production, productionStoreRotationTested: production,
          ...(production ? { sdk: { ordinaryTransport: true, customFetch: false, retries: 0, responseSha256: http.sdk.responseSha256,
            finishReason: 'stop', inputTokens: 2, outputTokens: 3 } } : {}),
          statuses: Object.fromEntries(negativeCases.map(name => [name, http.statuses[name]])),
          direct: { p50Ms: http.direct.p50Ms, p95Ms: http.direct.p95Ms }, protected: { p50Ms: http.protected.p50Ms, p95Ms: http.protected.p95Ms } } })
    }
  }
  check(receipts.length <= 1, 'receipt')
  return receipts[0] ?? null
}

async function dispatch(client, record, profileId, botId, now) {
  const scope = record.phase === 'revocation'
    ? 'This revocation phase makes no Git or PR writes and waits for the owner to stop it by rotating its synthetic Secret.'
    : "The task describes the only authorized disposable Git branch and draft PR."
  const tool = { issueId: record.issueId, repo: REPOSITORY, target: 'cloud', profileId, readOnly: false,
    note: `Execute this test's exact native verification command once, then reply STARTUP_OK_${record.sampleId} if it completes. ${scope} Do not submit to Factory, merge, change main, spawn agents, or retry.` }
  const trace = sampledRequestTrace(); record.requestTraceId = trace.traceId
  record.messageSubmittedAt = new Date(now()).toISOString()
  await client.rpc('coordinator.sendCoordinatorMessage', [
    `执行已有测试任务 ${record.issueId}，只调用一次 dispatch_run，参数：${JSON.stringify(tool)}。使用指定 Profile，不变更模型、订阅或电脑，不创建另一任务。派发后只汇报 runId。`,
    null, botId, randomUUID(), { $mikka: 'undefined' }, null, [], { $mikka: 'undefined' }, profileId,
  ], { headers: { traceparent: trace.traceparent } })
  let call, completed = false
  await observeEveSession(client, botId, { fail: () => { check(false, 'dispatch') },
    onEvent: async event => {
      if (event.type === 'call.requested' && event.data.capability?.name === 'dispatch_run') {
        const input = event.data.input
        if (input?.issueId !== record.issueId || !input.note?.includes(`STARTUP_OK_${record.sampleId}`)) return false
        check(input.profileId === profileId, 'dispatch')
        check(!call || call === event.data.callId, 'multiple_dispatches'); call = event.data.callId
        record.dispatchObservedAt ??= new Date(now()).toISOString()
      }
      if (event.type !== 'call.settled' || !call || call !== event.data.callId) return false
      check(event.data.outcome === 'completed' && UUID.test(event.data.output?.runId ?? ''), 'dispatch')
      const { threads } = await client.rpc('agents.pollIssueThreads', [record.issueId])
      check(threads?.length === 1 && UUID.test(threads[0].id ?? '') && threads[0].ownedByCurrentUser === true && event.data.output.runId === threads[0].id, 'thread')
      record.runId = threads[0].id; record.runIdHash = hash(record.runId).slice(0, 16); record.placement = { kind: 'cloud' }
      record.dispatchReturnedAt = new Date(now()).toISOString(); completed = true
      return true
    },
  })
  check(completed, 'dispatch')
}

export async function runTaskSecretsAcceptance(options, { env = process.env, fetchImpl = fetch, now = Date.now,
  WebSocketImpl = globalThis.WebSocket, buildBundles = buildFixtureBundles, createFixture = createIsolatedFixture,
  sessionClient = createSessionClient, watch = watchRun, createCanary = createProductionCanary } = {}) {
  const report = { version: 1, issue: 1712, sourceCommit: options.sourceCommit, origin: ORIGIN,
    startedAt: new Date(now()).toISOString(), mode: options.productionCanary ? 'production_canary' : options.execute ? 'execute' : 'preflight', status: 'running',
    productionCanary: productionCanaryPlan(), productionStoreMutated: false,
    externalEvidenceStillRequired: ['production_claim_store_canary', 'PostHog_canary_absence', 'screenshots_checkpoints_templates', 'Factory_full_acceptance'],
    // Only the exact official publication has the trusted-host diagnostic
    // opt-in and strict zero-extra-authorization gate. These are references to
    // its one sample per harness, never measurements of the cases below.
    authorizationCensus: options.releaseAttestation ? {
      source: 'pinned_official_release', scope: 'candidate_subscription_execution', samplesPerHarness: 1, taskCases: 'not_measured',
      sourceCommit: options.releaseAttestation.sourceCommit, upstream: options.releaseAttestation.upstream,
      artifactId: options.releaseAttestation.artifact.id, reportSha256: options.releaseAttestation.reportSha256,
    } : { source: 'unavailable', reason: 'release_attestation_not_supplied', taskCases: 'not_measured' },
    ...(options.releaseAttestation ? { releaseAttestation: options.releaseAttestation } : {}), cases: [], cleanup: { errors: [] } }
  if (options.productionCanary && (!options.execute || !options.canaryWindow || !env.MIKKA_DATABASE_URL)) {
    report.status = 'blocked'; report.failure = options.canaryWindow ? 'task_secrets_canary_database_unavailable' : 'task_secrets_canary_window'; return report
  }
  const account = smokeAcceptanceAccount(env), client = sessionClient(ORIGIN, fetchImpl), fixtureId = randomUUID()
  const cases = CASES.filter(item => options.modelCase === 'all' || item.id === options.modelCase)
  const executions = options.productionCanary ? cases.flatMap(item => ['revocation', 'fresh_claim'].map(phase => ({ ...item, phase }))) : cases
  const rotations = new Map()
  let ownerId, scope, originalWorkspaceId, loggedIn = false, fixture, botId, canary
  const profiles = [], pin = async () => check((await client.json('/api/version')).build === options.sourceCommit, 'build_mismatch')
  try {
    await pin()
    const login = await client.request('/api/auth/sign-in/email', post({ ...account, rememberMe: false }))
    check(login.ok, 'sign_in'); loggedIn = true; await login.body?.cancel()
    const identity = await client.json('/api/auth/get-session')
    check(identity.user?.email?.toLowerCase() === account.email.toLowerCase() && typeof identity.user.id === 'string', 'identity')
    ownerId = identity.user.id; report.ownerHash = hash(ownerId).slice(0, 16)
    scope = await selectAcceptanceTeam(client, { ownerId }, value => { originalWorkspaceId = value })
    report.team = scope.evidence
    const [threads, tasks, keys, github, order] = await Promise.all([
      client.rpc('task-runs.pollThreads', []), client.rpc('task-runs.pollTaskRuns', []),
      client.json(`/api/settings/api-keys?workspace=${scope.workspaceId}`), client.json('/api/integrations/github'),
      client.rpc('model-order.getModelOrder', [scope.workspaceId]),
    ])
    check(Array.isArray(threads?.items) && Array.isArray(tasks?.items), 'response')
    check([...threads.items, ...tasks.items].every(item => TERMINAL.has(item.status)), 'owner_busy')
    check(keys.apiKeyAfterQuota === false, 'paid_fallback_enabled')
    check(github.viewerId === ownerId && github.connected === true
      && github.repositories?.some(repository => repository.fullName === REPOSITORY), 'github_unavailable')
    // Reuse the bounded normal issue cursor, not a new timer/polling loop.
    report.visibleIssueCount = (await issueInventory(path => client.json(path), scope.workspaceId)).length
    const chosen = new Map()
    for (const item of cases) {
      const matches = (order.candidates ?? []).filter(candidate => candidate.harness === item.harness && candidate.model === item.model
        && candidate.source?.kind === 'subscription' && UUID.test(candidate.source.connectionId ?? '') && candidate.credentialOwnerId === scope.adminId)
      if (matches.length === 1) chosen.set(item.harness, matches[0])
      else report.cases.push({ harness: item.harness, model: item.model, status: 'blocked', failure: 'task_secrets_subscription_unavailable' })
    }
    report.preflight = { ownerVisibleRunsIdle: true, fallbackDisabled: true, githubRepositoryVisible: true, existingPreferencesChanged: false }
    if (!options.execute) { report.status = report.cases.length ? 'blocked' : 'preflight_passed'; return report }
    if (!chosen.size) { report.status = 'blocked'; return report }
    if (options.productionCanary) {
      canary = await createCanary({ client, ownerId, email: account.email, workspaceId: scope.workspaceId,
        sourceCommit: options.sourceCommit, fixtureId, window: options.canaryWindow, connectionString: env.MIKKA_DATABASE_URL, pin,
        persist: async evidence => {
          report.productionCanary.journal = evidence
          report.productionStoreMutated = evidence.productionStoreMutated
          if (evidence.productionStoreMutated) report.productionCanary.executed = true
          const path = resolve(dirname(options.reportPath), 'canary-journal.json'), temporary = `${path}.tmp`
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          await writeFile(temporary, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
          await rename(temporary, path)
        } }, { now })
      report.preflight.ownerWideIdle = await canary.preflight()
    }
    const bundles = await buildBundles()
    fixture = await createFixture({ fixtureId, sourceCommit: options.sourceCommit, apiKey: env.E2B_API_KEY, bundles },
      { fetchImpl, now, onEvidence: value => { report.fixture = value } })
    report.fixture = fixture.evidence
    if (canary) {
      // Keep the independent upstream alive before creating the single private
      // canary. Any later failure is handled by the exact-ID finalizer below.
      await canary.open()
      report.productionCanary.executed = true
      report.productionCanary.requiresSeparateReview = false
      report.fixture.signingKeySource = 'none_production_claim_uses_existing_application_key'
    }
    const bot = await client.rpc('bots.createBot', [{ name: `测试1712 ${fixtureId.slice(0, 8)}`, color: 'gris', shape: 'cercle', model: null, repository: null }])
    check(UUID.test(bot?.id ?? ''), 'bot'); botId = bot.id
    const observedBot = await client.json(`/api/bots/${botId}`)
    check(observedBot.id === botId && observedBot.name === `测试1712 ${fixtureId.slice(0, 8)}`, 'bot')
    report.bot = { id: botId, retention: 'dedicated_test_bot_no_delete_api' }; scope.botId = botId
    for (const item of executions) {
      const candidate = chosen.get(item.harness)
      if (!candidate) continue
      const caseId = randomUUID(), record = { caseId, sampleId: caseId, harness: item.harness, requestedModel: item.model,
        title: `测试 1712 ${caseId} ${item.harness}`, sourceCommit: options.sourceCommit, workerSha: options.workerSha,
        workerSourceCommit: options.workerSourceCommit, requireReply: true, minToolCalls: 1, requireReplyAfterTool: true,
        // Normal write-capable cloud tasks have no diagnostic opt-in. The
        // native command, reply, terminal state and external proofs stay required.
        requireRuntimeReceipt: false, requireTerminal: true,
        runtimeDiagnostics: { enabledByDriver: false, required: false, executionGateUsed: false, authorizationCensusUsed: false, status: 'not_observed' },
        stages: [], status: 'running', cleanup: { status: 'running', errors: [] },
        remoteCleanupTarget: { repository: REPOSITORY, branch: `acceptance/1712/${caseId}/${item.harness}`, mergeAuthorized: false } }
      const revocation = Boolean(canary && item.phase === 'revocation')
      if (canary) { record.deliveryMode = 'production_claim'; record.phase = item.phase }
      if (revocation) {
        record.requireReply = false; record.requireReplyAfterTool = false
        record.remoteCleanupTarget = { repository: REPOSITORY, status: 'no_git_write_in_revocation_phase', mergeAuthorized: false }
      }
      report.cases.push(record)
      let fixtureCaseCreated = false
      try {
        await pin()
        // Read the existing preference again at each independent dispatch;
        // never mutate a shared account preference to make an acceptance pass.
        check((await client.json(`/api/settings/api-keys?workspace=${scope.workspaceId}`)).apiKeyAfterQuota === false, 'paid_fallback_enabled')
        if (canary && !revocation) check(rotations.has(item.harness), 'canary_revocation')
        const state = canary ? await canary.prepareCase(fixture, caseId, item.phase) : await fixture.createCase(caseId)
        fixtureCaseCreated = true
        if (canary) record.sdkResponseSha256 = state.sdkResponseSha256
        const config = { ...state, harness: item.harness, repository: REPOSITORY, sourceCommit: options.sourceCommit,
          workerSha: options.workerSha, workerSourceCommit: options.workerSourceCommit,
          fixtureOrigin: fixture.fixtureOrigin, upstreamOrigin: fixture.upstreamOrigin,
          ...(canary && !revocation ? { previousCanarySha256: rotations.get(item.harness).previousCanarySha256 } : {}) }
        const command = nativeCommand(config, bundles.client.sha256)
        record.commandSha256 = hash(command)
        const created = await client.json('/api/factory/agent-profiles', post({ workspaceId: scope.workspaceId, requestId: randomUUID(), profile: {
          name: `测试1712 ${caseId.slice(0, 8)} ${item.harness}`, description: 'Disposable Secret/Git acceptance', enabled: true,
          harness: item.harness, model: { mode: 'fixed', harness: item.harness, model: item.model, source: candidate.source }, effort: 'low', roles: [], skills: [],
          instructions: revocation
            ? 'Run only the exact #1712 revocation verification command, once. Make no Git or PR write. Wait for the owner to rotate its synthetic Secret and stop the task; do not retry or replace the stopped command. Do not inspect unrelated credentials, change settings, use paid fallback, submit to Factory, or spawn agents.'
            : 'Run only the exact #1712 verification command from this task, once. It owns one disposable branch and draft PR, closes/deletes those in finally, and never merges or pushes a default branch. Do not inspect unrelated credentials, change settings, use paid fallback, submit to Factory, or spawn agents.',
        } }))
        const profile = created.profile
        check(UUID.test(profile?.id ?? '') && DIGEST.test(profile.digest ?? '') && profile.harness === item.harness
          && profile.model?.mode === 'fixed' && profile.model.model === item.model && profile.model.source?.kind === 'subscription'
          && profile.model.source.connectionId === candidate.source.connectionId, 'profile')
        profiles.push(profile); record.profileId = profile.id
        await chooseSharedChatModel(client, botId, item.harness)
        const taskScope = canary ? revocation
          ? '此阶段不操作 Git。脚本只使用任务实际领取的 MIKKA_SECRET_ENDPOINTS 访问本轮合成服务，然后等待 owner 轮换新建测试 Secret 产生的停止事件。停止属于预期验收，绝不重试。'
          : `只允许仓库 ${REPOSITORY} 的分支 ${record.remoteCleanupTarget.branch} 和唯一测试文件；必须创建 draft PR 后关闭、删分支，绝不 merge 或写默认分支。脚本只使用实际领取的 MIKKA_SECRET_ENDPOINTS 验证已轮换的本轮合成 Secret，不修改生产配置。`
          : `只允许仓库 ${REPOSITORY} 的分支 ${record.remoteCleanupTarget.branch} 和唯一测试文件；必须创建 draft PR 后关闭、删分支，绝不 merge 或写默认分支。脚本连接独立合成 key/canary fixture，不修改生产 Secret Store。`
        const issue = await client.rpc('issues.saveIssue', [{ title: record.title, status: 'todo', priority: 'low', content: { type: 'doc', content: [
          { type: 'paragraph', content: [{ type: 'text', text: `为 #1712 执行一次真正的原生凭证/Secret隔离验收。${taskScope}\n以下命令必须原样独占一次 bash/shell 工具调用，timeout 360000ms；不重试、不拼接其他命令。脚本验证下载代码摘要，使用正常原生身份；失败就报告失败。完成后仅回复 STARTUP_OK_${caseId}。\n\n${command}` }] },
        ] } }])
        check(UUID.test(issue.issue?.id ?? ''), 'issue'); record.issueId = issue.issue.id
        await dispatch(client, record, profile.id, botId, now)
        check(!report.cases.some(other => other !== record && other.runId === record.runId), 'thread')
        await fixture.bind(caseId, record.runId)
        await client.rpc('coordinator.stopCoordinatorTurn', [botId]); record.coordinatorStopped = true
        await subscriptionProof(client, record, scope, profile)
        if (revocation) {
          record.upstream = await fixture.waitForProtected(caseId)
          check(record.upstream.runId === record.runId && record.upstream.protectedRequests === 1, 'canary_fixture')
          const machine = await client.rpc('agents.getThreadMachine', [record.issueId, record.runId])
          check(machine.kind === 'cloud' && machine.cloud?.template === options.templates[item.harness], 'runtime')
          record.machine = { template: machine.cloud.template, sandboxIdHash: hash(machine.cloud.sandboxId).slice(0, 16) }
          const rotation = await canary.rotate(record.runId)
          rotations.set(item.harness, rotation)
          const deadline = Date.parse(rotation.requestedAt) + 90_000
          await watch(client, record, Math.max(1, deadline - now()), WebSocketImpl, now, undefined, { allowTerminal: true, observe: async detail => {
            const chunks = detail.chunks ?? [], text = JSON.stringify(chunks)
            check(![...text.matchAll(/mikka1712s_[a-f0-9]{64}/g)].some(match => hash(match[0]) === state.canarySha256), 'canary_visible')
            observeChunks(record, detail, now()); delete record.runtimeEvidence
            const exactInput = chunks.some(({ chunk }) => chunk?.type === 'tool-input-available'
              && ['bash', 'shell'].includes(chunk.toolName?.toLowerCase()) && isExactNativeCommand(chunk.input?.command, command)
              && typeof chunk.toolCallId === 'string' && (!UUID.test(chunk.toolCallId.slice(0, 36)) || chunk.toolCallId.slice(0, 36) === record.runId))
            if (!TERMINAL.has(record.lastStatus)) return false
            check(exactInput && now() >= Date.parse(rotation.requestedAt) && now() <= deadline
              && record.lastStatus === 'stopped', 'canary_revocation')
            record.revocation = { ...(await canary.verifyRevoked(record.runId, rotation.requestedAt)),
              requestedAt: rotation.requestedAt, observedAt: new Date(now()).toISOString(),
              elapsedMs: now() - Date.parse(rotation.requestedAt), maximumMs: 90_000,
              proof: 'actual_protected_upstream_then_store_rotation_expired_lease_and_native_run_stop',
              rawCapabilityReplayTested: false }
            return true
          } })
          await subscriptionProof(client, record, scope, profile)
          record.fixtureReceipt = await fixture.receipt(caseId)
          check(record.fixtureReceipt.mode === 'production_claim' && !record.fixtureReceipt.issued
            && record.fixtureReceipt.runId === record.runId && record.fixtureReceipt.counts.protected === 1, 'receipt')
          await pin(); record.status = 'passed'
          continue
        }
        await watch(client, record, options.timeoutMs, WebSocketImpl, now, undefined, { observe: async detail => {
          const text = JSON.stringify(detail.chunks ?? [])
          check(![...text.matchAll(/mikka1712s_[a-f0-9]{64}/g)].some(match =>
            [state.canarySha256, config.previousCanarySha256].includes(hash(match[0]))), 'canary_visible')
          const complete = observeChunks(record, detail, now())
          if (record.runtimeTimingStatus) {
            record.runtimeDiagnostics.observedStatus = record.runtimeTimingStatus
            record.runtimeDiagnostics.status = record.runtimeTimingStatus === 'complete' && record.runtimeEvidence?.status === 'passed'
              ? 'available_not_used_for_authorization_census' : 'unusable'
          }
          // observeChunks may retain an earlier valid timing on a replay. Keep
          // those closed observations, but never its optional derived census.
          delete record.runtimeEvidence
          record.native = nativeReceipt(detail, record, command)
          if (record.native && !record.machine) {
            const machine = await client.rpc('agents.getThreadMachine', [record.issueId, record.runId])
            check(machine.kind === 'cloud' && machine.cloud?.template === options.templates[item.harness], 'runtime')
            record.machine = { template: machine.cloud.template, sandboxIdHash: hash(machine.cloud.sandboxId).slice(0, 16) }
          }
          // A normal no-submit CLI turn ends as stopped. The owner projection
          // does not expose its stop reason; the native proofs remain required.
          return complete && Boolean(record.native) && record.lastStatus === 'stopped'
        } })
        await subscriptionProof(client, record, scope, profile)
        record.fixtureReceipt = await fixture.receipt(caseId)
        check(record.fixtureReceipt.runId === record.runId
          && (canary ? record.fixtureReceipt.mode === 'production_claim' && !record.fixtureReceipt.issued && record.fixtureReceipt.counts.sdk === 1
            : record.fixtureReceipt.issued && record.fixtureReceipt.rotated)
          && record.fixtureReceipt.counts.protected === 10 && record.fixtureReceipt.counts.public === 10
          && record.fixtureReceipt.counts.echo === 1 && record.fixtureReceipt.counts.redirect === 1, 'receipt')
        await pin(); record.status = 'passed'
      } catch (error) { record.status = 'blocked'; record.failure = safeFailure(error) }
      finally {
        if (record.issueId) {
          if (!record.runId) {
            // A dispatch response may be lost after its write. One owner read
            // resolves the new task's actual run for normal cleanup.
            try { const value = await client.rpc('agents.pollIssueThreads', [record.issueId]); if (value.threads?.length === 1 && value.threads[0].ownedByCurrentUser === true) record.runId = value.threads[0].id }
            catch { record.cleanup.errors.push({ step: 'resolve_run', code: 'task_secrets_cleanup' }) }
          }
          try { await cleanupCase(client, record, 'cloud', { timeoutMs: 60_000, WebSocketImpl, now, preserveIssue: !revocation && !record.native?.github.cleanup }) }
          catch { record.cleanup.errors.push({ step: 'owned_run_cleanup', code: 'task_secrets_cleanup' }) }
        } else record.cleanup.status = 'passed'
        if (fixtureCaseCreated) try { await fixture.deleteCase(caseId) } catch { record.cleanup.errors.push({ step: 'fixture_case_delete', code: 'task_secrets_cleanup' }) }
        if (!revocation) {
          if (!record.native?.github.cleanup) record.remoteCleanupTarget.status = 'unconfirmed_verify_exact_head_before_any_cleanup'
          else record.remoteCleanupTarget.status = 'verified_closed_and_branch_absent'
        }
        if (record.cleanup.errors.length || record.cleanup.status !== 'passed') record.status = 'blocked'
      }
    }
    report.status = report.cases.length === executions.length && report.cases.every(item => item.status === 'passed') ? 'scoped_external_acceptance_passed' : 'blocked'
    if (canary && report.status === 'scoped_external_acceptance_passed') {
      report.externalEvidenceStillRequired = ['PostHog_canary_absence', 'screenshots_checkpoints_templates', 'Factory_full_acceptance',
        'local_and_self_hosted_actual_claim', 'cross_owner_workspace_repository_actual_claim', 'raw_capability_expiry_replay',
        'same_version_native_startup_distributions_and_complete_RPC_SQL_census']
    }
  } catch (error) { report.status = 'blocked'; report.failure = safeFailure(error) }
  finally {
    if (canary) try { report.productionCanary.cleanup = await canary.close() }
    catch { report.productionCanary.cleanup = canary.evidence.cleanup; report.cleanup.errors.push({ step: 'production_canary', code: 'task_secrets_canary_cleanup' }) }
    if (fixture) try { report.fixture.cleanup = await fixture.close() } catch { report.cleanup.errors.push({ step: 'fixture_vm', code: 'task_secrets_cleanup' }) }
    if (loggedIn) {
      for (const profile of profiles) try {
        await client.json(`/api/factory/agent-profiles/${profile.id}`, { ...post({ workspaceId: scope.workspaceId, version: profile.version }), method: 'DELETE' })
      } catch { report.cleanup.errors.push({ step: 'profile_archive', id: profile.id, code: 'task_secrets_cleanup' }) }
      if (botId) try { await client.rpc('coordinator.stopCoordinatorTurn', [botId]) } catch { report.cleanup.errors.push({ step: 'coordinator_stop', code: 'task_secrets_cleanup' }) }
      if (originalWorkspaceId) try { await restoreAcceptanceWorkspace(client, ownerId, originalWorkspaceId); report.cleanup.workspaceRestored = true }
      catch { report.cleanup.errors.push({ step: 'workspace_restore', code: 'task_secrets_cleanup' }) }
      try { check((await client.request('/api/auth/sign-out', post({}))).ok, 'cleanup'); report.cleanup.sessionClosed = true }
      catch { report.cleanup.errors.push({ step: 'sign_out', code: 'task_secrets_cleanup' }) }
    }
    client.clear(); report.finishedAt = new Date(now()).toISOString()
    if (report.cleanup.errors.length) report.status = 'blocked'
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report, options
  try {
    const proof = await attestAcceptance(process.env)
    options = readOptions(process.argv.slice(2), process.env, proof)
    const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, maxBuffer: 200 })
    check(stdout.trim() === options.sourceCommit, 'source_mismatch')
    report = await runTaskSecretsAcceptance(options)
  } catch (error) { report = { version: 1, issue: 1712, status: 'blocked', failure: safeFailure(error), productionStoreMutated: false } }
  const reportPath = options?.reportPath ?? resolve('production-task-secrets-report/report.json')
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 })
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify({ issue: 1712, status: report.status, report: 'production-task-secrets-report/report.json' }) + '\n')
  if (!['preflight_passed', 'scoped_external_acceptance_passed'].includes(report.status)) process.exitCode = 1
}
