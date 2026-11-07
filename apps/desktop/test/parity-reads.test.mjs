import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureParityReadReceipts, parityBotReadKeys } from './parity-reads.mjs'
import { observeReads, pageReady } from './parity-page-ready.mjs'
import { compareImages } from './parity-images.mjs'

const ids = { coordinator: 'coordinator-bot', bot: 'bot', coordinatorUser: 'c1', coordinatorReply: 'c2', botUser: 'b1', botReply: 'b2' }
const coordinator = { conversationId: 'coordinator', lastReadMessageId: 'c2', lastReadPosition: 2 }
function fixture(initial = []) {
  const state = { reads: initial, messages: [{ id: 'c2', position: 2, botId: ids.coordinator }, { id: 'b2', position: 2, botId: ids.bot }], deletes: [] }
  return { state, client: { query: async (sql, args) => {
    assert.equal(args[0], 'leased-owner', 'every read and deletion retains the leased owner')
    if (sql.startsWith('SELECT "conversationId"')) return { rows: state.reads }
    if (sql.startsWith('SELECT id::text')) return { rows: state.messages }
    if (sql.startsWith('DELETE')) { state.deletes.push(args); return { rowCount: 1 } }
    assert.fail('unexpected query')
  } } }
}
test('receipt reservation uses actual fresh bot keys, never raw IDs or the shared coordinator label', () => {
  assert.deepEqual(parityBotReadKeys(ids), ['bot:coordinator-bot', 'bot:bot'])
})
test('a pre-existing coordinator receipt is refused without any deletion', async () => {
  const { client, state } = fixture([coordinator])
  await assert.rejects(captureParityReadReceipts(client, 'leased-owner', ids), /PARITY_READ_BASELINE_PRESENT/)
  assert.equal(state.deletes.length, 0)
})
test('only new receipts for the seeded owner messages and exact positions are removed', async () => {
  const { client, state } = fixture()
  const clean = await captureParityReadReceipts(client, 'leased-owner', ids)
  state.reads = [coordinator, { conversationId: 'bot:bot', lastReadMessageId: 'b2', lastReadPosition: 2 }]
  await clean(client)
  assert.deepEqual(state.deletes, [['leased-owner', 'coordinator', 'c2', 2], ['leased-owner', 'bot:bot', 'b2', 2]])
})
test('foreign messages, changed positions and unproven message owners fail before any row deletion', async () => {
  for (const patch of [{ lastReadMessageId: 'foreign-message' }, { lastReadPosition: 3 }, { conversationId: 'bot:foreign' }, null]) {
    const { client, state } = fixture()
    const clean = await captureParityReadReceipts(client, 'leased-owner', ids)
    state.reads = [{ ...coordinator, ...patch }]
    if (!patch) state.messages = []
    await assert.rejects(clean(client), /PARITY_READ_OWNERSHIP_UNPROVEN/)
    assert.equal(state.deletes.length, 0)
  }
})

function observedResponse({ action = 'agents.listDevices', path, flight = false, browser = false, status = 200, headers = {}, finished = async () => null, json = async () => ({ version: 1, ok: true, result: [] }) } = {}) {
  const calls = { body: 0, json: 0 }
  const requirement = path ? { path } : { action }
  const request = { method: () => path ? 'GET' : 'POST', headers: () => flight ? { 'next-action': 'actual-action-id' } : browser ? { 'x-mikka-rpc': '1' } : {}, postDataJSON: () => ({ version: 1, action, args: [] }) }
  const response = {
    request: () => request, url: () => `http://localhost:3004/mikka${path ?? (flight ? '/en' : browser ? '/api/rpc' : '/api/desktop/rpc')}`,
    ok: () => status >= 200 && status < 300, status: () => status,
    headers: () => ({ 'content-type': flight ? 'text/x-component' : 'application/json', ...headers }),
    finished: () => { calls.body++; return finished() },
    json: () => { calls.json++; return json() },
  }
  const page = {
    waitForResponse: async predicate => { assert.equal(predicate(response), true); return response },
    evaluate: async () => undefined,
  }
  return { calls, finish: observeReads(page, [requirement], new Map([['actual-action-id', action]]), '/mikka') }
}

