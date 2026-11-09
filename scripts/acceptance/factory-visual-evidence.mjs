#!/usr/bin/env node
/** #1783: ordinary shared-account Factory tasks, never database/capture fixtures.
 *
 * The read-only selector accepts only PR #1789's deployed merge and its owner's
 * live #1752 window. Web and E2B completion events may both wake it: the first
 * waits by declining selection until the exact runtime has finished publishing.
 * The second resumes through the same shared-account queue. Successful native
 * cases are reused from their exact source/run/attempt's successful job step.
 *
 * Credentials are read only by the existing Infisical OIDC workflow. This
 * program never emits an HTTP body, cookie, prompt, tool output or raw error.
 * Outputs are closed projections plus the fixture's actual downloaded media.
 */
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { createSessionClient, smokeAcceptanceAccount, selectAcceptanceTeam, restoreAcceptanceWorkspace,
  chooseSharedChatModel, cleanupCase, sampledRequestTrace } from './cloud-startup.mjs'
import { CASES, ORIGIN, openLive } from './run-observability.mjs'
import { assertCurrentMain, waitForWebDeployment } from '../release/web-deploy.mjs'
import { assertReleaseIdentity, selectRelease, REPOSITORY, RELEASE_NAME } from './thread-lifecycle-ci.mjs'
import { assertArtifactIdentity, downloadReleaseReport, releasePins } from './task-secrets-ci.mjs'
import { isExactNativeCommand } from './thread-lifecycle.mjs'

export const WORKFLOW = '.github/workflows/factory-visual-evidence-acceptance.yml'
export const WORKFLOW_NAME = 'Factory visual evidence production acceptance'
export const CASE_STEPS = Object.freeze({ claude: 'Run real Claude Factory task and verify stored evidence',
  codex: 'Run real Codex Factory task and verify stored evidence' })
const ROOT = resolve(import.meta.dirname, '../..')
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const positive = value => Number.isSafeInteger(value) && value > 0
const hash = value => createHash('sha256').update(value).digest('hex')
const iso = now => new Date(now()).toISOString()
const TERMINAL = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const route = { claude_code: 'claude_code_cli', codex: 'codex_cli' }
const codes = new Set(['context', 'checkout', 'github', 'trigger', 'pull_request', 'window', 'runtime', 'release_artifact',
  'prior_receipt', 'attempt_budget', 'build_changed', 'sign_in', 'identity', 'owner_busy', 'fallback_enabled', 'profile',
  'profile_conflict', 'subscription_unavailable', 'bot', 'issue', 'dispatch', 'response', 'scope', 'run_failed',
  'task_timeout', 'attempt_budget_exceeded', 'negative_host_gate_missing', 'negative_capture_present', 'submit_receipt',
  'bypass_not_refused', 'positive_candidate', 'independent_checks', 'activity', 'media_origin', 'media_bytes', 'media_decode',
  'report_binding', 'report_content', 'artifact_content', 'runtime_template', 'native_linux', 'native_visual', 'cleanup', 'incomplete'])
class AcceptanceError extends Error {
  constructor(code, cause) { super(`factory_visual_acceptance:${code}`, cause === undefined ? undefined : { cause }); this.code = code }
}
const check = (value, code) => { if (!value) throw new AcceptanceError(code) }
export const safeFailure = error => error instanceof AcceptanceError && codes.has(error.code) ? error.code : 'acceptance_failed'

async function github(path, { token, fetchImpl = fetch }) {
  check(typeof token === 'string' && token.length > 0 && path.startsWith('/'), 'context')
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    })
    check(response.ok, 'github'); return await response.json()
  } catch (cause) { throw new AcceptanceError('github', cause) }
}

/** The owner posts this marker in the same comment that claims the window.
 * It binds the PR's final head before its merge SHA exists. A newer marker for
 * this window, an edit releasing it, expiry or a changed head invalidates it.
 * No arbitrary prose, attachment or workflow log is interpreted as authority. */
export function windowProof(comment, { headSha, now = Date.now(), expectedId, expectedDigest } = {}) {
  check(positive(comment?.id) && (!expectedId || comment.id === Number(expectedId))
    && comment.user?.login === 'alexj11324' && typeof comment.body === 'string' && comment.body.length <= 65_536, 'window')
  const markers = [...comment.body.matchAll(/<!-- mikka-factory-1783 (\{[^\r\n]*\}) -->/g)]
  check(markers.length === 1, 'window')
  let marker
  try { marker = JSON.parse(markers[0][1]) } catch (cause) { throw new AcceptanceError('window', cause) }
  const expires = Date.parse(marker.expiresAt)
  check(marker.state === 'active' && marker.issue === 1783 && marker.pr === 1789 && marker.headSha === headSha
    && SHA.test(headSha ?? '') && Number.isFinite(expires) && expires > now && expires <= now + 120 * 60_000
    && (!expectedDigest || hash(markers[0][0]) === expectedDigest), 'window')
  return { commentId: comment.id, headSha, expiresAt: marker.expiresAt, markerSha256: hash(markers[0][0]) }
}

export async function readWindow(read, { headSha, expectedId, expectedDigest, now = Date.now() }) {
  check(!expectedId || /^[1-9][0-9]*$/.test(String(expectedId)), 'window')
  const issue = await read('/issues/1752')
  check(positive(issue.comments), 'window')
  // Only recent comment metadata/bodies, never anyone's attached evidence.
  // Ordinary progress/queue discussion is not a release or a replacement lock.
  const lastPage = Math.ceil(issue.comments / 100)
  const page = (await Promise.all([...new Set([Math.max(1, lastPage - 1), lastPage])].map(number =>
    read(`/issues/1752/comments?per_page=100&page=${number}`)))).flat()
  check(Array.isArray(page) && page.length > 0 && page.length <= 200, 'window')
  const markers = page.filter(comment => comment.user?.login === 'alexj11324' && typeof comment.body === 'string'
    && [...comment.body.matchAll(/<!-- mikka-factory-1783 (\{[^\r\n]*\}) -->/g)].some(match => {
      try { const value = JSON.parse(match[1]); return value.issue === 1783 && value.pr === 1789 && value.headSha === headSha } catch { return false }
    }))
  const latest = markers.at(-1)
  if (expectedId) {
    check(!latest || latest.id === Number(expectedId), 'window')
    return windowProof(await read(`/issues/comments/${expectedId}`), { headSha, expectedId, expectedDigest, now })
  }
  check(latest, 'window')
  return windowProof(latest, { headSha, now })
}

/** Recheck this lease before every normal mutation; cleanup deliberately does
 * not use it, so expiry/release can never prevent stopping our own resources. */
export function productionWindowGuard(window, read, { now = Date.now } = {}) {
  const current = () => check(Number.isFinite(Date.parse(window?.expiresAt)) && Date.parse(window.expiresAt) > now(), 'window')
  return {
    current,
    async write(operation) {
      current()
      await readWindow(read, { headSha: window.headSha, expectedId: window.commentId,
        expectedDigest: window.markerSha256, now: now() })
      // A slow GitHub read must not carry permission past the lease's expiry.
      current()
      return operation()
    },
  }
}

function ciContext(env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main'
    && ['workflow_run', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) && SHA.test(env.GITHUB_SHA ?? '')
    && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
    && env.GITHUB_TOKEN && typeof env.RUNNER_TEMP === 'string' && env.RUNNER_TEMP.startsWith('/'), 'context')
  check(['all', 'claude', 'codex'].includes(env.FACTORY_VISUAL_MODEL_CASE ?? 'all'), 'context')
}

/** A skipped step or a successful selection-only job cannot attest a paid case.
 * Keep the real attempt's identity, not only the mutable workflow run URL. */
export function previousCaseProof(jobs, { runId, runAttempt, sourceCommit }) {
  check(Array.isArray(jobs?.jobs) && jobs.total_count === jobs.jobs.length && jobs.jobs.length <= 100
    && jobs.jobs.every(job => job.run_id === runId && job.run_attempt === runAttempt && job.head_sha === sourceCommit), 'prior_receipt')
  const acceptance = jobs.jobs.filter(job => job.name === 'acceptance')
  check(acceptance.length <= 1, 'prior_receipt')
  const steps = acceptance[0]?.steps ?? [], result = {}
  for (const item of CASES) {
    const matches = steps.filter(step => step.name === CASE_STEPS[item.id])
    check(matches.length <= 1, 'prior_receipt')
    const step = matches[0]
    result[item.id] = { attempted: Boolean(step && (step.status === 'in_progress' || step.status === 'completed' && step.conclusion !== 'skipped')),
      passed: step?.status === 'completed' && step.conclusion === 'success', runId, runAttempt,
      jobId: acceptance[0]?.id ?? null, sourceCommit }
  }
  return result
}

