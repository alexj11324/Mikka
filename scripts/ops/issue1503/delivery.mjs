#!/usr/bin/env node
/** #1503 production acceptance through the ordinary smoke-owner HTTP APIs.
 * Run with Node 24 + tsx. No SQL, synthetic sessions, manual pushes/PRs,
 * state repair, or timer-based business-data polling. A failure-only E2B
 * observer may read a closed diagnostic from this case's own running VM.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { smokeSession, fail, SMOKE_ID, OWNER_ID } from './http.ts'
import { encode, decode } from '../../../lib/desktop-rpc/wire.ts'
import { ACTION_ERROR_CODES } from '../../../lib/action-result.ts'
import { explicitNewTaskArguments, explicitNewTaskComplete, explicitNewTaskEvidence, explicitNewTaskCleanupReceipts } from './explicit-submission.mjs'
import { codexQuestionConfirmation, confirmationPendingQuestion, confirmationPendingObservation, confirmationQuestionReference, confirmationRunEvidence, confirmationAnswerReceipt } from './question-confirmation.mjs'
import { createOwnVmDiagnostic } from './own-vm-diagnostic.mjs'
import { createFixtureGithubReader, collectFixtureCiEvidence, collectFixtureImplementationEvidence, reviewCriteriaEvidence, verifiedFileBytes } from './fixture-ci-evidence.mjs'
export { verifiedFileBytes } from './fixture-ci-evidence.mjs'

const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(value)
const sha = value => typeof value === 'string' && /^[a-f\d]{40}$/.test(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const check = (condition, code) => { if (!condition) fail(code) }
const REPOSITORY = 'alexj11324/Mikka-handoff'
const defaultWorkspace = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const defaultTeam = '62a760fc-da79-4d50-a8fa-a818e25d2f9a'
const briefOrder = view => ({ location: view.location, preferredHarness: view.preferredHarness, autoModelRouting: view.autoModelRouting,
  customized: view.customized, entries: view.entries.map(({ harness, model, source }) => ({ harness, model, source })) })
const binding = task => ({ taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, candidateId: task.candidateId, revision: task.revision })
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const verificationPath = '/api/integrations/github/repositories/verification'

/** Approval can precede the publisher's committed receipt. Wait on this
 * candidate's delivery; the full proof below still verifies the exact head. */
export function approvalPublicationReady(state, expectedBranch, previous) {
  if (state?.task?.stage !== 'approval' || !['pending', 'waiting'].includes(state.task.status)) return false
  const candidate = Array.isArray(state.candidates) ? state.candidates.find(item => item.id === state.task.candidateId) : null
  const delivery = state.delivery
  const pr = delivery?.pullRequest
  return Boolean(candidate && sha(candidate.sha) && uuid(candidate.runId)
    && (!previous || (candidate.id !== previous.candidateId && candidate.sha !== previous.candidateSha))
    && delivery?.candidateSha === candidate.sha && delivery.branch?.head === expectedBranch
    && pr?.state === 'open' && typeof pr.url === 'string'
    && new RegExp('^https://github\\.com/' + REPOSITORY + '/pull/\\d+$', 'i').test(pr.url)
    && (!previous || pr.url === previous.pullRequestUrl))
}

const rpcErrorCodes = new Set([...ACTION_ERROR_CODES, 'desktop_rpc_request_invalid', 'desktop_rpc_action_unknown',
  'desktop_client_update_required', 'desktop_session_expired', 'desktop_rpc_failed'])

export function rpcFailureMetadata(action, result, fallback) {
  const code = typeof result?.error === 'string' ? result.error : result?.error?.code
  return { action, code: rpcErrorCodes.has(code) ? code : fallback }
}

/** Existing issue chat: the source retains the explicit Profile. A task-dialog
 * destination is a different creation contract, not this message's placement.
 * The message and normal dispatch_run target keep execution cloud-only. */
export function existingIssueMessageArguments(text, botId, submissionId, profileId) {
  return [text, null, botId, submissionId, undefined, null, [], undefined, profileId]
}

export function chatSubmissionComplete(chat, text, after) {
  return chat?.working === false && Array.isArray(chat.items) && chat.items.some(item =>
    item.from === 'person' && item.position > after && item.text === text)
}

/** The first edit materializes default:* IDs as UUIDs. Consume every mutation's
 * returned view; at most the initial row count may be removed. */
export async function removeModelOrderEntries(view, change) {
  check(Array.isArray(view?.entries), 'model_order_view_invalid')
  const limit = view.entries.length
  for (let removed = 0; removed < limit; removed++) {
    const before = view.entries.length
    check(before > 0 && nonempty(view.entries[0]?.id), 'model_order_removal_invalid')
    view = await change({ kind: 'remove', id: view.entries[0].id })
    check(Array.isArray(view?.entries) && view.entries.length === before - 1, 'model_order_removal_no_progress')
  }
  check(view.entries.length === 0, 'model_order_removal_incomplete')
  return view
}

export function fileSpecification(marker, harness) {
  const initial = `Factory delivery acceptance #1503\nCase: ${marker}-${harness}\nState: initial\n`
  return { path: `docs/issue-1503/${marker}-${harness}.txt`, initial, revised: initial.replace('State: initial', 'State: revised') }
}

export function deliveryTaskText(specification) {
  return `Repository: ${REPOSITORY}. Create only ${specification.path} as UTF-8 text with a final newline.\nInitial contents:\n${specification.initial}\nAcceptance for this initial candidate: the header and Case line must stay exactly as given; State is initially initial. Do not edit any other file. Run a small command that reads the file and verifies these requirements.\nKeep these repository verification criterion labels verbatim in your report: Repository validator accepts the committed fixture. | Validator unit tests pass. | The 'verify' job of the Factory fixture checks and every other check on the pushed commit complete successfully. These require their actual repository-command or exact-commit CI observations; do not infer them from a narrative.\nLater workflow instructions: If the human requests changes, update only State to revised and preserve the header, Case line, final newline, and all other files. This later revision is not required for the initial candidate; wait for the actual human change request.\nDelivery instructions: Follow the injected Mikka agent delivery instructions. Keep the current local branch, commit your tested change, and push HEAD via https://github.com/${REPOSITORY}.git to the assigned task branch given in the run instructions. The assigned task branch is the remote destination; the local worktree branch need not have the same name. Use the provided owner's own GitHub credential to open or update the task PR with gh, retain the required Mikka issue marker, wait for its checks to pass for the pushed commit, and then call the Mikka submit tool. After opening or updating the PR, an initially empty check list means checks may still be registering; it is neither a pass nor, by itself, an external blocker. Use normal GitHub queries to wait for the "Factory fixture checks" workflow's "verify" job and every other check on the exact pushed commit to complete successfully before submitting. Honor any explicit deadline supplied by Mikka; this task text adds no separate deadline. If registration or completion times out, report the actual timeout as blocked. Mikka reads back the delivered commit and PR before Factory review. Leave the PR open for human review. Do not merge it yourself. Do not call any external messaging API.`
}

export function deliveryProfileInstructions(specification) {
  return `Perform the assigned Factory stage faithfully. Use the existing repository instructions, make only the requested tiny file change, and report actual command results. During the independent review, use mikka.inspect_artifact on ${specification.path} with its exact expectedUtf8 contents to observe the fixed commit, complete bytes and final newline. For the criterion that no other file changed, use mikka.inspect_repository with path:"." and baseCommit equal to the producing run report's full sourceCommit. This is the implementation's original baseline, not the review run's sourceCommit or the fixed candidate HEAD. The tool is granted in this read-only review even without shell or git diff. Check comparison.baseCommit against that baseline, comparison.head against the fixed candidate, comparison.truncated===false, and comparison.changes containing exactly one added (status A) file at ${specification.path}. Current working-tree status and the producer's narrative alone do not prove committed change scope. Record these actual tool observations in their separate applicable criteria. Never pass a criterion with missing or truncated observations. The v2 review is read-only and report-only; implementation owns command verification.`
}

/** The host executes this exact command after the agent submits. Validate the
 * current file and every other smoke file present, including the final newline.
 * The other harness's file may not exist yet when the first case runs. */
export function repositoryVerifyCommand(specifications, requiredPath) {
  check(specifications.some(item => item.path === requiredPath), 'verification_file_missing')
  const script = `const f=require("node:fs"),c=require("node:crypto"),s=${JSON.stringify(specifications)},r=[];for(const x of s){if(!f.existsSync(x.path)){if(x.path===${JSON.stringify(requiredPath)})throw Error("required_file_missing");continue}const b=f.readFileSync(x.path),state=b.equals(Buffer.from(x.initial))?"initial":b.equals(Buffer.from(x.revised))?"revised":null;if(!state)throw Error("file_bytes_mismatch");r.push({path:x.path,state,bytes:b.length,sha256:c.createHash("sha256").update(b).digest("hex")})}console.log(JSON.stringify({issue:1503,files:r}))`
  const command = `node -e '${script.replace(/'/g, "'\\''")}'`
  check(command.length <= 2000, 'verification_command_too_long')
  return command
}