test('a completed Next action does not wait for its ongoing page Flight stream', { timeout: 1000 }, async () => {
  const { finish, calls } = observedResponse({ flight: true, finished: () => new Promise(() => {}) })
  assert.deepEqual(await finish(), { linearUnavailable: false })
  assert.deepEqual(calls, { body: 0, json: 0 })
})

test('ordinary RPC waits for both the body and parsed JSON', { timeout: 1000 }, async () => {
  for (const browser of [false, true]) {
    const body = Promise.withResolvers()
    const data = Promise.withResolvers()
    const { finish, calls } = observedResponse({ browser, finished: () => body.promise, json: () => data.promise })
    let completed = false
    const result = finish().then(value => { completed = true; return value })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, { body: 1, json: 0 })
    assert.equal(completed, false)
    body.resolve(null)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, { body: 1, json: 1 })
    assert.equal(completed, false)
    data.resolve({ version: 1, ok: true, result: [] })
    assert.deepEqual(await result, { linearUnavailable: false })
  }
})

test('browser RPC refuses missing protocol results and business failures after real JSON completion', async () => {
  for (const data of [{ ok: true, result: [] }, { version: 1, ok: true },
    { version: 1, ok: false, error: { code: 'denied' } },
    { version: 1, ok: true, result: { error: 'denied' } }]) {
    await assert.rejects(observedResponse({ browser: true, json: async () => data }).finish(), assert.AssertionError)
  }
})

test('HTTP success does not hide API/RPC error data or a non-JSON redirect page', async () => {
  for (const options of [
    { json: async () => ({ ok: false, error: { code: 'denied' } }) },
    { path: '/api/settings/model-order', json: async () => ({ error: 'denied' }) },
    { headers: { 'content-type': 'text/html' } },
  ]) await assert.rejects(observedResponse(options).finish(), assert.AssertionError)
})

test('an action auth redirect or wrong response type is not successful completion', async () => {
  for (const headers of [{ 'x-action-redirect': '/en/sign-in;push' }, { 'content-type': 'text/html' }]) {
    await assert.rejects(observedResponse({ flight: true, headers }).finish(), assert.AssertionError)
  }
})

test('only the exact successful Linear unavailable payload enables its existing status message', async () => {
  for (const [path, status, data, expected] of [
    ['/api/integrations/linear/status', 200, { enabled: false, state: 'unavailable' }, true],
    ['/api/integrations/linear/status', 201, { enabled: false, state: 'unavailable' }, false],
    ['/api/integrations/linear/status', 200, { enabled: true, state: 'unavailable' }, false],
    ['/api/integrations/linear/status', 200, { enabled: false, state: 'disabled' }, false],
    ['/api/integrations/linear/status', 200, { state: 'unavailable' }, false],
    ['/api/integrations/github', 200, { enabled: false, state: 'unavailable' }, false],
  ]) {
    assert.deepEqual(await observedResponse({ path, status, json: async () => data }).finish(), { linearUnavailable: expected })
  }
})

const taskFixture = { issueTitle: 'Review the desktop workspace' }
const taskMessages = {
  Workspace: { detail: { createdTask: 'Created the task' } },
  IssueThreads: { open: 'Open thread {name}', conversation: 'Thread conversation' },
}
const taskDescription = 'Review conversations, task details, artifacts and workspace settings in the desktop app.'
const threadReply = 'The review is complete. Conversations, task details and artifacts are ready.'

