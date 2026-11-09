import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import * as delivery from './delivery.mjs'

const environment = {
  MIKKA_EXPECTED_DEPLOYMENT_SHA: '1'.repeat(40),
  MIKKA_1503_RUN_MARKER: 'offline-regression',
  MIKKA_1503_SUBMISSION_MODE: 'explicit_new_task',
}

test('explicit new task can run both required official subscriptions sequentially', () => {
  const configured = delivery.deliveryConfiguration(environment)
  assert.equal(configured.submissionMode, 'explicit_new_task')
  assert.deepEqual(configured.cases.map(({ harness, model, source }) => ({ harness, model, source })), [
    { harness: 'claude_code', model: 'claude-haiku-5-5', source: { kind: 'subscription', connectionId: '93b6ab23-900b-4e18-9ea0-baccf2d104ce' } },
    { harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: 'ef66c1d8-2bbc-48e9-abf3-2ce3787ceef5' } },
  ])
  assert.equal(new Set(configured.specifications.map(item => item.path)).size, 2)
  for (const specification of configured.specifications) {
    const command = delivery.repositoryVerifyCommand(configured.specifications, specification.path)
    assert.ok(command.length <= 2000)
    assert.ok(command.includes(specification.path))
  }
})

test('explicit new task retains optional single-harness selection and strict deployment pin', () => {
  for (const harness of ['claude_code', 'codex']) {
    const configured = delivery.deliveryConfiguration({ ...environment, MIKKA_1503_HARNESS: harness })
    assert.deepEqual(configured.cases.map(item => item.harness), [harness])
    assert.equal(configured.specifications.length, 1)
  }
  for (const changed of [
    { MIKKA_EXPECTED_DEPLOYMENT_SHA: 'main' },
    { MIKKA_1503_HARNESS: 'other' },
    { MIKKA_1503_SUBMISSION_MODE: 'other' },
    { MIKKA_1503_CLAUDE_CONNECTION_ID: 'other' },
  ]) assert.throws(() => delivery.deliveryConfiguration({ ...environment, ...changed }), /^Error: issue1503_/)
})

test('the optional permission round requires Codex and leaves the default flow disabled', () => {
  assert.equal(delivery.deliveryConfiguration(environment).codexQuestion, false)
  assert.equal(delivery.deliveryConfiguration({ ...environment, MIKKA_1503_CODEX_QUESTION: '0' }).codexQuestion, false)
  assert.equal(delivery.deliveryConfiguration({ ...environment, MIKKA_1503_CODEX_QUESTION: '1' }).codexQuestion, true)
  assert.equal(delivery.deliveryConfiguration({ ...environment, MIKKA_1503_HARNESS: 'codex', MIKKA_1503_CODEX_QUESTION: '1' }).codexQuestion, true)
  for (const changed of [
    { MIKKA_1503_HARNESS: 'claude_code', MIKKA_1503_CODEX_QUESTION: '1' },
    { MIKKA_1503_CODEX_QUESTION: 'yes' },
  ]) assert.throws(() => delivery.deliveryConfiguration({ ...environment, ...changed }), /^Error: issue1503_delivery_configuration_required$/)
})

const runId = '10000000-0000-4000-8000-000000000001'
const attemptId = '10000000-0000-4000-8000-000000000002'
const candidateId = '10000000-0000-4000-8000-000000000003'
const candidateSha = '2'.repeat(40)
const sourceCommit = '3'.repeat(40)
const filePath = 'docs/issue-1503/offline-regression-claude_code.txt'
const scopeText = 'Only that file is added and no other file is edited'
const scopeObservation = () => ({ path: '.', repository: 'alexj11324/mikka-handoff', head: candidateSha,
  comparison: { baseCommit: sourceCommit, head: candidateSha, truncated: false, changes: [{ status: 'A', path: filePath }] },
  status: { dirty: false, truncated: false, porcelain: '' }, entries: [{ name: 'docs', kind: 'directory' }], truncated: false })
const reviewThread = output => ({ thread: { id: runId, latestRunId: runId, status: 'succeeded' }, chunkCursor: { chain: runId }, chunks: [
  { chunk: { type: 'tool-input-available', toolName: 'mcp__mikka__inspect_repository', toolCallId: 'scope-1', input: { path: '.', baseCommit: sourceCommit } } },
  { chunk: { type: 'tool-output-available', toolCallId: 'scope-1', output } },
] })

