import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { selectBundledServer } from './bundled-server-choice.mjs'
import { selectBundledServer as canonicalSelect } from './native-document.mjs'

const contextLoss = () => new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.')
function fixture({ navigate = true, target = 'chosen', error, protocolError, pending = false, subframe = false,
  history = false, preflightDelay = 0, preflightFailure, readFailure, readPending = false } = {}) {
  const page = new EventEmitter(), main = {}, child = {}
  page.mainFrame = () => main
  page.calls = 0; page.selections = []; page.reads = 0; page.budgets = []
  page.target = 'old'
  page.url = () => 'mikka://app/mikka/sign-in'
  page.waitForURL = async (predicate, options) => {
    assert.equal(predicate(new URL(page.url())), true)
    assert.equal(options.waitUntil, 'domcontentloaded')
    assert.ok(Number.isFinite(options.timeout) && options.timeout > 0 && options.timeout <= 137)
    if (page.budgets.length) assert.ok(options.timeout <= page.budgets.at(-1))
    page.budgets.push(options.timeout)
    if (preflightDelay) await new Promise(resolve => setTimeout(resolve, preflightDelay))
    if (preflightFailure) throw preflightFailure
  }
  // Kept only for the P0-before RED; the candidate owns and removes its listener.
  page.waitForEvent = (event, options) => new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); page.off(event, done); resolve() }
    const timer = setTimeout(() => { page.off(event, done); reject(new Error('SDK_WAITER_TIMEOUT')) }, options.timeout)
    page.on(event, done)
  })
  page.evaluate = (fn, ...args) => {
    if (!args.length) {
      page.reads++
      if (readFailure) return Promise.reject(readFailure)
      if (readPending) return new Promise(() => {})
      const previous = globalThis.window
      globalThis.window = { mikka: { app: { serverUrl: page.target } } }
      try { return Promise.resolve(fn()) } finally {
        if (previous === undefined) delete globalThis.window
        else globalThis.window = previous
      }
    }
    const argument = args[0]
    page.calls++
    page.observedBeforeDispatch = page.listenerCount('domcontentloaded') > 0
    const previous = globalThis.window
    globalThis.window = { mikka: { bundled: { server: { select(value) {
      page.selections.push(value)
      if (navigate) {
        page.target = target
        page.emit('framenavigated', subframe ? child : main)
        if (!subframe && !history) page.emit('domcontentloaded', page)
      }
      if (error) return Promise.reject(error)
      return pending ? new Promise(() => {}) : Promise.resolve()
    } } } } }
    let result
    try { result = fn(argument) } finally {
      if (previous === undefined) delete globalThis.window
      else globalThis.window = previous
    }
    if (protocolError) {
      Promise.resolve(result).catch(() => {})
      return Promise.reject(protocolError)
    }
    return Promise.resolve(result)
  }
  return page
}
const run = (page, selection = 'chosen') => selectBundledServer(page, selection, 'chosen', { timeout: 20 })
const clean = page => {
  assert.equal(page.listenerCount('framenavigated'), 0)
  assert.equal(page.listenerCount('domcontentloaded'), 0)
  assert.equal(page.listenerCount('close'), 0)
  assert.equal(page.listenerCount('crash'), 0)
  assert.equal(page.calls, 1)
  assert.equal(page.selections.length, 1)
}

test('reload before the evaluate reply is accepted only after the actual main-frame target', async () => {
  const page = fixture({ protocolError: contextLoss() })
  await run(page)
  assert.equal(page.observedBeforeDispatch, true)
  assert.equal(page.reads, 1)
  clean(page)
})

test('normal selection and returning to built-in dispatch each exact argument once', async () => {
  for (const selection of ['chosen', null]) {
    const page = fixture()
    await run(page, selection)
    assert.deepEqual(page.selections, [selection])
    assert.equal(page.observedBeforeDispatch, true)
    clean(page)
  }
})

test('selection refusal remains the original failure even if navigation and target look ready', async () => {
  const error = new Error('unprobed server refused')
  const page = fixture({ error })
  await assert.rejects(run(page), value => value === error)
  clean(page)
})

test('unrelated evaluate errors and detached frames are never classified as navigation success', async () => {
  for (const message of ['Invalid renderer frame', 'Frame was detached', 'Execution context was destroyed: another error']) {
    const error = new Error(message), page = fixture({ protocolError: error })
    await assert.rejects(run(page), value => value === error)
    clean(page)
  }
})

test('a context loss with no navigation or only a child-frame navigation fails by deadline', async () => {
  for (const options of [{ navigate: false }, { subframe: true }]) {
    const page = fixture({ ...options, protocolError: contextLoss() })
    await assert.rejects(run(page), /NATIVE_SERVER_CHOICE_TIMEOUT/)
    assert.equal(page.reads, 0)
    clean(page)
  }
})

