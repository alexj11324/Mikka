import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, constants, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runOwnerMcpBoundaries } from './owner-mcp-boundaries.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value : null
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value) ? value : null
const model = value => typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,150}$/.test(value) ? value : null
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const bool = value => value === true
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null
const list = decoder => value => Array.isArray(value) ? value.slice(0, 200).map(decoder) : []
const shape = (value, fields) => Object.fromEntries(Object.entries(fields).map(([key, decode]) => [key, decode(value?.[key])]))
const failure = (error, fallback = 'acceptance_runner_failed') => error instanceof Error && /^(?:acceptance|replay)_[a-z0-9_]{1,90}$/.test(error.message) ? error.message : fallback
const receipt = value => value ? shape(value, { executionId: token, modelId: model, providerGenerationId: token, requestDigest: digest,
  startedAt: date, completedAt: date, imageDigests: list(digest), vision: token }) : null
const task = value => shape(value, { taskId: uuid, issueId: uuid, requestEpoch: uuid, stage: token, status: token,
  revision: finite, attemptId: uuid, candidateId: uuid, attempts: list(row => shape(row, { id: uuid, stage: token, status: token, runId: uuid, requestEpoch: uuid })) })
const evidenceReplay = value => value ? shape(value, { messageId: uuid, repeatReads: finite, replyIds: list(uuid), traceEventIds: list(token) }) : null
const artifact = value => value ? shape(value, { artifactId: uuid, version: finite, runId: uuid, bytes: finite, sha256: digest, retainedAfterStop: bool }) : null
const checks = list(input => shape(input, { stage: token, attemptId: uuid, runId: uuid, candidateId: uuid, requestEpoch: uuid }))
const acceptance = input => input ? shape(input, { acceptanceId: uuid, eventId: uuid, replayConfirmed: bool }) : null
const finalReport = input => input ? shape(input, { eventId: token, messageIds: list(uuid), reporterId: uuid }) : null
const continuation = input => input ? shape(input, { taskId: uuid, runId: uuid, previousEpoch: uuid, requestEpoch: uuid, outcome: token,
  updatedArtifactVerified: bool, checks, artifact, acceptance, finalReport, replay: evidenceReplay }) : null

/** The owner check never returns connection metadata or provider credentials. */
export function sanitizeOwnerMcpReport(value) {
  if (!value) return null
  return { schemaVersion: finite(value.schemaVersion), status: value.status === 'passed' ? 'passed' : 'failed',
    workspaceId: uuid(value.workspaceId), connectionId: uuid(value.connectionId),
    counts: shape(value.counts, { ownedBots: finite, before: finite, withFixture: finite, after: finite }),
    checks: shape(value.checks, { normalOwnerSession: bool, personalWorkspace: bool, existingBotsOwned: bool,
      created: bool, ownerMetadataReadback: bool, personalShareRejected: bool }),
    http: shape(value.http, { create: finite, share: finite, delete: finite }),
    cleanup: shape(value.cleanup, { deleteAttempted: bool, deleteAcknowledged: bool, absentReadback: bool }),
    errors: list(error => typeof error === 'string' && /^owner_mcp_[a-z0-9_]{1,80}$/.test(error) ? error : 'owner_mcp_unconfirmed')(value.errors),
    coverage: { scope: 'single-owner-MCP-management', ...shape(value.coverage, { modelCalls: finite, providerCalls: finite,
      secretCreated: bool, teamCreated: bool, twoMemberSharing: bool, gmail: bool, frozenRunToken: bool }) } }
}

/** Explicit output projection: no body, title, note, URL, email, credential,
 * cookie, source prompt, response body or arbitrary upstream object survives. */
