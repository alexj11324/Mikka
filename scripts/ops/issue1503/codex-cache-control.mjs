// One bounded production diagnostic, not Factory/runtime acceptance.
// The launcher passes only the existing application's named configuration to
// an isolated Node process. Credentials and provider text never enter receipts.
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { setImmediate } from 'node:timers/promises'

export const SOURCE = 'c31ac8cd8824ea4d44d23ba548ef67bd139771bb'
export const FIXTURE = Object.freeze({
  ownerId: 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3',
  botId: 'c81d69c7-fe23-4c80-875f-dd09e20a4d33',
  workspaceId: 'de300001-ece6-4021-8214-c986ea306bde',
  modelId: 'gpt-6-luna', route: 'codex_cpa',
  credentialOwnerId: 'OFtPbAHifGBAOYiek9hd3w',
  bindingId: '9aacdfa0-2aef-43ac-8469-481a65425d38',
  connectionId: '6223f3e1-d626-4eb7-ab62-34dcf3fbfd0c', connectionRevision: 2,
  bindingCreatedAt: '2026-11-07T06:20:31.439Z',
})
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const FILE = fileURLToPath(import.meta.url)
const REPORT = 'issue1503-report/codex-cache-control.json'
const SHA = /^[a-f0-9]{40}$/
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (condition, code) => { if (!condition) throw new ControlError(code) }
export class ControlError extends Error { constructor(code) { super(code); this.code = code } }
const failure = error => error instanceof ControlError ? error.code : 'unexpected'
const APP_KEYS = Object.freeze([
  'DATABASE_URL', 'MIKKA_DATABASE_URL', 'BETTER_AUTH_SECRET', 'NEXT_PUBLIC_POSTHOG_KEY',
  'MIKKA_BYOS_ENABLED', 'MIKKA_BYOS_CODEX_OAUTH', 'MIKKA_BYOS_CLAUDE_OAUTH',
  'MIKKA_BYOS_INFISICAL_ORIGIN', 'MIKKA_BYOS_INFISICAL_PROJECT', 'MIKKA_BYOS_INFISICAL_ENVIRONMENT',
  'MIKKA_BYOS_INFISICAL_PATH', 'MIKKA_BYOS_INFISICAL_TOKEN',
  'MIKKA_BYOS_ACCESS_INFISICAL_PATH', 'MIKKA_BYOS_ACCESS_INFISICAL_PROJECT', 'MIKKA_BYOS_ACCESS_INFISICAL_TOKEN',
  'MIKKA_BYOS_CUSTODY_CLIENT_ID', 'MIKKA_BYOS_CUSTODY_CLIENT_SECRET',
  'MIKKA_BYOS_ACCESS_CLIENT_ID', 'MIKKA_BYOS_ACCESS_CLIENT_SECRET', 'MIKKA_BYOS_SHARED_CUSTODY_IDENTITY',
])
const SOURCE_FILES = Object.freeze(['lib/prompt-cache.ts', 'lib/subscription-service.ts', 'lib/subscription-runtime.ts',
  'lib/subscription-repository.ts', 'packages/daemon/src/subscription-worker-client.ts',
  'packages/subscription-worker/plain_model.go', 'packages/subscription-worker/CPA_COMMIT', 'pnpm-lock.yaml'])
const OPS_FILES = new Set(['scripts/ops/issue1503/codex-cache-control.mjs', 'scripts/ops/issue1503/codex-cache-control.test.mjs',
  '.github/workflows/issue1503-codex-cache-control.yml'])

