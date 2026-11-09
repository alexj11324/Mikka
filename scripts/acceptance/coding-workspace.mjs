#!/usr/bin/env node
/** #1723/#1724: normal product tasks, normal owner HTTP APIs and native PTYs.
 * Explicit manual workspace-review mode only. No provider SDK, database, model
 * order changes, extra identity, task repair, retry, acceptance merge or polling.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSessionClient, smokeAcceptanceAccount, selectAcceptanceTeam, restoreAcceptanceWorkspace,
  chooseSharedChatModel, subscriptionProof, cleanupCase } from './cloud-startup.mjs'
import { CASES, openLive, assertAttemptBudget } from './run-observability.mjs'
import { verifyExistingTaskTerminal, verifyTerminalRefusal } from './task-review-terminal.mjs'
import { verifyExistingTaskPreview, verifyPreviewRefusal } from './task-review-preview.mjs'
import { ownedPublicationCleanupScript } from './coding-workspace-native.mjs'
import { attestCodingWorkspace, readWorkspaceReviewOptions } from './coding-workspace-ci.mjs'

const ORIGIN = 'https://app.aspectlylabs.com', REPOSITORY = 'alexj11324/Mikka-handoff'
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/, SHA = /^[a-f0-9]{40}$/
const ENDED = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const FACTORY_STAGES = new Set(['clarify', 'spec', 'execute', 'review', 'verify', 'approval', 'publish', 'monitor'])
const FACTORY_STATUSES = new Set(['pending', 'running', 'waiting', 'passed', 'failed', 'blocked', 'cancelled', 'revoked', 'completed', 'succeeded'])
const CODES = new Set(['guard', 'version', 'identity', 'workspace', 'owner_busy', 'profiles_busy', 'model', 'github', 'response',
  'profile', 'bot', 'issue', 'dispatch', 'dispatch_uncertain', 'coordinator_ended', 'factory', 'attempt_budget', 'run', 'candidate',
  'machine', 'terminal', 'preview', 'cleanup', 'checkpoint', 'interrupted', 'timeout', 'journal', 'publication'])
const failure = error => ({ code: CODES.has(error?.code) ? `workspace_review_${error.code}` : 'workspace_review_failed' })
const fail = (code, cause) => { throw Object.assign(new Error(`workspace_review_${code}`, cause ? { cause } : undefined), { code }) }
const check = (condition, code) => { if (!condition) fail(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const profileName = record => `测试1723/1724 ${record.caseId} ${record.harness}`
const title = record => `测试 Coding Workspace ${record.caseId} ${record.harness}`

export function codingFixture(caseId, harness) {
  check(UUID.test(caseId ?? '') && CASES.some(item => item.harness === harness), 'issue')
  const filePath = `docs/coding-workspace/acceptance-${caseId}.txt`
  const contents = `Mikka Coding Workspace acceptance #1723 #1724\nCase: ${caseId}\nHarness: ${harness}\n`
  const instructions = `Repository: ${REPOSITORY}. Create only ${filePath} as UTF-8 text with a final newline. Exact contents:\n${contents}\n`
    + 'Acceptance criteria: The one new file has exactly these bytes, including its final newline. No other repository file changes. '
    + 'Run a small Node or shell assertion that reads these exact bytes, and every applicable existing repository verification command; report actual commands and exit status. '
    + 'Follow the injected Mikka delivery instructions, keep the assigned branch, commit, push to the assigned task branch and open the task PR with the existing native GitHub credential. '
    + 'Keep the required Mikka issue marker at the end of the PR body. Observe the actual checks on this exact commit; an empty or pending check list is not a pass. '
    + 'Use the normal submit tool after verification, leave the PR open for human review, and do not merge, modify repository settings or use any external messaging API. '
    + 'Do not start a development server; the human will test the completed run through its owner terminal.'
  const profileInstructions = `Perform the assigned Factory stage on ${REPOSITORY}. Implement only the requested tiny file, without unrelated work or subagents. `
    + `For independent review, inspect_artifact must observe ${filePath} with its exact expectedUtf8 contents and final newline. `
    + 'Use inspect_repository with the producer report sourceCommit to verify that the fixed candidate adds exactly that one file. '
    + 'A narrative, current working tree or missing/truncated observations cannot pass the criterion. Keep review read-only and report actual evidence.'
  return { filePath, fileSha256: hash(contents), contents, instructions, profileInstructions }
}

/** An intent is durable before the write. A timeout has unknown side effects,
 * even when no response ID was received; it never becomes "nothing created".
 */