export function sanitizeGroupReport(value) {
  if (!value) return null
  return { ...shape(value, { status: token, error: token, revision: token, deploymentId: token, startedAt: date, finishedAt: date,
    fixtureId: uuid, workspaceId: uuid, conversationId: uuid, requesterId: token,
    bots: list(row => shape(row, { id: uuid, role: token, modelId: token })),
    subscriptionOptions: list(row => shape(row, { id: uuid, provider: token, modelId: model })) }),
    cases: (value.cases ?? []).slice(0, 20).map(row => ({
      ...shape(row, { name: token, status: token, phase: token, messageId: uuid, action: token, responders: list(uuid), generations: finite,
        publications: finite, decision: receipt, decisionCostUsd: finite, decisionLatencyMs: finite, taskId: uuid, issueId: uuid,
        requestEpoch: uuid, reporterId: uuid, expectedArtifact: input => input ? shape(input, { bytes: finite, sha256: digest }) : null,
        executionModels: list(input => shape(input, { harness: token, model: token, provider: token, credentialType: token })),
        messages: list(input => shape(input, { operation: token, messageId: uuid, decisionExecutionId: token, taskId: uuid, runId: uuid })),
        runs: list(input => shape(input, { id: uuid, status: token, harness: token, model: token, credentialType: token,
          requester: token, executionPrincipal: token, outputOwner: token, modelAccountOwner: token, runtimeAccountOwner: token, externalCost: token })),
        checks, artifact, acceptance, finalReport, continuation, stopContinuation: continuation,
        createReplay: evidenceReplay, statusReplay: evidenceReplay, stopReplay: evidenceReplay }),
      lastTask: row.lastTask ? task(row.lastTask) : null,
      observations: (row.observations ?? []).slice(-30).map(input => { let state; try { state = JSON.parse(input.state) } catch { state = null }; return { at: date(input.at), state: state ? task(state) : null } }),
    })) }
}

export function sanitizeReplayReport(value) {
  if (!value) return null
  const rows = list(row => ({ ...shape(row, { schemaVersion: finite, caseId: token, dataset: token, datasetDigest: digest,
    inputDigest: digest, policyVersion: token, evidenceKind: token, status: token, receipt, decisionLatencyMs: finite, decisionCostUsd: finite, costScope: token }),
    executionPerformed: false, policyChanged: false,
    route: row.route ? shape(row.route, { by: token, action: token, reason: token, responders: list(uuid), delegation: input => input ? shape(input, { operation: token, issueId: uuid, reportTiming: token }) : null }) : null,
  }))
  const summary = input => input ? shape(input, { cases: finite, measured: finite, coverage: finite, actionAccuracy: finite, responderAccuracy: finite,
    falseIntervention: finite, missedIntervention: finite, failures: list(row => shape(row, { caseId: token, reason: token })),
    cost: row => shape(row, { knownUsd: finite, knownObservations: finite, unknownObservations: finite }),
    decisionLatency: row => shape(row, { samples: finite, p50Ms: finite, p95Ms: finite }), runtimeCasesExcluded: list(token) }) : null
  return { ...shape(value, { status: token, error: token, dataset: token, datasetDigest: digest, deploymentId: token, revision: token,
    conversationId: uuid, startedAt: date, finishedAt: date, baseline: rows, candidate: rows }),
    comparison: { baseline: summary(value.comparison?.baseline), candidate: summary(value.comparison?.candidate),
      decisionReviewReady: value.comparison?.decisionReviewReady === true, requiresHumanReview: true, executionAcceptanceRequired: true },
    executionPerformed: false, productionAccepted: false, policyChanged: false }
}

async function defaultDependencies(repo) {
  const module = path => import(pathToFileURL(resolve(repo, path)).href)
  const [credentials, group, replay, cases, models, accounts] = await Promise.all([
    module('scripts/ops/proactive-test-credentials.mjs'), module('scripts/ops/group-production-acceptance.mjs'),
    module('scripts/group-decision-replay.ts'), module('lib/coordinator/group-decision-replay.ts'), module('scripts/test-model-policy.mjs'), module('lib/smoke-account.ts'),
  ])
  models.assertFlashTestModel('deepseek-flash')
  if (cases.GROUP_REPLAY_CASE_IDS.length !== 12) throw Error('acceptance_replay_case_count_changed')
  return { ...credentials, ...group, ...replay, ...accounts }
}