function identity(env) {
  check(env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && SHA.test(env.GITHUB_SHA ?? '')
    && /^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '') && env.GITHUB_RUN_ATTEMPT === '1'
    && env.GITHUB_REF === 'refs/heads/ops/issue-1503-codex-cache-control'
    && env.GITHUB_EVENT_NAME === 'push', 'identity_invalid')
  return { repository: env.GITHUB_REPOSITORY, sourceCommit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, ref: env.GITHUB_REF }
}
function sourceEvidence(env) {
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  check(git(['rev-parse', 'HEAD']) === env.GITHUB_SHA, 'source_mismatch')
  git(['merge-base', '--is-ancestor', SOURCE, 'HEAD'])
  check(git(['diff', '--name-only', SOURCE, 'HEAD']).split('\n').filter(Boolean).every(file => OPS_FILES.has(file)), 'source_mismatch')
  check(git(['diff', '--name-only', 'HEAD']).length === 0, 'source_mismatch')
  return { applicationSource: SOURCE, files: Object.fromEntries(SOURCE_FILES.map(file => [file, hash(readFileSync(resolve(ROOT, file)))])),
    workerBinarySha256: hash(readFileSync(resolve(ROOT, 'packages/subscription-worker/bin/mikka-subscription-worker'))) }
}
function save(report) {
  const path = resolve(ROOT, REPORT)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}

/** Deliberately long, fixed synthetic prefixes; no private context or tools.
 * Each stable layer has 128 numbered rules, comfortably beyond the documented
 * 1,024-token minimum. Byte/hash evidence is exact; no invented tokenizer count.
 */
export function syntheticPrompt() {
  const layer = section => Array.from({ length: 128 }, (_, index) =>
    `Synthetic ${section} rule ${String(index + 1).padStart(4, '0')}: This diagnostic grants no tool access, file changes, external actions, or additional requests. Keep the final answer to ACK.`).join('\n')
  return [
    ...['alpha', 'beta'].map(section => ({ role: 'system', content: layer(section),
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } })),
    { role: 'user', content: [{ type: 'text', text: 'Reply with ACK only.' }] },
  ]
}
export function markerEvidence(baseline, marked) {
  const stripped = structuredClone(marked)
  let count = 0
  for (const message of stripped) {
    if (message.providerOptions?.openaiCompatible?.mikka_cache_breakpoint === 'stable_system_v1') {
      count++
      delete message.providerOptions.openaiCompatible.mikka_cache_breakpoint
      if (!Object.keys(message.providerOptions.openaiCompatible).length) delete message.providerOptions.openaiCompatible
    }
  }
  check(count === 2 && isDeepStrictEqual(stripped, baseline), 'payload_difference_invalid')
  return { sourcePromptSha256: hash(JSON.stringify(baseline)), markedPromptSha256: hash(JSON.stringify(marked)),
    onlyPrivateMarkersDiffer: true, stableBoundaryCount: count, messageCount: baseline.length,
    toolCount: 0, minimumCacheableTokensFromOfficialGuide: 1024, measuredTokenCount: null,
    prefixes: baseline.filter(message => message.role === 'system').map(message => ({
      utf8Bytes: Buffer.byteLength(message.content), sha256: hash(message.content), numberedRules: 128,
    })) }
}

export function fixtureSnapshot(rows, expected) {
  check(Array.isArray(rows) && rows.length === 1, 'fixture_missing_or_ambiguous')
  const row = rows[0]
  check(row.botId === FIXTURE.botId && row.runOwnerId === FIXTURE.ownerId && row.workspaceId === FIXTURE.workspaceId
    && row.consumerId === FIXTURE.botId && row.modelId === FIXTURE.modelId && row.route === FIXTURE.route
    && row.bindingId === FIXTURE.bindingId && row.connectionId === FIXTURE.connectionId && UUID.test(row.custodyWorkspaceId ?? '')
    && row.ownerId === FIXTURE.credentialOwnerId && row.ownerId !== FIXTURE.ownerId
    && row.connectionOwnerId === row.ownerId && row.provider === 'codex' && row.state === 'connected'
    && row.paused === false && row.botArchivedAt === null && row.connectionRemovedAt === null
    && row.apiKeyId === null && row.shareAllowed === true && row.activeWork === false
    && Number.isSafeInteger(Number(row.connectionRevision)) && Number(row.connectionRevision) > 0
    && Number(row.connectionRevision) === FIXTURE.connectionRevision && Number(row.connectionRevision) === Number(row.epoch)
    && new Date(row.bindingCreatedAt).toISOString() === FIXTURE.bindingCreatedAt, 'fixture_scope_invalid')
  const value = { ownerId: row.ownerId, workspaceId: row.workspaceId, consumerId: row.consumerId,
    bindingId: row.bindingId, connectionId: row.connectionId, connectionRevision: Number(row.connectionRevision),
    custodyWorkspaceId: row.custodyWorkspaceId, modelId: row.modelId, route: row.route }
  check(!expected || isDeepStrictEqual(value, expected), 'fixture_changed')
  return value
}

