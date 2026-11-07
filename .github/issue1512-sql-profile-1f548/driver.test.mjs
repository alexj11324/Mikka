import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EXPECTED, REQUEST_PLAN, batchCalls, businessRead, options } from './driver.mjs'

const owner = 'synthetic-profile-owner'
const fixture = { workspace: '10000000-0000-4000-8000-000000000001', run: '10000000-0000-4000-8000-000000000002',
  issue: '10000000-0000-4000-8000-000000000003', coordinator: '10000000-0000-4000-8000-000000000004' }
const home = '20000000-0000-4000-8000-000000000001'
const live = { ownerId: owner, workspaceId: home }
const thread = () => ({ snapshot: { live, version: 'a'.repeat(32),
  items: [{ id: fixture.run, prompt: 'CANARY_PRIVATE_TRANSCRIPT' }], positions: [{ id: fixture.run, version: 'b'.repeat(32) }] } })
const chat = () => ({ chat: { live, version: 'c'.repeat(32), botId: fixture.coordinator, working: false, error: null,
  items: [{ position: 1, text: 'CANARY_PRIVATE_TRANSCRIPT' }, { position: 2, text: 'CANARY_PRIVATE_TRANSCRIPT' }],
  cursor: 2, continuation: { after: 1, cursor: 2, prefix: 'd'.repeat(32) }, sources: {}, artifacts: {} } })
const read = (data, action, held) => businessRead(data, action, held, fixture, owner, home)
const refused = code => error => error.name === 'ProfileFailure' && error.code === code

test('the measured synthetic source is distinct from the PR head tree', () => {
  assert.equal(EXPECTED.source, '7355553d3ec5e3c99b792f27eda2c8380724eeb2')
  assert.equal(EXPECTED.artifactRunId, 42368835389)
  assert.equal(EXPECTED.artifactId, 13572179042)
  assert.notEqual(EXPECTED.tree, EXPECTED.candidateTree)
  assert.equal(EXPECTED.parents.split(' ')[1], EXPECTED.candidate)
  assert.equal(REQUEST_PLAN.length, 24)
  assert.equal(new Set(REQUEST_PLAN).size, 24)
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
  assert.throws(() => read(first, 'task-runs.syncThreadList'), refused('THREAD_POSITIONS_INVALID'))
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