async function priorCases(env, sourceCommit, read) {
  const listing = await read(`/actions/workflows/factory-visual-evidence-acceptance.yml/runs?head_sha=${sourceCommit}&branch=main&per_page=100`)
  check(Array.isArray(listing.workflow_runs) && listing.total_count === listing.workflow_runs.length && listing.total_count <= 100, 'prior_receipt')
  const result = Object.fromEntries(CASES.map(item => [item.id, { attempts: 0, reused: null }]))
  const runs = listing.workflow_runs.filter(run => run.id !== Number(env.GITHUB_RUN_ID) || Number(env.GITHUB_RUN_ATTEMPT) > 1)
  for (const run of runs) {
    check(positive(run.id) && positive(run.run_attempt) && run.head_sha === sourceCommit && run.head_branch === 'main'
      && run.path === WORKFLOW && run.name === WORKFLOW_NAME && run.repository?.full_name === REPOSITORY
      && run.head_repository?.full_name === REPOSITORY && ['workflow_run', 'workflow_dispatch'].includes(run.event), 'prior_receipt')
    const end = run.id === Number(env.GITHUB_RUN_ID) ? Number(env.GITHUB_RUN_ATTEMPT) - 1 : run.run_attempt
    check(end <= 5, 'attempt_budget')
    for (let attempt = 1; attempt <= end; attempt++) {
      const proofs = previousCaseProof(await read(`/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`), {
        runId: run.id, runAttempt: attempt, sourceCommit,
      })
      for (const item of CASES) {
        if (proofs[item.id].attempted) result[item.id].attempts++
        if (proofs[item.id].passed) result[item.id].reused = proofs[item.id]
      }
    }
  }
  return result
}

/** Read-only, before Infisical and again inside the shared subscription queue. */
export async function selectAcceptance(env, event, { fetchImpl = fetch, now = Date.now, checkout = true,
  webProof = waitForWebDeployment } = {}) {
  ciContext(env)
  const read = path => github(path, { token: env.GITHUB_TOKEN, fetchImpl })
  const sourceCommit = env.APPLICATION_SHA || event?.workflow_run?.head_sha
  check(SHA.test(sourceCommit ?? ''), 'context')
  const empty = reason => ({ version: 1, issue: 1783, pr: 1789, sourceCommit, selected: false, reason,
    driver: { runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) } })
  const pr = await read('/pulls/1789')
  check(pr.number === 1789 && pr.base?.repo?.full_name === REPOSITORY && pr.base.ref === 'main'
    && pr.head?.repo?.full_name === REPOSITORY && pr.head.ref === 'feat/factory-visual-evidence' && SHA.test(pr.head.sha ?? ''), 'pull_request')
  if (pr.merged !== true || pr.merge_commit_sha !== sourceCommit) return empty('not_pr_1789_merge')
  if (env.GITHUB_SHA !== sourceCommit) return empty('main_moved')
  if (checkout) check(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === sourceCommit
    && execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === '', 'checkout')
  await assertCurrentMain({ expectedBuild: sourceCommit, token: env.GITHUB_TOKEN, fetchImpl })
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const pointer = event?.workflow_run
    check(positive(pointer?.id) && positive(pointer?.run_attempt) && pointer.head_sha === sourceCommit
      && ['Web deploy', RELEASE_NAME].includes(pointer.name), 'trigger')
    const [workflow, run] = await Promise.all([read(`/actions/workflows/${pointer.name === RELEASE_NAME ? 'e2b-official-runtime.yml' : 'web-deploy.yml'}`),
      read(`/actions/runs/${pointer.id}`)])
    check(workflow.id === pointer.workflow_id && workflow.state === 'active' && workflow.name === pointer.name
      && run.id === pointer.id && run.run_attempt === pointer.run_attempt && run.workflow_id === workflow.id
      && run.path === workflow.path && run.name === workflow.name && run.head_sha === sourceCommit && run.head_branch === 'main'
      && run.status === 'completed' && run.conclusion === 'success' && ['push', 'workflow_dispatch'].includes(run.event)
      && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY, 'trigger')
  }
  const window = await readWindow(read, { headSha: pr.head.sha, now: now(), expectedId: env.WINDOW_COMMENT_ID,
    expectedDigest: env.WINDOW_MARKER_SHA256 })
  const busy = await Promise.all(['queued', 'in_progress', 'waiting', 'pending', 'requested'].map(status =>
    read(`/actions/workflows/e2b-official-runtime.yml/runs?branch=main&status=${status}&per_page=100`)))
  for (const listing of busy) {
    check(Array.isArray(listing.workflow_runs) && listing.total_count === listing.workflow_runs.length && listing.total_count <= 100, 'runtime')
    if (listing.workflow_runs.some(run => run.head_branch === 'main' && run.status !== 'completed')) return empty('runtime_in_progress')
  }
  const releases = await read(`/actions/workflows/e2b-official-runtime.yml/runs?head_sha=${sourceCommit}&branch=main&per_page=100`)
  check(Array.isArray(releases.workflow_runs) && releases.total_count === releases.workflow_runs.length && releases.total_count <= 100, 'runtime')
  const upstream = releases.workflow_runs.filter(run => run.head_sha === sourceCommit).sort((a, b) => b.id - a.id)[0]
  if (!upstream || upstream.status !== 'completed') return empty('runtime_not_finished')
  const expected = { sourceCommit, runId: upstream.id, runAttempt: upstream.run_attempt, workflowId: upstream.workflow_id, event: upstream.event }
  const workflow = await read('/actions/workflows/e2b-official-runtime.yml')
  assertReleaseIdentity(expected, workflow, upstream)
  const release = selectRelease(expected, await read(`/actions/runs/${upstream.id}/attempts/${upstream.run_attempt}/jobs?per_page=100`), [])
  check(release.runtime === 'validated_and_published', 'runtime')
  const web = await webProof({ expectedBuild: sourceCommit, token: env.GITHUB_TOKEN, fetchImpl, maxWaitMs: 60_000 })
  const artifacts = await read(`/actions/runs/${upstream.id}/artifacts?per_page=100`)
  check(Array.isArray(artifacts.artifacts) && artifacts.total_count === artifacts.artifacts.length && artifacts.total_count <= 100, 'release_artifact')
  const matches = artifacts.artifacts.filter(value => value.name === `e2b-release-evidence-${upstream.id}-${upstream.run_attempt}`)
  check(matches.length === 1, 'release_artifact')
  const artifact = assertArtifactIdentity(expected, upstream, matches[0], now())
  const previous = await priorCases(env, sourceCommit, read)
  const selectedCase = env.FACTORY_VISUAL_MODEL_CASE ?? 'all'
  const cases = Object.fromEntries(CASES.map(item => {
    const prior = previous[item.id], selected = selectedCase === 'all' || selectedCase === item.id
    // At most two paid attempts per path for automatic completion events.
    // An explicitly dispatched retry still has a finite three-attempt bound.
    const budget = env.GITHUB_EVENT_NAME === 'workflow_run' ? 2 : 3
    check(!selected || prior.reused || prior.attempts < budget, 'attempt_budget')
    return [item.id, { ...prior, execute: selected && !prior.reused }]
  }))
  return { ...empty('exact_pr_merge_and_release'), selected: true, window, web, upstream: expected, artifact, cases }
}