/** The worker's already-sanitized diagnostic is still projected into enums.
 * Never serialize arbitrary error properties, messages, payloads or response text.
 */
export function safeLog(args) {
  if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length > 4096) return null
  let value
  try { value = JSON.parse(args[0]) } catch { return null }
  if (value?.msg !== 'subscription_worker' || typeof value.detail !== 'string') return null
  const match = /^subscription_upstream_failure codex (transport|response|event|incomplete|convert) (0|[1-5][0-9]{2}) (invalid_request_error|rate_limit_error|authentication_error|permission_error|server_error|unknown|network|stream_ended)$/.exec(value.detail)
  return match ? { provider: 'codex', stage: match[1], status: Number(match[2]), type: match[3] } : null
}
function quietLogs(report) {
  const old = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(key => [key, console[key]]))
  for (const key of Object.keys(old)) console[key] = (...args) => {
    const entry = safeLog(args)
    if (entry && report.currentCase !== null) report.cases[report.currentCase].upstream.push(entry)
    else report.suppressedLogCount++
  }
  return () => { for (const [key, value] of Object.entries(old)) console[key] = value }
}

const FIXTURE_SQL = `SELECT bot.id AS "botId",bot."ownerId" AS "runOwnerId",bot."workspaceId"::text AS "workspaceId",
  bot."archivedAt" AS "botArchivedAt",choice."apiKeyId",
  b.id AS "bindingId",b."ownerId",b."consumerId",b."connectionId",b."connectionRevision",b.route,b."modelId",b."createdAt" AS "bindingCreatedAt",
  c."ownerId" AS "connectionOwnerId",c."workspaceId" AS "custodyWorkspaceId",c.provider,c.state,c.paused,c.epoch,c."removedAt" AS "connectionRemovedAt",
  c."credentialVersion",c.quota->>'observedAt' AS "quotaObservedAt",
  (EXISTS(SELECT 1 FROM workspace_subscription_shares sh WHERE sh."ownerId"=b."ownerId" AND sh."workspaceId"::text=b."workspaceId" AND sh."allowOthers")
    AND NOT EXISTS(SELECT 1 FROM workspace_personal_policies p WHERE p."workspaceId"::text=b."workspaceId" AND NOT p.subscriptions)) AS "shareAllowed",
  (EXISTS(SELECT 1 FROM coordinator_sessions s WHERE s."userId"=bot."ownerId" AND s."botId"=bot.id AND s."leaseHolder" IS NOT NULL)
    OR EXISTS(SELECT 1 FROM agent_runs r WHERE r."userId"=bot."ownerId" AND r."botId"=bot.id AND r.status IN('queued','preparing','running','paused','waiting_input','finishing'))) AS "activeWork"
 FROM bots bot JOIN bot_model_choices choice ON choice."ownerId"=bot."ownerId" AND choice."workspaceId"=bot."workspaceId" AND choice."botKey"=bot.id::text
 JOIN byos_bindings b ON b.id=choice."bindingId" AND b."consumerId"=bot.id::text AND b."workspaceId"=bot."workspaceId"::text
 JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
 WHERE bot.id=$1 AND bot."ownerId"=$2 AND bot."workspaceId"=$3`

