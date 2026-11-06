import assert from 'node:assert/strict'
import test from 'node:test'
import { captureParityReadReceipts, parityBotReadKeys } from './parity-reads.mjs'
import { observeReads } from './parity-page-ready.mjs'

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
