import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXPECTED, REQUEST_PLAN, batchCalls, businessRead, options } from './driver.mjs'
import { COMMON_RPC_READS, GET_READS, assertNativeTarget, commonRead, getRequest, restReceipt } from './reads.mjs'

const owner = 'synthetic-profile-owner'
const fixture = { workspace: '10000000-0000-4000-8000-000000000001', run: '10000000-0000-4000-8000-000000000002',
  issue: '10000000-0000-4000-8000-000000000003', coordinator: '10000000-0000-4000-8000-000000000004',
  team: '10000000-0000-4000-8000-000000000005', device: '10000000-0000-4000-8000-000000000006',
  group: '10000000-0000-4000-8000-000000000007', bot: '10000000-0000-4000-8000-000000000008' }
const home = '20000000-0000-4000-8000-000000000001'
const live = { ownerId: owner, workspaceId: home }
const thread = () => ({ snapshot: { live, version: 'a'.repeat(32),
  items: [{ id: fixture.run, prompt: 'CANARY_PRIVATE_TRANSCRIPT' }], positions: [{ id: fixture.run, version: 'b'.repeat(32) }] } })
const chat = () => ({ chat: { live, version: 'c'.repeat(32), botId: fixture.coordinator, working: false, error: null,
  items: [{ position: 1, text: 'CANARY_PRIVATE_TRANSCRIPT' }, { position: 2, text: 'CANARY_PRIVATE_TRANSCRIPT' }],
  cursor: 2, continuation: { after: 1, cursor: 2, prefix: 'd'.repeat(32) }, sources: {}, artifacts: {} } })
const read = (data, action, held) => businessRead(data, action, held, fixture, owner, home)
const refused = code => error => error.name === 'ProfileFailure' && error.code === code

test('the exact successful Linux API is tied to e7 and its identical synthetic tree', () => {
  assert.equal(EXPECTED.source, '383da169d23b9cb6bfae1951ef862f43919a89c8')
  assert.equal(EXPECTED.artifactRunId, 42384327014)
  assert.equal(EXPECTED.artifactId, 13578149529)
  assert.equal(EXPECTED.tree, EXPECTED.candidateTree)
  assert.equal(EXPECTED.parents.split(' ')[1], EXPECTED.candidate)
  assert.equal(REQUEST_PLAN.length, 60)
  assert.equal(new Set(REQUEST_PLAN).size, 60)
  assert.ok(!REQUEST_PLAN.includes('system_browser_bootstrap'))
  assert.ok(REQUEST_PLAN.indexOf('web_live_ticket') < REQUEST_PLAN.indexOf('native_sign_in'))
  assert.ok(REQUEST_PLAN.indexOf('native_chat_cursor') < REQUEST_PLAN.indexOf('native_read_batch'))
})

test('CLI rejects incomplete, duplicated or unknown paths before any work', () => {
  assert.throws(() => options([]), refused('ARGUMENTS_INVALID'))
  assert.throws(() => options(['--source', '.', '--source', '.', '--output', '.']), refused('ARGUMENTS_INVALID'))
  assert.throws(() => options(['--source', '.', '--secrets', '.', '--output', '.']), refused('ARGUMENTS_INVALID'))
  const result = options(['--source', '.', '--artifact-zip', './owned.zip', '--output', './result.json'])
  assert.equal(Object.keys(result).sort().join(','), 'output,source,zip')
})

test('owner-wide reads require the actual personal home, never the selected team', () => {
  const task = { live, items: [{ runId: fixture.run, issueId: fixture.issue }] }
  assert.equal(read(task, 'task-runs.pollTaskRuns').receipt.samePersonalHome, true)
  assert.throws(() => read({ ...task, live: { ...live, workspaceId: fixture.workspace } }, 'task-runs.pollTaskRuns'), refused('READ_SCOPE_MISMATCH'))
  assert.throws(() => read({ ...task, live: { ...live, ownerId: 'another-owner' } }, 'task-runs.pollTaskRuns'), refused('READ_SCOPE_MISMATCH'))
  assert.throws(() => read({ live, items: [] }, 'task-runs.pollTaskRuns'), refused('FIXTURE_TASK_NOT_RETURNED'))
})

