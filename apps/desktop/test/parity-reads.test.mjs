import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { captureParityReadReceipts, parityBotReadKeys } from './parity-reads.mjs'
import { observeReads, pageReady } from './parity-page-ready.mjs'

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

const artifactFixture = { artifactTitle: 'Desktop review notes', htmlTitle: 'Desktop review preview' }
const finalReply = 'The review is complete. Conversations, task details and artifacts are ready.'

// Offline DOM locators: changes explicitly release visibility waits. No browser,
// application request, sleep or screenshot is involved in this readiness check.
function artifactPage(t, { reply = true, frameReady = true } = {}) {
  const window = new Window()
  const document = window.document
  const pending = new Set()
  const card = title => `<button data-slot="artifact-card"><span>${title}</span><span>Document · v1</span></button>`
  document.body.innerHTML = `<div id="background">${finalReply}${card(artifactFixture.artifactTitle)}${card(artifactFixture.htmlTitle)}</div>
    <div role="dialog"><main><h2>Desktop review</h2><iframe></iframe><div id="other-cards">${card(artifactFixture.artifactTitle)}${card(artifactFixture.htmlTitle)}</div></main>
    <aside><p id="reply">${reply ? finalReply : ''}</p><div data-slot="thread-artifacts"></div></aside></div>`
  const frame = document.querySelector('iframe').contentDocument
  frame.body.innerHTML = frameReady ? '<h1>Desktop review</h1>' : ''
  function locator(roots) {
    const descendants = selector => roots().flatMap(root => [...root.querySelectorAll(selector)])
    const matches = (node, value, exact) => exact ? node.textContent.trim() === value : node.textContent.includes(value)
    const visible = () => roots().some(node => !node.closest?.('[hidden]'))
    return {
      locator: selector => locator(() => descendants(selector)),
      frameLocator: selector => locator(() => descendants(selector).map(node => node.contentDocument)),
      getByRole: (role, { name, exact = false } = {}) => locator(() => descendants(role === 'heading' ? 'h1,h2,h3,h4,h5,h6' : `[role="${role}"]`)
        .filter(node => name === undefined || matches(node, name, exact))),
      getByText: (value, { exact = false } = {}) => locator(() => descendants('*').filter(node => matches(node, value, exact)
        && ![...node.children].some(child => matches(child, value, exact)))),
      waitFor: async () => {
        if (visible()) return
        await new Promise((resolve, reject) => pending.add({ visible, resolve, reject }))
      },
    }
  }
  const update = change => {
    change(document)
    for (const wait of pending) if (wait.visible()) { pending.delete(wait); wait.resolve() }
  }
  const expire = () => {
    for (const wait of pending) wait.reject(new Error('PARITY_FIXTURE_WAIT_TIMEOUT'))
    pending.clear()
  }
  t.after(() => { expire(); window.close() })
  const page = locator(() => [document])
  return { update, expire, frame, addCard: (title, hidden = false) => update(() => {
    const cards = document.querySelector('aside [data-slot="thread-artifacts"]')
    cards.insertAdjacentHTML('beforeend', card(title))
    cards.lastElementChild.hidden = hidden
  }), start: name => {
    const state = { completed: false }
    const result = pageReady(page, name, artifactFixture, {}).then(() => { state.completed = true })
    void result.catch(() => {})
    return { state, result }
  } }
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve))

for (const name of ['artifact-markdown', 'artifact-html']) {
  test(`${name} waits for both visible thread cards, not background or partial matches`, { timeout: 1000 }, async t => {
    const f = artifactPage(t)
    const { state, result } = f.start(name)
    await nextTurn()
    assert.equal(state.completed, false, 'background and dialog-body cards cannot complete the thread')
    f.addCard(artifactFixture.artifactTitle)
    await nextTurn()
    assert.equal(state.completed, false, 'one card is not the completed fixture')
    f.addCard(`${artifactFixture.htmlTitle} incomplete`)
    await nextTurn()
    assert.equal(state.completed, false, 'a partial title match is not the fixture card')
    f.update(document => document.querySelector('aside [data-slot="artifact-card"]:last-child').remove())
    f.addCard(artifactFixture.htmlTitle, true)
    await nextTurn()
    assert.equal(state.completed, false, 'a hidden card cannot be captured')
    f.update(document => { document.querySelector('aside [data-slot="artifact-card"]:last-child').hidden = false })
    await result
    assert.equal(state.completed, true)
  })

  test(`${name} requires the final reply in the dialog thread`, { timeout: 1000 }, async t => {
    const f = artifactPage(t, { reply: false })
    f.addCard(artifactFixture.artifactTitle)
    f.addCard(artifactFixture.htmlTitle)
    const { state, result } = f.start(name)
    await nextTurn()
    assert.equal(state.completed, false, 'a background reply does not complete the dialog thread')
    f.update(document => document.querySelector('main').insertAdjacentHTML('beforeend', `<p>${finalReply}</p>`))
    await nextTurn()
    assert.equal(state.completed, false, 'the document is not the thread')
    f.update(document => { document.querySelector('#reply').textContent = finalReply })
    await result
    assert.equal(state.completed, true)
  })

  test(`${name} fails when a required thread card never arrives`, { timeout: 1000 }, async t => {
    const f = artifactPage(t)
    f.addCard(artifactFixture.artifactTitle)
    const { state, result } = f.start(name)
    await nextTurn()
    assert.equal(state.completed, false)
    f.expire()
    await assert.rejects(result, /PARITY_FIXTURE_WAIT_TIMEOUT/)
  })
}

test('artifact HTML still requires the rendered iframe document', { timeout: 1000 }, async t => {
  const f = artifactPage(t, { frameReady: false })
  f.addCard(artifactFixture.artifactTitle)
  f.addCard(artifactFixture.htmlTitle)
  const { state, result } = f.start('artifact-html')
  await nextTurn()
  assert.equal(state.completed, false)
  f.update(() => { f.frame.body.innerHTML = '<h1>Desktop review</h1>' })
  await result
  assert.equal(state.completed, true)
})