export function sdkRequestEvidence(request, expectedMarkers, previous) {
  let body
  try { body = typeof request?.body === 'string' ? JSON.parse(request.body) : structuredClone(request?.body) }
  catch { throw new ControlError('sdk_request_invalid') }
  check(body && body.model === FIXTURE.modelId && body.stream === true && Array.isArray(body.messages)
    && body.messages.length === 3 && (!body.tools || body.tools.length === 0), 'sdk_request_invalid')
  const original = JSON.stringify(body)
  let markers = 0
  for (const message of body.messages) {
    if (!Object.hasOwn(message, 'mikka_cache_breakpoint')) continue
    check(message.role === 'system' && message.mikka_cache_breakpoint === 'stable_system_v1', 'sdk_request_invalid')
    markers++; delete message.mikka_cache_breakpoint
  }
  check(markers === expectedMarkers, 'sdk_marker_count_invalid')
  const noMarkersSha256 = hash(JSON.stringify(body))
  check(!previous || noMarkersSha256 === previous.noMarkersSha256, 'sdk_payload_difference_invalid')
  return { bodySha256: hash(original), noMarkersSha256, privateMarkerCount: markers,
    messageCount: body.messages.length, toolCount: 0, utf8Bytes: Buffer.byteLength(original) }
}

async function execute(report) {
  const restore = quietLogs(report)
  let pool, workspacePool
  try {
    report.stage = 'service_import'; save(report)
    const runtime = await import('../../../lib/subscription-runtime.ts')
    const { resolveFrozenHostedModel } = await import('../../../lib/subscription-model-snapshot.ts')
    const diagnostic = await import('../../../lib/subscription-generation-diagnostics.ts')
    const { generationFailureCode } = await import('../../../lib/subscription-service.ts')
    const { withCodexSystemCacheBreakpoints } = await import('../../../lib/prompt-cache.ts')
    const { refreshDeploymentSwitches } = await import('../../../lib/deployment-switches.ts')
    ;({ pool } = await import('../../../lib/db/index.ts'))
    ;({ workspacePool } = await import('../../../lib/workspace-db.ts'))
    const baseline = syntheticPrompt()
    const marked = withCodexSystemCacheBreakpoints(baseline, FIXTURE.modelId)
    report.payload = markerEvidence(baseline, marked)
    report.stage = 'fresh_authorization'; save(report)
    await refreshDeploymentSwitches()
    const service = runtime.subscriptionRuntime()
    const read = async expected => {
      const rows = (await pool.query(FIXTURE_SQL, [FIXTURE.botId, FIXTURE.ownerId, FIXTURE.workspaceId])).rows
      const snapshot = fixtureSnapshot(rows, expected)
      const version = Number(rows[0].credentialVersion), observed = Date.parse(rows[0].quotaObservedAt ?? '')
      check(Number.isSafeInteger(version) && version >= 0, 'fixture_scope_invalid')
      report.connectionObservations ??= []
      report.connectionObservations.push({ stage: report.stage, credentialVersion: version,
        quotaObservedAt: Number.isFinite(observed) ? new Date(observed).toISOString() : null })
      await runtime.authorizeSubscriptionWorkspace(FIXTURE.ownerId, FIXTURE.workspaceId)
      await runtime.authorizeSubscriptionWorkspace(snapshot.ownerId, FIXTURE.workspaceId)
      return snapshot
    }
    const fixed = await read()
    report.fixture = { botId: FIXTURE.botId, workspaceId: FIXTURE.workspaceId, requesterSha256: hash(FIXTURE.ownerId),
      credentialOwnerSha256: hash(fixed.ownerId), bindingId: fixed.bindingId, connectionId: fixed.connectionId,
      connectionRevision: fixed.connectionRevision, route: fixed.route, model: fixed.modelId, shared: true }
    for (const [index, [name, prompt]] of [['unmarked', baseline], ['marked', marked]].entries()) {
      await read(fixed)
      const item = { case: name, status: 'starting', requestCount: 0, upstream: [], textDeltaCount: 0,
        textCharacters: 0, finishCount: 0, finishReason: null, streamPartCount: 0, error: null }
      report.cases.push(item); report.currentCase = index; report.stage = name; save(report)
      const started = performance.now()
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
      let stream, reader
      try {
        // Keep the normal shared consumer's model-policy admission in addition
        // to the lender's ordinary service/credential checks.
        const model = await resolveFrozenHostedModel(
          { ownerId: FIXTURE.ownerId, botId: FIXTURE.botId, workspaceId: FIXTURE.workspaceId },
          { harness: 'ai_sdk', model: fixed.modelId, modelSelection: { type: 'subscription',
            runOwnerId: FIXTURE.ownerId, ownerId: fixed.ownerId, consumerId: fixed.consumerId,
            workspaceId: fixed.workspaceId, bindingId: fixed.bindingId, connectionId: fixed.connectionId,
            connectionRevision: fixed.connectionRevision, route: fixed.route, modelId: fixed.modelId } },
          { service: () => service, workspace: runtime.authorizeSubscriptionWorkspace }, signal)
        check(model.modelId === FIXTURE.modelId && model.specificationVersion === 'v4', 'model_contract_invalid')
        // No retry wrapper, tool loop, alternate model or alternate endpoint.
        item.requestCount = 1; save(report)
        const result = await model.doStream({ prompt, abortSignal: signal })
        stream = result.stream
        item.sdkRequest = sdkRequestEvidence(result.request, index === 0 ? 0 : 2, index === 1 ? report.cases[0].sdkRequest : undefined)
        reader = stream.getReader()
        for (;;) {
          const { value: part, done } = await reader.read()
          if (done) break
          item.streamPartCount++
          if (part.type === 'error') throw part.error
          if (part.type === 'text-delta') { item.textDeltaCount++; item.textCharacters += typeof part.delta === 'string' ? part.delta.length : 0 }
          if (part.type === 'finish') {
            item.finishCount++
            const reason = typeof part.finishReason === 'string' ? part.finishReason : part.finishReason?.unified
            item.finishReason = ['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other'].includes(reason) ? reason : 'unknown'
          }
          check(item.streamPartCount <= 10000 && item.textCharacters <= 4096, 'response_budget_exceeded')
        }
        check(item.finishCount === 1 && item.finishReason === 'stop' && item.textDeltaCount > 0, 'completion_not_proven')
        item.status = 'completed'
      } catch (error) {
        item.status = 'failed'
        item.error = error instanceof ControlError ? { code: error.code } : { code: generationFailureCode(error), ...diagnostic.generationFailureDetails(error) }
      } finally {
        // Also runs when the SDK receipt assertion fails before stream reads.
        // Abort only this diagnostic call; never stop the bot or a server run.
        controller.abort(new DOMException('Diagnostic complete', 'AbortError'))
        item.cleanup = { abortRequested: controller.signal.aborted, streamCancel: stream ? 'pending' : 'not_created' }
        if (stream) {
          try { await (reader ? reader.cancel() : stream.cancel()); item.cleanup.streamCancel = 'fulfilled' }
          catch { item.cleanup.streamCancel = 'rejected' }
          finally { if (reader) reader.releaseLock() }
        }
        await setImmediate(); item.durationMs = Math.round(performance.now() - started); save(report)
      }
    }
    await read(fixed)
    report.fixtureUnchanged = true
    report.sameCredentialVersionObserved = new Set(report.connectionObservations.map(row => row.credentialVersion)).size === 1
    report.quotaObservationChanged = new Set(report.connectionObservations.map(row => row.quotaObservedAt)).size > 1
    report.metadataChangeAttribution = 'normal_service_refresh_allowed_concurrent_use_not_excluded'
    const [a, b] = report.cases
    report.conclusion = report.sameCredentialVersionObserved && a.status === 'completed' && b.status === 'failed' && b.upstream.some(x => x.stage === 'response' && x.status === 400 && x.type === 'invalid_request_error')
      ? 'marked_rejected_unmarked_completed' : a.status === 'completed' && b.status === 'completed' ? 'both_completed' : 'inconclusive'
    report.status = 'observed'; report.stage = 'complete'
  } catch (error) { report.status = 'failed'; report.code = failure(error) }
  finally {
    report.currentCase = null
    report.cleanup = { applicationPoolClosed: false, workspacePoolClosed: false }
    for (const [name, value] of [['applicationPoolClosed', pool], ['workspacePoolClosed', workspacePool]]) {
      if (!value) continue
      try { await value.end(); report.cleanup[name] = true } catch { report.cleanupError = 'database_pool_close_failed' }
    }
    report.finishedAt = new Date().toISOString(); save(report); restore()
  }
  return report
}