/** Does not run on import. The CLI requires the exact release checkout and
 * deployment. Tests pass local synthetic dependencies; no production call. */
export async function runAcceptanceBundle({ env = process.env, fetchImpl = fetch, repo = process.cwd(), dependencies,
  verifySource = () => {
    if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim()) throw Error('acceptance_source_dirty')
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  } } = {}) {
  const revision = env.GROUP_ACCEPTANCE_REVISION, deploymentId = env.GROUP_ACCEPTANCE_DEPLOYMENT
  if (!/^[a-f0-9]{40}$/.test(revision ?? '') || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId ?? '')) throw Error('acceptance_fixed_deployment_required')
  if (env.GROUP_ACCEPTANCE_ORIGIN && env.GROUP_ACCEPTANCE_ORIGIN !== ORIGIN) throw Error('acceptance_origin_rejected')
  if (verifySource() !== revision) throw Error('acceptance_source_revision_mismatch')
  const email = env.SMOKE_OWNER_EMAIL
  const password = env.SMOKE_OWNER_PASSWORD
  if (!email || !password) throw Error('acceptance_account_required')
  const runEnv = { ...env, MIKKA_TEST_ACCOUNT_EMAIL: email, MIKKA_TEST_ACCOUNT_PASSWORD: password }
  const report = { schemaVersion: 1, status: 'running', origin: ORIGIN, revision, deploymentId, startedAt: new Date().toISOString(),
    finishedAt: null, fixtureConversationId: null, runtime: null, ownerMcp: null, group: null, replay: null, expectedDecisionReplays: 24,
    actualReceiptedDecisionReplays: 0, credentialCleanup: null, taskCleanup: null, replaySessionEnded: false,
    scope: 'Actual production owner MCP management, group runtime and fixed-case Decision inference. Owner MCP does not exercise sharing, Gmail or a provider. Replay does not perform projected execution. No official-subscription acceptance.', error: null }
  let ownerCookie = '', cleanupReceipt = null, groupRaw = null, capturedConversation = null
  const transport = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || !(url.pathname === '/mikka' || url.pathname.startsWith('/mikka/'))) throw Error('acceptance_transport_origin_rejected')
    const response = await fetchImpl(url, { ...init, redirect: 'error' })
    if (url.pathname === '/mikka/api/conversations' && init.method === 'POST' && response.ok) {
      const created = await response.clone().json().catch(() => null)
      capturedConversation = uuid(created?.id) ?? capturedConversation
    }
    return response
  }
  const request = async (path, body) => {
    const response = await transport(ORIGIN + '/mikka' + path, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(30000),
      headers: { origin: ORIGIN, 'cache-control': 'no-store', ...(ownerCookie ? { cookie: ownerCookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) throw Error(`acceptance_http_${response.status}`)
    return { response, data: await response.json().catch(() => null) }
  }
  const version = async () => { if ((await request('/api/version')).data?.build !== deploymentId) throw Error('acceptance_deployment_changed') }
  try {
    await version()
    const api = dependencies ?? await defaultDependencies(repo)
    if (!api.isSmokeAccountEmail(email)) throw Error('acceptance_account_required')
    await api.withTemporaryFlashCredential(async cleanup => {
      cleanupReceipt = cleanup
      try {
        await version()
        const login = await request('/api/auth/sign-in/email', { email, password })
        ownerCookie = login.response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
        const session = (await request('/api/auth/get-session')).data
        if (!ownerCookie || session?.user?.email?.toLowerCase() !== email.toLowerCase()) throw Error('acceptance_session_identity')
        // One no-secret disabled connection; scoped cleanup runs before group/model
        // work. A failed management check is evidence, not a reason to skip
        // the independent group and Decision replay acceptance.
        try {
          const owner = { request: (path, init = {}) => transport(ORIGIN + '/mikka' + path, { ...init,
            headers: { ...Object.fromEntries(new Headers(init.headers)), origin: ORIGIN, 'cache-control': 'no-store', cookie: ownerCookie } }) }
          report.ownerMcp = sanitizeOwnerMcpReport(await runOwnerMcpBoundaries({ owner, verifyTarget: version }))
        } catch { report.ownerMcp = sanitizeOwnerMcpReport({ status: 'failed', errors: ['owner_mcp_unconfirmed'] }) }
        // Independent scenario failures may continue; a changed production
        // deployment still stops the bundle before any group/model work.
        await version()
        const bots = (await request('/api/bots')).data
        const workspaceId = uuid(bots?.[0]?.workspaceId)
        if (!workspaceId) throw Error('acceptance_workspace_missing')
        const [cloud, order] = await Promise.all([
          request(`/api/settings/e2b-key?workspace=${workspaceId}`).then(result => result.data),
          request(`/api/settings/model-order?workspace=${workspaceId}`).then(result => result.data),
        ])
        report.runtime = { workspaceId, cloud: shape(cloud, { configured: bool, byoEnabled: bool, canEdit: bool, lastErrorCode: token }),
          order: shape(order, { location: token, customized: bool, preferredHarness: token, cloudReady: bool,
            entries: list(entry => ({ ...shape(entry, { model: token, provider: token, harness: token }), credentialType: token(entry.source?.kind), blockReason: token(entry.block?.reason), cloudModelState: token(order?.cloudModels?.[entry.id]) })) }) }
        try { groupRaw = await api.runGroupProductionAcceptance({ env: { ...runEnv, GROUP_ACCEPTANCE_ORIGIN: ORIGIN }, fetchImpl: transport }); report.group = sanitizeGroupReport(groupRaw) }
        catch (error) { report.group = { status: 'fail', error: failure(error) } }
        report.fixtureConversationId = uuid(groupRaw?.conversationId) ?? capturedConversation
        // Keep failed-case evidence unchanged; cleanup is recorded separately.
        // Only the task returned by this run's Factory case is eligible.
        if (groupRaw?.status !== 'pass') {
          const fixture = groupRaw?.cases?.find(row => row.name === 'group-factory-artifact-continuation-stop')
          if (uuid(fixture?.taskId) && uuid(fixture?.reporterId)) {
            report.taskCleanup = { taskId: fixture.taskId, status: 'pending' }
            try {
              const current = (await request(`/api/factory/tasks/${fixture.taskId}`)).data
              if (current?.task?.id !== fixture.taskId || current.task.botId !== fixture.reporterId || (fixture.issueId && current.task.issueId !== fixture.issueId)) throw Error('acceptance_cleanup_task_scope')
              const completed = current.task.status === 'passed' && ['approval', 'publish', 'monitor'].includes(current.task.stage)
              if (!completed && !['cancelled', 'revoked'].includes(current.task.status)) {
                const binding = { taskId: current.task.id, issueId: current.task.issueId, attemptId: current.task.attemptId, candidateId: current.task.candidateId, revision: current.task.revision }
                await request(`/api/factory/tasks/${fixture.taskId}`, { binding, eventId: randomUUID(), action: 'cancel', reason: 'Stop this synthetic acceptance task after its acceptance driver failed; retain its evidence.' })
              }
              report.taskCleanup.status = completed ? 'already-complete' : 'cancellation-recorded'
            } catch (error) { report.taskCleanup.status = 'failed'; report.taskCleanup.error = failure(error, 'acceptance_cleanup_failed') }
          }
        }
        // Factory or another group scenario can fail after the group exists.
        // The independent Decision replay still uses that normal authorized group.
        if (report.fixtureConversationId) {
          try {
            const replay = await api.runGroupDecisionReplay({ env: { ...env, GROUP_REPLAY_ORIGIN: ORIGIN,
              GROUP_REPLAY_CONVERSATION: report.fixtureConversationId, GROUP_REPLAY_DEPLOYMENT: deploymentId, GROUP_REPLAY_REVISION: revision,
              GROUP_REPLAY_TOKEN: undefined, GROUP_REPLAY_COOKIE: ownerCookie }, fetchImpl: transport })
            report.replay = sanitizeReplayReport(replay)
            report.actualReceiptedDecisionReplays = [...(report.replay?.baseline ?? []), ...(report.replay?.candidate ?? [])].filter(row => row.receipt?.providerGenerationId && row.receipt?.requestDigest).length
          } catch (error) { report.replay = { status: 'failed', error: failure(error, 'replay_request_failed') } }
        } else report.replay = { status: 'blocked', error: 'replay_fixture_group_missing' }
        await version()
      } finally {
        if (ownerCookie) { try { await request('/api/auth/sign-out', {}); report.replaySessionEnded = true } catch { report.replaySessionEnded = false } }
        ownerCookie = ''
      }
    }, { env: runEnv, fetchImpl: transport, cloudExecution: true })
  } catch (error) { report.error = failure(error) }
  finally {
    ownerCookie = ''
    report.credentialCleanup = cleanupReceipt ? shape(cleanupReceipt, { created: bool, removed: bool, cloudCreated: bool, cloudRemoved: bool }) : { status: 'helper_did_not_enter_run' }
    report.finishedAt = new Date().toISOString()
  }
  const cleaned = cleanupReceipt && (!cleanupReceipt.created || cleanupReceipt.removed) && (!cleanupReceipt.cloudCreated || cleanupReceipt.cloudRemoved)
  report.status = !report.error && cleaned && report.replaySessionEnded && report.ownerMcp?.status === 'passed' && report.group?.status === 'pass'
    && report.replay?.status === 'complete' && report.actualReceiptedDecisionReplays === 24 && report.replay?.comparison?.decisionReviewReady === true ? 'pass' : 'fail'
  return report
}

export function writeSanitizedReport(report, output, env = process.env) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  for (const name of ['MIKKA_TEST_ACCOUNT_PASSWORD', 'SMOKE_OWNER_PASSWORD', 'DEEPSEEK_API_KEY', 'E2B_API_KEY', 'GROUP_REPLAY_COOKIE', 'GROUP_REPLAY_TOKEN']) {
    if (env[name]?.length >= 8 && serialized.includes(env[name])) throw Error('acceptance_report_secret_detected')
  }
  if (/"(?:cookie|authorization|password|apiKey|prompt|body|email)"\s*:/i.test(serialized)) throw Error('acceptance_report_private_field_detected')
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 })
  const fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, serialized) } finally { closeSync(fd) }
}