test('thread sync uses returned positions and refuses a changed or unproved cursor', () => {
  const first = thread(), saved = read(first, 'task-runs.syncThreadList')
  assert.deepEqual(saved.held.args, [first.snapshot.version, first.snapshot.positions])
  const same = { snapshot: { live, unchanged: true, version: first.snapshot.version } }
  assert.equal(read(same, 'task-runs.syncThreadList', saved.held).receipt.originalReturnedCursorUsed, true)
  assert.throws(() => read({ snapshot: { ...same.snapshot, version: 'e'.repeat(32) } }, 'task-runs.syncThreadList', saved.held), refused('READ_CURSOR_NOT_UNCHANGED'))
  first.snapshot.positions.push(first.snapshot.positions[0])
  assert.throws(() => read(first, 'task-runs.syncThreadList'), refused('LIST_POSITIONS_INVALID'))
})

test('chat uses the normal null selector and only its returned continuation', () => {
  const first = chat(), saved = read(first, 'coordinator.syncCoordinatorChat')
  assert.deepEqual(saved.held.args, [null, first.chat.version, { ...first.chat.continuation, sourceIds: [], artifactIds: [] }])
  const same = { chat: { live, unchanged: true, version: first.chat.version, botId: fixture.coordinator, cursor: 2 } }
  assert.equal(read(same, 'coordinator.syncCoordinatorChat', saved.held).receipt.unchanged, true)
  assert.throws(() => read({ chat: { ...same.chat, cursor: 3 } }, 'coordinator.syncCoordinatorChat', saved.held), refused('CHAT_CURSOR_MISMATCH'))
  delete first.chat.continuation
  assert.throws(() => read(first, 'coordinator.syncCoordinatorChat'), refused('CHAT_CONTINUATION_MISSING'))
})

test('the one batch preserves each measured argument and order without a mutation', () => {
  const savedThread = read(thread(), 'task-runs.syncThreadList').held
  const savedChat = read(chat(), 'coordinator.syncCoordinatorChat').held
  const calls = batchCalls(savedThread, savedChat)
  assert.deepEqual(calls.map(call => call.action), ['task-runs.pollTaskRuns', 'task-runs.syncThreadList', 'coordinator.syncCoordinatorChat'])
  assert.strictEqual(calls[1].args, savedThread.args)
  assert.strictEqual(calls[2].args, savedChat.args)
  assert.throws(() => batchCalls(undefined, savedChat), refused('BATCH_REQUIRES_RETURNED_CURSORS'))
})

test('safe read receipts contain no body, owner, workspace, fixture ID or cursor', () => {
  const values = [read(thread(), 'task-runs.syncThreadList').receipt, read(chat(), 'coordinator.syncCoordinatorChat').receipt]
  const text = JSON.stringify(values)
  for (const forbidden of ['CANARY_PRIVATE_TRANSCRIPT', owner, home, ...Object.values(fixture), 'a'.repeat(32), 'c'.repeat(32), 'd'.repeat(32)]) assert.ok(!text.includes(forbidden))
  for (const receipt of values) assert.ok(Object.values(receipt).every(value => typeof value === 'boolean' || Number.isSafeInteger(value)))
  assert.throws(() => read({ error: 'CANARY_PRIVATE_REFUSAL' }, 'coordinator.syncCoordinatorChat'), refused('BUSINESS_READ_REJECTED'))
})

test('each shared RPC and eight REST endpoint types has a Web/Native pair, without a mutation or refresh', () => {
  const actions = new Set(['desktop.bootstrap', ...COMMON_RPC_READS.map(([, action]) => action)])
  assert.equal(actions.size, 10)
  assert.ok(![...actions].some(action => /refresh|send|enroll|switch|update|create|delete/i.test(action)))
  for (const [id] of COMMON_RPC_READS) for (const client of ['web', 'native']) assert.ok(REQUEST_PLAN.includes(`${client}_${id}`))
  const kinds = ['workspace', ...GET_READS.filter(name => name !== 'live_ticket')]
  const routes = new Set(kinds.map(name => getRequest(name, fixture, home, '17').route))
  assert.equal(routes.size, 8)
  assert.equal(getRequest('workspace', fixture, home).path, '/mikka/api/workspace')
  assert.ok(REQUEST_PLAN.indexOf('web_live_ticket') < REQUEST_PLAN.indexOf('native_sign_in'))
})