export function probeEnvironment(env) {
  check(env.DATABASE_URL && env.MIKKA_DATABASE_URL && env.NEXT_PUBLIC_POSTHOG_KEY, 'configuration_missing')
  for (const key of ['MIKKA_BYOS_INFISICAL_ORIGIN', 'MIKKA_BYOS_INFISICAL_PROJECT', 'MIKKA_BYOS_INFISICAL_ENVIRONMENT',
    'MIKKA_BYOS_INFISICAL_PATH', 'MIKKA_BYOS_ACCESS_INFISICAL_PATH']) check(env[key], 'configuration_missing')
  check(env.MIKKA_BYOS_INFISICAL_ENVIRONMENT === 'prod' && env.MIKKA_BYOS_INFISICAL_ORIGIN === 'https://app.infisical.com'
    && env.MIKKA_BYOS_INFISICAL_PATH !== env.MIKKA_BYOS_ACCESS_INFISICAL_PATH, 'configuration_scope_invalid')
  check(Boolean(env.MIKKA_BYOS_CUSTODY_CLIENT_ID && env.MIKKA_BYOS_CUSTODY_CLIENT_SECRET && (env.MIKKA_BYOS_SHARED_CUSTODY_IDENTITY === '1'
    || env.MIKKA_BYOS_ACCESS_CLIENT_ID && env.MIKKA_BYOS_ACCESS_CLIENT_SECRET && env.MIKKA_BYOS_ACCESS_CLIENT_ID !== env.MIKKA_BYOS_CUSTODY_CLIENT_ID))
    || Boolean(env.MIKKA_BYOS_INFISICAL_TOKEN && env.MIKKA_BYOS_ACCESS_INFISICAL_TOKEN && env.MIKKA_BYOS_INFISICAL_TOKEN !== env.MIKKA_BYOS_ACCESS_INFISICAL_TOKEN), 'configuration_missing')
  return Object.fromEntries([...APP_KEYS, 'PATH', 'HOME', 'LANG', 'TZ', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_REF', 'GITHUB_EVENT_NAME']
    .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]).concat([
      ['NODE_ENV', 'production'], ['VERCEL_ENV', 'production'], ['BETTER_AUTH_URL', 'https://app.aspectlylabs.com'],
    ]))
}