test('the actual unverified scope criterion cannot pass with an overall passed review or daemon verify', () => {
  const attempt = { id: attemptId, stage: 'review', status: 'passed', candidateId, runId }
  const state = { task: { route: { flowVersion: 2 } }, candidates: [{ id: candidateId, sha: candidateSha }], checks: [
    { attemptId, stage: 'review', status: 'passed', candidateId, candidateSha, runId, verify: { status: 'passed', command: 'node check.js', exitCode: 0 },
      criteria: [
        { text: 'Exact file contents', passed: true, status: 'passed', evidence: 'Observed exact bytes.' },
        { text: 'UTF-8 and final newline', passed: true, status: 'passed', evidence: 'Observed bytes and final newline.' },
        { text: scopeText, passed: false, status: 'unverified', reason: 'This read-only review has no git diff or git status tool; the producing report was not independently verified.' },
        { text: 'Published open PR', passed: true, status: 'passed', evidence: 'Host publication receipt.' },
      ] },
  ] }
  assert.throws(() => delivery.matchedCheckEvidence(state, [attempt]), /^Error: issue1503_verification_criteria_missing$/)
  state.checks[0].criteria[2] = { text: scopeText, passed: true, status: 'passed', evidence: 'inspect_repository observed the exact baseline and fixed head with one added file.' }
  assert.equal(delivery.matchedCheckEvidence(state, [attempt]).length, 1)
})

test('scope proof consumes actual Claude and Codex inspect_repository receipts bound to the producer baseline', () => {
  const observation = scopeObservation()
  for (const output of [JSON.stringify(observation), [{ type: 'text', text: JSON.stringify(observation) }]]) {
    const [evidence] = delivery.reviewRepositoryObservations(reviewThread(output), runId, candidateSha, sourceCommit, filePath)
    assert.equal(evidence.sourceCommit, sourceCommit)
    assert.equal(evidence.candidateSha, candidateSha)
    assert.deepEqual(evidence.changes, [{ status: 'A', path: filePath }])
    assert.equal(evidence.toolCallId, 'scope-1')
    assert.match(evidence.outputSha256, /^[a-f0-9]{64}$/)
  }
})

test('scope proof rejects status-only, truncated, foreign, extra-file and ambiguous tool records', () => {
  for (const mutate of [
    value => { delete value.comparison },
    value => { value.comparison.truncated = true },
    value => { value.comparison.baseCommit = candidateSha },
    value => { value.comparison.head = sourceCommit },
    value => { value.head = sourceCommit },
    value => { value.repository = 'other/repository' },
    value => { value.comparison.changes.push({ status: 'M', path: 'README.md' }) },
    value => { value.comparison.changes[0].path = 'other.txt' },
    value => { value.comparison.changes[0].status = 'M' },
  ]) {
    const value = scopeObservation(); mutate(value)
    assert.throws(() => delivery.reviewRepositoryObservations(reviewThread(JSON.stringify(value)), runId, candidateSha, sourceCommit, filePath), /^Error: issue1503_review_repository_observations_missing$/)
  }
  for (const mutate of [
    value => { value.chunks[0].chunk.input.baseCommit = candidateSha },
    value => { delete value.chunks[0].chunk.input.baseCommit },
    value => { value.chunks[1].chunk.type = 'tool-output-error' },
    value => { value.chunks[1].chunk.output = JSON.stringify(scopeObservation()).slice(-40) },
    value => { value.chunks.push(structuredClone(value.chunks[1])) },
    value => { value.chunks.reverse() },
    value => { value.thread.latestRunId = attemptId },
  ]) {
    const value = reviewThread(JSON.stringify(scopeObservation())); mutate(value)
    assert.throws(() => delivery.reviewRepositoryObservations(value, runId, candidateSha, sourceCommit, filePath), /^Error: issue1503_review_(?:repository_observations_missing|thread_binding_mismatch)$/)
  }
})

