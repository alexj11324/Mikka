import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { Window } from 'happy-dom'
import { captureParityReadReceipts, parityBotReadKeys } from './parity-reads.mjs'
import { observeReads, pageReady, selectParityWorkspace, selectWorkspaceMenuItem } from './parity-page-ready.mjs'
import { compareImages } from './parity-images.mjs'

const ids = { coordinator: 'coordinator-bot', bot: 'bot', coordinatorUser: 'c1', coordinatorReply: 'c2', botUser: 'b1', botReply: 'b2' }

for (const restored of [false, true]) test(`workspace capture completes the ${restored ? 'restored' : 'cold'} two-message history through its real button`, async () => {
  const history = Promise.withResolvers()
  const events = []
  const earlier = {
    isVisible: async () => restored,
    click: async () => { events.push('history-click') },
    waitFor: async options => {
      assert.equal(options.state, 'hidden')
      if (restored) await history.promise
      events.push('history-complete')
    },
  }
  const ready = { getByRole: () => ready, getByText: () => ready, waitFor: async () => {} }
  const conversation = {
    getByRole: (_role, options) => { assert.equal(options.name, 'Earlier messages'); return earlier },
    getByText: value => ({ waitFor: async () => { events.push(value) } }),
  }
  const page = { getByRole: role => role === 'region' ? conversation : ready }
  const messages = { Nav: {}, Shell: { panel: {} }, Coordinator: { conversation: 'Conversation' }, Common: { loadMore: 'Earlier messages' } }
  let completed = false
  const pending = pageReady(page, 'workspace-link', {}, messages).then(() => { completed = true })
  await new Promise(setImmediate)
  assert.equal(completed, !restored)
  if (restored) {
    assert.deepEqual(events, ['history-click'])
    history.resolve()
  }
  await pending
  assert.deepEqual(events, [...(restored ? ['history-click'] : []), 'history-complete',
    'What should we review today?', 'Review the desktop workspace, including conversations, tasks, artifacts and settings.'])
})

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
    // The response is already the one the real Page would emit; the transport
    // trace listeners only need to exist.
    on: () => undefined,
    off: () => undefined,
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

function workspacePage({ current = false, clickError } = {}) {
  const document = Promise.withResolvers()
  const calls = { menu: 0, item: 0, document: 0, menuReady: 0, observedBeforeClick: false }
  const menu = { first: () => menu, click: async () => { calls.menu++ }, waitFor: async () => { calls.menuReady++ } }
  const item = { getAttribute: async name => { assert.equal(name, 'aria-current'); return current ? 'true' : null }, click: async () => {
    calls.item++
    calls.observedBeforeClick = calls.document === 1
    if (clickError) throw clickError
  } }
  const page = {
    getByRole: role => { assert.ok(['button', 'menuitem'].includes(role)); return role === 'button' ? menu : item },
    // Both the old and new documents have this URL and the same ready menu.
    waitForURL: async predicate => { assert.equal(predicate(new URL('http://localhost:3000/mikka/en')), true) },
    waitForEvent: event => { assert.equal(event, 'domcontentloaded'); calls.document++; return document.promise },
  }
  const start = () => selectParityWorkspace(page, { menuName: 'Workspace', workspaceName: 'Fixture', basePath: '/mikka' })
  return { calls, document, start }
}

test('workspace selection waits for the new document even when its URL and old DOM already match', { timeout: 1000 }, async () => {
  const f = workspacePage()
  let completed = false
  const result = f.start().then(() => { completed = true })
  await nextTurn()
  assert.equal(completed, false, 'The old matching URL must not complete a real workspace switch')
  assert.equal(f.calls.observedBeforeClick, true, 'Observe the new document before the single switch click')
  assert.equal(f.calls.item, 1)
  assert.equal(f.calls.menuReady, 0)
  f.document.resolve()
  await result
  assert.equal(completed, true)
  assert.equal(f.calls.menuReady, 1)
})

test('the already-selected workspace closes its menu once without awaiting a nonexistent navigation', async () => {
  const f = workspacePage({ current: true })
  await f.start()
  assert.equal(f.calls.item, 1)
  assert.equal(f.calls.document, 0)
  assert.equal(f.calls.menuReady, 1)
})

test('workspace selection preserves a failed document wait and never retries the switch', async () => {
  const f = workspacePage()
  const failed = new Error('DOCUMENT_LOAD_FAILED')
  const result = f.start()
  const rejected = assert.rejects(result, error => error === failed)
  void rejected.catch(() => {})
  await nextTurn()
  if (f.calls.document) f.document.reject(failed)
  await rejected
  assert.equal(f.calls.item, 1)
  assert.equal(f.calls.menuReady, 0)
})