test('Native requests bind exact current scope and cursor, and enrollment stays a GET', () => {
  for (const name of ['workspace', ...GET_READS]) {
    const request = getRequest(name, fixture, home, '17')
    assert.equal(assertNativeTarget(request.path, 'GET', fixture, home, '17').pathname, request.route)
  }
  for (const [path, method] of [
    ['/mikka/api/devices/enrollment', 'POST'], ['/mikka/api/settings/secrets', 'GET'],
    [`/mikka/api/workspace?workspace=${fixture.workspace}`, 'GET'],
    [`/mikka/api/computer/events?workspace=${fixture.workspace}&after=18`, 'GET'],
    [`/mikka/api/computer/events?workspace=${home}&after=17`, 'GET'],
    [`/mikka/api/conversations?workspaceId=${fixture.workspace}&workspaceId=${fixture.workspace}`, 'GET'],
    ['http://example.invalid/mikka/api/workspace', 'GET'], ['/mikka/api/desktop/rpc?refresh=1', 'POST'],
  ]) assert.throws(() => assertNativeTarget(path, method, fixture, home, '17'), refused('NATIVE_HTTP_TARGET_INVALID'))
  assert.throws(() => getRequest('computer_cursor', fixture, home), refused('COMPUTER_CURSOR_UNAVAILABLE'))
})

test('issue sync validates both owned home and selected team, then uses only returned positions', () => {
  const value = { snapshot: { live: { ...live, selectedWorkspaceId: fixture.workspace }, version: 'e'.repeat(32),
    items: [{ id: fixture.issue, title: 'CANARY_PRIVATE_TITLE' }], positions: [{ id: fixture.issue, version: 'f'.repeat(32) }] } }
  const first = read(value, 'issues.syncIssueList')
  assert.strictEqual(first.held.args[1], value.snapshot.positions)
  const repeated = { snapshot: { live: value.snapshot.live, version: value.snapshot.version, unchanged: true } }
  assert.equal(read(repeated, 'issues.syncIssueList', first.held).receipt.originalReturnedCursorUsed, true)
  assert.throws(() => read({ snapshot: { ...value.snapshot, live: { ...live, selectedWorkspaceId: home } } }, 'issues.syncIssueList'), refused('ISSUE_SELECTED_SCOPE_MISMATCH'))
})

test('computer events keep the exact decimal cursor, require a complete ordered page and export no payload', () => {
  const cursor = '9007199254740993'
  const first = restReceipt({ events: [{ id: cursor, data: 'CANARY_PRIVATE_EVENT' }], cursor, hasMore: false },
    'computer_first', fixture, owner, home, undefined, '0')
  assert.equal(first.cursor, cursor)
  assert.equal(getRequest('computer_cursor', fixture, home, first.cursor).path,
    `/mikka/api/computer/events?workspace=${fixture.workspace}&after=${cursor}`)
  assert.equal(restReceipt({ events: [], cursor, hasMore: false }, 'computer_cursor', fixture, owner, home, undefined, cursor).receipt.originalReturnedCursorUsed, true)
  assert.ok(!JSON.stringify(first.receipt).includes(cursor))
  assert.ok(!JSON.stringify(first.receipt).includes('CANARY_PRIVATE_EVENT'))
  for (const value of [
    { events: [], cursor: '1', hasMore: false },
    { events: [{ id: '1', data: null }], cursor: '1', hasMore: true },
    { events: [{ id: '2', data: null }, { id: '1', data: null }], cursor: '1', hasMore: false },
    { events: [], cursor: 0, hasMore: false },
  ]) assert.throws(() => restReceipt(value, 'computer_first', fixture, owner, home, undefined, '0'))
})

