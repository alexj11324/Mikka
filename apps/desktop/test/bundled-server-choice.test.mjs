import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { selectBundledServer } from './bundled-server-choice.mjs'

const contextLoss = () => new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.')
function fixture({ navigate = true, target = 'chosen', error, protocolError, pending = false, subframe = false } = {}) {
  const page = new EventEmitter(), main = {}, child = {}
  page.mainFrame = () => main
  page.calls = 0; page.selections = []; page.waits = 0; page.disposals = 0
  page.target = 'old'
  page.evaluate = (fn, argument) => {
    page.calls++
    page.observedBeforeDispatch = page.listenerCount('framenavigated') > 0
    const previous = globalThis.window
    globalThis.window = { mikka: { bundled: { server: { select(value) {
      page.selections.push(value)
      if (navigate) { page.target = target; page.emit('framenavigated', subframe ? child : main) }
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
  page.waitForFunction = async (_predicate, expectedUrl) => {
    page.waits++
    if (page.target !== expectedUrl) return new Promise(() => {})
    return { dispose: async () => { page.disposals++ } }
  }
  return page
}
const run = (page, selection = 'chosen') => selectBundledServer(page, selection, 'chosen', { timeout: 20 })
const clean = page => {
  assert.equal(page.listenerCount('framenavigated'), 0)
  assert.equal(page.calls, 1)
  assert.equal(page.selections.length, 1)
}

test('reload before the evaluate reply is accepted only after the actual main-frame target', async () => {
  const page = fixture({ protocolError: contextLoss() })
  await run(page)
  assert.equal(page.observedBeforeDispatch, true)
  assert.equal(page.waits, 1); assert.equal(page.disposals, 1)
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
    assert.equal(page.waits, 0)
    clean(page)
  }
})

test('navigation to a wrong server never validates a lost evaluate reply', async () => {
  const page = fixture({ target: 'wrong', protocolError: contextLoss() })
  await assert.rejects(run(page), /NATIVE_SERVER_CHOICE_TIMEOUT/)
  clean(page)
})

test('ready target plus real navigation cannot hang on an unresolved selection reply', async () => {
  const page = fixture({ pending: true })
  await assert.rejects(run(page), /NATIVE_SERVER_CHOICE_TIMEOUT/)
  assert.equal(page.waits, 1)
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
  assert.equal(page.listenerCount('framenavigated'), 0)
})

test('invalid deadlines fail before any dispatch or listener', async () => {
  for (const timeout of [0, -1, Infinity, NaN]) {
    const page = fixture()
    await assert.rejects(selectBundledServer(page, null, 'chosen', { timeout }), /OPTIONS_INVALID/)
    assert.equal(page.calls, 0)
    assert.equal(page.listenerCount('framenavigated'), 0)
  }
})
