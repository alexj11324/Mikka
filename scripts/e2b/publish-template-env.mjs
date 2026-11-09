import { readBootstrapAcceptance } from '../acceptance/cloud-startup.mjs'
// Publishes the verified additive runtime configuration inside Web deploy's
// production queue. The caller then builds on GitHub and uploads --prebuilt;
// this module never requests a Vercel source build.
// Inputs: DESKTOP_TEMPLATE_ID, CLAUDE_TEMPLATE_ID, CODEX_TEMPLATE_ID and SOURCE_SHA (the worker hash,
// workerSha from build-template.py --json), the full source commit,
// the verified report file argv, its byte/model digests, GITHUB_TOKEN and
// VERCEL_TEAM_TOKEN. Complete reports never travel in the environment.
// With --current it only prints
// production's worker hash only when its complete runtime configuration agrees.
// One upsert is followed by per-variable readback; mismatches refuse publication
// and force a later revalidation (decision 2026-11-01-2335).
import { assertCurrentMain, assertProductionSource } from '../release/web-deploy.mjs'
import { isDeepStrictEqual } from 'node:util'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mcpBusinessEvidence } from '../acceptance/cloud-startup-evidence.mjs'
import { readRuntimeReport, templateModels, templateModelsDigest } from './runtime-report.mjs'

const finalizationBytes = readFileSync(new URL('./e2b-finalization-files.json', import.meta.url))
const finalizationPolicy = JSON.parse(finalizationBytes)
const finalizationPolicySha = createHash('sha256').update(finalizationBytes).digest('hex')
const certificateBytes = readFileSync(new URL('./e2b-certificate-relinks.json', import.meta.url))
if (createHash('sha256').update(certificateBytes).digest('hex') !== finalizationPolicy.certificateRelinksSha256) throw Error('e2b_certificate_policy_invalid')
const certificateRelinks = JSON.parse(certificateBytes)

const API = 'https://api.vercel.com'
export const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
export const TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'

const fail = (code) => { throw new Error(code) }

export async function api(path, { token, method = 'GET', body, fetchImpl = fetch }) {
  const url = new URL(path, API)
  if (url.origin !== API) fail('api_origin_invalid')
  url.searchParams.set('teamId', TEAM)
  let response
  try {
    response = await fetchImpl(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: 'error' })
  } catch { fail(`vercel_api_unavailable ${method} ${url.pathname}`) }
  // The status only: response bodies are not echoed into CI logs.
  if (!response.ok) fail(`vercel_api_http_${response.status} ${method} ${url.pathname}`)
  try { return await response.json() } catch { fail(`vercel_api_invalid_response ${method} ${url.pathname}`) }
}

/** Which variable names each template: the bot's computer, and a task machine per harness. */
export const TEMPLATE_ENV = { desktop: 'E2B_BYO_COMPUTER_TEMPLATE', claude: 'E2B_CLAUDE_TEMPLATE', codex: 'E2B_CODEX_TEMPLATE' }
const REQUIRED_HARNESSES = { desktop: ['claude_code', 'codex'], claude: ['claude_code'], codex: ['codex'] }
const RUNTIME_ENV_KEYS = [...Object.values(TEMPLATE_ENV), 'MIKKA_CLOUD_WORKER_SHA', 'MIKKA_CLOUD_TEMPLATE_MODELS', 'MIKKA_CLOUD_WORKER_SOURCE_COMMIT']
const hasModels = (rows, harnesses) => Array.isArray(rows) && harnesses.every(harness => rows.some(row =>
  row?.harness === harness && row.installed === true && (row.models?.length || row.modelSlots?.length)))