export async function attestAcceptance(env, event, dependencies = {}) {
  const proof = await selectAcceptance(env, event, dependencies)
  check(proof.selected, 'context')
  const workerSha = execFileSync('python3', ['scripts/e2b/build-template.py', '--worker-hash', '--source-ref', proof.sourceCommit], {
    cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  const bytes = await downloadReleaseReport(proof, { token: env.GITHUB_TOKEN, fetchImpl: dependencies.fetchImpl ?? fetch })
  const pins = releasePins(bytes, proof.upstream, workerSha)
  return { ...proof, pins, attestedAt: new Date().toISOString() }
}

/** Profile source may be explicit for a producer or host decision for an
 * independent check. In both cases the frozen profile and the shared payer,
 * requester, output owner, machine and exact small model must match. */
export function executionProof(evidence, { item, scope, profile, issueId, runId }) {
  const run = evidence?.run, identity = run?.executionIdentity
  check(run?.id === runId && run.issueId === issueId && run.botId === scope.botId && run.harness === item.harness
    && run.model === item.model && run.credentialType === 'subscription' && run.subscriptionRoute === route[item.harness]
    && run.agentProfile?.profileId === profile.id && run.agentProfile.version === profile.version
    && run.agentProfile.digest === profile.digest && ['explicit', 'decision'].includes(run.agentProfile.source), 'scope')
  check(Array.isArray(identity?.resourceBindings), 'scope')
  const devices = identity.resourceBindings.filter(value => value.kind === 'device')
  const subscriptions = identity.resourceBindings.filter(value => value.kind === 'subscription')
  const device = devices[0], subscription = subscriptions[0], payer = identity.billingAccount?.model, runtime = identity.billingAccount?.runtime
  check(identity.version === 1 && identity.requester === scope.ownerId && identity.executionPrincipal === scope.ownerId
    && identity.outputOwner === scope.ownerId && identity.botOwner === scope.ownerId && identity.botId === scope.botId
    && identity.workspaceId === scope.workspaceId && identity.personalResourcePolicy === 'requester_only'
    && devices.length === 1 && UUID.test(device?.id ?? '') && device.ownerId === scope.ownerId && device.access === 'owner'
    && runtime?.kind === 'e2b' && runtime.ownerId === scope.ownerId && runtime.resourceId === scope.ownerId
    && subscriptions.length === 1 && UUID.test(subscription?.id ?? '') && subscription.ownerId === scope.adminId
    && subscription.access === 'workspace_share' && /^(0|[1-9][0-9]*)$/.test(subscription.revision ?? '')
    && payer?.kind === 'subscription' && payer.ownerId === scope.adminId && payer.resourceId === subscription.id, 'scope')
  return { runId, status: run.status, harness: item.harness, model: item.model, credentialType: 'subscription',
    subscriptionRoute: run.subscriptionRoute, profileId: profile.id, profileVersion: profile.version, profileDigest: profile.digest,
    profileSource: run.agentProfile.source, requesterHash: hash(scope.ownerId).slice(0, 16), payerHash: hash(scope.adminId).slice(0, 16),
    workspaceHash: scope.evidence.teamWorkspaceHash, bindingHash: hash(subscription.id).slice(0, 16),
    subscriptionRevision: subscription.revision, sharedSubscription: true, ownCloudMachine: true }
}

/** Native MCP input and successful output, scoped to this run's chain prefix.
 * A text claim or report_blocked can never satisfy the missing-evidence probe. */
function scopedToolId(detail, id, runId) {
  const cursor = detail?.chunkCursor
  if (typeof id !== 'string' || id.length > 500 || !cursor || typeof cursor.chain !== 'string'
    || !cursor.chain.split(',').includes(runId)) return false
  if (UUID.test(id.slice(0, 36)) && id[36] === ':') return cursor.runs > 1 && id.slice(0, 36) === runId
  return cursor.runs === 1 && cursor.runId === runId
}

function toolOutput(value, depth = 0) {
  if (depth > 4) return { error: true, text: '' }
  if (typeof value === 'string') {
    if (value.length > 64_000) return { error: true, text: '' }
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && (Array.isArray(parsed) || 'isError' in parsed || 'error' in parsed
        || 'exitCode' in parsed || Array.isArray(parsed.content) || parsed.type === 'text')) return toolOutput(parsed, depth + 1)
    } catch { /* Native plaintext. */ }
    return { error: false, text: value }
  }
  if (Array.isArray(value)) {
    const parts = value.map(item => toolOutput(item, depth + 1))
    return { error: parts.some(item => item.error), text: parts.map(item => item.text).join('\n') }
  }
  if (!value || typeof value !== 'object' || value.isError === true || value.error || value.exitCode !== undefined && value.exitCode !== 0) return { error: true, text: '' }
  if (value.type === 'text' && typeof value.text === 'string') return toolOutput(value.text, depth + 1)
  if (Array.isArray(value.content)) return toolOutput(value.content, depth + 1)
  if (typeof value.output === 'string' || typeof value.stdout === 'string') return toolOutput(value.output ?? value.stdout, depth + 1)
  return { error: true, text: '' }
}

export function submitProof(detail, runId) {
  const inputs = new Set(), completed = new Set()
  const chain = detail?.thread?.attempts
  check(Array.isArray(chain) && chain.some(value => value.runId === runId && value.status === 'succeeded'), 'submit_receipt')
  for (const item of detail.chunks ?? []) {
    const chunk = item.chunk, id = chunk?.toolCallId
    if (!scopedToolId(detail, id, runId)) continue
    check(!(chunk.type === 'tool-input-available' && chunk.toolName === 'mcp__mikka__report_blocked'), 'submit_receipt')
    if (chunk.type === 'tool-input-available' && chunk.toolName === 'mcp__mikka__submit') inputs.add(id)
    if (chunk.type === 'tool-output-available' && inputs.has(id)) {
      const output = toolOutput(chunk.output)
      if (!output.error && output.text.trim() === 'Handed in. End your turn now.') completed.add(id)
    }
  }
  check(inputs.size === 1 && completed.size === 1, 'submit_receipt')
  return { runId, ordinarySubmit: true, toolCallHash: hash([...completed][0]), nativeSucceeded: true }
}

export function linuxProof(detail, runId) {
  const inputs = new Set()
  for (const item of detail.chunks ?? []) {
    const chunk = item.chunk, id = chunk?.toolCallId
    if (!scopedToolId(detail, id, runId)) continue
    if (chunk.type === 'tool-input-available' && ['bash', 'shell', 'shell_command'].includes(chunk.toolName?.toLowerCase())
      && isExactNativeCommand(chunk.input?.command, 'uname -s')) inputs.add(id)
    if (chunk.type !== 'tool-output-available' || !inputs.has(id)) continue
    const output = toolOutput(chunk.output)
    if (!output.error && (output.text.trim() === 'Linux' || /(?:^|\n)Linux\r?(?:\n|$)/.test(output.text))) return { runId, platform: 'linux', command: 'uname -s', toolCallHash: hash(id) }
  }
  throw new AcceptanceError('native_linux')
}

const currentCandidate = state => state.candidates?.find(value => value.id === state.task?.candidateId)
export function negativeProof(state, evidence, detail) {
  const task = state?.task, candidate = currentCandidate(state)
  const attempt = state?.attempts?.find(value => value.id === task?.attemptId)
  const gate = attempt?.output?.evidenceGate
  check(UUID.test(task?.id ?? '') && UUID.test(task.sourceEventId ?? '') && task.stage === 'execute' && task.status === 'blocked'
    && candidate?.kind === 'deliverable' && candidate.sha === null && UUID.test(task.botId ?? '')
    && candidate.repository === `/home/user/.mikka/bot-workspaces/${task.botId}` && candidate.taskId === task.id
    && candidate.scope === `issue:${task.issueId}` && UUID.test(candidate.runId ?? '')
    && attempt?.stage === 'execute' && attempt.status === 'blocked' && attempt.candidateId === candidate.id && attempt.runId === candidate.runId
    && attempt.output.requestEpoch === task.sourceEventId && gate?.code === 'factory_visual_evidence_required'
    && gate.candidateId === candidate.id && gate.sourceEventId === task.sourceEventId && UUID.test(gate.eventId ?? '')
    && evidence?.run?.id === candidate.runId && evidence.run.status === 'succeeded'
    && !state.attempts.some(value => value.output?.requestEpoch === task.sourceEventId && ['review', 'verify', 'approval', 'publish'].includes(value.stage)),
  'negative_host_gate_missing')
  check(Array.isArray(evidence.captures) && evidence.captures.length === 0 && evidence.recording === false, 'negative_capture_present')
  const submit = submitProof(detail, candidate.runId)
  return { taskId: task.id, issueId: task.issueId, botId: task.botId, candidateId: candidate.id, runId: candidate.runId, attemptId: attempt.id,
    sourceEventId: task.sourceEventId, revision: task.revision, stage: 'execute', status: 'blocked',
    hostGate: { code: gate.code, candidateId: gate.candidateId, sourceEventId: gate.sourceEventId, eventId: gate.eventId },
    submit, readyCaptureCount: 0, consumerAttemptCount: 0 }
}

export function positiveProof(state, negative, proofs) {
  const task = state?.task, candidate = currentCandidate(state)
  check(task?.issueId === negative.issueId && UUID.test(task.id ?? '') && UUID.test(task.sourceEventId ?? '')
    && task.sourceEventId !== negative.sourceEventId && task.stage === 'approval' && ['pending', 'waiting', 'passed'].includes(task.status)
    && task.botId === negative.botId && candidate?.kind === 'deliverable' && candidate.sha === null
    && candidate.repository === `/home/user/.mikka/bot-workspaces/${task.botId}` && candidate.taskId === task.id && candidate.scope === `issue:${task.issueId}`
    && UUID.test(candidate.runId ?? '') && candidate.runId !== negative.runId && candidate.id !== negative.candidateId, 'positive_candidate')
  const stages = task.route?.flowVersion === 2 ? ['execute', 'review'] : ['execute', 'review', 'verify']
  const attempts = state.attempts.filter(value => value.output?.requestEpoch === task.sourceEventId && stages.includes(value.stage))
  check(attempts.length === stages.length && stages.every(stage => attempts.filter(value => value.stage === stage).length === 1)
    && new Set(attempts.map(value => value.runId)).size === attempts.length
    && attempts.every(value => value.candidateId === candidate.id && value.status === 'passed' && UUID.test(value.runId ?? '')
      && proofs.get(value.runId)?.status === 'succeeded')
    && attempts.find(value => value.stage === 'execute').runId === candidate.runId, 'independent_checks')
  return { taskId: task.id, issueId: task.issueId, candidateId: candidate.id, runId: candidate.runId, sourceEventId: task.sourceEventId,
    revision: task.revision, flowVersion: task.route?.flowVersion === 2 ? 2 : 1,
    checks: attempts.map(value => ({ stage: value.stage, runId: value.runId, attemptId: value.id, status: value.status })) }
}

