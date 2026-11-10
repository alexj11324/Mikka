import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertReviewCandidate, cleanupWorkspaceCase, codingFixture, journalMutation, runCodingWorkspace,
  waitForWorkspaceChange, writeWorkspaceCheckpoint } from './coding-workspace.mjs'
import { subscriptionProof } from './cloud-startup.mjs'

const id = digit => `00000000-0000-4000-8000-${String(digit).padStart(12, '0')}`
const ownerId = 'synthetic-smoke-owner', adminId = 'synthetic-subscription-owner', workspaceId = id(1), otherId = id(2)
const source = 'a'.repeat(40), worker = 'b'.repeat(40), privateText = 'PRIVATE_CREDENTIAL_OR_NATIVE_TEXT'
const options = { sourceCommit: source, workerSha: worker, workerSourceCommit: source,
  templates: { claude_code: 'released-claude', codex: 'released-codex' }, driver: { runId: 123, runAttempt: 1 },
  cleanupOnly: false, reportPath: '/synthetic/report.json', timeoutMs: 480000 }

test('a response-lost creation stays uncertain, and acknowledged IDs are checkpointed before later work', async () => {
  const record = {}, snapshots = [], checkpoint = async () => { snapshots.push(structuredClone(record)) }
  await assert.rejects(journalMutation(record, 'issue_create', async () => { throw Error(privateText) }, () => assert.fail(), checkpoint))
  assert.equal(record.intents[0].state, 'uncertain'); assert.equal(record.issueId, undefined)
  assert.equal(snapshots[0].intents[0].state, 'requested')
  await journalMutation(record, 'profile_create', async () => ({ profile: { id: id(4) } }), value => { record.profileId = value.profile.id }, checkpoint)
  assert.equal(snapshots.at(-1).profileId, id(4)); assert.equal(snapshots.at(-1).intents[1].state, 'responded')
  assert.equal(JSON.stringify(record).includes(privateText), false)
})

test('the durable checkpoint is atomic and private, with no partial JSON on replacement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-review-checkpoint-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'report.json')
  await writeWorkspaceCheckpoint(path, { version: 1, cases: [] })
  await writeWorkspaceCheckpoint(path, { version: 1, cases: [{ issueId: id(4) }] })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { version: 1, cases: [{ issueId: id(4) }] })
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  await assert.rejects(stat(path + '.tmp'), { code: 'ENOENT' })
})

function factoryFixture() {
  const record = { factoryTaskId: id(3), issueId: id(4), botId: id(5), workspaceId }
  const candidate = { id: id(6), runId: id(7), sha: 'c'.repeat(40), repository: 'alexj11324/Mikka-handoff' }
  const state = { liveWorkspaceId: workspaceId, task: { id: record.factoryTaskId, issueId: record.issueId, botId: record.botId,
    sourceEventId: id(8), candidateId: candidate.id, stage: 'approval', status: 'pending', route: { flowVersion: 2 } },
    candidates: [candidate], attempts: ['execute', 'review'].map((stage, index) => ({ id: id(30 + index), stage,
      runId: index ? id(9) : candidate.runId, candidateId: candidate.id, status: 'passed', output: { requestEpoch: id(8) } })),
    delivery: { pullRequest: { state: 'open', url: 'https://github.com/alexj11324/Mikka-handoff/pull/31' } } }
  return { record, state }
}

test('PTY target remains the verified candidate producer, excluding newer review/verify runs and repo:none work', () => {
  const f = factoryFixture(), found = assertReviewCandidate(f.state, f.record)
  assert.equal(found.candidate.runId, id(7)); assert.notEqual(found.candidate.runId, id(9))
  assert.equal(found.prNumber, 31)
  for (const mutate of [state => { state.candidates[0].sha = null }, state => { state.candidates[0].runId = id(9) },
    state => { state.liveWorkspaceId = otherId }, state => { state.attempts[1].status = 'failed' },
    state => { state.attempts[1].output.requestEpoch = id(11) }, state => { state.task.status = 'blocked' },
    state => { state.delivery.pullRequest.url = 'https://github.com/other/repo/pull/31' },
    state => { state.attempts.push({ ...state.attempts[0], runId: id(99) }) }]) {
    const altered = structuredClone(f.state); mutate(altered)
    assert.throws(() => assertReviewCandidate(altered, f.record))
  }
})

test('waits reread only after authenticated live revision changes and never fall back after socket failure', async () => {
  let revision = 0, reads = 0, waits = 0
  const channel = { get revision() { return revision }, async wait(after, _deadline, signal) {
    waits++; assert.equal(after, revision); assert.equal(signal.aborted, false); revision++
  } }
  assert.equal(await waitForWorkspaceChange([channel], async () => ++reads, value => value === 2, Date.now() + 1000), 2)
  assert.equal(reads, 2); assert.equal(waits, 1)
  let failedReads = 0
  await assert.rejects(waitForWorkspaceChange([{ revision: 0, wait: async () => { throw Error('closed_socket') } }],
    async () => ++failedReads, () => false, Date.now() + 1000), /closed_socket/)
  assert.equal(failedReads, 1)
})