test('workspace selection preserves click failures while its pending document observer is safely settled', async () => {
  const failed = new Error('WORKSPACE_CLICK_FAILED')
  const f = workspacePage({ clickError: failed })
  await assert.rejects(f.start(), error => error === failed)
  if (f.calls.document) f.document.reject(new Error('DOCUMENT_LOAD_TIMEOUT'))
  await nextTurn()
  assert.equal(f.calls.item, 1)
  assert.equal(f.calls.menuReady, 0)
})

// Exercise the actual lifecycle caller without starting Electron, fixtures or
// a server. The default locale stays unchanged while the document is replaced.
const lifecycleSource = await readFile(new URL('./lifecycle.mjs', import.meta.url), 'utf8')
const selectFixtureSource = lifecycleSource.match(/async function selectFixture\(page\) \{[\s\S]*?\n\}/)?.[0]
assert.ok(selectFixtureSource, 'The lifecycle workspace selector must remain testable')
function lifecycleWorkspace({ current = false, clickError } = {}) {
  const f = workspacePage({ current, clickError })
  let usableReads = 0, readyDocument = current
  const selected = []
  const item = { getAttribute: async () => current ? 'true' : null, click: async () => {
    f.calls.item++
    f.calls.observedBeforeClick = f.calls.document === 1
    if (clickError) throw clickError
  } }
  const menu = { first: () => menu, click: async () => { f.calls.menu++ } }
  const page = {
    waitForFunction: async () => {}, evaluate: async () => 'zh-CN',
    getByRole: (role, options) => { selected.push({ role, ...options }); return role === 'button' ? menu : item },
    waitForEvent: event => { assert.equal(event, 'domcontentloaded'); f.calls.document++; return f.document.promise },
  }
  const select = vm.runInNewContext(`(${selectFixtureSource})`, {
    menuNames: { 'zh-CN': 'Workspace' }, fixtures: { fixture: { workspaceName: 'Fixture' } }, selectWorkspaceMenuItem,
    usable: async () => { usableReads++; if (!readyDocument) throw new Error('Execution context was destroyed, most likely because of a navigation') },
  })
  return { ...f, selected, usableReads: () => usableReads, start: () => select(page), loaded: () => { readyDocument = true; f.document.resolve() } }
}

test('lifecycle workspace selection waits for the switched document before its viewport readiness read', { timeout: 1000 }, async () => {
  const f = lifecycleWorkspace()
  const result = f.start()
  void result.catch(() => {})
  await nextTurn()
  assert.equal(f.usableReads(), 0, 'A matching old document cannot begin the lifecycle viewport read')
  assert.equal(f.calls.observedBeforeClick, true)
  assert.deepEqual(f.selected.at(-1), { role: 'menuitem', name: 'Fixture', exact: true })
  f.loaded()
  assert.equal(await result, 'zh-CN')
  assert.equal(f.usableReads(), 1)
  assert.equal(f.calls.item, 1)
})

test('lifecycle workspace selection keeps the current default-locale document without waiting for navigation', async () => {
  const f = lifecycleWorkspace({ current: true })
  assert.equal(await f.start(), 'zh-CN')
  assert.equal(f.usableReads(), 1)
  assert.equal(f.calls.document, 0)
  assert.equal(f.calls.item, 1)
})

test('lifecycle workspace selection preserves navigation failure before any viewport read', async () => {
  const f = lifecycleWorkspace()
  const failed = new Error('DOCUMENT_LOAD_FAILED')
  const rejected = assert.rejects(f.start(), error => error === failed)
  void rejected.catch(() => {})
  await nextTurn()
  if (f.calls.document) f.document.reject(failed)
  await rejected
  assert.equal(f.usableReads(), 0)
  assert.equal(f.calls.item, 1)
})

test('lifecycle workspace selection preserves a single click failure and drains its pending observer', async () => {
  const failed = new Error('WORKSPACE_CLICK_FAILED')
  const f = lifecycleWorkspace({ clickError: failed })
  await assert.rejects(f.start(), error => error === failed)
  if (f.calls.document) f.document.reject(new Error('DOCUMENT_LOAD_TIMEOUT'))
  await nextTurn()
  assert.equal(f.usableReads(), 0)
  assert.equal(f.calls.item, 1)
})

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

const taskFixture = { issueTitle: 'Review the desktop workspace', agentLabel: 'Codex' }
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
        assert.deepEqual(options, { name: 'Open thread Codex', exact: true, pressed: true })
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
