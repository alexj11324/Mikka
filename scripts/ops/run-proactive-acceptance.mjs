import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, constants, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
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
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const oneOf = values => value => values.includes(value) ? value : null
const protocol = oneOf(['group-sequential-v1'])
const phase = oneOf(['intent', 'responder', 'delegation', 'report_timing', 'legacy_primary'])
const decisionFailure = oneOf(['unavailable', 'missing_or_refused', 'wrong_answer_type', 'uncertain', 'choice_outside_contract',
  'receipt_missing', 'duplicate_receipt', 'mention_requires_intervention', 'reporter_unavailable', 'call_budget_exhausted', 'invalid_response', 'members_unavailable'])
const decisionCalls = value => shape(value, { attempted: integer, receipted: integer, unreceipted: integer })
const decisionCost = value => shape(value, { knownUsd: finite, knownCalls: integer, unknownCalls: integer, omittedCalls: integer })
const decisionStep = value => shape(value, { id: token, phase, index: integer, policyVersion: oneOf(['group-route-v0', 'group-contribution-v1', 'group-contribution-v2', 'group-contribution-v3']),
  status: oneOf(['complete', 'invalid_decision', 'unavailable']), failure: decisionFailure, receipt, decisionCostUsd: finite })
const decisionFields = { decisionProtocol: protocol, decisions: list(decisionStep), decisionsOmitted: integer,
  failureReason: decisionFailure, decisionCalls, decisionCost, decisionCostUsd: finite, decisionLatencyMs: finite,
  costScope: oneOf(['routing-decision-chain']) }
const validReceipt = value => Boolean(value && token(value.executionId) && token(value.providerGenerationId)
  && model(value.modelId) && digest(value.requestDigest) && date(value.startedAt) && date(value.completedAt)
  && Date.parse(value.completedAt) >= Date.parse(value.startedAt)
  && Array.isArray(value.imageDigests) && value.imageDigests.every(item => digest(item))
  && ['no-image-input', 'image-input-submitted'].includes(value.vision))
function measureDecisions(steps, omittedCalls = 0) {
  const generations = new Set()
  let attempted = 0, receipted = 0, knownCalls = 0, knownUsd = 0
  for (const item of steps) {
    const step = item && typeof item === 'object' ? item : {}
    const generation = validReceipt(step.receipt) ? step.receipt.providerGenerationId : null
    if (generation && generations.has(generation)) continue
    attempted++
    if (generation) { generations.add(generation); receipted++ }
    if (generation && finite(step.decisionCostUsd) !== null) { knownCalls++; knownUsd += step.decisionCostUsd }
  }
  const unknownCalls = attempted - knownCalls
  return { decisionCalls: { attempted, receipted, unreceipted: attempted - receipted },
    decisionCost: { knownUsd, knownCalls, unknownCalls, omittedCalls },
    decisionCostUsd: unknownCalls || omittedCalls || !attempted ? null : knownUsd }
}
const sameCount = (left, right) => ['attempted', 'receipted', 'unreceipted'].every(key => left?.[key] === right[key])
const sameCost = (left, right) => ['knownCalls', 'unknownCalls', 'omittedCalls'].every(key => left?.[key] === right[key])
  && finite(left?.knownUsd) !== null && Math.abs(left.knownUsd - right.knownUsd) < 1e-9

/** Count logical replay cases separately from paid/unknown provider requests.
 * Failed rows retain their receipts and unknown costs; duplicate evidence never
 * makes the fixed 12 x 2 logical suite pass. */