async function main() {
  const output = resolve(process.env.GROUP_ACCEPTANCE_OUTPUT ?? 'proactive-acceptance-sanitized/results.json')
  let report
  try { report = await runAcceptanceBundle() }
  catch (error) { report = { schemaVersion: 1, status: 'fail', error: failure(error), actualReceiptedDecisionReplays: 0 } }
  report.runnerDigest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
  writeSanitizedReport(report, output)
  const summary = { status: report.status, ownerMcp: report.ownerMcp?.status ?? 'not-run', group: report.group?.status ?? 'not-run', replay: report.replay?.status ?? 'not-run',
    actualReceiptedDecisionReplays: report.actualReceiptedDecisionReplays, expectedDecisionReplays: 24,
    error: report.error ?? null, fixtureConversationId: report.fixtureConversationId ?? null, report: output }
  console.log(JSON.stringify(summary))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Proactive production acceptance\n\nStatus: **${summary.status}**\n\nOwner MCP management: ${summary.ownerMcp}; group runtime: ${summary.group}; actual Decision replays: ${summary.actualReceiptedDecisionReplays}/24 (${summary.replay}).\n\nOnly the sanitized JSON report is uploaded. Owner MCP does not call a provider; replay does not execute its projected actions.\n`)
  if (report.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => { console.error(failure(error)); process.exitCode = 1 })