export async function journalMutation(record, kind, operation, capture, checkpoint) {
  const intent = { id: randomUUID(), kind, state: 'requested', startedAt: new Date().toISOString() }
  record.intents ??= []; record.intents.push(intent); await checkpoint()
  try {
    const result = await operation()
    capture(result)
    intent.state = 'responded'; intent.finishedAt = new Date().toISOString()
    await checkpoint(); return result
  } catch (cause) {
    intent.state = 'uncertain'; intent.finishedAt = new Date().toISOString()
    await checkpoint(); throw cause
  }
}

export async function writeWorkspaceCheckpoint(path, report) {
  const directory = dirname(path), temporary = `${path}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}

/** Push wakes a finite authoritative read. A failed socket is not replaced by
 * a timer/status loop; all losing waits are cancelled after each wake-up.
 */
export async function waitForWorkspaceChange(channels, read, ready, deadline, { now = Date.now, signal } = {}) {
  for (;;) {
    check(!signal?.aborted, 'interrupted'); check(now() < deadline, 'timeout')
    const revisions = channels.map(channel => channel.revision)
    const value = await read()
    if (ready(value)) return value
    const waiting = new AbortController()
    try {
      await Promise.race(channels.map((channel, index) => channel.wait(revisions[index], deadline,
        AbortSignal.any([waiting.signal, ...(signal ? [signal] : [])]))))
    } finally { waiting.abort() }
  }
}

export function assertReviewCandidate(state, record) {
  check(state?.task?.id === record.factoryTaskId && state.task.issueId === record.issueId && state.task.botId === record.botId
    && state.liveWorkspaceId === record.workspaceId && UUID.test(state.task.sourceEventId ?? ''), 'factory')
  const flowVersion = state.task.route?.flowVersion === 2 ? 2 : 1
  try { assertAttemptBudget(state.attempts ?? [], flowVersion) } catch (cause) { fail('attempt_budget', cause) }
  check(!['failed', 'blocked', 'cancelled', 'revoked'].includes(state.task.status), 'factory')
  if (state.task.stage !== 'approval' || !['pending', 'waiting'].includes(state.task.status)) return null
  const candidate = state.candidates?.find(item => item.id === state.task.candidateId)
  check(candidate && UUID.test(candidate.id ?? '') && UUID.test(candidate.runId ?? '') && SHA.test(candidate.sha ?? ''), 'candidate')
  const stages = flowVersion === 2 ? ['execute', 'review'] : ['execute', 'review', 'verify']
  const attempts = stages.map(stage => state.attempts.find(item => item.stage === stage && item.candidateId === candidate.id))
  check(attempts.every(item => item && UUID.test(item.runId ?? '') && item.status === 'passed'
    && item.output?.requestEpoch === state.task.sourceEventId) && attempts[0].runId === candidate.runId, 'candidate')
  check(state.delivery?.pullRequest?.state === 'open', 'publication')
  const number = /^https:\/\/github\.com\/alexj11324\/Mikka-handoff\/pull\/([1-9][0-9]*)$/.exec(state.delivery.pullRequest.url ?? '')?.[1]
  check(number && Number.isSafeInteger(Number(number)), 'publication')
  return { candidate, attempts, flowVersion, prNumber: Number(number) }
}

async function quietAccount(client, workspaceId) {
  const [threads, tasks, keys, profiles, order, github] = await Promise.all([
    client.rpc('task-runs.pollThreads', []), client.rpc('task-runs.pollTaskRuns', []),
    client.json(`/api/settings/api-keys?workspace=${workspaceId}`),
    client.json(`/api/factory/agent-profiles?workspaceId=${workspaceId}&location=cloud`),
    client.rpc('model-order.getModelOrder', [workspaceId]), client.json('/api/integrations/github'),
  ])
  check(Array.isArray(threads?.items) && Array.isArray(tasks?.items), 'response')
  check([...threads.items, ...tasks.items].every(item => ENDED.has(item.status)), 'owner_busy')
  check(keys.apiKeyAfterQuota === false && order.cloudReady === true, 'model')
  check(Array.isArray(profiles.profiles) && !profiles.profiles.some(item => item.enabled && !item.archivedAt), 'profiles_busy')
  check(github.connected === true && github.repositories?.some(item => item.fullName === REPOSITORY), 'github')
  return { order, github, visibleRunRows: threads.items.length + tasks.items.length }
}

export async function cleanupWorkspaceCase(client, record, scope, { checkpoint, cleanup = cleanupCase, now = Date.now,
  WebSocketImpl = globalThis.WebSocket } = {}) {
  const result = { status: 'running', errors: [], retained: [] }
  record.productCleanup = result; await checkpoint()
  const step = async (name, action) => {
    try { await action(); result[name] = true; await checkpoint(); return true }
    catch (cause) { result.errors.push({ step: name, ...failure(cause) }); await checkpoint(); return false }
  }
  if (record.botId) await step('botStopped', async () => {
    const bot = await client.json(`/api/bots/${record.botId}`)
    check(bot.id === record.botId && bot.name === profileName(record), 'bot')
    await client.rpc('coordinator.stopCoordinatorTurn', [record.botId])
  })
  let issueOwned = false
  if (record.issueId) {
    issueOwned = await step('issueScopeVerified', async () => {
      const { issue } = await client.rpc('issues.getIssue', [record.issueId])
      check(issue?.id === record.issueId && issue.userId === scope.ownerId && issue.workspaceId === scope.workspaceId
        && issue.title === title(record) && issue.ownershipState === 'bound', 'issue')
    })
    if (issueOwned && (!record.botId || result.botStopped)) await step('runsAndMachinesEnded', async () => {
      await cleanup(client, record, 'cloud', { preserveIssue: true, timeoutMs: 60000, now, WebSocketImpl })
      check(record.cleanup?.status === 'passed', 'cleanup')
    })
    const uncertain = record.intents?.some(item => item.state !== 'responded')
    const remoteComplete = !record.dispatched && !uncertain || record.remoteCleanup?.status === 'passed'
    if (issueOwned && result.runsAndMachinesEnded && remoteComplete && !uncertain) await step('issueDeleted', async () => {
      const { issue } = await client.rpc('issues.getIssue', [record.issueId])
      check(issue?.id === record.issueId && issue.userId === scope.ownerId && issue.workspaceId === scope.workspaceId
        && issue.title === title(record), 'issue')
      const deleted = await client.rpc('issue-operations.setIssueDeleted', [{ id: issue.id, revision: issue.revision }])
      check(deleted.issue?.id === issue.id && typeof deleted.issue.metadata?.deletedAt === 'string', 'cleanup')
    })
    else result.retained.push('issue_for_exact_recovery')
  }
  if (record.profileId) await step('profileArchived', async () => {
    const path = `/api/factory/agent-profiles/${record.profileId}`
    const { profile } = await client.json(`${path}?workspaceId=${scope.workspaceId}`)
    check(profile?.id === record.profileId && profile.name === profileName(record) && profile.harness === record.harness, 'profile')
    if (profile.archivedAt) return
    check(profile.version === record.profileVersion, 'profile')
    const archived = await client.json(path, { ...post({ workspaceId: scope.workspaceId, version: profile.version }), method: 'DELETE' })
    check(archived.profile?.id === profile.id && !!archived.profile.archivedAt && archived.profile.enabled === false, 'cleanup')
  })
  if (record.intents?.some(item => item.state !== 'responded')) result.retained.push('write_response_or_checkpoint_uncertain')
  if (record.dispatched && record.remoteCleanup?.status !== 'passed') result.retained.push('native_publication_unconfirmed')
  if (record.botId) result.botRetention = 'owned_idle_bot_no_delete_api'
  result.status = result.errors.length || result.retained.length ? 'unconfirmed' : 'passed'
  await checkpoint(); return result
}

export function createWorkspaceReviewIssue(client, scope, record, fixture) {
  return client.rpc('issues.saveIssue', [{ title: title(record),
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: fixture.instructions }] }] },
    status: 'todo', priority: 'low' }], { headers: { 'x-mikka-workspace-id': scope.workspaceId } })
}

async function executeCase(client, record, scope, profile, options, { checkpoint, pin, live = openLive,
  terminal = verifyExistingTaskTerminal, preview = verifyExistingTaskPreview, now = Date.now, signal } = {}) {
  const fixture = codingFixture(record.caseId, record.harness), channels = []
  const owned = { ...scope, botId: record.botId }
  const write = (kind, operation, capture) => journalMutation(record, kind, operation, capture, checkpoint)
  const phase = async value => { record.phase = value; await checkpoint(); check(!signal?.aborted, 'interrupted'); await pin() }
  try {
    await phase('issue_create')
    const created = await write('issue_create', () => createWorkspaceReviewIssue(client, scope, record, fixture), value => {
      check(UUID.test(value?.issue?.id ?? ''), 'issue'); record.issueId = value.issue.id
    })
    const issue = created.issue
    check(issue?.id === record.issueId && issue.workspaceId === scope.workspaceId && issue.ownershipState === 'bound'
      && issue.scope === 'workspace' && issue.userId === scope.ownerId && /^[A-Za-z][A-Za-z0-9-]*-[1-9][0-9]*$/.test(issue.identifier ?? ''), 'issue')
    record.identifier = issue.identifier; record.branch = 'mikka/' + issue.identifier.toLowerCase()
    record.filePath = fixture.filePath; record.fileSha256 = fixture.fileSha256; await checkpoint()
    const initial = await client.json(`/api/factory/tasks?issueId=${record.issueId}`)
    check(initial.issueId === record.issueId && initial.tasks?.length === 0 && initial.liveWorkspaceId === scope.workspaceId, 'issue')
    const chat = (await client.rpc('coordinator.syncCoordinatorChat', [record.botId])).chat
    check(chat?.botId === record.botId && chat.live?.ownerId === scope.ownerId && UUID.test(chat.live.workspaceId ?? '')
      && Number.isSafeInteger(chat.cursor) && chat.working === false, 'bot')
    for (const workspaceId of new Set([scope.workspaceId, chat.live.workspaceId])) channels.push(await live(path => client.json(path), workspaceId))
    await phase('dispatch')
    record.submissionId = randomUUID()
    const message = `Execute existing task ${issue.identifier} (issueId ${issue.id}) now in ${REPOSITORY}. Read the exact existing description, do not create another task. `
      + `Use normal dispatch_run with repo ${REPOSITORY}, target cloud, model harness ${record.harness}, selected Profile ${profile.id}, needsSpec false. `
      + 'Follow the task criteria and injected delivery instructions, submit the tested candidate and leave the task PR open for human review. Do not merge.'
    // Preserve the public RPC's undefined sentinel, including the distinct
    // existing-issue message contract (no task-dialog destination override).
    const undefinedWire = { $mikka: 'undefined' }
    const dispatched = await write('dispatch', () => client.rpc('coordinator.sendCoordinatorMessage',
      [message, null, record.botId, record.submissionId, undefinedWire, null, [], undefinedWire, profile.id]), value => {
      check(value?.queued === true, 'dispatch_uncertain'); record.dispatched = true
    })
    check(dispatched.queued === true, 'dispatch')
    const deadline = now() + options.timeoutMs
    const readDispatch = async () => {
      const found = await client.json(`/api/factory/tasks?issueId=${record.issueId}`)
      check(found.issueId === record.issueId && Array.isArray(found.tasks) && found.tasks.length <= 1, 'factory')
      if (found.tasks.length) return found
      const current = (await client.rpc('coordinator.syncCoordinatorChat', [record.botId])).chat
      check(current?.botId === record.botId && current.live?.ownerId === scope.ownerId
        && current.live.workspaceId === chat.live.workspaceId, 'bot')
      if (current.working === false && current.items?.some(item => item.from === 'person' && item.position > chat.cursor && item.text === message)) {
        const final = await client.json(`/api/factory/tasks?issueId=${record.issueId}`)
        check(final.tasks?.length === 1, 'coordinator_ended'); return final
      }
      return found
    }
    const found = await waitForWorkspaceChange(channels, readDispatch, value => value.tasks.length === 1, deadline, { now, signal })
    check(UUID.test(found.tasks[0].id ?? '') && found.tasks[0].issueId === record.issueId, 'factory')
    record.factoryTaskId = found.tasks[0].id; await checkpoint()
    await phase('factory_review')
    const state = await waitForWorkspaceChange(channels, async () => {
      const value = await client.json(`/api/factory/tasks/${record.factoryTaskId}`)
      check(value.task?.id === record.factoryTaskId && value.task.issueId === record.issueId
        && value.task.botId === record.botId && value.liveWorkspaceId === scope.workspaceId
        && FACTORY_STAGES.has(value.task.stage) && FACTORY_STATUSES.has(value.task.status), 'factory')
      record.runIds = [...new Set([...(record.runIds ?? []), ...(value.attempts ?? []).map(item => item.runId).filter(id => UUID.test(id ?? ''))])]
      // Even a failed candidate may have created a PR: preserve its exact ID
      // before any later validation or failure cleanup, never invent ownership.
      const number = /^https:\/\/github\.com\/alexj11324\/Mikka-handoff\/pull\/([1-9][0-9]*)$/.exec(value.delivery?.pullRequest?.url ?? '')?.[1]
      if (number && Number.isSafeInteger(Number(number))) record.prNumber = Number(number)
      const candidate = value.candidates?.find(item => item.id === value.task.candidateId)
      if (candidate && SHA.test(candidate.sha ?? '') && UUID.test(candidate.runId ?? '')) {
        record.candidateSha = candidate.sha; record.runId = candidate.runId
      }
      record.lastState = { stage: value.task.stage, status: value.task.status }
      await checkpoint(); return value
    }, value => assertReviewCandidate(value, record) !== null, deadline, { now, signal })
    const verified = assertReviewCandidate(state, record), candidate = verified.candidate
    record.runId = candidate.runId; record.candidateSha = candidate.sha; record.prNumber = verified.prNumber
    record.flowVersion = verified.flowVersion; await checkpoint()
    await phase('provenance')
    record.runs = []
    for (const attempt of verified.attempts) {
      const evidence = await client.json(`/api/runs/${attempt.runId}/evidence`)
      check(evidence.run?.status === 'succeeded' && evidence.run.id === attempt.runId && evidence.run.issueId === record.issueId, 'run')
      const proof = { issueId: record.issueId, runId: attempt.runId, harness: record.harness, profileId: profile.id, placement: { kind: 'cloud' } }
      await subscriptionProof(client, proof, owned, profile, { profileSource: attempt.stage === 'execute' ? 'explicit' : 'decision' })
      record.runs.push({ runId: attempt.runId, stage: attempt.stage, status: 'succeeded', execution: proof.execution }); await checkpoint()
    }
    const artifact = await client.json(`/api/factory/tasks/${record.factoryTaskId}/approval?artifact=${encodeURIComponent(`run-report:${record.runId}`)}`)
    const raw = artifact.raw, publish = raw?.publish
    check(SHA.test(raw?.sourceCommit ?? '') && publish?.pushed === true && publish.remote === 'origin'
      && publish.branch === record.branch && publish.commit === candidate.sha && raw.verify?.status === 'passed' && raw.verify.exitCode === 0, 'publication')
    record.baseCommit = raw.sourceCommit; record.producerReportSha256 = hash(JSON.stringify(raw)); await checkpoint()
    const machine = await client.rpc('agents.getThreadMachine', [record.issueId, record.runId])
    check(machine?.kind === 'cloud' && ['paused', 'running'].includes(machine.state) && machine.cloud?.endedAt === null
      && /^[A-Za-z0-9_-]{1,128}$/.test(machine.cloud.sandboxId ?? '') && machine.cloud.template === options.templates[record.harness], 'machine')
    record.machine = { state: machine.state, template: machine.cloud.template, sandboxIdHash: hash(machine.cloud.sandboxId).slice(0, 16) }
    await checkpoint()
    const controls = { client, taskId: record.issueId, runId: record.runId, workspaceId: scope.workspaceId, ownerId: scope.ownerId,
      expectedBuild: options.sourceCommit, signal }
    await phase('terminal')
    record.terminal = await terminal({ ...controls, otherWorkspaceId: scope.otherWorkspaceId })
    await checkpoint(); check(record.terminal.status === 'passed_for_requested_scope', 'terminal')
    if (scope.otherWorkspaceId) record.previewOtherWorkspace = await verifyPreviewRefusal({ client, taskId: record.issueId,
      status: 403, code: 'review_scope_denied', workspaceId: scope.otherWorkspaceId })
    await phase('preview')
    record.preview = await preview({ ...controls, fixtureId: record.caseId, harness: record.harness, sandboxId: machine.cloud.sandboxId,
      workerSha: options.workerSha, workerSourceCommit: options.workerSourceCommit,
      beforeEnd: async terminalControls => {
        record.remoteCleanup = { status: 'requested', prNumber: record.prNumber, candidateSha: record.candidateSha }
        await checkpoint()
        await terminalControls.run(ownedPublicationCleanupScript({ repository: REPOSITORY, issueId: record.issueId,
          branch: record.branch, candidateSha: record.candidateSha, baseCommit: record.baseCommit, prNumber: record.prNumber,
          filePath: fixture.filePath, fileSha256: fixture.fileSha256, createdAfter: record.createdAt }), { timeoutMs: 90000 })
        record.remoteCleanup = { status: 'passed', prNumber: record.prNumber, candidateSha: record.candidateSha,
          prClosed: true, branchDeleted: true, defaultBranchUnchanged: true }
        await checkpoint(); return record.remoteCleanup
      } })
    await checkpoint(); check(record.preview.status === 'passed_for_requested_scope', 'preview')
    await phase('verified'); record.status = 'passed_for_requested_scope'
  } finally { for (const channel of channels) channel.close() }
}

export async function runCodingWorkspace(options, { env = process.env, fetchImpl = fetch, now = Date.now, signal,
  attest = attestCodingWorkspace, clientFactory = createSessionClient, execute = executeCase,
  cleanup = cleanupWorkspaceCase, writeCheckpoint = writeWorkspaceCheckpoint, selectTeam = selectAcceptanceTeam,
  quiet = quietAccount, chooseModel = chooseSharedChatModel } = {}) {
  const report = { version: 1, kind: 'coding-workspace-product-acceptance', issues: [1723, 1724], fixtureId: randomUUID(),
    driver: options.driver, sourceCommit: options.sourceCommit, origin: ORIGIN, repository: REPOSITORY,
    startedAt: new Date(now()).toISOString(), status: 'running', cases: [], cleanup: { errors: [] },
    limitations: ['local_machine_terminal_not_implemented', 'same_task_two_actor_sessions_not_run', 'observed_attempt_budget_not_hard_model_call_or_dollar_cap'] }
  const checkpoint = () => writeCheckpoint(options.reportPath, report)
  let client, scope, loggedIn = false, originalWorkspaceId, ownerId
  const phase = async name => { report.phase = name; await checkpoint(); check(!signal?.aborted, 'interrupted') }
  const pin = async () => check((await client.json('/api/version')).build === options.sourceCommit, 'version')
  try {
    check(!options.cleanupOnly, 'guard')
    await phase('attestation'); report.attestation = await attest(env)
    check(report.attestation?.sourceCommit === options.sourceCommit && report.attestation.workerSha === options.workerSha
      && report.attestation.workerSourceCommit === options.workerSourceCommit
      && CASES.every(item => report.attestation.templates?.[item.harness] === options.templates[item.harness]), 'guard')
    await checkpoint()
    const account = smokeAcceptanceAccount(env)
    client = clientFactory(ORIGIN, fetchImpl)
    await phase('sign_in'); await pin()
    const response = await client.request('/api/auth/sign-in/email', post({ ...account, rememberMe: false }))
    check(response.ok, 'identity'); loggedIn = true; await response.body?.cancel()
    const identity = await client.json('/api/auth/get-session')
    check(identity.user?.email?.toLowerCase() === account.email.toLowerCase() && typeof identity.user.id === 'string', 'identity')
    ownerId = identity.user.id; report.ownerHash = hash(ownerId).slice(0, 16)
    scope = await selectTeam(client, { ownerId }, value => { originalWorkspaceId = value })
    report.workspaceId = scope.workspaceId; report.team = scope.evidence; await checkpoint()
    const selected = await client.json('/api/workspace')
    scope.otherWorkspaceId = selected.choices?.find(choice => UUID.test(choice.id ?? '') && choice.id !== scope.workspaceId)?.id
    if (!scope.otherWorkspaceId) report.limitations.push('no_existing_second_workspace_fixture')
    await phase('preflight')
    const preflight = await quiet(client, scope.workspaceId)
    check(preflight.github.viewerId === ownerId, 'github')
    report.visibleOwnerRunRows = preflight.visibleRunRows
    const candidates = new Map()
    for (const item of CASES) {
      const matches = preflight.order.candidates?.filter(candidate => candidate.harness === item.harness && candidate.model === item.model
        && candidate.source?.kind === 'subscription' && UUID.test(candidate.source.connectionId ?? '') && candidate.credentialOwnerId === scope.adminId) ?? []
      if (matches.length === 1) candidates.set(item.harness, matches[0])
    }
    const visible = await client.rpc('issues.listWorkspaceIssues', [scope.workspaceId])
    check(Array.isArray(visible), 'response')
    const peer = visible.find(issue => {
      const responsible = issue.metadata?.assignee?.kind === 'member' ? issue.metadata.assignee.id : issue.ownerId ?? issue.userId
      return UUID.test(issue.id ?? '') && typeof responsible === 'string' && responsible !== ownerId
    })
    if (peer) {
      report.nonOwner = { taskId: peer.id, terminal: [] }
      for (const method of ['GET', 'POST']) report.nonOwner.terminal.push(await verifyTerminalRefusal({ client, taskId: peer.id,
        status: 403, codes: ['not_owner_terminal'], method }))
      report.nonOwner.preview = await verifyPreviewRefusal({ client, taskId: peer.id, status: 403, code: 'not_owner_terminal' })
    } else report.limitations.push('no_existing_visible_non_owner_task_fixture')
    for (const definition of CASES) {
      await phase('case_prepare'); await pin()
      // The previous profile is archived before another model can be selected.
      await quiet(client, scope.workspaceId)
      const record = { caseId: randomUUID(), harness: definition.harness, model: definition.model, status: 'running',
        workspaceId: scope.workspaceId, createdAt: now(), intents: [], runIds: [] }
      report.cases.push(record); await checkpoint()
      try {
        const specification = codingFixture(record.caseId, record.harness), candidate = candidates.get(record.harness)
        check(candidate, 'model')
        const profileResponse = await journalMutation(record, 'profile_create', () => client.json('/api/factory/agent-profiles', post({
          workspaceId: scope.workspaceId, requestId: randomUUID(), profile: { name: profileName(record), description: 'Temporary Coding Workspace product acceptance',
            enabled: true, harness: record.harness, model: { mode: 'fixed', harness: record.harness, model: record.model, source: candidate.source },
            effort: 'low', roles: ['execute', 'review', 'verify'], skills: [], instructions: specification.profileInstructions } })), value => {
          check(UUID.test(value?.profile?.id ?? ''), 'profile'); record.profileId = value.profile.id
          if (Number.isSafeInteger(value?.profile?.version)) record.profileVersion = value.profile.version
          check(record.profileVersion > 0, 'profile')
        }, checkpoint)
        const profile = profileResponse.profile
        check(profile?.id === record.profileId && profile.version > 0 && /^[a-f0-9]{64}$/.test(profile.digest ?? '')
          && profile.harness === record.harness && profile.model?.model === record.model && profile.model.mode === 'fixed'
          && profile.model.source?.kind === 'subscription' && profile.model.source.connectionId === candidate.source.connectionId, 'profile')
        const bot = await journalMutation(record, 'bot_create', () => client.rpc('bots.createBot', [{ name: profileName(record),
          color: 'gris', shape: 'cercle', repository: `v2/github.com/${REPOSITORY.toLowerCase()}`, model: null }]),
        value => { check(UUID.test(value?.id ?? ''), 'bot'); record.botId = value.id }, checkpoint)
        check(bot?.id === record.botId && bot.name === profileName(record), 'bot')
        await chooseModel(client, record.botId, record.harness)
        await execute(client, record, scope, profile, options, { checkpoint, pin, now, signal })
      } catch (cause) { record.status = 'failed'; record.failure = failure(cause); await checkpoint() }
      finally { await cleanup(client, record, scope, { checkpoint, now }) }
      // Failure/unknown cleanup never launches a replacement case or VM.
      check(record.productCleanup?.status === 'passed', 'cleanup')
      if (record.status !== 'passed_for_requested_scope') report.failedCase = true
    }
    await pin()
    report.status = report.failedCase || report.cases.some(record => record.status !== 'passed_for_requested_scope') ? 'failed'
      : report.limitations.some(value => value.startsWith('no_existing_')) ? 'incomplete' : 'passed_for_requested_scope'
  } catch (cause) { report.status = 'failed'; report.failure = failure(cause) }
  finally {
    if (loggedIn) {
      if (originalWorkspaceId && ownerId) {
        try { await restoreAcceptanceWorkspace(client, ownerId, originalWorkspaceId); report.cleanup.workspaceRestored = true }
        catch (cause) { report.cleanup.errors.push({ step: 'workspace_restore', ...failure(cause) }) }
      }
      try {
        const response = await client.request('/api/auth/sign-out', post({}))
        check(response.ok, 'cleanup'); await response.body?.cancel(); report.cleanup.signedOut = true
      } catch (cause) { report.cleanup.errors.push({ step: 'sign_out', ...failure(cause) }) }
    }
    client?.clear()
    if (report.cleanup.errors.length) report.status = 'failed'
    report.finishedAt = new Date(now()).toISOString(); await checkpoint()
  }
  return report
}

/** Runner cancellation recovery reads only this invocation's exact journal.
 * It does not create a task, retry a model, infer lost IDs or scan other data.
 * A changed deployment may still clean its own resources through normal ACLs.
 */
export async function cleanupCodingWorkspace(options, { env = process.env, fetchImpl = fetch, writeCheckpoint = writeWorkspaceCheckpoint } = {}) {
  let info
  try { info = await lstat(options.reportPath) } catch (cause) {
    if (cause?.code === 'ENOENT') return { status: 'not_started', noJournal: true }
    throw cause
  }
  check(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024, 'journal')
  const report = JSON.parse(await readFile(options.reportPath, 'utf8'))
  check(report?.version === 1 && report.kind === 'coding-workspace-product-acceptance' && report.sourceCommit === options.sourceCommit
    && report.driver?.runId === options.driver.runId && report.driver.runAttempt === options.driver.runAttempt
    && UUID.test(report.fixtureId ?? '') && Array.isArray(report.cases) && report.cases.length <= 2, 'journal')
  if (!report.cases.length || report.cases.every(record => record.productCleanup?.status === 'passed'))
    return { status: 'already_cleaned', cases: report.cases.length }
  check(UUID.test(report.workspaceId ?? '') && /^[a-f0-9]{16}$/.test(report.ownerHash ?? ''), 'journal')
  for (const record of report.cases) check(UUID.test(record.caseId ?? '') && CASES.some(item => item.harness === record.harness && item.model === record.model)
    && record.workspaceId === report.workspaceId && ['issueId', 'botId', 'profileId', 'runId', 'factoryTaskId'].every(key => !record[key] || UUID.test(record[key])), 'journal')
  const client = createSessionClient(ORIGIN, fetchImpl), account = smokeAcceptanceAccount(env)
  let loggedIn = false, ownerId, originalWorkspaceId
  const checkpoint = () => writeCheckpoint(options.reportPath, report)
  report.recovery = { status: 'running', errors: [] }; await checkpoint()
  try {
    const response = await client.request('/api/auth/sign-in/email', post({ ...account, rememberMe: false }))
    check(response.ok, 'identity'); loggedIn = true; await response.body?.cancel()
    const identity = await client.json('/api/auth/get-session'); ownerId = identity.user?.id
    check(typeof ownerId === 'string' && hash(ownerId).slice(0, 16) === report.ownerHash
      && identity.user.email?.toLowerCase() === account.email.toLowerCase(), 'identity')
    const scope = await selectAcceptanceTeam(client, { ownerId, workspace: report.workspaceId }, value => { originalWorkspaceId = value })
    for (const record of report.cases) if (record.productCleanup?.status !== 'passed')
      await cleanupWorkspaceCase(client, record, scope, { checkpoint })
    report.recovery.status = report.cases.every(record => record.productCleanup?.status === 'passed') ? 'passed' : 'unconfirmed'
  } catch (cause) { report.recovery.status = 'unconfirmed'; report.recovery.errors.push(failure(cause)) }
  finally {
    if (loggedIn) {
      try { if (ownerId && originalWorkspaceId) await restoreAcceptanceWorkspace(client, ownerId, originalWorkspaceId) }
      catch (cause) { report.recovery.errors.push({ step: 'workspace_restore', ...failure(cause) }) }
      try { const response = await client.request('/api/auth/sign-out', post({})); check(response.ok, 'cleanup'); await response.body?.cancel() }
      catch (cause) { report.recovery.errors.push({ step: 'sign_out', ...failure(cause) }) }
    }
    client.clear()
    if (report.recovery.errors.length) report.recovery.status = 'unconfirmed'
    await checkpoint()
  }
  return report.recovery
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const abort = new AbortController(), stop = () => abort.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const options = readWorkspaceReviewOptions(process.argv.slice(2))
    const report = options.cleanupOnly ? await cleanupCodingWorkspace(options) : await runCodingWorkspace(options, { signal: abort.signal })
    console.log(JSON.stringify({ kind: 'coding-workspace-product-acceptance', status: report.status, ...(report.failure ? { failure: report.failure } : {}) }))
    if (!['passed_for_requested_scope', 'already_cleaned', 'not_started', 'passed'].includes(report.status)) process.exitCode = 1
  } catch (cause) { console.error(JSON.stringify({ kind: 'coding-workspace-product-acceptance', status: 'failed', ...failure(cause) })); process.exitCode = 1 }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) }
}