/** Only fixed same-origin host routes are allowed to receive session cookies. */
export function mediaPath(value, expected) {
  check(typeof value === 'string' && (value === expected || value === ORIGIN + expected)
    && expected.startsWith('/mikka/api/') && !/[?#%\\]/.test(value), 'media_origin')
  const url = new URL(value, ORIGIN)
  check(url.origin === ORIGIN && !url.username && !url.password && !url.search && !url.hash && url.pathname === expected, 'media_origin')
  return expected.slice('/mikka'.length)
}

export function activityProof(activity, positive) {
  const acceptance = activity?.task?.acceptance
  check(activity?.version === 1 && activity.task?.id === positive.taskId && activity.task.issueId === positive.issueId
    && activity.task.revision === positive.revision
    && acceptance?.runId === positive.runId && acceptance.candidateId === positive.candidateId
    && UUID.test(acceptance.artifactId ?? '') && positiveInteger(acceptance.version)
    && Array.isArray(activity.artifacts) && Array.isArray(acceptance.media), 'activity')
  const reports = activity.artifacts.filter(value => value.kind === 'acceptance' && value.artifactId === acceptance.artifactId
    && value.version === acceptance.version && value.runId === positive.runId && value.candidateId === positive.candidateId)
  check(reports.length === 1, 'report_binding')
  const report = reports[0]
  mediaPath(report.downloadUrl, `/mikka/api/artifacts/${acceptance.artifactId}/versions/${acceptance.version}/download`)
  const media = activity.artifacts.filter(value => ['image', 'video'].includes(value.kind) && value.runId === positive.runId)
  check(media.length >= 2 && media.length <= 40 && media.some(value => value.kind === 'image') && media.some(value => value.kind === 'video')
    && new Set(media.map(value => value.captureId)).size === media.length, 'activity')
  for (const capture of media) {
    check(UUID.test(capture.captureId ?? '') && positiveInteger(capture.size), 'activity')
    const references = acceptance.media.filter(value => value.captureId === capture.captureId && value.runId === positive.runId && value.kind === capture.kind)
    check(references.length === 1, 'report_binding')
    mediaPath(capture.url, `/mikka/api/factory/tasks/${positive.taskId}/media/${capture.captureId}`)
    check(references[0].candidateId === positive.candidateId && references[0].appliesToCurrentCandidate === true, 'report_binding')
    mediaPath(references[0].url, `/mikka/api/captures/${capture.captureId}`)
    if (capture.kind === 'video') mediaPath(capture.posterUrl, `/mikka/api/factory/tasks/${positive.taskId}/media/${capture.captureId}/poster`)
  }
  return { report, media: media.map(value => ({ ...value, reportUrl: acceptance.media.find(item => item.captureId === value.captureId).url })) }
}
const positiveInteger = positive

async function boundedDownload(client, path, maxBytes, expectedType) {
  const response = await client.request(path, {}, 120_000)
  check(response.ok && (!expectedType || response.headers.get('content-type')?.split(';')[0] === expectedType), 'media_bytes')
  const length = response.headers.get('content-length')
  check(!length || /^\d+$/.test(length) && Number(length) > 0 && Number(length) <= maxBytes, 'media_bytes')
  const reader = response.body?.getReader(), chunks = []; let size = 0
  check(reader, 'media_bytes')
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; check(size <= maxBytes, 'media_bytes'); chunks.push(next.value) }
  } finally { await reader.cancel().catch(() => {}) }
  check(size > 0 && (!length || size === Number(length)), 'media_bytes')
  return Buffer.concat(chunks)
}

function decodeMedia(filename, kind, command = execFileSync) {
  try {
    const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], {
      timeout: 30_000, maxBuffer: 64_000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    }))
    const video = probe.streams?.find(value => value.codec_type === 'video')
    check(typeof video?.codec_name === 'string' && positive(video.width) && positive(video.height), 'media_decode')
    const duration = Number(probe.format?.duration ?? video.duration ?? 0)
    check(kind !== 'video' || Number.isFinite(duration) && duration > 0 && duration <= 3600, 'media_decode')
    command('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode', '-protocol_whitelist', 'file,pipe', '-i', filename, '-map', '0:v:0', '-f', 'null', '-'], {
      timeout: 120_000, maxBuffer: 64_000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { decoded: true, codec: video.codec_name, width: video.width, height: video.height,
      ...(kind === 'video' ? { durationMs: Math.round(duration * 1000) } : {}) }
  } catch (cause) { throw new AcceptanceError('media_decode', cause) }
}

export async function readActivityEvidence(client, activity, positive, { directory, caseId, decode = decodeMedia } = {}) {
  const selection = activityProof(activity, positive), report = selection.report
  const bytes = await boundedDownload(client, mediaPath(report.downloadUrl,
    `/mikka/api/artifacts/${report.artifactId}/versions/${report.version}/download`), 2_000_000)
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  check(body.includes(positive.runId) && body.includes(positive.candidateId)
    && selection.media.every(value => body.includes(value.reportUrl)), 'report_content')
  await mkdir(directory, { recursive: true })
  const reportFile = `${caseId}-acceptance.md`
  await writeFile(join(directory, reportFile), bytes, { mode: 0o600 })
  const receipts = []
  for (const [index, capture] of selection.media.entries()) {
    const types = capture.kind === 'video' ? ['video/mp4', 'video/webm'] : ['image/png', 'image/jpeg', 'image/webp']
    check(types.includes(capture.contentType), 'media_bytes')
    const limit = capture.kind === 'video' ? 100_000_000 : 10_000_000
    const raw = await boundedDownload(client, mediaPath(capture.url,
      `/mikka/api/factory/tasks/${positive.taskId}/media/${capture.captureId}`), limit, capture.contentType)
    const linked = await boundedDownload(client, mediaPath(capture.reportUrl,
      `/mikka/api/captures/${capture.captureId}`), limit, capture.contentType)
    check(raw.length === capture.size && raw.equals(linked), 'media_bytes')
    const ext = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[capture.contentType]
    const file = `${caseId}-${capture.kind}-${index + 1}.${ext}`, filename = join(directory, file)
    await writeFile(filename, raw, { mode: 0o600 })
    const decoded = decode(filename, capture.kind)
    const receipt = { captureId: capture.captureId, runId: positive.runId, kind: capture.kind, source: capture.source, url: capture.url,
      reportUrl: capture.reportUrl, bytes: raw.length, sha256: hash(raw), file, ...decoded }
    if (capture.kind === 'video') {
      const poster = await boundedDownload(client, mediaPath(capture.posterUrl,
        `/mikka/api/factory/tasks/${positive.taskId}/media/${capture.captureId}/poster`), 10_000_000, 'image/jpeg')
      const posterFile = `${caseId}-poster-${index + 1}.jpg`
      await writeFile(join(directory, posterFile), poster, { mode: 0o600 })
      receipt.poster = { url: capture.posterUrl, file: posterFile, sha256: hash(poster), bytes: poster.length,
        ...decode(join(directory, posterFile), 'image') }
    }
    receipts.push(receipt)
  }
  return { activityUrl: `${ORIGIN}/mikka/api/factory/tasks/${positive.taskId}/activity`,
    report: { artifactId: report.artifactId, version: report.version, runId: report.runId, candidateId: report.candidateId,
      downloadUrl: report.downloadUrl, bytes: bytes.length, sha256: hash(bytes), file: reportFile }, media: receipts }
}

const definition = value => Object.fromEntries(['name', 'description', 'roles', 'enabled', 'harness', 'model', 'effort', 'instructions', 'skills']
  .filter(key => value[key] !== undefined).map(key => [key, structuredClone(value[key])]))
const profilePath = (workspaceId, id = '') => `/api/factory/agent-profiles${id ? '/' + id : ''}?workspaceId=${workspaceId}`

/** A real browser opens and reloads the on-disk deliverable. This exact native
 * program is matched against stored shell input/output, then its files against
 * submit_capture receipts and the downloaded captures. The same released
 * FFmpeg processor computes the expected encoded video before normal upload;
 * original WebM and encoded MP4 have deliberately different byte identities. */