function driverFixture({ failedCleanup = false, loseBotResponse = false, invalidBotResponse = false,
  invalidProfileResponse = false, missingClaude = false } = {}) {
  const snapshots = [], actions = [], cases = [], profiles = new Map(), bots = new Map()
  let selected = workspaceId, next = 10
  const email = 'fixture+mikka-smoke@example.invalid'
  const client = {
    clear() { actions.push('session:clear') },
    async request(path) { actions.push(path); return Response.json({}) },
    async json(path, init) {
      if (path === '/api/version') return { build: source }
      if (path === '/api/auth/get-session') return { user: { id: ownerId, email } }
      if (path === '/api/workspace') return { currentUserId: ownerId, workspace: { id: selected }, choices: [{ id: workspaceId }, { id: otherId }] }
      if (path === '/api/factory/agent-profiles') {
        const input = JSON.parse(init.body), profile = { ...input.profile, id: id(next++), version: 1, digest: 'd'.repeat(64) }
        profiles.set(profile.id, profile); actions.push('create:profile'); return invalidProfileResponse ? {} : { profile }
      }
      assert.fail('unexpected HTTP request')
    },
    async rpc(action, args) {
      if (action === 'issues.listWorkspaceIssues') return []
      if (action === 'bots.createBot') {
        actions.push('create:bot')
        if (loseBotResponse) throw Error(privateText)
        const bot = { ...args[0], id: id(next++) }; bots.set(bot.id, bot); return invalidBotResponse ? {} : bot
      }
      if (action === 'workspace.switchWorkspace') { selected = args[0]; return { workspaceId: selected } }
      assert.fail('unexpected RPC')
    },
  }
  const candidates = [
    ...(!missingClaude ? [{ harness: 'claude_code', model: 'claude-haiku-5-5', source: { kind: 'subscription', connectionId: id(30) }, credentialOwnerId: adminId }] : []),
    { harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: id(31) }, credentialOwnerId: adminId },
  ]
  const deps = { env: { SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: privateText }, clientFactory: () => client,
    attest: async () => ({ sourceCommit: source, workerSha: worker, workerSourceCommit: source, templates: options.templates }),
    writeCheckpoint: async (_path, report) => { snapshots.push(structuredClone(report)) },
    selectTeam: async (_client, actor, remember) => { assert.equal(actor.ownerId, ownerId); remember(otherId); return { workspaceId, ownerId, adminId, evidence: { verified: true } } },
    quiet: async () => ({ order: { candidates }, github: { viewerId: ownerId }, visibleRunRows: 3 }),
    chooseModel: async (_client, botId, harness) => { assert.ok(bots.has(botId)); actions.push('model:' + harness) },
    execute: async (_client, record, _scope, profile) => {
      cases.push(record.harness); assert.ok(profiles.has(profile.id))
      const persisted = snapshots.at(-1).cases.at(-1)
      assert.equal(persisted.botId, record.botId); assert.equal(persisted.profileId, record.profileId)
      record.status = 'passed_for_requested_scope'
    },
    cleanup: async (_client, record) => {
      actions.push('cleanup:' + record.harness)
      record.productCleanup = { status: failedCleanup || record.intents.some(item => item.state === 'uncertain') ? 'unconfirmed' : 'passed' }
    },
  }
  return { deps, actions, cases, snapshots }
}

test('both fixed harnesses run sequentially with immediate ID checkpoints; sign-out and workspace restoration always finish', async () => {
  const f = driverFixture(), report = await runCodingWorkspace(options, f.deps)
  assert.equal(report.status, 'incomplete') // No synthetic second actor is invented.
  assert.deepEqual(f.cases, ['claude_code', 'codex'])
  assert.ok(report.limitations.includes('no_existing_visible_non_owner_task_fixture'))
  assert.equal(report.cleanup.workspaceRestored, true); assert.equal(report.cleanup.signedOut, true)
  assert.equal(JSON.stringify(report).includes(privateText), false)
  const firstCleanup = f.actions.indexOf('cleanup:claude_code')
  assert.ok(firstCleanup < f.actions.lastIndexOf('create:profile'))
})

test('case one unconfirmed cleanup, lost response or missing created ID prevents case two and leaves recovery intent', async () => {
  for (const change of [{ failedCleanup: true }, { loseBotResponse: true }, { invalidBotResponse: true }, { invalidProfileResponse: true }]) {
    const f = driverFixture(change), report = await runCodingWorkspace(options, f.deps)
    assert.equal(report.status, 'failed'); assert.equal(report.cases.length, 1)
    assert.equal(f.actions.filter(action => action === 'create:profile').length, 1)
    assert.equal(report.cases[0].productCleanup.status, 'unconfirmed')
    assert.equal(report.cleanup.signedOut, true); assert.equal(JSON.stringify(report).includes(privateText), false)
    if (change.loseBotResponse || change.invalidBotResponse) {
      assert.equal(report.cases[0].botId, undefined)
      assert.equal(report.cases[0].intents.find(item => item.kind === 'bot_create').state, 'uncertain')
    }
    if (change.invalidProfileResponse) {
      assert.equal(report.cases[0].profileId, undefined)
      assert.equal(report.cases[0].intents.find(item => item.kind === 'profile_create').state, 'uncertain')
      assert.equal(f.actions.includes('create:bot'), false)
    }
  }
})