export function assertConservation(proof, kind) {
  const valid = row => Number.isSafeInteger(row?.entries) && row.entries > 0 && /^[a-f0-9]{64}$/.test(row.sha256 ?? '')
  const final = proof?.finalization, rules = { ...finalizationPolicy.common, ...finalizationPolicy.templates[kind] }
  for (const certificate of certificateRelinks.filter(row => row.templates.includes(kind))) rules[certificate.path] = {
    kind: { before: 'file', after: 'link' }, sha256: { before: certificate.sha256, after: null },
    target: { before: null, after: certificate.target }, ...(certificate.mode ? { mode: certificate.mode } : {}), _certificate: certificate,
  }
  if (!valid(proof?.before) || !isDeepStrictEqual(proof.before, proof.after)
    || final?.kind !== kind || final?.policySha256 !== finalizationPolicySha
    || !isDeepStrictEqual(final?.originalBefore, proof.before) || !valid(final?.originalAfter)
    || !valid(final?.before) || !isDeepStrictEqual(final.before, final.after)
    || final.before.entries !== proof.before.entries || final.originalAfter.entries !== proof.before.entries
    || !Array.isArray(final.providerChanges)) fail(`runtime_release_conservation_invalid ${kind}`)
  const paths = new Set()
  for (const change of final.providerChanges) {
    const fields = Object.keys(change?.before ?? {}), allowed = rules[change?.path]
    if (paths.has(change?.path) || !fields.length || !allowed
      || (allowed._kind && change.kind !== allowed._kind)
      || !isDeepStrictEqual(fields.sort(), Object.keys(change?.after ?? {}).sort())) fail(`runtime_release_conservation_invalid ${kind}`)
    paths.add(change.path)
    const certificate = allowed._certificate
    if (certificate && (change.kind !== 'file' || change.before.kind !== 'file' || change.after.kind !== 'link'
      || !/^[a-f0-9]{64}$/.test(change.resolvedSha256 ?? '')
      || (!certificate.providerRoot && change.resolvedSha256 !== certificate.sha256))) fail(`runtime_release_conservation_invalid ${kind}`)
    for (const field of fields) {
      const before = change.before[field], after = change.after[field], rule = allowed[field]
      if (rule === 'per-boot') {
        if (field !== 'sha256' || ![before, after].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) fail(`runtime_release_conservation_invalid ${kind}`)
      } else if (!rule || rule.before !== before || rule.after !== after) fail(`runtime_release_conservation_invalid ${kind}`)
    }
  }
}

/** A partially written tuple must neither skip validation nor replace last-good.
 * Legacy official-only catalogues can be retained for rollback, but require a
 * fresh gate before being treated as the current additive release. */
export function runtimeConfigurationSha(configuration, { allowLegacy = false } = {}) {
  const sha = configuration.MIKKA_CLOUD_WORKER_SHA, source = configuration.MIKKA_CLOUD_WORKER_SOURCE_COMMIT
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^[a-f0-9]{40}$/.test(source ?? '')) return ''
  let catalogue
  try { catalogue = JSON.parse(configuration.MIKKA_CLOUD_TEMPLATE_MODELS) } catch { return '' }
  if (catalogue?.version !== 1 || catalogue.workerSha !== sha) return ''
  const legacy = allowLegacy && catalogue.sourceCommit === undefined
    && Object.entries(TEMPLATE_ENV).every(([kind, key]) => configuration[key] === kind)
  if (!legacy && catalogue.sourceCommit !== source) return ''
  for (const [kind, key] of Object.entries(TEMPLATE_ENV)) {
    const id = configuration[key], row = catalogue.templates?.[kind]
    if (!/^[A-Za-z0-9_-]+$/.test(id ?? '') || row?.templateId !== id
      || !(row.baseTemplate === kind || (legacy && row.baseTemplate === undefined))
      || !(row.preinstalled === (id !== kind) || (legacy && row.preinstalled === undefined))
      || !hasModels(row.models, REQUIRED_HARNESSES[kind])) return ''
  }
  return sha
}