// Deferred Locator boundaries exercise the real readiness helper without a
// browser. The task and its nested thread have the same accessible region name;
// only the outer region contains #task-title. Their independent reads can finish
// in any order, without a skeleton for the activity or the task's thread list.
function taskReadiness(pending) {
  const waiting = Promise.withResolvers()
  const wait = key => key === pending ? waiting.promise : Promise.resolve()
  const text = (value, options) => {
    assert.equal(options.exact, true)
    const key = new Map([[taskDescription, 'description'], [taskMessages.Workspace.detail.createdTask, 'activity']]).get(value)
    assert.ok(key, 'task text must be one of the existing positive readiness markers')
    return { waitFor: () => wait(key) }
  }
  let narrowed = false
  const task = {
    _apiName: 'Locator',
    filter({ has }) {
      assert.equal(has.selector, '#task-title')
      narrowed = true
      return this
    },
    async _expect(expression, options) {
      assert.equal(narrowed, true, 'the nested thread shares this accessible name; select the region containing the task title')
      assert.equal(expression, 'to.have.attribute.value')
      assert.equal(options.expressionArg, 'aria-busy')
      assert.equal(options.expectedText[0].string, 'false')
      await wait('verified')
      return { matches: true }
    },
    locator(selector) {
      assert.equal(selector, '#task-title:not([readonly])')
      return { waitFor: () => wait('editable-title') }
    },
    getByText: text,
    getByRole(role, options) {
      if (role === 'button') {
        assert.deepEqual(options, { name: 'Open thread Review the desktop workspace', exact: true, pressed: true })
        return { waitFor: () => wait('thread-row') }
      }
      assert.equal(role, 'list')
      assert.deepEqual(options, { name: 'Thread conversation', exact: true })
      return { getByText(value, options) {
        assert.equal(value, threadReply)
        assert.deepEqual(options, { exact: true })
        return { waitFor: () => wait('thread-reply') }
      } }
    },
  }
  const page = {
    getByRole(role, options) {
      assert.equal(role, 'region')
      assert.deepEqual(options, { name: taskFixture.issueTitle, exact: true })
      return task
    },
    locator: selector => ({ selector }),
    getByText() { assert.fail('a reply or activity elsewhere on the page must not satisfy task readiness') },
  }
  return { page, release: waiting.resolve }
}

for (const pending of ['verified', 'editable-title', 'description', 'activity', 'thread-row', 'thread-reply']) {
  test(`task-thread capture waits for ${pending} even when all its other reads are ready`, async t => {
    const { page, release } = taskReadiness(pending)
    t.after(release)
    let completed = false
    let failure
    const ready = pageReady(page, 'task-thread', taskFixture, taskMessages).then(() => { completed = true }, error => { failure = error })
    await new Promise(resolve => setImmediate(resolve))
    assert.ifError(failure)
    assert.equal(completed, false, 'mask collection must not begin while an independent read is unrendered')
    release()
    await ready
    assert.ifError(failure)
    assert.equal(completed, true)
  })
}

const whitePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4jwYYSBcAAHg8P8HaEZ1pAAAAAElFTkSuQmCC', 'base64')
const blackPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNgYGD4j4ZJFQAABloP8TIttywAAAAASUVORK5CYII=', 'base64')

test('identical pixels with different mask geometry still fail and retain both geometries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-parity-masks-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const before = { bytes: whitePng, masks: [{ kind: 'time', x: 0, y: 0, width: 1, height: 1 }] }
  const after = { bytes: whitePng, masks: [{ kind: 'time', x: 1, y: 0, width: 1, height: 1 }] }
  const report = await compareImages(before, after, join(directory, 'diff.png'))
  assert.equal(report.changedPixels, 0)
  assert.equal(report.maskGeometryMatches, false)
  assert.equal(report.passed, false)
  const retained = JSON.parse(JSON.stringify(report))
  assert.deepEqual(retained.masks, before.masks)
  assert.deepEqual(retained.afterMasks, after.masks)
})

test('matching masks preserve the unchanged strict pixel comparison', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-parity-pixels-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const original = { bytes: whitePng, masks: [] }
  const same = await compareImages(original, original, join(directory, 'same.png'))
  assert.equal(same.passed, true)
  const changed = await compareImages(original, { bytes: blackPng, masks: [] }, join(directory, 'different.png'))
  assert.equal(changed.maskGeometryMatches, true)
  assert.equal(changed.changedRatio, 1)
  assert.equal(changed.maximumRatio, 0.001)
  assert.equal(changed.passed, false)
})