/** Empty/missing/duplicated projections cannot stand in for completed checks. */
export function matchedCheckEvidence(state, passed, externalCi = null, implementationReceipt = null) {
  check(passed.length > 0 && Array.isArray(state.checks), 'verification_checks_missing')
  const selected = state.checks.filter(item => passed.some(attempt => attempt.id === item.attemptId))
  check(selected.length === passed.length && new Set(selected.map(item => item.attemptId)).size === passed.length, 'verification_checks_missing')
  return passed.map(attempt => {
    const item = selected.find(value => value.attemptId === attempt.id)
    const candidate = state.candidates.find(value => value.id === attempt.candidateId)
    check(candidate && sha(candidate.sha) && uuid(attempt.runId) && item.status === 'passed' && item.stage === attempt.stage
      && item.runId === attempt.runId && item.candidateId === attempt.candidateId && item.candidateSha === candidate.sha, 'verification_check_binding_mismatch')
    const v2Review = state.task.route?.flowVersion === 2 && item.stage === 'review'
    const implementation = v2Review && implementationReceipt?.taskId === state.task.id
      && implementationReceipt?.producerRunId === candidate.runId ? implementationReceipt : null
    const coverage = reviewCriteriaEvidence(item.criteria, candidate.sha, v2Review ? externalCi : null,
      { requireExplicitStatus: true, implementationReceipt: implementation })
    check(coverage, 'verification_criteria_missing')
    // V2 review permits report-only evidence. A configured repository command
    // may also run; actual artifact observations remain independently required.
    if (!(state.task.route?.flowVersion === 2 && item.stage === 'review')) check(item.verify?.status === 'passed'
      && nonempty(item.verify.command) && item.verify.exitCode === 0, 'independent_command_verification_missing')
    return item
  })
}

function artifactToolValues(value, depth = 0) {
  if (depth > 4) return []
  if (typeof value === 'string') { try { return artifactToolValues(JSON.parse(value), depth + 1) } catch { return [] } }
  if (!value || typeof value !== 'object' || value.isError === true) return []
  if (Array.isArray(value)) return value.flatMap(item => artifactToolValues(item, depth + 1))
  if (value.type === 'text' && typeof value.text === 'string') return artifactToolValues(value.text, depth + 1)
  if (Array.isArray(value.content)) return value.content.flatMap(item => item.type === 'text' ? artifactToolValues(item.text, depth + 1) : [])
  return [value]
}

function reviewToolPairs(thread, runId, toolName) {
  check(thread.thread?.id === runId && thread.thread.latestRunId === runId && thread.thread.status === 'succeeded' && thread.chunkCursor?.chain === runId
    && Array.isArray(thread.chunks), 'review_thread_binding_mismatch')
  const chunks = thread.chunks.map(item => item.chunk)
  const pairs = []
  for (const [index, input] of chunks.entries()) {
    if (input.type !== 'tool-input-available' || input.toolName !== toolName) continue
    const inputs = chunks.filter(item => item.type === 'tool-input-available' && item.toolCallId === input.toolCallId)
    const outputs = chunks.map((item, i) => ({ item, i })).filter(({ item }) => ['tool-output-available', 'tool-output-error'].includes(item.type) && item.toolCallId === input.toolCallId)
    if (!nonempty(input.toolCallId) || inputs.length !== 1 || outputs.length !== 1 || outputs[0].i <= index || outputs[0].item.type !== 'tool-output-available') continue
    pairs.push({ input, output: outputs[0].item.output })
  }
  return pairs
}

/** Read-only native tool observations, not the reviewer's narrative. Keep only
 * safe hashes and identifiers in the report; never dump a thread transcript. */
export function reviewArtifactObservations(thread, runId, candidateSha, filePath, expectedText) {
  const matches = []
  for (const { input, output } of reviewToolPairs(thread, runId, 'mcp__mikka__inspect_artifact')) {
    if (input.input?.path !== filePath) continue
    const observed = artifactToolValues(output).find(item => item.path === filePath && item.head === candidateSha
      && item.contentUtf8 === expectedText && item.bytes === Buffer.byteLength(expectedText) && item.sha256 === digest(expectedText)
      && item.committedSha256 === digest(expectedText) && item.contentMatchesGit === true && item.textUnavailable === null)
    if (observed) matches.push({ runId, candidateSha, path: filePath, bytes: observed.bytes, sha256: observed.sha256,
      toolCallId: input.toolCallId, inputSha256: digest(JSON.stringify(input.input)), outputSha256: digest(JSON.stringify(output)),
      contentMatchesGit: true, source: 'review_inspect_artifact' })
  }
  check(matches.length > 0, 'review_artifact_observations_missing')
  return matches
}

export function reviewRepositoryObservations(thread, runId, candidateSha, sourceCommit, filePath) {
  check(sha(sourceCommit) && sha(candidateSha), 'review_repository_observations_missing')
  const matches = []
  for (const { input, output } of reviewToolPairs(thread, runId, 'mcp__mikka__inspect_repository')) {
    if ((input.input?.path ?? '.') !== '.' || input.input?.baseCommit !== sourceCommit) continue
    const observed = artifactToolValues(output).find(item => item.path === '.' && item.repository === REPOSITORY.toLowerCase()
      && item.head === candidateSha && item.comparison?.baseCommit === sourceCommit && item.comparison.head === candidateSha
      && item.comparison.truncated === false && Array.isArray(item.comparison.changes) && item.comparison.changes.length === 1
      && item.comparison.changes[0].path === filePath && item.comparison.changes[0].status === 'A')
    if (observed) matches.push({ runId, candidateSha, sourceCommit, repository: observed.repository,
      changes: observed.comparison.changes.map(({ status, path }) => ({ status, path })), truncated: false,
      toolCallId: input.toolCallId, inputSha256: digest(JSON.stringify(input.input)), outputSha256: digest(JSON.stringify(output)),
      source: 'review_inspect_repository' })
  }
  check(matches.length > 0, 'review_repository_observations_missing')
  return matches
}

const repositoryVerificationValue = value => {
  check(value?.viewerId === SMOKE_ID && value.repository === REPOSITORY
    && (value.verifyCommand === null || nonempty(value.verifyCommand)), 'repository_verification_scope_mismatch')
  return value.verifyCommand
}

export async function restoreRepositoryVerification(json, post, originalCommand, installedCommands) {
  const readPath = `${verificationPath}?repository=${encodeURIComponent(REPOSITORY)}`
  const current = repositoryVerificationValue(await json(readPath))
  if (current !== originalCommand) {
    // Do not overwrite a concurrent operator's unrelated setting.
    check(installedCommands.has(current), 'repository_verification_restore_conflict')
    const restored = repositoryVerificationValue(await json(verificationPath, { ...post({ repository: REPOSITORY, verifyCommand: originalCommand }), method: 'PATCH' }))
    check(restored === originalCommand, 'repository_verification_restore_mismatch')
  }
  check(repositoryVerificationValue(await json(readPath)) === originalCommand, 'repository_verification_restore_mismatch')
  return { kind: 'repository_verification_restored', configured: originalCommand !== null,
    commandSha256: originalCommand === null ? null : digest(originalCommand) }
}

/** Owner/workspace invalidations only. Timers maintain the socket and deadlines;
 * business reads occur on initial load, acknowledged writes, or live messages.
 */