function completeReplayProjection(row) {
  const route = row.route, projected = row.projection
  if (!route || !projected || !['model', 'mention'].includes(route.by)
    || !['ignore', 'observe', 'reply', 'clarify', 'delegate'].includes(route.action)
    || !Array.isArray(route.responders) || route.responders.some(id => !uuid(id))
    || new Set(route.responders).size !== route.responders.length) return false
  const intervention = !['ignore', 'observe'].includes(route.action), delegation = route.delegation
  if (intervention ? route.responders.length < 1 || route.responders.length > 3 : route.responders.length !== 0) return false
  if (route.action === 'delegate') {
    if (route.responders.length !== 1 || !delegation || !['create', 'continue', 'status', 'stop'].includes(delegation.operation)
      || (delegation.operation === 'create' ? delegation.issueId !== null : !uuid(delegation.issueId))
      || !['now', 'on_completion'].includes(delegation.reportTiming)
      || ['status', 'stop'].includes(delegation.operation) && delegation.reportTiming !== 'now') return false
  } else if (delegation != null) return false
  return projected.intervention === intervention && projected.selectedResponderCount === route.responders.length
    && projected.delegationOperation === (delegation?.operation ?? null)
    && projected.reportTiming === (delegation?.reportTiming ?? null)
}
function boundReplaySummary(value, stats, expected) {
  const totals = measureDecisions(stats.steps)
  return Boolean(value && value.cases === 12 && value.logicalReplays === 12 && value.observed === 12
    && value.observationCoverage === 1 && value.accuracyDenominator === 12
    && value.measured === stats.complete && value.coverage === stats.complete / 12 && value.abstentions === stats.abstentions
    && integer(value.unresolvedPositive) !== null && integer(value.unresolvedNegative) !== null
    && value.unresolvedPositive + value.unresolvedNegative === stats.abstentions
    && integer(value.intentionalNonIntervention) !== null && value.intentionalNonIntervention <= stats.complete
    && finite(value.actionAccuracy) !== null && value.actionAccuracy <= 1
    && finite(value.responderAccuracy) !== null && value.responderAccuracy <= 1
    && Array.isArray(value.missingCaseIds) && value.missingCaseIds.length === 0
    && Array.isArray(value.failures) && value.failures.every(item => expected.caseIds.includes(item?.caseId)
      && ['invalid_decision', 'receipt_missing', 'action', 'responder', 'report_timing'].includes(item?.reason))
    && stats.failedCaseIds.every(caseId => value.failures.some(item => item.caseId === caseId && item.reason === 'invalid_decision'))
    && sameCount(value.decisionCalls, totals.decisionCalls) && value.cost?.scope === 'routing-decision-chain'
    && sameCost(value.cost, totals.decisionCost)
    && (totals.decisionCostUsd === null ? value.cost.completeTotalUsd === null
      : finite(value.cost.completeTotalUsd) !== null && Math.abs(value.cost.completeTotalUsd - totals.decisionCostUsd) < 1e-9))
}
export function measureReplayEvidence(value, expected) {
  const allSteps = [], generations = new Set(), executions = new Set(), logical = new Set(), stepIds = new Set()
  const stats = { baseline: { complete: 0, abstentions: 0, steps: [], failedCaseIds: [] },
    candidate: { complete: 0, abstentions: 0, steps: [], failedCaseIds: [] } }
  let logicalReplays = 0, receiptedLogicalReplays = 0, completedLogicalReplays = 0, unobservedLogicalReplays = 0, evidenceValid = true
  const configured = Array.isArray(expected.caseIds) && expected.caseIds.length === 12 && new Set(expected.caseIds).size === 12
    && digest(expected.datasetDigest) && expected.baselinePolicy === 'group-route-v0' && expected.candidatePolicy === 'group-contribution-v3'
    && expected.comparisonVersion === 'group-decision-comparison-v2' && value?.comparisonVersion === expected.comparisonVersion
  for (const [label, policy] of [['baseline', expected.baselinePolicy], ['candidate', expected.candidatePolicy]]) {
    const rows = Array.isArray(value?.[label]) ? value[label] : []
    if (rows.length !== 12) evidenceValid = false
    for (const row of rows) {
      logicalReplays++
      if (validReceipt(row.receipt)) receiptedLogicalReplays++
      const key = policy + ':' + row.caseId, steps = Array.isArray(row.decisions) ? row.decisions : []
      if (!steps.length) unobservedLogicalReplays++
      const totals = measureDecisions(steps)
      let rowBound = configured && !logical.has(key) && expected.caseIds.includes(row.caseId)
        && row.policyVersion === policy && row.datasetDigest === expected.datasetDigest && digest(row.inputDigest) && row.schemaVersion === 1
        && row.evidenceKind === 'actual-decision-inference' && row.executionPerformed === false && row.policyChanged === false
        && row.decisionProtocol === 'group-sequential-v1' && ['complete', 'invalid_decision'].includes(row.status)
        && (row.status === 'complete' ? row.failureReason === null && completeReplayProjection(row)
          : decisionFailure(row.failureReason) !== null && row.route === null && row.projection === null)
        && row.costScope === 'routing-decision-chain' && steps.length > 0 && steps.length <= 4
        && validReceipt(row.receipt) && row.receipt.modelId === 'openai/gpt-6-luna-decisions'
        && steps[0]?.receipt?.executionId === row.receipt?.executionId
        && steps[0]?.receipt?.providerGenerationId === row.receipt?.providerGenerationId
        && steps[0]?.receipt?.requestDigest === row.receipt?.requestDigest
        && sameCount(row.decisionCalls, totals.decisionCalls) && sameCost(row.decisionCost, totals.decisionCost)
        && (totals.decisionCostUsd === null ? row.decisionCostUsd === null
          : finite(row.decisionCostUsd) !== null && Math.abs(row.decisionCostUsd - totals.decisionCostUsd) < 1e-9)
      logical.add(key)
      for (const [index, item] of steps.entries()) {
        const step = item && typeof item === 'object' ? item : {}
        allSteps.push(step); stats[label].steps.push(step)
        const evidence = validReceipt(step.receipt)
        const failedLast = row.status === 'invalid_decision' && index === steps.length - 1
        const stepBound = failedLast
          ? step.failure === row.failureReason && (evidence ? step.status === 'invalid_decision' : step.status === 'unavailable' && step.receipt === null)
          : step.status === 'complete' && step.failure === null && evidence
        if (!uuid(step.id) || stepIds.has(step.id) || !['intent', 'responder', 'delegation', 'report_timing'].includes(step.phase) || step.index !== index
          || step.policyVersion !== policy || !stepBound) rowBound = false
        stepIds.add(step.id)
        if (evidence) {
          if (step.receipt.modelId !== 'openai/gpt-6-luna-decisions' || generations.has(step.receipt.providerGenerationId)
            || executions.has(step.receipt.executionId)) rowBound = false
          generations.add(step.receipt.providerGenerationId); executions.add(step.receipt.executionId)
        }
      }
      if (rowBound && row.status === 'complete') { completedLogicalReplays++; stats[label].complete++ }
      if (rowBound && row.status === 'invalid_decision') {
        stats[label].failedCaseIds.push(row.caseId)
        if (row.failureReason === 'uncertain' && steps.every(step => validReceipt(step.receipt))) stats[label].abstentions++
      }
      if (!rowBound) evidenceValid = false
    }
  }
  const totals = measureDecisions(allSteps)
  if (unobservedLogicalReplays) totals.decisionCostUsd = null
  evidenceValid = Boolean(evidenceValid && configured && logicalReplays === 24 && totals.decisionCalls.attempted <= 96)
  const collectionComplete = evidenceValid && value?.collectionComplete === true
  const baselineClassifiable = evidenceValid && stats.baseline.complete + stats.baseline.abstentions === 12
  const summariesBound = boundReplaySummary(value?.comparison?.baseline, stats.baseline, expected)
    && boundReplaySummary(value?.comparison?.candidate, stats.candidate, expected)
  const valid = Boolean(collectionComplete && baselineClassifiable && stats.candidate.complete === 12 && summariesBound)
  const baseline = value?.comparison?.baseline, candidate = value?.comparison?.candidate
  const qualityAccepted = valid && value?.status === 'comparison_ready' && value?.qualityAccepted === true
    && value?.comparison?.baselineClassifiable === true && value?.comparison?.decisionReviewReady === true
    && value?.comparison?.requiresHumanReview === true && value?.comparison?.executionAcceptanceRequired === true
    && candidate.failures.length === 0 && candidate.actionAccuracy === 1 && candidate.responderAccuracy === 1
    && integer(candidate.falseIntervention) !== null && integer(baseline.falseIntervention) !== null
    && integer(candidate.missedIntervention) !== null && integer(baseline.missedIntervention) !== null
    && candidate.falseIntervention <= baseline.falseIntervention && candidate.missedIntervention <= baseline.missedIntervention
  return { scope: 'routing-decision-chain', comparisonVersion: configured ? expected.comparisonVersion : null,
    logicalReplays, receiptedLogicalReplays, completedLogicalReplays, unobservedLogicalReplays,
    baselineClassifiable, baselineCompleted: stats.baseline.complete, baselineAbstentions: stats.baseline.abstentions, candidateCompleted: stats.candidate.complete,
    evidenceValid, collectionComplete, qualityAccepted, valid,
    ...totals, maximumProviderCalls: 96 }
}
const cleanupTurn = row => shape(row, { messageId: uuid, status: token, error: token, traceStatus: token })
const groupCleanup = value => value ? shape(value, { source: token, status: token, conversationId: uuid, attempted: bool,
  acknowledged: bool, stoppedTurns: integer, noPendingRetry: bool, executionStopConfirmed: bool,
  delegatedTaskIds: list(uuid), before: list(cleanupTurn), after: list(cleanupTurn), error: token }) : null
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
    fixtureId: uuid, workspaceId: uuid, conversationId: uuid, requesterId: token, sessionEnded: bool, groupCleanup,
    decisionObservations: list(row => shape(row, { messageId: uuid, primaryReceipt: receipt, ...decisionFields })),
    decisionAccounting: row => row ? shape(row, { scope: oneOf(['routing-decision-chain']), decisionCalls, decisionCost,
      decisionCostUsd: finite, decisionLatencyMs: finite, unobservedTurns: integer }) : null,
    bots: list(row => shape(row, { id: uuid, role: token, modelId: token })),
    subscriptionOptions: list(row => shape(row, { id: uuid, provider: token, modelId: model })) }),
    cases: (value.cases ?? []).slice(0, 20).map(row => ({
      ...shape(row, { name: token, status: token, phase: token, messageId: uuid, action: token, responders: list(uuid), wakes: integer, generations: finite,
        publications: finite, decision: receipt, ...decisionFields, taskId: uuid, issueId: uuid,
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
    inputDigest: digest, policyVersion: token, evidenceKind: token, status: token, receipt, ...decisionFields }),
    executionPerformed: typeof row.executionPerformed === 'boolean' ? row.executionPerformed : null,
    policyChanged: typeof row.policyChanged === 'boolean' ? row.policyChanged : null,
    projection: row.projection ? shape(row.projection, { intervention: bool, selectedResponderCount: integer, delegationOperation: token, reportTiming: token }) : null,
    route: row.route ? shape(row.route, { by: token, action: token, reason: token, responders: list(uuid), delegation: input => input ? shape(input, { operation: token, issueId: uuid, reportTiming: token }) : null }) : null,
  }))
  const summary = input => input ? shape(input, { cases: finite, logicalReplays: integer, observed: integer, observationCoverage: finite, measured: finite, coverage: finite, accuracyDenominator: integer,
    abstentions: integer, unresolvedPositive: integer, unresolvedNegative: integer, intentionalNonIntervention: integer, missingCaseIds: list(token),
    actionAccuracy: finite, responderAccuracy: finite,
    falseIntervention: finite, missedIntervention: finite, failures: list(row => shape(row, { caseId: token, reason: token })),
    decisionCalls, cost: row => shape(row, { scope: oneOf(['routing-decision-chain']), knownUsd: finite,
      knownCalls: integer, unknownCalls: integer, omittedCalls: integer, completeTotalUsd: finite,
      knownObservations: integer, unknownObservations: integer }),
    decisionLatency: row => shape(row, { scope: oneOf(['provider-request']), samples: finite, p50Ms: finite, p95Ms: finite }), runtimeCasesExcluded: list(token) }) : null
  return { ...shape(value, { status: token, error: token, comparisonVersion: token, collectionComplete: bool, qualityAccepted: bool, dataset: token, datasetDigest: digest, deploymentId: token, revision: token,
    conversationId: uuid, startedAt: date, finishedAt: date, baseline: rows, candidate: rows }),
    comparison: { baseline: summary(value.comparison?.baseline), candidate: summary(value.comparison?.candidate),
      baselineClassifiable: value.comparison?.baselineClassifiable === true, decisionReviewReady: value.comparison?.decisionReviewReady === true, requiresHumanReview: true, executionAcceptanceRequired: true },
    executionPerformed: false, productionAccepted: false, policyChanged: false }
}