test('initial task criteria retain full scope and defer the exact revision until the real human rejection', () => {
  const specification = delivery.fileSpecification('offline-regression', 'claude_code')
  const text = delivery.deliveryTaskText(specification)
  assert.ok(text.includes(specification.initial))
  assert.match(text, /Do not edit any other file/)
  assert.match(text, /Run a small command/)
  assert.match(text, /push HEAD via https:\/\/github\.com\/alexj11324\/Mikka-handoff\.git to the assigned task branch/)
  assert.match(text, /owner's own GitHub credential/)
  assert.match(text, /checks to pass for the pushed commit, and then call the Mikka submit tool/)
  assert.match(text, /Do not merge it yourself/)
  assert.doesNotMatch(text, /host automatically pushes|host-managed submit/)
  const [initialRequirements, laterWorkflow] = text.split('Later workflow instructions:')
  assert.doesNotMatch(initialRequirements, /State to revised|State: revised|If the human requests changes/)
  assert.match(laterWorkflow, /If the human requests changes, update only State to revised/)
  assert.match(laterWorkflow, /not required for the initial candidate; wait for the actual human change request/)
  const instructions = delivery.deliveryProfileInstructions(specification)
  assert.match(instructions, /mikka\.inspect_artifact/)
  assert.match(instructions, /mikka\.inspect_repository/)
  assert.match(instructions, /baseCommit.*producing run report.*sourceCommit/)
  assert.match(instructions, /comparison\.truncated/)
  assert.ok(instructions.includes(specification.path))
})

test('shared native-tool pairing still requires complete committed file bytes', () => {
  const { initial } = delivery.fileSpecification('offline-regression', 'claude_code')
  const hash = createHash('sha256').update(initial).digest('hex')
  const observation = { path: filePath, head: candidateSha, contentUtf8: initial, bytes: Buffer.byteLength(initial),
    sha256: hash, committedSha256: hash, contentMatchesGit: true, textUnavailable: null }
  for (const output of [JSON.stringify(observation), [{ type: 'text', text: JSON.stringify(observation) }]]) {
    const thread = reviewThread(output)
    thread.chunks[0].chunk.toolName = 'mcp__mikka__inspect_artifact'
    thread.chunks[0].chunk.input = { path: filePath, expectedUtf8: initial }
    assert.equal(delivery.reviewArtifactObservations(thread, runId, candidateSha, filePath, initial)[0].sha256, hash)
    assert.throws(() => delivery.reviewArtifactObservations(thread, runId, candidateSha, filePath, initial.slice(0, -1)), /^Error: issue1503_review_artifact_observations_missing$/)
  }
})

test('failure cleanup discovers the exact admitted task once and rejects another bot or run', async () => {
  const workspaceId = '10000000-0000-4000-8000-000000000010'
  const issueId = '10000000-0000-4000-8000-000000000011'
  const botId = '10000000-0000-4000-8000-000000000012'
  const taskId = '10000000-0000-4000-8000-000000000013'
  const item = { issueId, botId, dispatchReceipts: { runIds: [runId] } }
  const state = { liveWorkspaceId: workspaceId, task: { id: taskId, issueId, botId }, attempts: [{ runId, stage: 'execute' }] }
  const calls = []
  const json = async path => {
    calls.push(path)
    return path.includes('?') ? { liveWorkspaceId: workspaceId, tasks: [{ id: taskId }] } : state
  }
  assert.equal(await delivery.discoverExplicitCleanupTask(json, workspaceId, item), state)
  assert.deepEqual(calls, [`/api/factory/tasks?issueId=${issueId}`, `/api/factory/tasks/${taskId}`])
  state.task.botId = attemptId
  await assert.rejects(delivery.discoverExplicitCleanupTask(json, workspaceId, item), /^Error: issue1503_cleanup_task_scope_mismatch$/)
  state.task.botId = botId; state.attempts[0].runId = attemptId
  await assert.rejects(delivery.discoverExplicitCleanupTask(json, workspaceId, item), /^Error: issue1503_cleanup_task_scope_mismatch$/)
})


const publicationIssueId = '00000000-0000-4000-8000-000000000018'
const publicationTaskId = '00000000-0000-4000-8000-000000000019'
const publicationWorkspaceId = '00000000-0000-4000-8000-000000000020'
const publicationBranch = 'mikka/test-18'
const priorPublication = {
  candidateId: '00000000-0000-4000-8000-000000000021',
  candidateSha: '1'.repeat(40),
  pullRequestUrl: 'https://github.com/alexj11324/Mikka-handoff/pull/999999',
}
const publishedCandidate = () => ({
  task: { id: publicationTaskId, stage: 'approval', status: 'pending', candidateId: '00000000-0000-4000-8000-000000000022' },
  candidates: [{ id: '00000000-0000-4000-8000-000000000022', sha: '2'.repeat(40), runId: '00000000-0000-4000-8000-000000000023' }],
  delivery: { candidateSha: '2'.repeat(40), branch: { head: publicationBranch, base: 'main' },
    pullRequest: { state: 'open', url: priorPublication.pullRequestUrl } },
})
const publicationKeys = ['factory_task:' + publicationTaskId, 'factory_issue:' + publicationIssueId, 'issue_threads:' + publicationIssueId, 'pull_request_status:' + publicationIssueId]
const publicationKinds = ['factory_task', 'factory_issue', 'issue_threads']
const nextPublicationTurn = () => new Promise(resolve => setImmediate(resolve))

class PublicationTestSocket {
  static current
  constructor() {
    PublicationTestSocket.current = this
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'live_ready', version: 2, kinds: publicationKinds }) }))
  }
  send() {}
  close() {}
  event(kind, id) { this.onmessage?.({ data: JSON.stringify({ kind, id }) }) }
}