export class LiveChanges {
  constructor(json, workspaceId, { Socket = WebSocket, kinds = ['factory_task', 'factory_issue'], onNotify } = {}) {
    Object.assign(this, { json, workspaceId, Socket, kinds, onNotify, sequence: 0, connection: 0, versions: new Map(), waiters: new Set(), closed: false,
      socket: null, heartbeat: null, renewal: null, reconnect: null, reconnects: 0, messages: 0 })
  }
  stamp(keys) { return `${this.connection}:${keys.map(key => this.versions.get(key) ?? 0).join(':')}` }
  notify(key) {
    if (key) this.versions.set(key, ++this.sequence)
    for (const waiter of [...this.waiters]) waiter()
    this.onNotify?.(key)
  }
  async start() { await this.connect() }
  async connect() {
    if (this.closed) return
    clearTimeout(this.reconnect)
    const ticket = await this.json(`/api/live/ticket?workspace=${this.workspaceId}`)
    check(typeof ticket.url === 'string' && /^wss:\/\//.test(ticket.url) && typeof ticket.protocol === 'string'
      && Number.isFinite(ticket.expiresAt) && ticket.expiresAt > Date.now(), 'live_ticket_unavailable')
    const url = new URL(ticket.url); url.searchParams.set('revisions', '1')
    const socket = this.socket = new this.Socket(url.href, ticket.protocol)
    await new Promise((resolve, reject) => {
      let ready = false, pong = true
      const timeout = setTimeout(() => reject(new Error('issue1503_live_ready_timeout')), 15000)
      const reconnect = () => {
        if (this.closed || this.socket !== socket) return
        clearInterval(this.heartbeat); clearTimeout(this.renewal); clearTimeout(timeout)
        this.socket = null
        try { socket.close() } catch {}
        if (!ready) { reject(new Error('issue1503_live_connection_failed')); return }
        if (++this.reconnects > 8) { this.failure = new Error('issue1503_live_disconnected'); this.notify(); return }
        this.reconnect = setTimeout(() => this.connect().catch(error => { this.failure = error; this.notify() }), 1000)
      }
      socket.onmessage = event => {
        if (this.socket !== socket) return
        if (event.data === 'pong') { pong = true; return }
        if (typeof event.data !== 'string' || event.data.length > 2048) return
        let value
        try { value = JSON.parse(event.data) } catch { return }
        if (value.type === 'live_ready') {
          if (![1, 2].includes(value.version) || !this.kinds.every(kind => value.kinds?.includes(kind))) {
            clearTimeout(timeout); reject(new Error('issue1503_live_capabilities_missing')); return
          }
          if (ready) return
          ready = true; clearTimeout(timeout); this.connection++; this.notify(); resolve()
          this.heartbeat = setInterval(() => { if (!pong) { reconnect(); return }; pong = false; try { socket.send('ping') } catch { reconnect() } }, 30000)
          this.renewal = setTimeout(reconnect, Math.max(1, ticket.expiresAt - Date.now()))
          return
        }
        if (ready && uuid(value.id) && [...this.kinds, 'pull_request_status'].includes(value.kind)) {
          this.messages++; this.notify(`${value.kind}:${value.id}`)
        }
      }
      socket.onerror = socket.onclose = reconnect
    })
  }
  async changed(keys, before, deadline) {
    if (this.failure) throw this.failure
    if (this.stamp(keys) !== before) return
    await new Promise((resolve, reject) => {
      const done = () => {
        if (this.failure || this.stamp(keys) !== before || this.closed) {
          clearTimeout(timer); this.waiters.delete(done)
          if (this.failure) reject(this.failure)
          else if (this.closed) reject(new Error('issue1503_live_closed'))
          else resolve()
        }
      }
      const timer = setTimeout(() => { this.waiters.delete(done); reject(new Error('issue1503_task_timeout')) }, Math.max(1, deadline - Date.now()))
      this.waiters.add(done); done()
    })
  }
  async until(keys, read, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.failure) throw this.failure
      const before = this.stamp(keys)
      const value = await read()
      if (predicate(value)) return value
      check(Date.now() < deadline, 'task_timeout')
      await this.changed(keys, before, deadline)
    }
  }
  close() {
    this.closed = true; clearInterval(this.heartbeat); clearTimeout(this.renewal); clearTimeout(this.reconnect)
    if (this.socket) { this.socket.onclose = this.socket.onerror = this.socket.onmessage = null; this.socket.close() }
    this.notify()
  }
}

export function deliveryConfiguration(env = process.env) {
  const expectedSha = env.MIKKA_EXPECTED_DEPLOYMENT_SHA
  const workspaceId = env.MIKKA_1503_WORKSPACE_ID ?? defaultWorkspace
  const teamId = env.MIKKA_1503_TEAM_ID ?? defaultTeam
  const marker = env.MIKKA_1503_RUN_MARKER ?? `${env.GITHUB_RUN_ID ?? 'manual'}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`
  const harness = env.MIKKA_1503_HARNESS || undefined
  const submissionMode = env.MIKKA_1503_SUBMISSION_MODE ?? 'existing_issue'
  const codexQuestion = env.MIKKA_1503_CODEX_QUESTION ?? '0'
  const timeoutMs = Number(env.MIKKA_ACCEPTANCE_TIMEOUT_MS ?? 1200000)
  check(sha(expectedSha) && uuid(workspaceId) && uuid(teamId) && /^[a-zA-Z0-9_-]{3,43}$/.test(marker)
    && (harness === undefined || ['claude_code', 'codex'].includes(harness))
    && ['existing_issue', 'explicit_new_task'].includes(submissionMode)
    && ['0', '1'].includes(codexQuestion) && (codexQuestion !== '1' || harness !== 'claude_code')
    && Number.isFinite(timeoutMs) && timeoutMs >= 60000 && timeoutMs <= 3600000, 'delivery_configuration_required')
  const cases = [
    { harness: 'claude_code', model: 'claude-haiku-5-5', source: { kind: 'subscription', connectionId: env.MIKKA_1503_CLAUDE_CONNECTION_ID ?? '93b6ab23-900b-4e18-9ea0-baccf2d104ce' } },
    { harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: env.MIKKA_1503_CODEX_CONNECTION_ID ?? 'ef66c1d8-2bbc-48e9-abf3-2ce3787ceef5' } },
  ].filter(item => harness === undefined || item.harness === harness)
  check(cases.every(item => uuid(item.source.connectionId)), 'subscription_reference_invalid')
  const specifications = cases.map(item => fileSpecification(marker, item.harness))
  return { expectedSha, workspaceId, teamId, marker, submissionMode, codexQuestion: codexQuestion === '1', timeoutMs, cases, specifications }
}

/** A single failure-path discovery, scoped to the issue actually created by
 * this invocation's new bot. Never infer cleanup targets from titles or prose. */
export async function discoverExplicitCleanupTask(json, workspaceId, item) {
  if (!uuid(item.issueId) || !uuid(item.botId)) return null
  const found = await json(`/api/factory/tasks?issueId=${item.issueId}`)
  check(found.liveWorkspaceId === workspaceId && Array.isArray(found.tasks), 'cleanup_task_scope_mismatch')
  if (found.tasks.length === 0) return null
  check(found.tasks.length === 1 && uuid(found.tasks[0].id), 'cleanup_task_scope_mismatch')
  const state = await json(`/api/factory/tasks/${found.tasks[0].id}`)
  check(state.liveWorkspaceId === workspaceId && state.task?.id === found.tasks[0].id && state.task.issueId === item.issueId
    && state.task.botId === item.botId && Array.isArray(state.attempts)
    && (item.dispatchReceipts?.runIds ?? []).every(runId => state.attempts.some(attempt => attempt.runId === runId)), 'cleanup_task_scope_mismatch')
  return state
}