export function visualCommand({ marker, title, content }, sourceCommit, workerSha) {
  check(/^[a-z0-9-]+$/.test(marker) && title === marker + '.txt' && SHA.test(sourceCommit) && SHA.test(workerSha), 'context')
  return ["node --input-type=module <<'MIKKA_1783_VISUAL'",
    "import assert from 'node:assert/strict'",
    "import { readFile, mkdir, realpath } from 'node:fs/promises'",
    "import { resolve, join } from 'node:path'",
    "import { createServer } from 'node:http'",
    "import { createHash } from 'node:crypto'",
    "import { chromium } from '@playwright/test'",
    "import { processCaptureVideo } from '/opt/mikka/worker/packages/daemon/src/agents/capture-video.mjs'",
    `const spec = ${JSON.stringify({ marker, title, content, sourceCommit, workerSha })}`,
    "assert.equal(process.platform, 'linux')",
    "assert.equal((await readFile('/opt/mikka/worker-source-sha', 'utf8')).trim(), spec.workerSha)",
    "assert.equal(await realpath('/opt/mikka/worker'), '/opt/mikka/releases/' + spec.sourceCommit + '/source')",
    "const sha = bytes => createHash('sha256').update(bytes).digest('hex')",
    "const file = resolve(spec.title), bytes = await readFile(file)",
    "assert.equal(bytes.toString('utf8'), spec.content)",
    "const directory = resolve('.' + spec.marker + '-visual')",
    "await mkdir(directory, { mode: 0o700 })",
    "const escape = text => text.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])",
    "const server = createServer(async (_request, response) => {",
    "  try { const current = await readFile(file); assert.ok(current.equals(bytes)); response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end('<!doctype html><meta charset=utf-8><title>Factory verification</title><style>body{font:22px monospace;margin:48px;color:#14283c}pre{white-space:pre-wrap}</style><h1>Factory verification</h1><pre>' + escape(current.toString('utf8')) + '</pre><p>SHA-256: ' + sha(current) + '</p><p>Platform: ' + process.platform + '</p>') }",
    "  catch { response.writeHead(500); response.end('verification failed') }",
    "})",
    "await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))",
    "let browser, context, rawVideo",
    "const imagePath = join(directory, 'verification.png'), encodedPath = join(directory, 'expected.mp4')",
    "try {",
    "  browser = await chromium.launch({ headless: true })",
    "  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: directory, size: { width: 1280, height: 800 } } })",
    "  const page = await context.newPage(), response = await page.goto('http://127.0.0.1:' + server.address().port)",
    "  assert.equal(response.status(), 200); assert.equal(await page.locator('pre').textContent(), spec.content)",
    "  await page.waitForTimeout(1200); await page.reload(); assert.equal(await page.locator('pre').textContent(), spec.content)",
    "  await page.screenshot({ path: imagePath, fullPage: true }); await page.waitForTimeout(800)",
    "  const video = page.video(); await context.close(); context = null; rawVideo = await video.path()",
    "} finally { await context?.close(); await browser?.close(); await new Promise(resolve => server.close(resolve)) }",
    "const processed = await processCaptureVideo(rawVideo, encodedPath)",
    "const image = await readFile(imagePath), original = await readFile(rawVideo), encoded = await readFile(encodedPath)",
    "assert.equal(processed.processing.originalSha256, sha(original)); assert.equal(processed.size, encoded.length)",
    "console.log('MIKKA_1783_VISUAL ' + JSON.stringify({ version: 1, marker: spec.marker, sourceCommit: spec.sourceCommit, workerSha: spec.workerSha, platform: process.platform, pageMatched: true, reloadMatched: true, fileSha256: sha(bytes), image: { path: imagePath, bytes: image.length, sha256: sha(image) }, video: { path: rawVideo, originalSha256: sha(original), encodedBytes: encoded.length, encodedSha256: sha(encoded), durationMs: processed.durationMs } }))",
    'MIKKA_1783_VISUAL',
  ].join('\n')
}

export function nativeVisualProof(detail, runId, command, fixtureData, sourceCommit, workerSha, evidence) {
  const shell = new Set(), captures = new Map(), receipts = [], linked = []
  for (const item of detail.chunks ?? []) {
    const chunk = item.chunk, id = chunk?.toolCallId
    if (!scopedToolId(detail, id, runId)) continue
    if (chunk.type === 'tool-input-available') {
      if (['bash', 'shell', 'shell_command'].includes(chunk.toolName?.toLowerCase()) && isExactNativeCommand(chunk.input?.command, command)) shell.add(id)
      if (chunk.toolName === 'mcp__mikka__submit_capture' && typeof chunk.input?.path === 'string') captures.set(id, chunk.input.path)
    }
    if (chunk.type !== 'tool-output-available') continue
    const output = toolOutput(chunk.output)
    if (output.error) continue
    if (shell.has(id)) for (const line of output.text.split('\n').filter(value => value.startsWith('MIKKA_1783_VISUAL '))) {
      try { receipts.push(JSON.parse(line.slice('MIKKA_1783_VISUAL '.length))) } catch { /* Refuse below. */ }
    }
    if (captures.has(id)) {
      let value
      try { value = JSON.parse(output.text) } catch { continue }
      if (value.status === 'queued' && UUID.test(value.captureId ?? '')) linked.push({ captureId: value.captureId, path: captures.get(id) })
    }
  }
  check(shell.size === 1 && receipts.length === 1 && linked.length === 2 && evidence.media.length === 2, 'native_visual')
  const receipt = receipts[0]
  check(receipt.version === 1 && receipt.marker === fixtureData.marker && receipt.sourceCommit === sourceCommit && receipt.workerSha === workerSha && receipt.platform === 'linux'
    && receipt.pageMatched === true && receipt.reloadMatched === true && receipt.fileSha256 === hash(fixtureData.content)
    && DIGEST.test(receipt.image?.sha256 ?? '') && DIGEST.test(receipt.video?.originalSha256 ?? '')
    && DIGEST.test(receipt.video?.encodedSha256 ?? '') && positive(receipt.video?.durationMs), 'native_visual')
  for (const media of evidence.media) {
    const native = media.kind === 'image' ? receipt.image : receipt.video
    check(media.runId === runId && media.source === 'local' && linked.filter(value => value.captureId === media.captureId && value.path === native.path).length === 1
      && media.sha256 === (media.kind === 'image' ? native.sha256 : native.encodedSha256)
      && media.bytes === (media.kind === 'image' ? native.bytes : native.encodedBytes), 'native_visual')
  }
  return { runId, platform: 'linux', workerSourceCommit: sourceCommit, workerSha, exactNativeCommandSha256: hash(command),
    pageMatched: true, reloadMatched: true, fileSha256: receipt.fileSha256,
    imageSha256: receipt.image.sha256, videoOriginalSha256: receipt.video.originalSha256,
    videoEncodedSha256: receipt.video.encodedSha256, captureIds: linked.map(value => value.captureId) }
}

function fixture(sourceCommit, workerSha, item, driver) {
  const marker = `m1783-${sourceCommit.slice(0, 10)}-${item.id}-${driver.runId}-${driver.runAttempt}`
  const title = `${marker}.txt`, content = `Factory visual evidence #1783\nrevision=${sourceCommit}\nharness=${item.harness}\nstatus=verified\n`
  const shared = `Use only the selected official subscription ${item.model} and cloud Linux. Deliver the text Artifact ${title}; its UTF-8 bytes must equal ${JSON.stringify(content)}. Read the actual file back. This is a no-repository deliverable: no GitHub push, PR, merge, external message, account/configuration change, subagent, model switch, paid API key or retry. `
  const negative = shared + 'This first run is an authorized negative acceptance of the host visual-evidence gate. Create and submit that ordinary Artifact, then call the ordinary Mikka submit MCP tool exactly once, with truthful passing file criteria, but without taking/uploading any screenshot or recording and without visualEvidence. The product host must refuse the handoff after this real submit. A prose assertion, report_blocked, fabricated report/capture, editing host state or skipping submit does not exercise this test and is a failure. Do not claim that the host allowed the handoff. Stop after the one submit.'
  const captureCommand = visualCommand({ marker, title, content }, sourceCommit, workerSha)
  const followup = shared + 'This follow-up replaces the earlier deliberate omission: now complete the same deliverable with real visual evidence in THIS continuation run. Prepare and submit the text Artifact first. Execute exactly uname -s as one shell tool call. In your own worktree only, install @playwright/test@1.64.1 and its Chromium if absent. Then execute the complete command below unchanged as ONE ordinary shell tool call; it actually reads the file, opens/reloads it in Chromium, takes a screenshot, records real video, verifies the released worker source and runs the released FFmpeg processor. No synthesized image/video, substituted program or invented receipt. After it succeeds, use normal Mikka submit_capture twice: the exact image.path and RAW video.path from its native JSON receipt, with no steps argument. Never upload expected.mp4 (that is only the independent encoded-byte comparison). Do not modify these files after the command. Finally call ordinary Mikka submit once with truthful criteria and both actual capture IDs; let Factory run independent review and stop at Owner acceptance. No retry or new issue.\n\n' + captureCommand
  return { marker, title, content, negative, followup, captureCommand }
}

/** One normal initial request and one normal thread continuation. No endpoint
 * accepts a synthetic finish/report/capture, and no database client is used. */