/** Same authoritative prod:/vercel delivery as Web deploy. Vercel is only a
 * GET fallback for named non-sensitive settings absent from that delivery.
 * A partial inventory never proves absence; an opaque secret is never guessed.
 */
async function completeConfiguration(env, report) {
  try { return { env: probeEnvironment(env), source: 'infisical_prod_configuration', vercelGetCount: 0 } }
  catch (error) { if (!(error instanceof ControlError) || error.code !== 'configuration_missing') throw error }
  check(env.VERCEL_TEAM_TOKEN, 'configuration_missing')
  const { api, PROJECT } = await import('../../e2b/publish-template-env.mjs')
  let getCount = 0
  const read = async path => { getCount++; return api(path, { token: env.VERCEL_TEAM_TOKEN, method: 'GET' }) }
  const inventory = async () => {
    const response = await read(`/v10/projects/${PROJECT}/env?decrypt=false`)
    check(response && Array.isArray(response.envs) && response.envs.length <= 10000
      && response.truncated !== true && !response.pagination?.next, 'configuration_inventory_incomplete')
    return APP_KEYS.map(key => {
      const found = response.envs.filter(row => row?.key === key && Array.isArray(row.target) && row.target.includes('production') && !row.gitBranch)
      check(found.length <= 1, 'configuration_ambiguous')
      if (!found.length) return { key, absent: true }
      const row = found[0]
      check(typeof row.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.id)
        && ['plain', 'encrypted', 'secret', 'sensitive', 'system'].includes(row.type)
        && typeof row.value === 'string', 'configuration_metadata_invalid')
      return { key, id: row.id, type: row.type, updatedAt: row.updatedAt ?? null, fingerprint: hash(row.value) }
    })
  }
  report.stage = 'configuration_read'; save(report)
  const before = await inventory(), values = { ...env }
  const filledKeys = []
  for (const row of before) {
    if (row.absent || values[row.key] || row.type === 'sensitive') continue
    const value = await read(`/v1/projects/${PROJECT}/env/${row.id}`)
    check(value && value.key === row.key && (!value.id || value.id === row.id) && value.type === row.type
      && typeof value.value === 'string' && value.value.length <= 32768, 'configuration_value_invalid')
    if (value.value) { values[row.key] = value.value; filledKeys.push(row.key) }
  }
  check(isDeepStrictEqual(before, await inventory()), 'configuration_changed')
  return { env: probeEnvironment(values), source: 'infisical_with_selected_vercel_get', vercelGetCount: getCount, filledKeys, metadataFenceMatched: true }
}