export function assertReleaseEvidence({ releaseEvidence, templates, sourceSha, sourceCommit, models }) {
  if (releaseEvidence?.sourceCommit !== sourceCommit || releaseEvidence?.workerSha !== sourceSha) fail('runtime_release_source_invalid')
  const scope = releaseEvidence.acceptanceScope
  if (scope?.account !== 'shared_smoke' || scope.team?.teamWorkspaceConfirmed !== true || scope.team.teamAdminMembershipVerified !== true
    || scope.workspaceRestored !== true || !/^[a-f0-9]{64}$/.test(scope.team.teamWorkspaceHash ?? '')
    || !/^[a-f0-9]{16}$/.test(scope.requesterHash ?? '') || !/^[a-f0-9]{16}$/.test(scope.payerHash ?? '')
    || scope.requesterHash === scope.payerHash) fail('runtime_release_shared_scope_invalid')
  for (const kind of Object.keys(TEMPLATE_ENV)) {
    const row = releaseEvidence.templates?.[kind], proof = row?.conservation
    if (row?.templateId !== templates[kind] || row?.baseTemplate !== kind || row?.preinstalled !== true
      || row?.public !== true || row?.buildStatus !== 'ready' || !row?.buildId) fail(`runtime_release_template_invalid ${kind}`)
    if (!Array.isArray(row.models) || !isDeepStrictEqual(row.models, models?.[kind])) fail(`runtime_release_models_invalid ${kind}`)
    assertConservation(proof, kind)
  }
  for (const [kind, harness, model] of [['claude', 'claude_code', 'claude-haiku-5-5'], ['codex', 'codex', 'gpt-6-luna']]) {
    const row = releaseEvidence.subscriptionAcceptance?.[kind]
    const shared = row?.sharedScope
    if (shared?.verified !== true || shared.access !== 'workspace_share' || shared.requesterHash !== scope.requesterHash
      || shared.payerHash !== scope.payerHash || shared.workspaceHash !== scope.team.teamWorkspaceHash
      || !['connectionHash', 'bindingHash'].every(key => /^[a-f0-9]{16}$/.test(shared[key] ?? ''))
      || !/^(0|[1-9][0-9]*)$/.test(shared.connectionRevision ?? '')
      || !Number.isInteger(shared.profileVersion) || shared.profileVersion < 1 || !/^[a-f0-9]{64}$/.test(shared.profileDigest ?? '')) fail(`runtime_release_shared_scope_invalid ${kind}`)
    const ack = row?.agentAcceptance, authorization = row?.runtimeAuthorization, tool = row?.toolEvidence
    if (row?.status !== 'passed' || row?.templateId !== templates[kind] || row?.sourceCommit !== sourceCommit || row?.workerSha !== sourceSha
      || row?.harness !== harness || row?.model !== model || row?.credentialRoute !== 'subscription' || row?.replyVerified !== true
      || row?.replyVerifiedAfterTool !== true || tool?.outcome !== 'ok' || !/^[a-f0-9]{16}$/.test(tool?.toolCallHash ?? '')
      || Object.keys(tool).length !== 2
      || !/^[a-f0-9]{64}$/.test(row?.officialBinarySha256 ?? '') || typeof row?.officialCliVersion !== 'string' || !row.officialCliVersion
      || !row?.runId || !row?.deviceId
      || ack?.harness !== harness || ack?.runIdHash !== createHash('sha256').update(row.runId).digest('hex').slice(0, 16)
      || ack?.kind !== (harness === 'claude_code' ? 'claude_user_ack' : 'codex_turn_start_ack')
      || !Number.isSafeInteger(ack?.at) || ack.at <= 0 || !Number.isFinite(ack?.ms) || ack.ms < 0
      || authorization?.source !== 'http_server_link' || authorization.complete !== true || authorization.truncated !== false
      || authorization.scope !== 'daemon_http_server_link_and_task_fetch'
      || authorization.hostAuthorizationComplete !== true || authorization.allFirstPartyHttpComplete !== false
      || authorization.basis !== 'host_authorization_census_and_closed_mcp_business_paths'
      || authorization.extraRemoteCalls !== 0
      || !Number.isSafeInteger(authorization.observedProviderEvents) || authorization.observedProviderEvents < 1
      || authorization.officialDelivery !== 'best_effort_not_a_complete_call_count'
      || mcpBusinessEvidence(authorization.mcpHttpTiming, { runIdHash: ack.runIdHash, harness }).status !== 'observed'
      || !readBootstrapAcceptance(row.bootstrapAcceptance, { runIdHash: ack.runIdHash, harness }))
      fail(`runtime_release_subscription_missing ${kind}`)
  }
}

export function pairEnv({ templates, sourceSha, sourceCommit, models }) {
  for (const kind of Object.keys(TEMPLATE_ENV))
    if (!/^[A-Za-z0-9_-]+$/.test(templates?.[kind] ?? '')) fail(`template_id_invalid ${kind}`)
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) fail('source_sha_invalid')
  for (const [kind, harnesses] of Object.entries(REQUIRED_HARNESSES)) {
    if (!Array.isArray(models?.[kind])) fail(`template_models_invalid ${kind}`)
    for (const harness of harnesses) {
      const report = models[kind].find(row => row?.harness === harness && row.installed === true)
      if (!report || !(report.models?.length || report.modelSlots?.length)) fail(`template_models_missing ${kind} ${harness}`)
    }
  }
  const catalogue = { version: 1, workerSha: sourceSha, ...(sourceCommit ? { sourceCommit } : {}), templates: Object.fromEntries(Object.keys(TEMPLATE_ENV).map(kind => [kind, {
    templateId: templates[kind], baseTemplate: kind, preinstalled: templates[kind] !== kind, models: models[kind],
  }])) }
  return [
    ...Object.entries(TEMPLATE_ENV).map(([kind, key]) => ({ key, value: templates[kind], type: 'plain', target: ['production'] })),
    { key: 'MIKKA_CLOUD_WORKER_SHA', value: sourceSha, type: 'plain', target: ['production'] },
    { key: 'MIKKA_CLOUD_TEMPLATE_MODELS', value: JSON.stringify(catalogue), type: 'plain', target: ['production'] },
  ]
}

export async function currentWorkerSha({ token, fetchImpl = fetch }) {
  if (!token) fail('vercel_token_unavailable')
  const { envs = [] } = await api(`/v10/projects/${PROJECT}/env`, { token, fetchImpl })
  const pairs = await Promise.all(RUNTIME_ENV_KEYS.map(async key => {
    const row = envs.find(item => item.key === key && item.target?.includes('production') && !item.gitBranch)
    return [key, row ? (await api(`/v1/projects/${PROJECT}/env/${encodeURIComponent(row.id)}`, { token, fetchImpl })).value : undefined]
  }))
  return runtimeConfigurationSha(Object.fromEntries(pairs))
}