export async function runProductionCase(proof, item, { env = process.env, fetchImpl = fetch, now = Date.now,
  openLiveImpl = openLive, directory, timeoutMs = 12 * 60_000 } = {}) {
  check(proof?.selected && SHA.test(proof.sourceCommit ?? '') && proof.cases?.[item.id]?.execute === true
    && proof.pins?.workerSourceCommit === proof.sourceCommit && SHA.test(proof.pins.workerSha ?? '') && directory, 'context')
  const client = createSessionClient(ORIGIN, fetchImpl), fixtureData = fixture(proof.sourceCommit, proof.pins.workerSha, item, proof.driver)
  const result = { version: 1, issue: 1783, sourceCommit: proof.sourceCommit, case: item.id, harness: item.harness, model: item.model,
    driver: proof.driver, window: proof.window, runtime: proof.pins, status: 'running', startedAt: iso(now),
    budget: { initialRequests: 1, followups: 1, maximumNativeRuns: 4, timeoutMs }, cleanup: { status: 'running', errors: [] } }
  const account = smokeAcceptanceAccount(env), disabled = []
  let loggedIn = false, ownerId, scope, originalWorkspaceId, profile, botId, live, prepared = false
  const record = { title: fixtureData.marker, cleanup: { status: 'running', errors: [] } }
  const lease = productionWindowGuard(proof.window, path => github(path, { token: env.GITHUB_TOKEN, fetchImpl }), { now })
  const pin = async () => { lease.current(); const version = await client.json('/api/version'); check(version.build === proof.sourceCommit, 'build_changed'); lease.current(); return version.build }
  const proofs = new Map(), states = new Map(), runs = new Map(), machineProofs = new Map()
  async function currentState() {
    const issue = await client.rpc('issues.getIssue', [record.issueId])
    check(issue.issue?.id === record.issueId && issue.issue.userId === ownerId && issue.issue.title === fixtureData.marker, 'scope')
    const listing = await client.json(`/api/factory/tasks?issueId=${record.issueId}`)
    check(listing.issueId === record.issueId && Array.isArray(listing.tasks) && listing.tasks.length <= 2, 'response')
    for (const listed of listing.tasks) {
      const state = await client.json(`/api/factory/tasks/${listed.id}`), task = state.task
      check(UUID.test(task?.id ?? '') && task.issueId === record.issueId && task.userId === ownerId && task.botId === botId
        && Array.isArray(state.attempts) && Array.isArray(state.candidates), 'scope')
      states.set(task.id, state)
      for (const attempt of state.attempts) if (UUID.test(attempt.runId ?? '')) {
        const evidence = await client.json(`/api/runs/${attempt.runId}/evidence`)
        runs.set(attempt.runId, evidence)
        proofs.set(attempt.runId, executionProof(evidence, { item, scope, profile, issueId: record.issueId, runId: attempt.runId }))
        if (!record.runId && attempt.stage === 'execute') record.runId = attempt.runId
        if (!machineProofs.has(attempt.runId)) {
          const machine = await client.rpc('agents.getThreadMachine', [record.issueId, attempt.runId])
          if (machine?.cloud) {
            check(machine.kind === 'cloud' && machine.cloud.template === proof.pins.templates[item.harness], 'runtime_template')
            machineProofs.set(attempt.runId, { runId: attempt.runId, kind: 'cloud', templateId: machine.cloud.template,
              sandboxHash: hash(machine.cloud.sandboxId).slice(0, 16) })
          }
        }
      }
    }
    check(runs.size <= 4, 'attempt_budget_exceeded')
    const active = (await client.json(profilePath(scope.workspaceId))).profiles.filter(value => value.enabled && !value.archivedAt)
    check(active.length === 1 && active[0].id === profile.id && active[0].version === profile.version && active[0].digest === profile.digest, 'profile_conflict')
    check((await client.json(`/api/settings/api-keys?workspace=${scope.workspaceId}`)).apiKeyAfterQuota === false, 'fallback_enabled')
    result.runs = [...proofs.values()]; result.machines = [...machineProofs.values()]
    result.observedTasks = [...states.values()].map(value => ({ taskId: value.task.id, issueId: value.task.issueId, revision: value.task.revision,
      stage: value.task.stage, status: value.task.status, sourceEventId: value.task.sourceEventId, candidateId: value.task.candidateId,
      attempts: value.attempts.map(attempt => ({ id: attempt.id, stage: attempt.stage, status: attempt.status, runId: attempt.runId,
        candidateId: attempt.candidateId, requestEpoch: attempt.output?.requestEpoch,
        evidenceGate: attempt.output?.evidenceGate?.code === 'factory_visual_evidence_required' ? { code: 'factory_visual_evidence_required',
          candidateId: attempt.output.evidenceGate.candidateId, sourceEventId: attempt.output.evidenceGate.sourceEventId, eventId: attempt.output.evidenceGate.eventId } : null })) }))
    return [...states.values()]
  }
  async function waitFor(readiness, deadline) {
    for (;;) {
      check(now() < deadline, 'task_timeout')
      const before = live.revision
      await pin()
      const observed = await currentState(), value = await readiness(observed)
      if (value) return value
      check(![...proofs.values()].some(value => ['failed', 'stopped', 'cancelled', 'paused'].includes(value.status)), 'run_failed')
      try { await live.wait(before, Math.min(deadline, Date.parse(proof.window.expiresAt))) }
      catch (error) { lease.current(); throw error }
    }
  }
  try {
    result.buildBefore = await pin()
    const login = await lease.write(() => client.request('/api/auth/sign-in/email', post({ ...account, rememberMe: false })))
    check(login.ok, 'sign_in'); loggedIn = true; await login.body?.cancel()
    const session = await client.json('/api/auth/get-session')
    check(session.user?.email?.toLowerCase() === account.email.toLowerCase() && typeof session.user.id === 'string', 'identity')
    ownerId = session.user.id; result.ownerHash = hash(ownerId).slice(0, 16)
    scope = await lease.write(() => selectAcceptanceTeam(client, { ownerId }, value => { originalWorkspaceId = value })); result.team = scope.evidence
    const [threads, tasks, keys, order, profiles] = await Promise.all([client.rpc('task-runs.pollThreads', []), client.rpc('task-runs.pollTaskRuns', []),
      client.json(`/api/settings/api-keys?workspace=${scope.workspaceId}`), client.rpc('model-order.getModelOrder', [scope.workspaceId]),
      client.json(profilePath(scope.workspaceId))])
    check(Array.isArray(threads.items) && Array.isArray(tasks.items) && [...threads.items, ...tasks.items].every(value => TERMINAL.has(value.status)), 'owner_busy')
    check(keys.apiKeyAfterQuota === false, 'fallback_enabled')
    const candidates = (order.candidates ?? []).filter(value => value.harness === item.harness && value.model === item.model
      && value.source?.kind === 'subscription' && UUID.test(value.source.connectionId ?? '') && value.credentialOwnerId === scope.adminId)
    check(candidates.length === 1 && Array.isArray(profiles.profiles), 'subscription_unavailable')
    // Shared test account, exclusive shared queue, version/digest CAS. Preserve
    // full definitions in memory only and restore even after a rejected write.
    for (const existing of profiles.profiles.filter(value => value.enabled && !value.archivedAt)) {
      const current = (await client.json(profilePath(scope.workspaceId, existing.id))).profile
      check(current?.version === existing.version && current.digest === existing.digest && isDeepStrictEqual(definition(current), definition(existing)), 'profile_conflict')
      const entry = { id: existing.id, version: existing.version, digest: existing.digest, before: definition(existing), written: null }
      disabled.push(entry)
      const changed = (await lease.write(() => client.json(profilePath(scope.workspaceId, entry.id), { ...post({ workspaceId: scope.workspaceId,
        version: entry.version, profile: { ...entry.before, enabled: false } }), method: 'PATCH' }))).profile
      check(changed?.version === entry.version + 1 && DIGEST.test(changed.digest ?? '')
        && isDeepStrictEqual(definition(changed), { ...entry.before, enabled: false }), 'profile_conflict')
      entry.written = { version: changed.version, digest: changed.digest }
    }
    prepared = true
    const createdProfile = await lease.write(() => client.json('/api/factory/agent-profiles', post({ workspaceId: scope.workspaceId, requestId: randomUUID(), profile: {
      name: fixtureData.marker, description: 'Issue #1783 visual handoff acceptance', enabled: true, harness: item.harness,
      model: { mode: 'fixed', harness: item.harness, model: item.model, source: candidates[0].source }, effort: 'low', roles: [], skills: [], instructions: '',
    } })))
    profile = createdProfile.profile
    check(UUID.test(profile?.id ?? '') && positive(profile.version) && DIGEST.test(profile.digest ?? '')
      && profile.harness === item.harness && profile.model?.model === item.model
      && profile.model.source?.connectionId === candidates[0].source.connectionId, 'profile')
    const bot = await lease.write(() => client.rpc('bots.createBot', [{ name: fixtureData.marker, color: 'gris', shape: 'cercle', model: null, repository: null }]))
    check(UUID.test(bot?.id ?? ''), 'bot'); botId = bot.id; scope.botId = botId
    const observedBot = await client.json(`/api/bots/${botId}`)
    check(observedBot.id === botId && observedBot.name === fixtureData.marker, 'bot')
    result.botId = botId; result.profileId = profile.id
    await lease.write(() => chooseSharedChatModel(client, botId, item.harness))
    const issue = await lease.write(() => client.rpc('issues.saveIssue', [{ title: fixtureData.marker, status: 'todo', priority: 'low', content: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: fixtureData.negative }] },
    ] } }]))
    check(UUID.test(issue.issue?.id ?? ''), 'issue'); record.issueId = issue.issue.id; result.issueId = record.issueId
    live = await openLiveImpl(path => client.json(path), scope.workspaceId, { now })
    const trace = sampledRequestTrace()
    const input = `Use the existing task ${record.issueId} (${fixtureData.marker}) exactly once through ordinary Factory dispatch (dispatch_factory_task), on cloud with selected Profile ${profile.id}. Do not create another issue or bypass Factory with dispatch_run. The task is a deliberately missing-evidence first phase; pass its exact instructions through to the producer. ${fixtureData.negative}`
    const queued = await lease.write(() => client.rpc('coordinator.sendCoordinatorMessage', [input, null, botId, randomUUID(), { kind: 'cloud' }, null, [], { $mikka: 'undefined' }, profile.id],
      { headers: { traceparent: trace.traceparent } }))
    check(queued.queued === true, 'dispatch'); result.initialRequestSent = true
    const deadline = now() + timeoutMs
    const negativeState = await waitFor(async observed => {
      const state = observed.find(value => value.task.stage === 'execute' && value.task.status === 'blocked')
      if (state) return state
      check(!observed.some(value => ['review', 'verify', 'approval', 'publish'].includes(value.task.stage)), 'negative_host_gate_missing')
      return null
    }, deadline)
    const negativeCandidate = currentCandidate(negativeState)
    const negativeRunId = negativeCandidate?.runId ?? negativeState.attempts.find(value => value.id === negativeState.task.attemptId)?.runId
    check(UUID.test(negativeRunId ?? ''), 'negative_host_gate_missing')
    const negativeDetail = await client.rpc('agents.getIssueThread', [record.issueId, negativeRunId])
    try {
      result.negative = { ...negativeProof(negativeState, runs.get(negativeRunId), negativeDetail), rootRunId: negativeDetail.thread.rootRunId,
        // Retain the persisted task status separately from the test result.
        testStatus: 'passed' }
      check(machineProofs.has(result.negative.runId), 'runtime_template')
    } catch (error) {
      result.negative = { testStatus: 'failed', failure: safeFailure(error), taskId: negativeState.task.id, issueId: record.issueId, botId,
        runId: negativeRunId, candidateId: negativeCandidate?.id ?? null, sourceEventId: negativeState.task.sourceEventId,
        rootRunId: negativeDetail.thread.rootRunId,
        stage: negativeState.task.stage, status: negativeState.task.status,
        nativeStatus: runs.get(negativeRunId)?.run?.status ?? null,
        readyCaptureCount: runs.get(negativeRunId)?.captures?.length ?? null,
        ordinarySubmitInputs: (negativeDetail.chunks ?? []).filter(value => value.chunk?.type === 'tool-input-available' && value.chunk.toolName === 'mcp__mikka__submit').length,
        reportBlockedInputs: (negativeDetail.chunks ?? []).filter(value => value.chunk?.type === 'tool-input-available' && value.chunk.toolName === 'mcp__mikka__report_blocked').length }
      // A model choosing report_blocked is a failed negative test. Still run
      // its ordinary follow-up and the other subscription to collect the
      // remaining real evidence; neither can turn this negative into a pass.
    }
    // Try the real human accept entry once. Its rejection and unchanged
    // persisted revision demonstrate that the owner UI cannot bypass the gate.
    const binding = { taskId: negativeState.task.id, issueId: record.issueId, attemptId: negativeState.task.attemptId,
      candidateId: negativeCandidate?.id ?? null, revision: negativeState.task.revision }
    if (result.negative.testStatus === 'passed') {
      const activity = await client.json(`/api/factory/tasks/${binding.taskId}/activity`)
      check(activity.task?.id === binding.taskId && activity.task.issueId === record.issueId && activity.task.revision === binding.revision
        && activity.task.needsYou?.kind === 'blocked' && activity.task.acceptance === null
        && !activity.artifacts.some(value => ['image', 'video'].includes(value.kind) && value.runId === negativeRunId), 'negative_host_gate_missing')
      result.negative.activity = { observed: true, revision: activity.task.revision, needsYou: 'blocked', acceptance: null, readyProducerMedia: 0 }
      const refused = await lease.write(() => client.request(`/api/factory/tasks/${binding.taskId}/approval`, post({ operation: 'accept', input: { binding, eventId: randomUUID() } })))
      const refusal = await refused.json().catch(() => null)
      check(refused.status === 409 && refusal?.error === 'factoryTransition', 'bypass_not_refused')
      const unchanged = await client.json(`/api/factory/tasks/${binding.taskId}`)
      check(unchanged.task.revision === binding.revision && unchanged.task.status === 'blocked' && unchanged.task.stage === 'execute', 'bypass_not_refused')
      result.negative.ownerAcceptRefused = { status: refused.status, code: 'factoryTransition', unchangedRevision: binding.revision }
    }
    await client.rpc('coordinator.stopCoordinatorTurn', [botId]); result.coordinatorStopped = true
    const followed = await lease.write(() => client.request(`/api/mobile/threads/${result.negative.runId}`, post({ text: fixtureData.followup })))
    check(followed.status === 202 && (await followed.json()).queued === true, 'dispatch'); result.followupSent = true
    const positiveState = await waitFor(async observed => {
      const current = observed.filter(value => value.task.sourceEventId !== result.negative.sourceEventId)
      check(current.length <= 1, 'positive_candidate')
      const state = current[0]
      if (!state) return null
      check(!['blocked', 'failed', 'cancelled', 'revoked'].includes(state.task.status), 'run_failed')
      if (state.task.stage !== 'approval') return null
      result.positive = positiveProof(state, result.negative, proofs)
      return state
    }, deadline)
    check(machineProofs.has(result.positive.runId), 'runtime_template')
    const positiveDetail = await client.rpc('agents.getIssueThread', [record.issueId, result.positive.runId])
    check(positiveDetail.thread?.rootRunId === result.negative.rootRunId
      && positiveDetail.thread.attempts.some(value => value.runId === result.negative.runId), 'positive_candidate')
    result.positive.submit = submitProof(positiveDetail, result.positive.runId)
    result.positive.linux = linuxProof(positiveDetail, result.positive.runId)
    const activity = await client.json(`/api/factory/tasks/${result.positive.taskId}/activity`)
    result.evidence = await readActivityEvidence(client, activity, result.positive, { directory, caseId: item.id })
    result.positive.nativeVisual = nativeVisualProof(positiveDetail, result.positive.runId, fixtureData.captureCommand, fixtureData, proof.sourceCommit, proof.pins.workerSha, result.evidence)
    const documents = activity.artifacts.filter(value => value.kind === 'document' && value.title === fixtureData.title && value.runId === result.positive.runId)
    check(documents.length === 1 && UUID.test(documents[0].artifactId ?? '') && positive(documents[0].version), 'artifact_content')
    const document = documents[0], exact = await boundedDownload(client, mediaPath(document.downloadUrl,
      `/mikka/api/artifacts/${document.artifactId}/versions/${document.version}/download`), 65_536)
    check(exact.equals(Buffer.from(fixtureData.content, 'utf8')), 'artifact_content')
    result.deliverable = { artifactId: document.artifactId, version: document.version, runId: document.runId, bytes: exact.length, sha256: hash(exact) }
    const task = positiveState.task, acceptedBinding = { taskId: task.id, issueId: task.issueId, attemptId: task.attemptId,
      candidateId: task.candidateId, revision: task.revision }
    const accepted = await lease.write(() => client.json(`/api/factory/tasks/${task.id}/approval`, post({ operation: 'accept', input: { binding: acceptedBinding, eventId: randomUUID() } })))
    check(accepted.status === 'accepted' && UUID.test(accepted.acceptanceId ?? '')
      && isDeepStrictEqual(accepted.binding, { ...acceptedBinding, revision: acceptedBinding.revision + 1 }), 'positive_candidate')
    const acceptedState = await client.json(`/api/factory/tasks/${task.id}`)
    check(acceptedState.task.status === 'passed' && acceptedState.task.stage === 'approval'
      && positiveProof(acceptedState, result.negative, proofs).candidateId === result.positive.candidateId, 'positive_candidate')
    result.positive.ownerAcceptanceId = accepted.acceptanceId
    const retainedActivity = await client.json(`/api/factory/tasks/${task.id}/activity`)
    check(activityProof(retainedActivity, { ...result.positive, revision: acceptedState.task.revision }).report.version === result.evidence.report.version, 'report_binding')
    result.buildAfter = await pin(); result.status = result.negative.testStatus === 'passed' ? 'passed' : 'failed'
    if (result.negative.testStatus !== 'passed') result.failure = result.negative.failure
  } catch (error) { result.status = 'failed'; result.failure = safeFailure(error) }
  finally {
    live?.close()
    const cleanup = async (step, operation) => { try { await operation(); result.cleanup[step] = true }
      catch (error) { result.cleanup.errors.push({ step, code: safeFailure(error) }) } }
    if (botId) await cleanup('coordinatorStopped', () => client.rpc('coordinator.stopCoordinatorTurn', [botId]))
    if (record.issueId) {
      await cleanup('ownTaskCleaned', () => cleanupCase(client, record, 'cloud', { timeoutMs: 60_000, now, preserveIssue: true }))
      result.cleanup.task = record.cleanup
      if (record.cleanup.status !== 'passed') result.cleanup.errors.push({ step: 'ownTaskCleaned', code: 'cleanup' })
    }
    if (profile && (!record.issueId || record.cleanup.status === 'passed')) await cleanup('profileArchived', async () => {
      const current = (await client.json(profilePath(scope.workspaceId, profile.id))).profile
      check(current?.version === profile.version && current.digest === profile.digest, 'profile_conflict')
      const archived = await client.json(profilePath(scope.workspaceId, profile.id), { ...post({ workspaceId: scope.workspaceId, version: current.version }), method: 'DELETE' })
      check(archived.profile?.archivedAt, 'cleanup')
    })
    for (const entry of disabled.toReversed()) await cleanup(`profileRestored_${entry.id}`, async () => {
      const current = (await client.json(profilePath(scope.workspaceId, entry.id))).profile
      if (current?.version === entry.version && current.digest === entry.digest && isDeepStrictEqual(definition(current), entry.before)) return
      const acknowledged = entry.written ?? (current?.version === entry.version + 1 && DIGEST.test(current.digest ?? '')
        && isDeepStrictEqual(definition(current), { ...entry.before, enabled: false }) ? { version: current.version, digest: current.digest } : null)
      check(acknowledged && current?.version === acknowledged.version && current.digest === acknowledged.digest
        && isDeepStrictEqual(definition(current), { ...entry.before, enabled: false }), 'profile_conflict')
      const restored = (await client.json(profilePath(scope.workspaceId, entry.id), { ...post({ workspaceId: scope.workspaceId,
        version: current.version, profile: entry.before }), method: 'PATCH' })).profile
      check(restored?.version === current.version + 1 && isDeepStrictEqual(definition(restored), entry.before), 'profile_conflict')
    })
    result.cleanup.temporaryProfilesDisabled = disabled.length; result.cleanup.preparationCompleted = prepared
    if (originalWorkspaceId && ownerId) await cleanup('workspaceRestored', () => restoreAcceptanceWorkspace(client, ownerId, originalWorkspaceId))
    if (loggedIn) await cleanup('sessionClosed', async () => {
      const signedOut = await client.request('/api/auth/sign-out', post({})); check(signedOut.ok, 'cleanup'); await signedOut.body?.cancel()
    })
    client.clear(); result.cleanup.status = result.cleanup.errors.length ? 'failed' : 'passed'
    if (result.cleanup.status !== 'passed') result.status = 'failed'
    result.finishedAt = iso(now)
  }
  return result
}