async function main() {
  let report = { version: 1, status: 'starting', stage: 'identity', identity: null, applicationSource: SOURCE,
    startedAt: new Date().toISOString(), cases: [], currentCase: null, suppressedLogCount: 0,
    factoryAcceptance: false, readonly: false, allowedNormalServiceEffects: ['quota_refresh', 'credential_refresh', 'model_admission_audit'],
    settingsOrBindingWrites: false, maximumInferenceCalls: 2, retries: 0 }
  try {
    report.identity = identity(process.env)
    if (process.argv[2] === '--run') {
      report = JSON.parse(readFileSync(resolve(ROOT, REPORT), 'utf8'))
      check(isDeepStrictEqual(report.identity, identity(process.env)) && report.status === 'starting' && report.stage === 'launch', 'checkpoint_invalid')
      probeEnvironment(process.env)
      report = await execute(report)
    } else {
      check(process.argv.length === 2, 'entry_invalid')
      save(report)
      report.stage = 'source'; report.source = sourceEvidence(process.env); save(report)
      report.stage = 'configuration'; save(report)
      const { env, ...configuration } = await completeConfiguration(process.env, report)
      report.configuration = { ...configuration, selectedKeys: APP_KEYS.filter(key => env[key] !== undefined) }
      report.stage = 'launch'; save(report)
      const child = spawn(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', FILE, '--run'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
      // Only the receipt is the result. No raw module, DB, worker or provider stderr.
      child.stdout.resume(); child.stderr.resume()
      const exit = await new Promise(resolve => { child.once('error', () => resolve(null)); child.once('close', code => resolve(code)) })
      report = JSON.parse(readFileSync(resolve(ROOT, REPORT), 'utf8'))
      check(exit === 0 && report.status === 'observed' || exit === 1 && report.status === 'failed', 'child_failed')
    }
  } catch (error) { report.status = 'failed'; report.code = failure(error); report.finishedAt = new Date().toISOString(); save(report) }
  if (process.argv[2] !== '--run') console.log(JSON.stringify({ status: report.status, code: report.code ?? null, stage: report.stage, conclusion: report.conclusion ?? null, factoryAcceptance: false }))
  process.exitCode = report.status === 'observed' ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === FILE) await main()