async function defaultDependencies(repo) {
  const module = path => import(pathToFileURL(resolve(repo, path)).href)
  const [credentials, group, replay, cases, models, accounts, policy] = await Promise.all([
    module('scripts/ops/proactive-test-credentials.mjs'), module('scripts/ops/group-production-acceptance.mjs'),
    module('scripts/group-decision-replay.ts'), module('lib/coordinator/group-decision-replay.ts'), module('scripts/test-model-policy.mjs'), module('lib/smoke-account.ts'),
    module('lib/coordinator/group-decision-policy.ts'),
  ])
  models.assertFlashTestModel('deepseek-flash')
  if (cases.GROUP_REPLAY_CASE_IDS.length !== 12) throw Error('acceptance_replay_case_count_changed')
  if (cases.GROUP_REPLAY_COMPARISON_VERSION !== 'group-decision-comparison-v2' || policy.GROUP_BASELINE_VERSION !== 'group-route-v0'
    || policy.GROUP_POLICY_VERSION !== 'group-contribution-v3') throw Error('acceptance_replay_comparison_contract')
  return { ...credentials, ...group, ...replay, ...accounts, replayContract: { caseIds: cases.GROUP_REPLAY_CASE_IDS,
    datasetDigest: cases.GROUP_REPLAY_DATASET_DIGEST, comparisonVersion: cases.GROUP_REPLAY_COMPARISON_VERSION, baselinePolicy: policy.GROUP_BASELINE_VERSION, candidatePolicy: policy.GROUP_POLICY_VERSION } }
}