test('publication readiness: pending waits for the same-issue post-commit event without polling', async () => {
  let ticketReads = 0, taskReads = 0, settled = false
  let current = publishedCandidate()
  current.delivery.pullRequest = null
  const live = new delivery.LiveChanges(async path => {
    assert.equal(path, '/api/live/ticket?workspace=' + publicationWorkspaceId)
    ticketReads++
    return { url: 'wss://offline.invalid/live', protocol: 'offline', expiresAt: Date.now() + 60_000 }
  }, publicationWorkspaceId, { Socket: PublicationTestSocket, kinds: publicationKinds })
  try {
    await live.start()
    const waiting = live.until(publicationKeys, async () => { taskReads++; return current },
      state => delivery.approvalPublicationReady(state, publicationBranch, priorPublication), 1_000)
    waiting.then(() => { settled = true }, () => { settled = true })
    await nextPublicationTurn()
    assert.equal(taskReads, 1)
    assert.equal(settled, false)
    assert.equal(live.waiters.size, 1, 'pending publication waits instead of failing proof')
    current = publishedCandidate()
    PublicationTestSocket.current.event('issue_threads', '00000000-0000-4000-8000-000000000099')
    await nextPublicationTurn()
    assert.equal(taskReads, 1, 'another issue cannot cause a business read')
    assert.equal(settled, false)
    PublicationTestSocket.current.event('issue_threads', publicationIssueId)
    assert.equal(await waiting, current)
    assert.equal(taskReads, 2, 'only initial read plus the matching live invalidation')
    assert.equal(ticketReads, 1)
  } finally { live.close() }
})

test('publication readiness: current candidate SHA branch and same PR must all match', () => {
  const cases = [
    state => { state.task.candidateId = priorPublication.candidateId },
    state => { state.candidates[0].sha = priorPublication.candidateSha; state.delivery.candidateSha = priorPublication.candidateSha },
    state => { state.candidates[0].runId = 'not-a-run' },
    state => { state.candidates[0].sha = 'not-a-sha' },
    state => { state.delivery.candidateSha = '3'.repeat(40) },
    state => { state.delivery.branch.head = 'mikka/another-18' },
    state => { state.delivery.branch = null },
    state => { state.delivery.pullRequest.url = priorPublication.pullRequestUrl + '0' },
    state => { state.delivery.pullRequest.url = 'https://github.com/another/repo/pull/999999' },
    state => { state.delivery.pullRequest.state = 'closed' },
    state => { state.delivery.pullRequest.state = 'draft' },
    state => { state.delivery.pullRequest = null },
    state => { state.delivery = null },
    state => { state.task.stage = 'execute' },
    state => { state.task.status = 'cancelled' },
    state => { state.task.status = 'failed' },
    state => { state.task.status = 'blocked' },
    state => { state.task.status = 'revoked' },
    state => {
      state.candidates.push({ id: '00000000-0000-4000-8000-000000000024', sha: '3'.repeat(40), runId: '00000000-0000-4000-8000-000000000025' })
      state.delivery.candidateSha = '3'.repeat(40)
    },
  ]
  for (const mutate of cases) {
    const state = publishedCandidate()
    mutate(state)
    assert.equal(delivery.approvalPublicationReady(state, publicationBranch, priorPublication), false)
  }
})

test('publication readiness: initial and repaired candidates need their own published delivery', () => {
  const state = publishedCandidate()
  assert.equal(delivery.approvalPublicationReady(state, publicationBranch), true)
  assert.equal(delivery.approvalPublicationReady(state, publicationBranch, priorPublication), true)
  state.task.status = 'waiting'
  assert.equal(delivery.approvalPublicationReady(state, publicationBranch, priorPublication), true)
  state.delivery.pullRequest = null
  assert.equal(delivery.approvalPublicationReady(state, publicationBranch), false)
})

test('publication readiness: existing live read failures and deadline remain failures', async () => {
  const live = new delivery.LiveChanges(() => assert.fail('no API is needed for this pure case'), publicationWorkspaceId, { Socket: PublicationTestSocket, kinds: publicationKinds })
  try {
    const terminal = new Error('issue1503_factory_terminal_failure')
    await assert.rejects(live.until(publicationKeys, async () => { throw terminal },
      state => delivery.approvalPublicationReady(state, publicationBranch, priorPublication), 1_000), error => error === terminal)
    let reads = 0
    const pending = publishedCandidate()
    pending.delivery.pullRequest = null
    await assert.rejects(live.until(publicationKeys, async () => { reads++; return pending },
      state => delivery.approvalPublicationReady(state, publicationBranch, priorPublication), 20), /issue1503_task_timeout/)
    assert.equal(reads, 1, 'a deadline timer never polls task data')
  } finally { live.close() }
})