export async function publish({ token, githubToken, templates, sourceSha, sourceCommit, models, releaseEvidence, fetchImpl = fetch, log = console.log }) {
  if (!token) fail('vercel_token_unavailable')
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? '')) fail('official_source_commit_invalid')
  assertReleaseEvidence({ releaseEvidence, templates, sourceSha, sourceCommit, models })
  const env = pairEnv({ templates, sourceSha, sourceCommit, models })
  env.push({ key: 'MIKKA_CLOUD_WORKER_SOURCE_COMMIT', value: sourceCommit, type: 'plain', target: ['production'] })
  await assertCurrentMain({ expectedBuild: sourceCommit, token: githubToken, fetchImpl })
  await assertProductionSource({ expectedBuild: sourceCommit, token, fetchImpl })
  const call = (path, options = {}) => api(path, { token, fetchImpl, ...options })
  const listedNow = await call(`/v10/projects/${PROJECT}/env`)
  const unchanged = [], previous = {}
  for (const want of env) {
    const row = (listedNow.envs ?? []).find((item) => item.key === want.key && item.target?.includes('production') && !item.gitBranch)
    const value = row ? (await call(`/v1/projects/${PROJECT}/env/${encodeURIComponent(row.id)}`)).value : undefined
    if (value !== undefined) previous[want.key] = value
    unchanged.push(value === want.value)
  }
  // Environment reads can span a new main push. Recheck at the write boundary,
  // including no-op refreshes, which must not rebuild an obsolete application.
  await assertCurrentMain({ expectedBuild: sourceCommit, token: githubToken, fetchImpl })
  const changed = !unchanged.every(Boolean)
  // Keep the exact previous release alongside the new one. Template names are
  // immutable and this pipeline never updates/deletes an old template or alias.
  // Re-running the same release does not overwrite the rollback target.
  if (changed && runtimeConfigurationSha(previous, { allowLegacy: true })) env.push({ key: 'MIKKA_CLOUD_RUNTIME_PREVIOUS',
    value: JSON.stringify({ version: 1, configuration: previous }), type: 'plain', target: ['production'] })
  // An uncertain POST is not retried. The next explicit failed-job rerun reads
  // back first; whether or not this write took, Web deploy still rebuilds.
  if (changed) await call(`/v10/projects/${PROJECT}/env?upsert=true`, { method: 'POST', body: env })
  const listed = await call(`/v10/projects/${PROJECT}/env`)
  for (const want of env) {
    const row = (listed.envs ?? []).find((item) => item.key === want.key && item.target?.includes('production') && !item.gitBranch)
    if (!row) fail(`env_missing ${want.key}`)
    const read = await call(`/v1/projects/${PROJECT}/env/${encodeURIComponent(row.id)}`)
    if (read.value !== want.value) fail(`env_not_updated ${want.key}`)
  }
  log(`production runtime env ${changed ? 'updated' : 'unchanged'} and verified; GitHub Web build required`)
  return { changed, requiresWebBuild: true, sourceCommit, workerSha: sourceSha }
}

export function publicationInputFromFile(file, { sha256, modelsSha256, sourceSha, sourceCommit, runId, runAttempt, templates }) {
  const releaseEvidence = readRuntimeReport(file, { sha256, sourceCommit, workerSha: sourceSha, runId, runAttempt })
  if (!/^[a-f0-9]{64}$/.test(modelsSha256 ?? '') || templateModelsDigest(releaseEvidence) !== modelsSha256)
    fail('runtime_release_models_digest_mismatch')
  return { templates, sourceSha, sourceCommit, models: templateModels(releaseEvidence), releaseEvidence }
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--current')) {
  console.log(await currentWorkerSha({ token: process.env.VERCEL_TEAM_TOKEN }))
} else if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const templates = { desktop: process.env.DESKTOP_TEMPLATE_ID, claude: process.env.CLAUDE_TEMPLATE_ID, codex: process.env.CODEX_TEMPLATE_ID }
    const input = publicationInputFromFile(process.argv[2], { templates, sourceSha: process.env.SOURCE_SHA,
      sourceCommit: process.env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT, sha256: process.env.RUNTIME_REPORT_SHA256,
      modelsSha256: process.env.TEMPLATE_MODELS_SHA256, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT })
    const result = await publish({ token: process.env.VERCEL_TEAM_TOKEN, githubToken: process.env.GITHUB_TOKEN, ...input })
    console.log(JSON.stringify({ event: 'official_runtime_env_verified', ...result }))
  } catch (error) {
    // Keep parser causes for callers, never print receipt excerpts from them.
    console.error(error.message)
    process.exitCode = 1
  }
}