const evidenceDirectory = env => join(env.RUNNER_TEMP, 'factory-visual-evidence-1783')
async function saveJson(directory, name, value) { await mkdir(directory, { recursive: true }); await writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }) }
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
async function finishReport(env, proof) {
  const directory = evidenceDirectory(env), cases = []
  for (const item of CASES) {
    if (proof.cases[item.id].reused) cases.push({ case: item.id, status: 'passed', reused: proof.cases[item.id].reused })
    else {
      let value
      try { value = JSON.parse(await readFile(join(directory, `${item.id}-report.json`), 'utf8')) } catch { value = null }
      check(value?.case === item.id && value.sourceCommit === proof.sourceCommit && value.status === 'passed'
        && value.cleanup?.status === 'passed' && value.buildBefore === proof.sourceCommit && value.buildAfter === proof.sourceCommit, 'incomplete')
      cases.push(value)
    }
  }
  const report = { version: 1, issue: 1783, sourceCommit: proof.sourceCommit, status: 'passed', window: proof.window,
    upstream: proof.upstream, cases, finishedAt: new Date().toISOString() }
  await saveJson(directory, 'report.json', report)
  const sections = cases.map(value => value.reused ? `<section><h2>${escapeHtml(value.case)}</h2><p>Verified in GitHub run ${value.reused.runId}, attempt ${value.reused.runAttempt}; exact source ${proof.sourceCommit}.</p></section>`
    : `<section><h2>${escapeHtml(value.case)}</h2><p>Host refused missing evidence: ${escapeHtml(value.negative.hostGate.code)}. Current candidate: ${escapeHtml(value.positive.candidateId)}.</p><p><a href="${escapeHtml(value.evidence.activityUrl)}">Authenticated task activity</a> · <a href="${escapeHtml(value.evidence.report.file)}">Downloaded immutable acceptance report</a></p>${value.evidence.media.map(media => media.kind === 'video'
      ? `<video controls preload="metadata" src="${escapeHtml(media.file)}" poster="${escapeHtml(media.poster.file)}"></video>`
      : `<img src="${escapeHtml(media.file)}" alt="Actual cloud Linux verification screenshot">`).join('')}<pre>${escapeHtml(JSON.stringify({ negative: value.negative, positive: value.positive, evidence: value.evidence }, null, 2))}</pre></section>`).join('')
  await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Factory visual evidence #1783</title><style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#17202a;background:#f7f9fb}section{background:white;padding:24px;margin:24px 0;border:1px solid #d9e0e6;border-radius:12px}video,img{display:block;width:100%;height:auto;margin:20px 0}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Factory visual evidence #1783</h1><p>Source ${escapeHtml(proof.sourceCommit)}. Downloads below are the actual task activity and immutable report media, verified byte for byte and decoded with FFmpeg.</p>${sections}</html>`, { mode: 0o600 })
}