/** Does not run on import. The CLI requires the exact release checkout and
 * deployment. Tests pass local synthetic dependencies; no production call. */
export async function runAcceptanceBundle({ env = process.env, fetchImpl = fetch, repo = process.cwd(), dependencies,
  now = Date.now, wait = delay,
  verifySource = () => {
    if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim()) throw Error('acceptance_source_dirty')
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  } } = {}) {
  const revision = env.GROUP_ACCEPTANCE_REVISION, deploymentId = env.GROUP_ACCEPTANCE_DEPLOYMENT
  if (!/^[a-f0-9]{40}$/.test(revision ?? '') || !/^dpl_[A-Za-z0-9]+$/.test(deploymentId ?? '')) throw Error('acceptance_fixed_deployment_required')
  if (env.GROUP_ACCEPTANCE_ORIGIN && env.GROUP_ACCEPTANCE_ORIGIN !== ORIGIN) throw Error('acceptance_origin_rejected')
  if (verifySource() !== revision) throw Error('acceptance_source_revision_mismatch')
  const terminalWaitBudgetMs = Number(env.GROUP_ACCEPTANCE_STOP_TIMEOUT_MS ?? 180000)
  if (!Number.isSafeInteger(terminalWaitBudgetMs) || terminalWaitBudgetMs < 1000 || terminalWaitBudgetMs > 180000) throw Error('acceptance_stop_budget_invalid')
  const email = env.SMOKE_OWNER_EMAIL
  const password = env.SMOKE_OWNER_PASSWORD
  if (!email || !password) throw Error('acceptance_account_required')
  const runEnv = { ...env, MIKKA_TEST_ACCOUNT_EMAIL: email, MIKKA_TEST_ACCOUNT_PASSWORD: password }
  const report = { schemaVersion: 1, status: 'running', origin: ORIGIN, revision, deploymentId, startedAt: new Date().toISOString(),
    finishedAt: null, fixtureConversationId: null, runtime: null, ownerMcp: null, group: null, replay: null, expectedDecisionReplays: 24,
    actualReceiptedDecisionReplays: 0, completedLogicalDecisionReplays: 0, replayAccounting: null,
    credentialCleanup: null, taskCleanup: null, groupCleanup: null, machineCleanup: null, replaySessionEnded: false,
    sessionCleanup: {},
    scope: 'Actual production owner MCP management, group runtime and fixed-case Decision inference. Owner MCP does not exercise sharing, Gmail or a provider. Replay does not perform projected execution. No official-subscription acceptance.', error: null }
  let ownerCookie = '', cleanupReceipt = null, groupRaw = null, capturedGroup = null, ownerId = null
  const capturedBots = new Map()
  const transport = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== ORIGIN || url.username || url.password || url.hash || !(url.pathname === '/mikka' || url.pathname.startsWith('/mikka/'))) throw Error('acceptance_transport_origin_rejected')
    const response = await fetchImpl(url, { ...init, redirect: 'error' })
    if (['/mikka/api/conversations', '/mikka/api/bots'].includes(url.pathname) && init.method === 'POST' && response.status === 201) {
      const created = await response.clone().json().catch(() => null)
      let submitted
      try { submitted = JSON.parse(init.body) } catch { submitted = null }
      if (url.pathname.endsWith('/api/bots') && uuid(created?.id) && created.name === submitted?.name
        && /^Acceptance (UI|Coding|Testing) [a-f0-9]{8}$/.test(created.name)) capturedBots.set(created.id, { id: created.id, name: created.name })
      if (url.pathname.endsWith('/api/conversations') && uuid(created?.id) && uuid(submitted?.workspaceId)
        && created.title === submitted?.title && /^Proactive acceptance [a-f0-9]{8}$/.test(created.title)
        && Array.isArray(submitted.members) && submitted.members.length === 3
        && submitted.members.every(member => member.memberType === 'bot' && capturedBots.has(member.memberId))) {
        capturedGroup = { id: created.id, title: created.title, workspaceId: submitted.workspaceId,
          botIds: submitted.members.map(member => member.memberId) }
      }
    }
    return response
  }
  const sessionTransport = scope => {
    const record = report.sessionCleanup[scope] = { loginAttempted: false, loginStatus: null,
      logoutAttempted: false, logoutAcknowledged: false, logoutStatus: null }
    return async (input, init = {}) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
      const login = path === '/mikka/api/auth/sign-in/email' && init.method === 'POST'
      const logout = path === '/mikka/api/auth/sign-out' && init.method === 'POST'
      if (login) record.loginAttempted = true
      if (logout) record.logoutAttempted = true
      const response = await transport(input, init)
      if (login) record.loginStatus = response.status
      if (logout) { record.logoutStatus = response.status; record.logoutAcknowledged = response.status === 200 }
      return response
    }
  }
  const ownerTransport = sessionTransport('ownerMcpAndReplay')
  const credentialTransport = sessionTransport('temporaryCredentials')
  const groupTransport = sessionTransport('groupRuntime')
  const request = async (path, body, signal = AbortSignal.timeout(30000)) => {
    const response = await ownerTransport(ORIGIN + '/mikka' + path, { method: body === undefined ? 'GET' : 'POST', signal,
      headers: { origin: ORIGIN, 'cache-control': 'no-store', ...(ownerCookie ? { cookie: ownerCookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) throw Error(`acceptance_http_${response.status}`)
    return { response, data: await response.json().catch(() => null) }
  }
  const version = async signal => { if ((await request('/api/version', undefined, signal)).data?.build !== deploymentId) throw Error('acceptance_deployment_changed') }
  async function stopCapturedGroup() {
    const cleanup = { source: 'runner-fallback', status: 'failed', conversationId: capturedGroup.id, attempted: false,
      acknowledged: false, stoppedTurns: null, noPendingRetry: false, executionStopConfirmed: false, delegatedTaskIds: [], before: [], after: [] }
    report.groupCleanup = cleanup
    const check = (condition, code) => { if (!condition) throw Error(code) }
    const project = rows => rows.map(row => cleanupTurn({ ...row, traceStatus: row.trace?.status }))
    try {
      await version()
      check((await request('/api/auth/get-session')).data?.user?.id === ownerId, 'acceptance_group_cleanup_owner')
      const groups = (await request('/api/conversations?workspaceId=' + capturedGroup.workspaceId)).data?.conversations
      const current = groups?.find(row => row.id === capturedGroup.id)
      check(current?.createdBy === ownerId && current.workspaceId === capturedGroup.workspaceId && current.kind === 'group'
        && current.title === capturedGroup.title && date(current.createdAt)
        && Date.parse(current.createdAt) >= Date.parse(report.startedAt) - 5000, 'acceptance_group_cleanup_scope')
      const bots = (await request('/api/bots')).data
      check(new Set(capturedGroup.botIds).size === 3 && capturedGroup.botIds.every(id => Array.isArray(bots)
        && bots.some(row => row.id === id && row.ownerId === ownerId && row.workspaceId === capturedGroup.workspaceId
          && row.name === capturedBots.get(id)?.name && row.name.endsWith(capturedGroup.title.slice(-8)))), 'acceptance_group_cleanup_bots')
      const members = (await request('/api/conversations/' + capturedGroup.id + '/members')).data?.members
      const expected = ['user:' + ownerId, ...capturedGroup.botIds.map(id => 'bot:' + id)].sort()
      check(Array.isArray(members) && JSON.stringify(members.map(row => row.memberType + ':' + row.id).sort()) === JSON.stringify(expected)
        && members.find(row => row.memberType === 'user' && row.id === ownerId)?.role === 'owner', 'acceptance_group_cleanup_members')
      const before = (await request('/api/conversations/' + capturedGroup.id + '/decisions?limit=100')).data?.turns
      check(Array.isArray(before) && before.length <= 100, 'acceptance_group_cleanup_trace')
      cleanup.before = project(before)
      cleanup.delegatedTaskIds = [...new Set(before.flatMap(row => (row.trace?.events ?? [])
        .filter(event => event.type === 'delegate' && uuid(event.taskId)).map(event => event.taskId)))]
      await version()
      cleanup.attempted = true
      try {
        const stopped = await request('/api/conversations/' + capturedGroup.id + '/stop', {})
        cleanup.acknowledged = stopped.response.status === 200 && integer(stopped.data?.stopped) !== null && stopped.data.stopped <= before.length
        cleanup.stoppedTurns = cleanup.acknowledged ? stopped.data.stopped : null
      } catch { cleanup.error = 'acceptance_group_stop_unconfirmed' }
      const after = (await request('/api/conversations/' + capturedGroup.id + '/decisions?limit=100')).data?.turns
      check(Array.isArray(after) && after.length <= 100, 'acceptance_group_cleanup_trace')
      cleanup.after = project(after)
      cleanup.noPendingRetry = after.every(row => !['queued', 'running'].includes(row.status) && row.error !== 'group_judgment_pending')
      cleanup.status = cleanup.acknowledged && cleanup.noPendingRetry ? 'stopped' : cleanup.noPendingRetry ? 'stop-observed-unconfirmed' : 'failed'
    } catch (error) { cleanup.error = failure(error, 'acceptance_group_cleanup_failed') }
  }
  async function endFixtureMachines(fixture) {
    const cleanup = { status: 'failed', taskId: uuid(fixture.taskId), issueId: uuid(fixture.issueId), reporterId: uuid(fixture.reporterId),
      runs: [], artifactsReadbackConfirmed: false, executionStopConfirmed: false, machineEndAcknowledged: false,
      independentProviderObservation: false, perRunExternalStatus: 'unknown', sharedDesktop: null,
      terminalWaitBudgetMs, terminalWaitElapsedMs: 0, terminalPolls: 0 }
    report.machineCleanup = cleanup
    const check = (condition, code) => { if (!condition) throw Error(code) }
    const ended = new Set(['succeeded', 'completed', 'failed', 'stopped', 'cancelled'])
    try {
      await version()
      check(capturedGroup && groupRaw?.requesterId === ownerId && groupRaw.workspaceId === capturedGroup.workspaceId
        && capturedGroup.botIds.includes(fixture.reporterId) && uuid(fixture.taskId) && uuid(fixture.issueId), 'acceptance_machine_cleanup_fixture')
      const quality = (await request('/api/conversations/' + capturedGroup.id + '/decisions?limit=100')).data
      const bindings = (fixture.messages ?? []).filter(row => ['create', 'continue'].includes(row.operation)
        && row.taskId === fixture.taskId && uuid(row.messageId) && uuid(row.runId))
      check(bindings.some(row => row.operation === 'create') && Array.isArray(quality?.turns), 'acceptance_machine_cleanup_receipt')
      for (const binding of bindings) {
        const events = quality.turns.find(row => row.messageId === binding.messageId)?.trace?.events
        check(Array.isArray(events) && events.some(event => event.type === 'delegate' && event.outcome === 'succeeded'
          && event.memberId === fixture.reporterId && event.taskId === fixture.taskId && event.runId === binding.runId), 'acceptance_machine_cleanup_receipt')
      }
      const state = (await request('/api/factory/tasks/' + fixture.taskId)).data
      check(state?.task?.id === fixture.taskId && state.task.botId === fixture.reporterId && state.task.issueId === fixture.issueId
        && Array.isArray(state.attempts), 'acceptance_machine_cleanup_task_scope')
      check(['failed', 'cancelled', 'revoked'].includes(state.task.status)
        || state.task.status === 'passed' && ['approval', 'publish', 'monitor'].includes(state.task.stage), 'acceptance_machine_cleanup_task_active')
      const epochs = new Set(bindings.map(binding => state.attempts.find(attempt => attempt.runId === binding.runId)?.output?.requestEpoch))
      check(epochs.size > 0 && [...epochs].every(value => uuid(value)) && epochs.has(state.task.sourceEventId), 'acceptance_machine_cleanup_epoch_scope')
      const runIds = [...new Set(state.attempts.filter(attempt => epochs.has(attempt.output?.requestEpoch) && uuid(attempt.runId)).map(attempt => attempt.runId))]
      check(runIds.length > 0 && runIds.length <= 48 && bindings.every(binding => runIds.includes(binding.runId)), 'acceptance_machine_cleanup_run_scope')
      const runBindings = attempts => attempts.filter(attempt => epochs.has(attempt.output?.requestEpoch) && uuid(attempt.runId))
        .map(attempt => attempt.runId + ':' + attempt.output.requestEpoch).sort()
      const originalBindings = JSON.stringify(runBindings(state.attempts))
      const recheckTask = async signal => {
        const current = (await request('/api/factory/tasks/' + fixture.taskId, undefined, signal)).data
        check(current?.task?.id === fixture.taskId && current.task.botId === fixture.reporterId && current.task.issueId === fixture.issueId
          && Array.isArray(current.attempts), 'acceptance_machine_cleanup_task_scope')
        check(current.task.sourceEventId === state.task.sourceEventId && JSON.stringify(runBindings(current.attempts)) === originalBindings,
          'acceptance_machine_cleanup_epoch_scope')
        check(['failed', 'cancelled', 'revoked'].includes(current.task.status)
          || current.task.status === 'passed' && ['approval', 'publish', 'monitor'].includes(current.task.stage), 'acceptance_machine_cleanup_task_active')
      }
      let artifactCount = 0
      const waitingSince = now(), deadline = waitingSince + terminalWaitBudgetMs
      const remainingSignal = () => {
        check(now() < deadline, 'acceptance_machine_cleanup_runs_active')
        return AbortSignal.timeout(Math.max(1, Math.min(30000, deadline - now())))
      }
      try {
        while (true) {
          await version(remainingSignal())
          await recheckTask(remainingSignal())
          cleanup.terminalPolls++
          artifactCount = 0; cleanup.runs = []
          for (const runId of runIds) {
            const evidence = (await request('/api/runs/' + runId + '/evidence', undefined, remainingSignal())).data, run = evidence?.run
            const identity = run?.executionIdentity
            check(run?.id === runId && run.issueId === fixture.issueId && run.botId === fixture.reporterId
              && identity?.requester === ownerId && identity.executionPrincipal === ownerId && identity.outputOwner === ownerId
              && identity.botId === fixture.reporterId && identity.botOwner === ownerId && identity.workspaceId === capturedGroup.workspaceId
              && identity.billingAccount?.runtime?.kind === 'e2b' && identity.billingAccount.runtime.ownerId === ownerId, 'acceptance_machine_cleanup_run_scope')
            check(Array.isArray(evidence.artifacts), 'acceptance_machine_cleanup_artifact_inventory')
            artifactCount += evidence.artifacts.length
            cleanup.runs.push({ runId, requestEpoch: state.attempts.find(attempt => attempt.runId === runId).output.requestEpoch,
              status: token(run.status), terminal: ended.has(run.status), machineEndAttempted: false,
              machineEndAcknowledged: false, machineEndHttpStatus: null, independentProviderObservation: false })
          }
          cleanup.executionStopConfirmed = cleanup.runs.every(run => run.terminal)
          if (cleanup.executionStopConfirmed) break
          check(now() < deadline, 'acceptance_machine_cleanup_runs_active')
          await wait(Math.min(2000, deadline - now()))
        }
      } finally { cleanup.terminalWaitElapsedMs = Math.max(0, now() - waitingSince) }
      const artifacts = [fixture.artifact, fixture.continuation?.artifact].filter(Boolean)
      cleanup.artifactsReadbackConfirmed = artifactCount === 0 || artifacts.length > 0
        && artifacts.every(item => item.retainedAfterStop === true && uuid(item.artifactId) && digest(item.sha256) && integer(item.bytes) !== null)
      check(cleanup.artifactsReadbackConfirmed, 'acceptance_machine_cleanup_artifacts_unconfirmed')
      // This is an intentional owner cleanup action, not a GET substitute.
      // A 200 ended response follows the product's fence and awaited kill when
      // a sandbox existed. Unknown/404 results never prove provider shutdown.
      for (const run of cleanup.runs) {
        await version()
        await recheckTask()
        run.machineEndAttempted = true
        try {
          const response = await ownerTransport(ORIGIN + '/mikka/api/threads/' + run.runId + '/machine', {
            method: 'POST', signal: AbortSignal.timeout(30000), headers: { origin: ORIGIN, cookie: ownerCookie, 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'end' }) })
          run.machineEndHttpStatus = response.status
          const result = await response.json().catch(() => null)
          run.machineEndAcknowledged = response.status === 200 && result?.runId === run.runId && result.state === 'ended'
        } catch { run.error = 'acceptance_machine_end_unconfirmed' }
      }
      cleanup.machineEndAcknowledged = cleanup.runs.every(run => run.machineEndAcknowledged)
      const desktop = (await request('/api/bots/' + fixture.reporterId + '/computer')).data
      cleanup.sharedDesktop = { scope: 'shared-owner-workspace-desktop', botId: fixture.reporterId,
        machine: oneOf(['sleeping', 'waking', 'running', 'error'])(desktop?.machine), control: oneOf(['agent', 'user', 'idle'])(desktop?.control),
        mayBeSynthesized: true, provesThreadMachineStop: false }
      cleanup.status = cleanup.machineEndAcknowledged ? 'ended' : 'unconfirmed'
    } catch (error) { cleanup.error = failure(error, 'acceptance_machine_cleanup_failed') }
  }
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
        ownerId = token(session.user.id)
        if (!ownerId) throw Error('acceptance_session_identity')
        // One no-secret disabled connection; scoped cleanup runs before group/model
        // work. A failed management check is evidence, not a reason to skip
        // the independent group and Decision replay acceptance.
        try {
          const owner = { request: (path, init = {}) => ownerTransport(ORIGIN + '/mikka' + path, { ...init,
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
        try { groupRaw = await api.runGroupProductionAcceptance({ env: { ...runEnv, GROUP_ACCEPTANCE_ORIGIN: ORIGIN }, fetchImpl: groupTransport }); report.group = sanitizeGroupReport(groupRaw) }
        catch (error) { report.group = { status: 'fail', error: failure(error) } }
        report.fixtureConversationId = uuid(groupRaw?.conversationId) ?? capturedGroup?.id ?? null
        if (groupRaw?.groupCleanup) report.groupCleanup = groupCleanup({ ...groupRaw.groupCleanup, source: 'source-driver' })
        // Only an unhandled driver failure needs this fallback. A returned
        // cleanup receipt, including an unknown stop, is never replayed.
        else if (report.group.status !== 'pass' && capturedGroup) await stopCapturedGroup()
        // Keep failed-case evidence unchanged; cleanup is recorded separately.
        // Only the task returned by this run's Factory case is eligible.
        if (groupRaw?.status !== 'pass') {
          const fixture = groupRaw?.cases?.find(row => row.name === 'group-factory-artifact-continuation-stop')
          if (uuid(fixture?.taskId) && uuid(fixture?.reporterId)) {
            report.taskCleanup = { taskId: fixture.taskId, status: 'pending', executionStopConfirmed: false, cloudStopConfirmed: false }
            try {
              await version()
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
        if (report.fixtureConversationId && (report.group.status === 'pass' || report.groupCleanup?.noPendingRetry === true)) {
          try {
            const replay = await api.runGroupDecisionReplay({ env: { ...env, GROUP_REPLAY_ORIGIN: ORIGIN,
              GROUP_REPLAY_CONVERSATION: report.fixtureConversationId, GROUP_REPLAY_DEPLOYMENT: deploymentId, GROUP_REPLAY_REVISION: revision,
              GROUP_REPLAY_TOKEN: undefined, GROUP_REPLAY_COOKIE: ownerCookie }, fetchImpl: transport })
            report.replay = sanitizeReplayReport(replay)
            report.replayAccounting = measureReplayEvidence(replay, api.replayContract ?? {})
            report.actualReceiptedDecisionReplays = report.replayAccounting.receiptedLogicalReplays
            report.completedLogicalDecisionReplays = report.replayAccounting.completedLogicalReplays
          } catch (error) { report.replay = { status: 'failed', error: failure(error, 'replay_request_failed') } }
        } else report.replay = { status: 'blocked', error: report.fixtureConversationId ? 'replay_pending_group_cleanup_unconfirmed' : 'replay_fixture_group_missing' }
        await version()
      } finally {
        const fixture = groupRaw?.cases?.find(row => row.name === 'group-factory-artifact-continuation-stop')
        if (ownerCookie && uuid(fixture?.taskId)) await endFixtureMachines(fixture)
        if (ownerCookie) { try { report.replaySessionEnded = (await request('/api/auth/sign-out', {})).response.status === 200 } catch { report.replaySessionEnded = false } }
        ownerCookie = ''
      }
    }, { env: runEnv, fetchImpl: credentialTransport, cloudExecution: true })
  } catch (error) { report.error = failure(error) }
  finally {
    ownerCookie = ''
    report.credentialCleanup = cleanupReceipt ? shape(cleanupReceipt, { created: bool, removed: bool, cloudCreated: bool, cloudRemoved: bool }) : { status: 'helper_did_not_enter_run' }
    report.credentialCleanup.credentialSessionLogoutAttempted = report.sessionCleanup.temporaryCredentials.logoutAttempted
    report.credentialCleanup.credentialSessionLogoutAcknowledged = report.sessionCleanup.temporaryCredentials.logoutAcknowledged
    report.credentialCleanup.credentialSessionLogoutStatus = report.sessionCleanup.temporaryCredentials.logoutStatus
    report.finishedAt = new Date().toISOString()
  }
  const cleaned = cleanupReceipt && (!cleanupReceipt.created || cleanupReceipt.removed) && (!cleanupReceipt.cloudCreated || cleanupReceipt.cloudRemoved)
  const sessionsEnded = Object.values(report.sessionCleanup).every(session => session.loginAttempted
    && session.loginStatus === 200 && session.logoutAttempted && session.logoutAcknowledged && session.logoutStatus === 200)
  const machinesCleaned = !groupRaw?.cases?.some(row => uuid(row.taskId)) || report.machineCleanup?.status === 'ended'
  report.status = !report.error && cleaned && machinesCleaned && sessionsEnded && report.replaySessionEnded && report.group?.sessionEnded
    && report.ownerMcp?.status === 'passed' && report.group?.status === 'pass' && report.replay?.status === 'comparison_ready'
    && report.replayAccounting?.qualityAccepted && report.replay?.comparison?.decisionReviewReady === true ? 'pass' : 'fail'
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
    actualReceiptedDecisionReplays: report.actualReceiptedDecisionReplays, completedLogicalDecisionReplays: report.completedLogicalDecisionReplays ?? 0,
    collectedLogicalDecisionReplays: report.replayAccounting?.logicalReplays ?? 0,
    replayCollectionComplete: report.replayAccounting?.collectionComplete === true, replayQualityAccepted: report.replayAccounting?.qualityAccepted === true,
    expectedDecisionReplays: 24, replayDecisionCalls: report.replayAccounting?.decisionCalls ?? null,
    error: report.error ?? null, fixtureConversationId: report.fixtureConversationId ?? null, report: output }
  console.log(JSON.stringify(summary))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Proactive production acceptance\n\nStatus: **${summary.status}**\n\nOwner MCP management: ${summary.ownerMcp}; group runtime: ${summary.group}; collected logical Decision replays: ${summary.collectedLogicalDecisionReplays}/24; complete judgments: ${summary.completedLogicalDecisionReplays}/24 (${summary.replay}). Collection complete: ${summary.replayCollectionComplete}; quality accepted: ${summary.replayQualityAccepted}.\n\nReplay provider calls: attempted ${summary.replayDecisionCalls?.attempted ?? 'unknown'}, receipted ${summary.replayDecisionCalls?.receipted ?? 'unknown'}, unreceipted ${summary.replayDecisionCalls?.unreceipted ?? 'unknown'}. Routing cost remains unknown unless every call is priced.\n\nOnly the sanitized JSON report is uploaded. Owner MCP does not call a provider; replay does not execute its projected actions.\n`)
  if (report.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => { console.error(failure(error)); process.exitCode = 1 })