export async function runDeliveryAcceptance(env = process.env) {
  const { expectedSha, workspaceId, teamId, marker, submissionMode, codexQuestion, timeoutMs, cases, specifications } = deliveryConfiguration(env)
  const report = { issue: 1503, phase: 'delivery', startedAt: new Date().toISOString(), expectedSha, workspaceId, teamId,
    marker, submissionMode, codexQuestion, selectedHarnesses: cases.map(item => item.harness), repository: REPOSITORY, cases: [], cleanup: [], status: 'running' }
  let session, live, chatLive, originalOrder, currentOrder, profile, activeCase, project, originalVerification, explicitSubmission
  let vmDiagnostic
  const chatLiveCounts = { messages: 0, reconnects: 0 }
  const closeChatLive = () => {
    if (!chatLive) return
    chatLiveCounts.messages += chatLive.messages; chatLiveCounts.reconnects += chatLive.reconnects
    chatLive.close(); chatLive = null
  }
  const installedVerificationCommands = new Set()
  const reportPath = resolve(env.MIKKA_1503_REPORT ?? 'issue1503-report/delivery.json')
  const checkpoint = async () => { await mkdir(resolve(reportPath, '..'), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }) }
  const diagnoseOwnRun = async runId => {
    const item = activeCase
    if (!item || !vmDiagnostic || !uuid(item.issueId) || !uuid(runId)) return
    item.vmDiagnostic = await vmDiagnostic.collect({ runId, issueId: item.issueId, workspaceId,
      sinceMs: Date.parse(report.startedAt), untilMs: Date.now() + 5000 })
  }
  const rememberExplicitReceipts = async chat => {
    if (!explicitSubmission) return
    check(chat?.botId === activeCase.botId && chat.live?.ownerId === SMOKE_ID, 'chat_live_scope_missing')
    const receipts = explicitNewTaskCleanupReceipts(chat, explicitSubmission.text, explicitSubmission.after)
    if (!receipts.issueIds.length && !receipts.runIds.length) return
    activeCase.dispatchReceipts = receipts
    if (receipts.issueIds.length === 1) activeCase.issueId ??= receipts.issueIds[0]
    activeCase.threadRunId ??= receipts.runIds[0]
    activeCase.runIdsSeen = [...new Set([...(activeCase.runIdsSeen ?? []), ...receipts.runIds])]
    await checkpoint()
  }
  let rpc, json, request
  const stage = async name => { report.stage = name; console.log(JSON.stringify({ phase: name, harness: activeCase?.harness, taskId: activeCase?.taskId })); await checkpoint() }
  try {
    const readFixtureCi = createFixtureGithubReader(env.ISSUE1503_CI_GITHUB_TOKEN)
    session = await smokeSession()
    request = (path, init = {}) => session.request(path, { ...init, headers: { cookie: `mikka-workspace=${workspaceId}`, 'x-mikka-locale': 'en', ...init.headers } })
    json = async (path, init) => {
      const response = await request(path, init)
      const value = await response.json().catch(() => null)
      if (!response.ok) {
        const known = typeof value?.error === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{1,100}$/.test(value.error) ? value.error : null
        report.lastHttpFailure = { path: path.split('?')[0], status: response.status, ...(known ? { code: known } : {}) }
        fail(`http_${response.status}`)
      }
      check(value !== null, 'http_json_invalid'); return value
    }
    rpc = async (action, args) => {
      let recorded = false
      const record = (result, code) => {
        const failure = rpcFailureMetadata(action, result, code)
        report.firstRpcFailure ??= failure; report.lastRpcFailure = failure; recorded = true
        console.log(JSON.stringify({ phase: 'rpc_failure', ...failure }))
      }
      try {
        const response = await request('/api/desktop/rpc', session.post({ version: 1, action, args: encode(args) }))
        const result = await response.json().catch(() => null)
        if (!response.ok || result?.ok !== true) { record(result, 'rpc_failed'); fail('rpc_failed') }
        let value
        try { value = decode(result.result) } catch { record(null, 'rpc_decode_failed'); fail('rpc_decode_failed') }
        if (value?.ok === false || value?.error) { record(value, 'rpc_action_failed'); fail('rpc_action_failed') }
        return value?.ok === true && Object.hasOwn(value, 'data') ? value.data : value
      } catch (error) {
        if (!recorded) record(null, 'rpc_transport_failed')
        throw error
      }
    }
    const pin = async () => check((await json('/api/version')).build === expectedSha, 'deployment_changed')
    const order = async () => rpc('model-order.getModelOrder', [workspaceId])
    const changeOrder = async change => { currentOrder = await rpc('model-order.changeModelOrder', [change, workspaceId]); return currentOrder }
    await pin(); await rpc('workspace.switchWorkspace', [workspaceId])
    const directory = await rpc('teams.loadTeamDirectory', [workspaceId])
    check(directory.teams.some(team => team.id === teamId && team.identifier === 'F1503'), 'fixture_team_mismatch')
    if (submissionMode === 'explicit_new_task') check(directory.teams.length === 1, 'new_task_team_ambiguous')
    const github = await json('/api/integrations/github')
    check(github.connected && github.viewerId === SMOKE_ID && github.login === 'alexj11324'
      && github.repositories?.some(repo => repo.fullName === REPOSITORY), 'github_authorization_missing')
    report.githubLogin = github.login
    originalVerification = { command: repositoryVerificationValue(await json(`${verificationPath}?repository=${encodeURIComponent(REPOSITORY)}`)) }
    report.repositoryVerification = { originalConfigured: originalVerification.command !== null,
      originalCommandSha256: originalVerification.command === null ? null : digest(originalVerification.command), installed: [] }
    // createBot takes the registered repository's versioned identity, not its
    // display name. Its normal server action rechecks workspace installation.
    const botRepository = `v2/github.com/${REPOSITORY.toLowerCase()}`
    const profiles = await json(`/api/factory/agent-profiles?workspaceId=${workspaceId}&location=cloud`)
    check(!(profiles.profiles ?? []).some(item => item.enabled && !item.archivedAt), 'fixture_has_enabled_profiles')
    originalOrder = currentOrder = await order(); report.originalOrder = briefOrder(originalOrder)
    check(originalOrder.cloudReady, 'cloud_unavailable')
    live = new LiveChanges(json, workspaceId, { kinds: ['factory_task', 'factory_issue', 'issue_threads'] }); await live.start()
    // Existing tasks join the project before dispatch. Explicit new tasks are
    // already dispatched by their creation turn; changing scope then stops them.
    if (submissionMode === 'existing_issue') {
      await stage('create_project')
      project = (await rpc('projects.saveProject', [{ name: `Factory 1503 ${marker}`, summary: 'Production delivery acceptance for issue #1503',
        description: 'Two tiny, independent text-file changes in alexj11324/Mikka-handoff. Each is reviewed, sent back once, repaired on the same PR, and merged by the owner.',
        status: 'started', priority: 'normal', lead: 'me', team: 'Mikka', startDate: '', targetDate: '' }])).project
      check(uuid(project?.id), 'project_missing')
      project = await rpc('team-relations.setProjectTeams', [{ projectId: project.id, revision: project.revision, teamIds: [teamId], primaryTeamId: teamId }])
      report.projectId = project.id
    }
    for (const definition of cases) {
      const specification = fileSpecification(marker, definition.harness)
      const confirmation = codexQuestion && definition.harness === 'codex' ? codexQuestionConfirmation(marker, specification) : null
      const { initial: initialText, revised: revisedText } = specification
      const verifyCommand = repositoryVerifyCommand(specifications, specification.path)
      activeCase = { harness: definition.harness, model: definition.model, status: 'running', filePath: specification.path, runs: [] }
      vmDiagnostic = createOwnVmDiagnostic({ apiKey: env.E2B_API_KEY })
      if (confirmation) activeCase.questionConfirmation = { required: true, questionSha256: digest(confirmation.question), answerAttempted: false }
      explicitSubmission = null
      report.cases.push(activeCase)
      await stage('configure_repository_verification'); await pin()
      const currentVerification = repositoryVerificationValue(await json(`${verificationPath}?repository=${encodeURIComponent(REPOSITORY)}`))
      check(currentVerification === originalVerification.command || installedVerificationCommands.has(currentVerification), 'repository_verification_configuration_conflict')
      installedVerificationCommands.add(verifyCommand)
      check(repositoryVerificationValue(await json(verificationPath, { ...session.post({ repository: REPOSITORY, verifyCommand }), method: 'PATCH' })) === verifyCommand,
        'repository_verification_configuration_mismatch')
      report.repositoryVerification.installed.push({ harness: definition.harness, requiredPath: specification.path, commandSha256: digest(verifyCommand) })
      await stage('configure_small_official_model'); await pin()
      currentOrder = await removeModelOrderEntries(currentOrder, changeOrder)
      await changeOrder({ kind: 'add', entries: [definition] })
      await changeOrder({ kind: 'location', location: 'cloud' })
      await changeOrder({ kind: 'autoRouting', enabled: false })
      await changeOrder({ kind: 'preferred', harness: definition.harness })
      // Settings display only a 15-minute allowance snapshot. Refresh this
      // selected subscription once, as the ordinary explicit quota action does.
      currentOrder = await rpc('model-order.checkModelOrderQuota', [definition.source.connectionId, workspaceId])
      check(currentOrder.entries.length === 1 && currentOrder.entries[0].model === definition.model && !currentOrder.entries[0].block, 'required_model_unavailable')
      profile = (await json('/api/factory/agent-profiles', session.post({ workspaceId, requestId: randomUUID(), profile: {
        name: `1503 ${marker} ${definition.harness}`, description: 'Tiny code delivery and independent Factory review.', roles: ['execute', 'review', 'verify'],
        enabled: true, harness: definition.harness, model: { mode: 'fixed', ...definition }, effort: 'low', skills: [],
        instructions: deliveryProfileInstructions(specification) } }))).profile
      check(uuid(profile?.id), 'profile_missing'); activeCase.profileId = profile.id
      const bot = await rpc('bots.createBot', [{ name: `1503 ${marker} ${definition.harness}`, color: 'bleu', shape: 'cercle', repository: botRepository, model: null }])
      check(uuid(bot?.id), 'bot_missing'); activeCase.botId = bot.id
      const taskText = `${confirmation ? confirmation.instructions + '\n\n' : ''}${deliveryTaskText(specification)}`
      let issue, found, issueKeys
      if (submissionMode === 'explicit_new_task') {
        const title = `Factory #1503 ${marker} ${definition.harness} explicit cloud`
        const submissionId = randomUUID()
        // Match NewTaskDialog's English prompt/context and transport. The
        // Coordinator creates the issue and binds taskEventId itself; there is
        // no saveIssue/promote call or operator-written provenance in this mode.
        const dispatchText = `Create a task for me (run it on Mikka Cloud): Create one new task with this exact title: ${title}. Put the following complete requirements in its body.\n${taskText}\nCreate the task through normal create_issue in this workspace's sole F1503 team, then dispatch that created task with normal dispatch_run, repo ${REPOSITORY}, target cloud, model harness ${definition.harness}, selected Profile ${profile.id}, needsSpec false. Do not create another task or use dispatch_bot_computer. Follow the injected Mikka agent delivery instructions and leave its PR open for my Factory review.`
        const readChat = async () => {
          if (chatLive?.failure) throw chatLive.failure
          const chat = (await rpc('coordinator.syncCoordinatorChat', [bot.id])).chat
          check(chat?.botId === bot.id && chat.live?.ownerId === SMOKE_ID && uuid(chat.live.workspaceId), 'chat_live_scope_missing')
          await rememberExplicitReceipts(chat)
          return chat
        }
        const beforeChat = await readChat()
        check(Number.isSafeInteger(beforeChat.cursor) && beforeChat.cursor >= 0, 'chat_live_scope_missing')
        const chatKey = `bot_chat:${bot.id}`
        chatLive = new LiveChanges(json, beforeChat.live.workspaceId, { kinds: ['bot_chat'] })
        await chatLive.start()
        await stage('create_and_dispatch_new_task'); await pin()
        activeCase.submissionId = submissionId
        explicitSubmission = { text: dispatchText, after: beforeChat.cursor }
        const dispatched = await rpc('coordinator.sendCoordinatorMessage', explicitNewTaskArguments(dispatchText, bot.id, submissionId, profile.id))
        check(dispatched.queued === true, 'dispatch_failed')
        const completed = await chatLive.until([chatKey], async () => {
          const chat = await readChat()
          check(chat.live.workspaceId === beforeChat.live.workspaceId, 'chat_live_scope_changed')
          return chat
        }, chat => explicitNewTaskComplete(chat, dispatchText, beforeChat.cursor), timeoutMs)
        // One list read after the completed turn. The sole team is selected by
        // normal create_issue, so the issue must already have its F1503 number.
        const workspaceIssues = await rpc('issues.listWorkspaceIssues', [workspaceId])
        const created = Array.isArray(workspaceIssues) ? workspaceIssues.filter(item => item.title === title) : []
        check(created.length === 1 && uuid(created[0].id) && created[0].scope === 'workspace'
          && /^F1503-\d+$/.test(created[0].identifier) && Date.parse(created[0].createdAt) >= Date.parse(report.startedAt), 'new_task_numbered_issue_missing')
        issue = created[0]
        check(!activeCase.issueId || activeCase.issueId === issue.id, 'new_task_creation_receipt_mismatch')
        activeCase.issueId = issue.id; activeCase.identifier = issue.identifier; activeCase.expectedBranch = `mikka/${issue.identifier.toLowerCase()}`
        activeCase.workspaceList = { count: workspaceIssues.length, identifier: issue.identifier }
        issueKeys = [`factory_issue:${issue.id}`]
        found = await json(`/api/factory/tasks?issueId=${issue.id}`)
        check(found.liveWorkspaceId === workspaceId && found.tasks.length === 1, 'new_task_factory_missing')
        // Bind cleanup before checking the receipt, in case a proof mismatch
        // follows a successfully admitted task owned by this invocation.
        activeCase.taskId = found.tasks[0].id
        activeCase.creation = explicitNewTaskEvidence(completed, dispatchText, beforeChat.cursor, issue.id)
        activeCase.threadRunId = activeCase.creation.runId
        await checkpoint()
      } else {
        await stage('create_numbered_task')
        issue = (await rpc('issues.saveIssue', [{ title: `Factory #1503 ${marker} ${definition.harness}`, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: taskText }] }] }, status: 'todo', priority: 'low' }])).issue
        check(uuid(issue?.id) && typeof issue.identifier === 'string' && /-\d+$/.test(issue.identifier), 'number_missing_at_creation')
        activeCase.issueId = issue.id; activeCase.personalIdentifier = issue.identifier
        issue = (await rpc('issues.promoteIssueToTeam', [{ requestId: randomUUID(), issueId: issue.id, revision: issue.revision, teamId, expectedTeamId: null }])).issue
        check(issue?.scope === 'workspace' && /^F1503-\d+$/.test(issue.identifier), 'team_number_missing')
        activeCase.identifier = issue.identifier; activeCase.expectedBranch = `mikka/${issue.identifier.toLowerCase()}`
        const workspaceIssues = await rpc('issues.listWorkspaceIssues', [workspaceId])
        check(Array.isArray(workspaceIssues) && workspaceIssues.some(item => item.id === issue.id && item.identifier === issue.identifier), 'workspace_issue_number_mismatch')
        activeCase.workspaceList = { count: workspaceIssues.length, identifier: issue.identifier }
        project = (await rpc('projects.setProjectIssues', [{ id: project.id, revision: project.revision, issueIds: report.cases.map(item => item.issueId) }])).project
        issueKeys = [`factory_issue:${issue.id}`]
        const before = await json(`/api/factory/tasks?issueId=${issue.id}`)
        check(before.liveWorkspaceId === workspaceId && before.tasks.length === 0, 'fixture_task_not_fresh')
        await stage('dispatch'); await pin()
        // The ordinary chat dispatches this existing issue. Keep the human source
        // and Profile, with cloud-only placement in its normal dispatch_run call.
        const submissionId = randomUUID()
        const dispatchText = `Execute existing task ${issue.identifier} (issueId ${issue.id}) now in ${REPOSITORY}. Read its existing description and use that exact task; do not create a duplicate. This is repository work, so use normal dispatch_run with repo ${REPOSITORY}, target cloud, model harness ${definition.harness}, and the selected Profile ${profile.id}. It is a tiny file task and needs no specification approval: needsSpec false. Preserve the task's existing acceptance criteria, follow the injected Mikka agent delivery instructions, and leave its PR open for my Factory review.`
        const readChat = async () => (await rpc('coordinator.syncCoordinatorChat', [bot.id])).chat
        const beforeChat = await readChat()
        check(beforeChat?.botId === bot.id && beforeChat.live?.ownerId === SMOKE_ID && uuid(beforeChat.live.workspaceId)
          && Number.isSafeInteger(beforeChat.cursor) && beforeChat.cursor >= 0, 'chat_live_scope_missing')
        const chatKey = `bot_chat:${bot.id}`
        // Chat invalidations use the owner's home channel, which may differ from
        // the task workspace. Forward only a wake-up, never message contents.
        chatLive = new LiveChanges(json, beforeChat.live.workspaceId, { kinds: ['bot_chat'], onNotify: key => { if (!key || key === chatKey) live.notify(chatKey) } })
        await chatLive.start()
        const dispatched = await rpc('coordinator.sendCoordinatorMessage', existingIssueMessageArguments(dispatchText, bot.id, submissionId, profile.id))
        check(dispatched.queued === true, 'dispatch_failed'); activeCase.submissionId = submissionId
        const readDispatched = async () => {
          if (chatLive.failure) throw chatLive.failure
          const found = await json(`/api/factory/tasks?issueId=${issue.id}`)
          if (found.tasks.length) return found
          const chat = await readChat()
          check(chat?.botId === bot.id && chat.live?.ownerId === SMOKE_ID
            && chat.live.workspaceId === beforeChat.live.workspaceId, 'chat_live_scope_changed')
          if (chatSubmissionComplete(chat, dispatchText, beforeChat.cursor)) {
            // The queue commit precedes the completed reply. Read after observing
            // that reply to avoid racing a dispatch that committed during chat read.
            const completed = await json(`/api/factory/tasks?issueId=${issue.id}`)
            if (completed.tasks.length) return completed
            activeCase.dispatchFailure = { cursor: chat.cursor, working: false,
              code: ['wake_exhausted', 'wake_failed', 'wake_start_unconfirmed', 'turn_failed', 'length'].includes(chat.error) ? chat.error : 'completed_without_dispatch' }
            fail('coordinator_completed_without_dispatch')
          }
          return found
        }
        found = await live.until([...issueKeys, chatKey], readDispatched, value => value.tasks.length > 0, timeoutMs)
      }
      check(found.tasks.length === 1, 'multiple_factory_tasks'); activeCase.taskId = found.tasks[0].id
      closeChatLive()
      const keys = [`factory_task:${activeCase.taskId}`, ...issueKeys, `issue_threads:${issue.id}`, `pull_request_status:${issue.id}`]
      let lastState = ''
      const read = async () => {
        const state = await json(`/api/factory/tasks/${activeCase.taskId}`)
        check(state.task.id === activeCase.taskId && state.task.issueId === issue.id && state.liveWorkspaceId === workspaceId, 'task_scope_mismatch')
        if (submissionMode === 'explicit_new_task') {
          check(state.task.botId === bot.id && uuid(state.task.sourceEventId)
            && state.attempts.some(item => item.stage === 'execute' && item.runId === activeCase.creation.runId), 'new_task_source_binding_mismatch')
          activeCase.creation.sourceEventId ??= state.task.sourceEventId
          check(state.task.sourceEventId === activeCase.creation.sourceEventId, 'new_task_source_binding_changed')
        }
        const now = `${state.task.stage}:${state.task.status}:${state.task.revision}`
        if (now !== lastState) { lastState = now; console.log(JSON.stringify({ phase: 'factory_progress', harness: definition.harness, taskId: state.task.id, stage: state.task.stage, status: state.task.status, revision: state.task.revision })) }
        activeCase.lastState = { stage: state.task.stage, status: state.task.status, revision: state.task.revision }
        activeCase.threadRunId ??= state.attempts.find(item => item.stage === 'execute' && uuid(item.runId))?.runId
        activeCase.runIdsSeen = [...new Set([...(activeCase.runIdsSeen ?? []), ...state.attempts.map(item => item.runId).filter(uuid)])]
        // Observe the first failed execute attempt while its VM may still be
        // running, even when Factory has already adopted a normal retry. This
        // does not change the task, retry policy or any acceptance assertion.
        const failedExecute = state.attempts.find(item => item.stage === 'execute' && item.status === 'failed' && uuid(item.runId))
        if (failedExecute) await diagnoseOwnRun(failedExecute.runId)
        if (['failed', 'blocked', 'cancelled', 'revoked'].includes(state.task.status)) {
          activeCase.failedAttempt = state.attempts.filter(item => item.id === state.task.attemptId).map(item => ({ id: item.id, runId: item.runId, stage: item.stage, status: item.status,
            ...(typeof item.output?.reasonCode === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(item.output.reasonCode) ? { reasonCode: item.output.reasonCode } : {}) }))[0]
          fail('factory_terminal_failure')
        }
        if (confirmation && state.task.stage === 'execute' && state.task.status === 'waiting') {
          const pending = await json(`/api/factory/questions?taskId=${activeCase.taskId}`)
          activeCase.questionConfirmation.latestPendingObservation = confirmationPendingObservation(pending, state.task.revision)
          await checkpoint()
          const pendingQuestion = confirmationPendingQuestion(pending, activeCase.questionConfirmation, {
            taskId: activeCase.taskId, originRunId: activeCase.threadRunId, sourceEventId: state.task.sourceEventId
          }, confirmation)
          if (!pendingQuestion) return state
          const question = await json(`/api/factory/questions/${pendingQuestion.questionId}`)
          const expected = { ownerId: SMOKE_ID, credentialOwnerId: OWNER_ID, workspaceId, taskId: activeCase.taskId,
            issueId: issue.id, botId: bot.id, originRunId: activeCase.threadRunId, sourceEventId: state.task.sourceEventId, profile }
          const originEvidence = await json(`/api/runs/${expected.originRunId}/evidence`)
          const reference = confirmationQuestionReference(state, question, originEvidence, expected, confirmation)
          // Permission is escalated through the existing live Factory channel.
          // Wait for its human-facing state; no timer or business-data polling.
          if (question.status === 'open') return state
          const origin = confirmationRunEvidence(originEvidence, expected, expected.originRunId)
          const answerId = randomUUID()
          Object.assign(activeCase.questionConfirmation, { questionId: question.id, kind: question.kind,
            questionStatus: question.status, questionRevision: question.revision, origin,
            originSessionSha256: digest(reference.originSessionId), answerId })
          await stage('answer_codex_permission'); await pin()
          activeCase.questionConfirmation.answerAttempted = true; await checkpoint()
          const result = await json(`/api/factory/questions/${question.id}`, session.post({ reference, answerId, text: confirmation.answer }))
          // Retain the real returned child for cleanup before proof assertions.
          if (uuid(result.continuationRunId)) activeCase.runIdsSeen = [...new Set([...activeCase.runIdsSeen, result.continuationRunId])]
          const answered = await json(`/api/factory/questions/${question.id}`)
          const receipt = confirmationAnswerReceipt(result, answered, reference, answerId, expected, confirmation)
          const continuation = confirmationRunEvidence(await json(`/api/runs/${receipt.continuationRunId}/evidence`), expected, receipt.continuationRunId)
          check(continuation.bindingId === origin.bindingId && continuation.executionIdentitySha256 === origin.executionIdentitySha256,
            'confirmation_changed_frozen_subscription')
          Object.assign(activeCase.questionConfirmation, { receipt, continuation, answeredAt: new Date().toISOString() })
          await stage('wait_initial_review')
        }
        return state
      }
      const approval = previous => live.until(keys, read,
        state => approvalPublicationReady(state, activeCase.expectedBranch, previous), timeoutMs)
      const proof = async (state, expectedText, label) => {
        const candidate = state.candidates.find(item => item.id === state.task.candidateId)
        check(candidate && sha(candidate.sha) && uuid(candidate.runId), 'candidate_missing')
        if (confirmation && label === 'initial') {
          const receipt = activeCase.questionConfirmation.receipt
          check(receipt && candidate.runId === receipt.continuationRunId && state.task.sourceEventId === receipt.sourceEventId
            && state.attempts.some(item => item.id === receipt.originAttemptId && item.runId === receipt.originRunId && item.stage === 'execute'),
          'confirmation_continuation_not_producer')
          const resolved = await json(`/api/factory/questions/${receipt.questionId}`)
          check(resolved.status === 'resolved' && resolved.answerSource === 'human' && resolved.answerId === receipt.answerId
            && resolved.originRunId === receipt.originRunId && resolved.continuationRunId === candidate.runId
            && digest(resolved.originSessionId) === receipt.originSessionSha256, 'confirmation_not_resolved')
          activeCase.questionConfirmation.resolved = true
        }
        check(state.delivery?.pullRequest?.state === 'open' && new RegExp(`^https://github\\.com/${REPOSITORY}/pull/\\d+$`, 'i').test(state.delivery.pullRequest.url), 'automatic_pr_missing')
        const flowVersion = state.task.route?.flowVersion ?? 1
        const historicalReview = flowVersion === 2 && label === 'repaired'
        const passed = state.attempts.filter(item => ['review', 'verify'].includes(item.stage) && item.status === 'passed'
          && (historicalReview ? activeCase.initial.checks.some(prior => prior.attemptId === item.id && prior.runId === item.runId && prior.candidateId === item.candidateId) : item.candidateId === candidate.id))
        check(passed.some(item => item.stage === 'review') && (flowVersion === 2 || passed.some(item => item.stage === 'verify')), 'independent_checks_missing')
        if (historicalReview) check(state.attempts.filter(item => item.stage === 'review' && item.runId).length === activeCase.initial.reviewAttemptCount,
          'v2_unexpected_second_review')
        check(new Set([candidate.runId, ...passed.map(item => item.runId)]).size === passed.length + 1, 'checks_not_independent')
        // V2 has one review. A repaired head must not inherit a false claim
        // that its SHA was independently reviewed. Its implementation must
        // instead provide fresh, successful verification of the new content.
        const { artifact, verifiedContent, receipt: implementationVerification } = await collectFixtureImplementationEvidence(json, {
          taskId: state.task.id, producerRunId: candidate.runId, candidateSha: candidate.sha, expectedBranch: activeCase.expectedBranch,
          command: verifyCommand, filePath: activeCase.filePath, expectedText, expectedState: label === 'initial' ? 'initial' : 'revised' })
        const publish = artifact.raw.publish
        const externalCi = await collectFixtureCiEvidence(readFixtureCi, { candidateSha: candidate.sha,
          pullRequestUrl: state.delivery.pullRequest.url, expectedBranch: activeCase.expectedBranch })
        const reviewCi = historicalReview ? activeCase.initial.externalCi : externalCi
        const reviewImplementation = historicalReview ? activeCase.initial.implementationVerification : implementationVerification
        const verification = matchedCheckEvidence(state, passed, reviewCi, reviewImplementation)
        for (const runId of [...new Set(state.attempts.map(item => item.runId).filter(uuid))]) {
          if (activeCase.runs.some(item => item.runId === runId)) continue
          const evidence = await json(`/api/runs/${runId}/evidence`)
          if (confirmation && runId === activeCase.questionConfirmation.receipt?.continuationRunId) {
            check(evidence.run.status === 'succeeded', 'confirmation_producer_not_succeeded')
            activeCase.questionConfirmation.producerStatus = evidence.run.status
          }
          check(evidence.run.harness === definition.harness && evidence.run.model === definition.model && evidence.run.credentialType === 'subscription'
            && evidence.run.subscriptionRoute === (definition.harness === 'codex' ? 'codex_cli' : 'claude_code_cli'), 'official_model_provenance_mismatch')
          if (submissionMode === 'explicit_new_task') check(evidence.run.issueId === issue.id
            && evidence.run.executionIdentity?.billingAccount?.runtime?.kind === 'e2b'
            && evidence.run.agentProfile?.profileId === profile.id && evidence.run.agentProfile.version === profile.version
            && evidence.run.agentProfile.source === (state.attempts.some(item => item.stage === 'execute' && item.runId === runId) ? 'explicit' : 'decision'),
          'new_task_cloud_profile_provenance_mismatch')
          activeCase.runs.push({ runId, status: evidence.run.status, harness: evidence.run.harness, model: evidence.run.model, credentialType: evidence.run.credentialType, subscriptionRoute: evidence.run.subscriptionRoute,
            profileId: evidence.run.agentProfile?.profileId, profileVersion: evidence.run.agentProfile?.version,
            ...(submissionMode === 'explicit_new_task' ? { profileSource: evidence.run.agentProfile.source, runtimeKind: evidence.run.executionIdentity.billingAccount.runtime.kind } : {}) })
        }
        const reviewArtifacts = []
        for (const verified of verification) {
          if (historicalReview) {
            const prior = activeCase.initial.reviewArtifacts.find(item => item.attemptId === verified.attemptId && item.runId === verified.runId
              && item.candidateId === verified.candidateId && item.candidateSha === verified.candidateSha)
            check(prior && prior.observations.length > 0 && prior.repositoryObservations.length > 0, 'historical_review_observations_missing')
            reviewArtifacts.push({ ...prior, appliesToCurrentCandidate: false })
            continue
          }
          const artifactRef = `run-report:${verified.runId}`
          const checked = await json(`/api/factory/tasks/${state.task.id}/approval?artifact=${encodeURIComponent(artifactRef)}`)
          const raw = checked.raw
          const criteriaEvidence = reviewCriteriaEvidence(raw?.criteria, verified.candidateSha,
            flowVersion === 2 && verified.stage === 'review' ? reviewCi : null,
            { implementationReceipt: flowVersion === 2 && verified.stage === 'review' ? reviewImplementation : null })
          check(raw?.check?.sha === verified.candidateSha && raw.check.readOnly === true && Array.isArray(raw.filesChanged)
            && raw.filesChanged.length === 0 && criteriaEvidence, 'independent_report_evidence_missing')
          let observations = [], repositoryObservations = []
          if (flowVersion === 2 && verified.stage === 'review') {
            check(raw.reviewVerdict === 'passed', 'independent_review_verdict_missing')
            const thread = await rpc('agents.getIssueThread', [issue.id, verified.runId])
            observations = reviewArtifactObservations(thread, verified.runId, verified.candidateSha, activeCase.filePath, expectedText)
            repositoryObservations = reviewRepositoryObservations(thread, verified.runId, verified.candidateSha, artifact.raw?.sourceCommit, activeCase.filePath)
          } else verifiedFileBytes(raw, verifyCommand, activeCase.filePath, expectedText, label === 'initial' ? 'initial' : 'revised')
          reviewArtifacts.push({ attemptId: verified.attemptId, runId: verified.runId, stage: verified.stage, candidateId: verified.candidateId,
            candidateSha: verified.candidateSha, artifact: artifactRef, reportSha256: digest(JSON.stringify(raw)),
            reviewVerdict: raw.reviewVerdict ?? null, verifyStatus: raw.verify?.status ?? null, appliesToCurrentCandidate: true, observations, repositoryObservations,
            criteria: raw.criteria.map(item => ({ criterionId: item.criterionId ?? null, passed: item.passed, status: item.status ?? 'passed',
              evidenceSha256: nonempty(item.evidence) ? digest(item.evidence) : null,
              reasonSha256: nonempty(item.reason) ? digest(item.reason) : null })),
            externalVerification: criteriaEvidence.covered })
        }
        const actualVerifyCommands = [{ command: verifyCommand, commandSha256: digest(verifyCommand), exitCode: 0, source: 'daemon_verify' }]
        const changes = await rpc('agents.getThreadChanges', [issue.id, candidate.runId])
        check(changes.state === 'ready' && changes.changes.files.length === 1 && changes.changes.files[0].path === activeCase.filePath, 'unexpected_file_changes')
        const file = changes.changes.files[0]
        const newLines = file.blocks.filter(block => block.kind === 'line' && block.line.kind !== 'removed').map(block => block.line)
        check(newLines.some(line => line.text === (label === 'initial' ? 'State: initial' : 'State: revised')), 'requested_file_change_missing')
        if (file.status === 'added') check(newLines.map(line => line.text).join('\n') + '\n' === expectedText, 'file_content_mismatch')
        const item = { candidateId: candidate.id, candidateSha: candidate.sha, runId: candidate.runId, pullRequestUrl: state.delivery.pullRequest.url,
          branch: publish.branch, expectedFileSha256: digest(expectedText), checkpointSha256: digest(JSON.stringify(file)),
          flowVersion, actualVerifyCommands, verifiedContent, implementationVerification, reviewArtifacts, externalCi, reviewAppliesToCurrentCandidate: !historicalReview,
          reviewAttemptCount: state.attempts.filter(item => item.stage === 'review' && item.runId).length,
          verification: verification.map(item => ({ attemptId: item.attemptId, runId: item.runId, stage: item.stage,
            candidateId: item.candidateId, candidateSha: item.candidateSha, status: item.status,
            verifyStatus: item.verify?.status, exitCode: item.verify?.exitCode, commandSha256: nonempty(item.verify?.command) ? digest(item.verify.command) : null,
            criteria: item.criteria.map(criterion => ({ criterionId: criterion.criterionId, passed: criterion.passed, status: criterion.status,
              evidenceSha256: nonempty(criterion.evidence) ? digest(criterion.evidence) : null,
              reasonSha256: nonempty(criterion.reason) ? digest(criterion.reason) : null, exitCode: criterion.exitCode })),
            externalVerification: reviewCriteriaEvidence(item.criteria, item.candidateSha,
              flowVersion === 2 && item.stage === 'review' ? reviewCi : null,
              { requireExplicitStatus: true, implementationReceipt: flowVersion === 2 && item.stage === 'review' ? reviewImplementation : null }).covered })),
          checks: passed.map(check => ({ attemptId: check.id, runId: check.runId, stage: check.stage, candidateId: check.candidateId,
            candidateSha: state.candidates.find(item => item.id === check.candidateId)?.sha ?? null })) }
        activeCase[label] = item; await checkpoint(); return item
      }
      await stage('wait_initial_review')
      const initial = await approval()
      activeCase.sourceEventId = initial.task.sourceEventId
      const first = await proof(initial, initialText, 'initial')
      await stage('request_changes'); await pin()
      const rejectionId = randomUUID()
      const rejected = await json(`/api/factory/tasks/${activeCase.taskId}/approval`, session.post({ operation: 'reject', input: { binding: binding(initial.task), eventId: rejectionId,
        candidateId: first.candidateId, note: `Please revise only ${activeCase.filePath}: change State: initial to State: revised. Preserve its exact header, Case line, final newline, and all other files. Verify the change, commit, and submit through the same Mikka task and PR.` } }))
      check(rejected.rejectionId === rejectionId && !rejected.repairBudgetExhausted, 'reject_failed')
      activeCase.rejectionId = rejectionId
      // Exactly the existing sendBack UI behavior: no recovery endpoint or redispatch.
      await stage('wait_automatic_repair')
      const repaired = await approval(first)
      check(repaired.task.sourceEventId === activeCase.sourceEventId, 'repair_replaced_acceptance_target')
      const second = await proof(repaired, revisedText, 'repaired')
      check(second.pullRequestUrl === first.pullRequestUrl && second.candidateSha !== first.candidateSha, 'repair_not_same_pr')
      const rejectionLedger = await json(`/api/factory/tasks/${activeCase.taskId}/approval?view=ledger`)
      check(rejectionLedger.rejections?.some(item => item.id === rejectionId && item.candidateId === first.candidateId && item.actor?.userId === SMOKE_ID), 'human_rejection_receipt_missing')
      await stage('approve_and_merge'); await pin()
      const acceptId = randomUUID()
      const accepted = await json(`/api/factory/tasks/${activeCase.taskId}/approval`, session.post({ operation: 'accept', input: { binding: binding(repaired.task), eventId: acceptId } }))
      check(['merged', 'merging'].includes(accepted.status) && accepted.pullRequestUrl === first.pullRequestUrl, 'merge_not_requested')
      const final = await live.until(keys, read, state => state.task.stage === 'publish' && state.task.status === 'passed' && state.delivery?.pullRequest?.state === 'merged', timeoutMs)
      const ledger = await json(`/api/factory/tasks/${activeCase.taskId}/approval?view=ledger`)
      const merged = ledger.merges?.find(item => item.id === accepted.mergeId && item.status === 'merged')
      check(merged && merged.source === 'mikka' && merged.candidateId === second.candidateId && merged.sha === second.candidateSha
        && merged.headSha === second.candidateSha && sha(merged.mergeCommitSha), 'merge_receipt_missing')
      const githubState = await json('/api/github/pull-request-status', session.post({ issueId: issue.id, url: first.pullRequestUrl }))
      check(githubState.viewerId === SMOKE_ID && githubState.state === 'merged', 'github_merge_unconfirmed')
      activeCase.merge = { mergeId: merged.id, eventId: acceptId, candidateSha: merged.sha, headSha: merged.headSha, mergeCommitSha: merged.mergeCommitSha, pullRequestUrl: merged.pullRequestUrl, source: merged.source }
      activeCase.finalBinding = binding(final.task); activeCase.status = 'passed'
      await json(`/api/factory/agent-profiles/${profile.id}`, { ...session.post({ workspaceId, version: profile.version }), method: 'DELETE' })
      report.cleanup.push({ kind: 'profile_archived', id: profile.id }); profile = null
      await checkpoint(); activeCase = null; explicitSubmission = null
    }
    await pin()
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.code = /^issue1503_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'issue1503_delivery_failed'
    if (activeCase) activeCase.status = 'failed'
    await diagnoseOwnRun(activeCase?.threadRunId)
  } finally {
    // A live timeout can settle while its read callback is still awaiting the
    // probe. Join the same hard-bounded child before the first cleanup write.
    await vmDiagnostic?.settled()
    closeChatLive()
    live?.close()
    let cleanupState
    if (activeCase?.botId && explicitSubmission && !activeCase.taskId && rpc) {
      // Admission may have succeeded before a chat/list/proof failure. Stop this
      // new bot's Coordinator, retain its real tool receipts, then discover once.
      try {
        const stopped = await rpc('coordinator.stopCoordinatorTurn', [activeCase.botId])
        report.cleanup.push({ kind: 'coordinator_turn_stopped', botId: activeCase.botId, stopped: stopped.stopped === true })
      } catch { report.cleanup.push({ kind: 'coordinator_turn_stop_failed', botId: activeCase.botId }) }
      try { await rememberExplicitReceipts((await rpc('coordinator.syncCoordinatorChat', [activeCase.botId])).chat) }
      catch { report.cleanup.push({ kind: 'dispatch_receipt_read_failed', botId: activeCase.botId }) }
      try {
        cleanupState = await discoverExplicitCleanupTask(json, workspaceId, activeCase)
        if (cleanupState) {
          activeCase.taskId = cleanupState.task.id
          activeCase.runIdsSeen = [...new Set([...(activeCase.runIdsSeen ?? []), ...cleanupState.attempts.map(item => item.runId).filter(uuid)])]
          activeCase.threadRunId ??= cleanupState.attempts.find(item => item.stage === 'execute' && uuid(item.runId))?.runId
          report.cleanup.push({ kind: 'admitted_task_discovered', id: activeCase.taskId })
        }
      } catch { report.cleanup.push({ kind: 'admitted_task_discovery_failed', botId: activeCase.botId }) }
    }
    // Stop only this invocation's unfinished tasks. Leave evidence and receipts.
    if (activeCase?.taskId && json) {
      try {
        const state = cleanupState ?? await json(`/api/factory/tasks/${activeCase.taskId}`)
        activeCase.runIdsSeen = [...new Set([...(activeCase.runIdsSeen ?? []), ...state.attempts.map(item => item.runId).filter(uuid)])]
        if (!['passed', 'cancelled', 'revoked'].includes(state.task.status)) {
          await json(`/api/factory/tasks/${activeCase.taskId}`, session.post({ binding: { taskId: activeCase.taskId, revision: state.task.revision }, eventId: randomUUID(), action: 'cancel', reason: 'Issue #1503 acceptance round ended; release its temporary run resources.' }))
          report.cleanup.push({ kind: 'task_cancelled', id: activeCase.taskId })
        }
      } catch { report.cleanup.push({ kind: 'task_cancel_failed', id: activeCase.taskId }) }
    }
    if (activeCase?.threadRunId && request) {
      try {
        const stopped = await request(`/api/mobile/threads/${activeCase.threadRunId}/stop`, session.post({}))
        const value = await stopped.json().catch(() => null)
        check(stopped.ok || (stopped.status === 409 && value?.error === 'runChainEnded'), 'run_cleanup_failed')
        report.cleanup.push({ kind: stopped.ok ? 'thread_stopped' : 'thread_already_ended', id: activeCase.threadRunId })
      } catch { report.cleanup.push({ kind: 'thread_stop_failed', id: activeCase.threadRunId }) }
    }
    if (request) for (const item of report.cases) for (const runId of new Set([...(item.runIdsSeen ?? []), ...item.runs.map(run => run.runId), item.threadRunId].filter(uuid))) {
      try {
        const response = await request(`/api/threads/${runId}/machine`, session.post({ action: 'end' }))
        const result = await response.json().catch(() => null)
        check((response.ok && result?.state === 'ended') || response.status === 404, 'machine_cleanup_failed')
        report.cleanup.push({ kind: response.status === 404 ? 'thread_machine_not_allocated' : 'thread_machine_ended', id: runId })
      } catch { report.cleanup.push({ kind: 'thread_machine_end_failed', id: runId }); report.status = 'failed' }
    }
    if (profile && json) {
      try { await json(`/api/factory/agent-profiles/${profile.id}`, { ...session.post({ workspaceId, version: profile.version }), method: 'DELETE' }); report.cleanup.push({ kind: 'profile_archived', id: profile.id }) }
      catch { report.cleanup.push({ kind: 'profile_archive_failed', id: profile.id }) }
    }
    if (originalVerification && installedVerificationCommands.size && json) {
      try { report.cleanup.push(await restoreRepositoryVerification(json, session.post, originalVerification.command, installedVerificationCommands)) }
      catch (error) { report.cleanup.push({ kind: 'repository_verification_restore_failed',
        code: /^issue1503_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'issue1503_verification_restore_failed' }); report.status = 'failed' }
    }
    if (originalOrder && rpc) {
      try {
        currentOrder = await rpc('model-order.getModelOrder', [workspaceId])
        if (JSON.stringify(briefOrder(currentOrder)) !== JSON.stringify(briefOrder(originalOrder))) {
          currentOrder = await removeModelOrderEntries(currentOrder, change => rpc('model-order.changeModelOrder', [change, workspaceId]))
          if (originalOrder.entries.length) await rpc('model-order.changeModelOrder', [{ kind: 'add', entries: briefOrder(originalOrder).entries }, workspaceId])
          for (const change of [{ kind: 'location', location: originalOrder.location }, { kind: 'autoRouting', enabled: originalOrder.autoModelRouting }, { kind: 'preferred', harness: originalOrder.preferredHarness }])
            await rpc('model-order.changeModelOrder', [change, workspaceId])
        }
        const restored = briefOrder(await rpc('model-order.getModelOrder', [workspaceId]))
        check(JSON.stringify({ ...restored, customized: undefined }) === JSON.stringify({ ...briefOrder(originalOrder), customized: undefined }), 'settings_restore_mismatch')
        report.restoredOrder = restored
        report.cleanup.push({ kind: 'effective_model_order_restored', customizedFlagPreserved: restored.customized === originalOrder.customized })
      } catch { report.cleanup.push({ kind: 'model_order_restore_failed' }); report.status = 'failed' }
    }
    await session?.close().catch(() => undefined)
    report.live = { messages: live?.messages ?? 0, reconnects: live?.reconnects ?? 0, chat: chatLiveCounts }
    report.completedAt = new Date().toISOString(); await checkpoint()
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runDeliveryAcceptance()
    console.log(JSON.stringify({ status: report.status, code: report.code, cases: report.cases.map(item => ({ harness: item.harness, status: item.status, issueId: item.issueId, taskId: item.taskId, pullRequestUrl: item.merge?.pullRequestUrl })), report: process.env.MIKKA_1503_REPORT ?? 'issue1503-report/delivery.json' }))
    if (report.status !== 'passed') process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: /^issue1503_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'issue1503_delivery_failed' }))
    process.exitCode = 1
  }
}