async function main() {
  const env = process.env, command = process.argv[2]
  ciContext(env)
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')), directory = evidenceDirectory(env)
  try {
    if (command === 'select') {
      const proof = await selectAcceptance(env, event)
      await saveJson(directory, 'selection.json', proof)
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `selected=${proof.selected}\nsource-sha=${proof.sourceCommit}\nwindow-id=${proof.window?.commentId ?? ''}\nwindow-digest=${proof.window?.markerSha256 ?? ''}\n`)
      console.log(`factory_visual_acceptance_selection:${proof.reason}`)
    } else if (command === 'attest') {
      const proof = await attestAcceptance(env, event)
      await saveJson(directory, 'attestation.json', proof)
      if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `claude=${proof.cases.claude.execute}\ncodex=${proof.cases.codex.execute}\n`)
      console.log('factory_visual_acceptance_credential_guard_passed')
    } else if (command === 'run') {
      const item = CASES.find(value => value.id === process.argv[3]); check(item, 'context')
      const proof = await attestAcceptance(env, event)
      check(proof.cases[item.id].execute, 'prior_receipt')
      const result = await runProductionCase(proof, item, { directory })
      await saveJson(directory, `${item.id}-report.json`, result)
      console.log(`factory_visual_acceptance:${item.id}:${result.status}${result.failure ? ':' + result.failure : ''}`)
      if (result.status !== 'passed') process.exitCode = 1
    } else if (command === 'complete') {
      const proof = JSON.parse(await readFile(join(directory, 'attestation.json'), 'utf8'))
      check(proof.sourceCommit === env.APPLICATION_SHA && proof.driver.runId === Number(env.GITHUB_RUN_ID)
        && proof.driver.runAttempt === Number(env.GITHUB_RUN_ATTEMPT), 'context')
      // Recheck the release/window/main after both cases without replacing the
      // pre-execution receipt whose case decisions governed the job steps.
      check((await selectAcceptance(env, event)).selected, 'context')
      await finishReport(env, proof)
      console.log('factory_visual_acceptance:both_official_subscriptions_passed')
    } else throw new AcceptanceError('context')
  } catch (error) {
    await saveJson(directory, 'failure.json', { issue: 1783, status: 'failed', command: ['select', 'attest', 'run', 'complete'].includes(command) ? command : 'unknown',
      code: safeFailure(error), sourceCommit: SHA.test(env.APPLICATION_SHA ?? '') ? env.APPLICATION_SHA : null, at: new Date().toISOString() })
    console.error(`factory_visual_acceptance:${safeFailure(error)}`); process.exitCode = 1
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