test('REST receipts bind original default workspace, owner and owned fixture without disclosing text', () => {
  const headers = new Headers({ 'x-mikka-viewer': encodeURIComponent(owner), 'x-mikka-observed-at': '2026-11-07T00:00:00.000Z' })
  const workspace = { workspace: { id: fixture.workspace, name: 'CANARY_PRIVATE_NAME' }, currentUserId: owner,
    members: [], invitations: [], live: { ownerId: owner, workspaceId: fixture.workspace, homeWorkspaceId: home } }
  const values = [
    restReceipt(workspace, 'workspace', fixture, owner, undefined),
    restReceipt({ workspace: workspace.workspace, live, accounts: [{ id: owner, email: 'CANARY_PRIVATE_EMAIL', choices: [{ id: fixture.workspace }] }] }, 'switcher', fixture, owner, home),
    restReceipt({ sessions: [], sessionId: null, selectedSession: null, turns: [] }, 'agent_sessions', fixture, owner, home),
    restReceipt({ ownerId: owner, deviceIds: [fixture.device] }, 'enrollment', fixture, owner, home),
    restReceipt({ viewerId: owner, workspaceId: fixture.workspace, conversations: [{ id: fixture.group, title: 'CANARY_PRIVATE_TITLE' }] }, 'conversations', fixture, owner, home),
    restReceipt([{ payload: 'CANARY_PRIVATE_ACTION' }], 'pending_actions', fixture, owner, home, headers),
    restReceipt({ proactive: true, pushDecide: true, pushReview: false, pushFinished: true, pushBriefing: true,
      memoryEnabled: true, dailySuggestions: true, pushWhen: 'always', sendKey: 'enter', personalInstructions: 'CANARY_PRIVATE_INSTRUCTION' }, 'preferences', fixture, owner, home),
  ].map(value => value.receipt)
  const output = JSON.stringify(values)
  for (const secret of ['CANARY_PRIVATE', owner, home, ...Object.values(fixture)]) assert.ok(!output.includes(secret))
  assert.ok(values.every(receipt => Object.values(receipt).every(value => typeof value === 'boolean' || Number.isSafeInteger(value))))
  assert.throws(() => restReceipt({ ...workspace, currentUserId: 'another' }, 'workspace', fixture, owner, home), refused('REST_WORKSPACE_MISMATCH'))
  assert.throws(() => restReceipt({ ownerId: owner, deviceIds: [] }, 'enrollment', fixture, owner, home), refused('ENROLLMENT_SCOPE_MISMATCH'))
  assert.throws(() => restReceipt([], 'pending_actions', fixture, owner, home, new Headers()), refused('PENDING_ACTIONS_SCOPE_MISMATCH'))
})

test('common read receipts validate the actual fixture and refuse non-isolated provider menu options', () => {
  const checks = [
    [{ live: { ownerId: owner, workspaceId: fixture.workspace }, items: [{ id: fixture.coordinator }, { id: fixture.bot }] }, 'bots.pollBots'],
    [{ live, items: { [fixture.coordinator]: { line: 'CANARY_PRIVATE_REPLY' } } }, 'coordinator.pollBotChatSummaries'],
    [[], 'projects.listProjects'], [[{ id: fixture.team, name: 'CANARY_PRIVATE_TEAM' }], 'teams.listTeams'],
    [[], 'team-relations.listProjectTeams'], [{ groups: [], current: { kind: 'hosted', available: false } }, 'execution-settings.getBotModelMenu'],
  ]
  const output = JSON.stringify(checks.map(([value, action]) => commonRead(value, action, fixture, owner, home)))
  for (const secret of ['CANARY_PRIVATE', owner, home, ...Object.values(fixture)]) assert.ok(!output.includes(secret))
  assert.throws(() => commonRead({ groups: [{ kind: 'subscription', options: [] }], current: { kind: 'hosted', available: true } },
    'execution-settings.getBotModelMenu', fixture, owner, home), refused('MODEL_MENU_ISOLATION_MISMATCH'))
})