test('an unavailable original subscription does not switch models or prevent a separately clean second path', async () => {
  const f = driverFixture({ missingClaude: true }), report = await runCodingWorkspace(options, f.deps)
  assert.equal(report.status, 'failed'); assert.equal(report.cases[0].failure.code, 'workspace_review_model')
  assert.deepEqual(f.cases, ['codex']); assert.equal(f.actions.filter(action => action === 'create:profile').length, 1)
})

test('failure cleanup retains ambiguous publication/issue and ends only the acknowledged own fixture', async () => {
  const record = { caseId: id(40), harness: 'codex', issueId: id(41), botId: id(42), workspaceId,
    dispatched: true, intents: [{ kind: 'dispatch', state: 'uncertain' }] }
  const actions = [], client = {
    json: async path => { assert.equal(path, '/api/bots/' + record.botId); return { id: record.botId, name: `测试1723/1724 ${record.caseId} codex` } },
    rpc: async (action, args) => {
      actions.push(action)
      if (action === 'coordinator.stopCoordinatorTurn') { assert.deepEqual(args, [record.botId]); return {} }
      assert.equal(action, 'issues.getIssue'); assert.deepEqual(args, [record.issueId])
      return { issue: { id: record.issueId, userId: ownerId, workspaceId, ownershipState: 'bound', title: `测试 Coding Workspace ${record.caseId} codex` } }
    },
  }
  const result = await cleanupWorkspaceCase(client, record, { ownerId, workspaceId }, { checkpoint: async () => {},
    cleanup: async (_client, found, target, settings) => {
      assert.equal(found, record); assert.equal(target, 'cloud'); assert.equal(settings.preserveIssue, true)
      found.cleanup = { status: 'passed' }
    } })
  assert.equal(result.status, 'unconfirmed'); assert.ok(result.retained.includes('native_publication_unconfirmed'))
  assert.ok(result.retained.includes('write_response_or_checkpoint_uncertain'))
  assert.equal(actions.includes('issue-operations.setIssueDeleted'), false)
})

test('fixed repository work is unique to this acceptance and cannot borrow an old 1503 fixture', () => {
  const fixture = codingFixture(id(50), 'codex')
  assert.ok(fixture.filePath.startsWith('docs/coding-workspace/acceptance-'))
  assert.ok(fixture.instructions.includes('Do not start a development server'))
  assert.equal(fixture.instructions.includes('1503'), false)
  assert.throws(() => codingFixture('other', 'codex'))
  assert.throws(() => codingFixture(id(50), 'other-model'))
})

test('independent checker proof preserves the same shared subscription/model and requires actual decision provenance', async () => {
  const profile = { id: id(60), version: 1, digest: 'd'.repeat(64), model: { source: { connectionId: id(61) } } }
  const scope = { ownerId, adminId, workspaceId, botId: id(62), evidence: { teamWorkspaceHash: 'e'.repeat(16) } }
  const record = { issueId: id(63), runId: id(64), profileId: profile.id, harness: 'codex', placement: { kind: 'cloud' } }
  const run = { id: record.runId, issueId: record.issueId, harness: 'codex', model: 'gpt-6-luna', credentialType: 'subscription', subscriptionRoute: 'codex_cli',
    agentProfile: { profileId: profile.id, version: 1, digest: profile.digest, source: 'decision' },
    executionIdentity: { version: 1, requester: ownerId, executionPrincipal: ownerId, botId: scope.botId, botOwner: ownerId, outputOwner: ownerId,
      workspaceId, personalResourcePolicy: 'requester_only', resourceBindings: [
        { kind: 'device', id: id(65), ownerId, access: 'owner' }, { kind: 'subscription', id: id(66), ownerId: adminId, access: 'workspace_share', revision: '1' },
      ], billingAccount: { model: { kind: 'subscription', ownerId: adminId, resourceId: id(66) }, runtime: { kind: 'e2b', ownerId, resourceId: ownerId } } } }
  const client = { json: async () => ({ run }) }
  await assert.rejects(subscriptionProof(client, { ...record }, scope, profile))
  const checked = { ...record }
  await subscriptionProof(client, checked, scope, profile, { profileSource: 'decision' })
  assert.equal(checked.execution.model, 'gpt-6-luna'); assert.equal(checked.execution.sharedScope.verified, true)
  for (const mutation of [value => { value.model = 'gpt-6-pro' }, value => { value.executionIdentity.workspaceId = otherId },
    value => { value.executionIdentity.billingAccount.model.ownerId = 'other-owner' }, value => { value.agentProfile.source = 'explicit' }]) {
    const changed = structuredClone(run); mutation(changed)
    await assert.rejects(subscriptionProof({ json: async () => ({ run: changed }) }, { ...record }, scope, profile, { profileSource: 'decision' }))
  }
})