test('navigation to a wrong server never validates a lost evaluate reply', async () => {
  const page = fixture({ target: 'wrong', protocolError: contextLoss() })
  await assert.rejects(run(page), { code: 'ERR_ASSERTION' })
  assert.equal(page.reads, 1)
  clean(page)
})

test('ready target plus real navigation cannot hang on an unresolved selection reply', async () => {
  const page = fixture({ pending: true })
  await assert.rejects(run(page), /NATIVE_SERVER_CHOICE_TIMEOUT/)
  assert.equal(page.reads, 0)
  clean(page)
})

test('a selection that resolves without main-frame navigation is not accepted', async () => {
  const page = fixture({ navigate: false })
  page.target = 'chosen'
  await assert.rejects(run(page), /NATIVE_SERVER_CHOICE_TIMEOUT/)
  clean(page)
})

test('late dispatch rejection after timeout is handled and cannot reopen the listener', async () => {
  const page = fixture()
  let rejectDispatch
  page.evaluate = () => new Promise((_, reject) => { rejectDispatch = reject })
  await assert.rejects(run(page), /NATIVE_SERVER_CHOICE_TIMEOUT/)
  rejectDispatch(new Error('late IPC failure'))
  await new Promise(resolve => setImmediate(resolve))
  for (const event of ['domcontentloaded', 'close', 'crash', 'framenavigated']) assert.equal(page.listenerCount(event), 0)
})

test('invalid deadlines fail before any dispatch or listener', async () => {
  for (const timeout of [0, -1, Infinity, NaN]) {
    const page = fixture()
    await assert.rejects(selectBundledServer(page, null, 'chosen', { timeout }), /OPTIONS_INVALID/)
    assert.equal(page.calls, 0)
    for (const event of ['domcontentloaded', 'close', 'crash', 'framenavigated']) assert.equal(page.listenerCount(event), 0)
  }
})

test('preflight completing after the total deadline cannot dispatch or add a listener', async () => {
  const page = fixture({ preflightDelay: 45 })
  const started = performance.now()
  await assert.rejects(canonicalSelect(page, 'chosen', 'chosen', { timeout: 15 }), /NATIVE_SERVER_CHOICE_TIMEOUT/)
  assert.ok(performance.now() - started < 150, 'one bounded deadline covers preflight')
  await new Promise(resolve => setTimeout(resolve, 55))
  assert.equal(page.calls, 0); assert.equal(page.reads, 0)
  for (const event of ['domcontentloaded', 'close', 'crash', 'framenavigated']) assert.equal(page.listenerCount(event), 0)
})
test('a History or same-document main-frame event is not a next document', async () => {
  const page = fixture({ history: true })
  await assert.rejects(run(page), /NATIVE_SERVER_CHOICE_TIMEOUT/)
  assert.equal(page.reads, 0); clean(page)
})
test('both import paths expose the exact same canonical function', () => {
  assert.equal(selectBundledServer, canonicalSelect)
})
test('SDK preflight errors and target-read context errors retain their actual identity', async () => {
  const before = new Error('SDK_PREFLIGHT_FAILED')
  const page = fixture({ preflightFailure: before })
  await assert.rejects(run(page), error => error === before)
  assert.equal(page.calls, 0)
  const readFailure = contextLoss(), target = fixture({ readFailure })
  await assert.rejects(run(target), error => error === readFailure)
  assert.equal(target.reads, 1); clean(target)
})
test('the final immutable target read is covered by the same deadline', async () => {
  const page = fixture({ readPending: true })
  await assert.rejects(run(page), /NATIVE_SERVER_CHOICE_TIMEOUT/)
  assert.equal(page.reads, 1); clean(page)
})
test('deadline budget is positive and cannot restart after slow preflight', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const page = fixture({ preflightDelay: 35, pending: true })
  const pending = selectBundledServer(page, null, 'chosen', { timeout: 60 }).then(() => null, error => error)
  t.mock.timers.tick(35)
  await new Promise(setImmediate)
  assert.deepEqual(page.selections, [null])
  t.mock.timers.tick(25)
  assert.match((await pending).message, /NATIVE_SERVER_CHOICE_TIMEOUT/, '35ms preflight leaves only 25ms, never a second 60ms budget')
  assert.ok(page.budgets.every((value, index, all) => value > 0 && value <= 60 && (!index || value <= all[index - 1])))
  assert.deepEqual(page.selections, [null]); clean(page)
})

test('page close after the next DCL still rejects a pending reply or target read', async () => {
  for (const options of [{ pending: true }, { readPending: true }]) {
    const page = fixture(options)
    const pending = run(page).then(() => null, error => error)
    await new Promise(setImmediate)
    page.emit('close')
    assert.match((await pending).message, /NATIVE_SERVER_CHOICE_PAGE_CLOSED/)
    clean(page)
  }
})
