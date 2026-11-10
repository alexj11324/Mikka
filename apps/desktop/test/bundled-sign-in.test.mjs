import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import vm from 'node:vm'
import { signInBundledAccount } from './bundled-sign-in.mjs'

const contextLost = () => new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.')
const publicSession = userId => ({ user: { id: userId }, session: { id: `public-session-${userId}` } })

// Control delivery of the main IPC reply separately from the external-URL
// observation. The actual harness, browser-continuation helper and session
// reader run unchanged; no account, cookie, credential or provider is involved.
function fixture({ delayedReply = false, registrationError, callbackError,
  navigate = 'main', returnedUrl = 'mikka://app/mikka', actualOwner = 'peer', sessionError } = {}) {
  const page = new EventEmitter(), events = [], resources = [], inputs = [], state = {}, shell = {}
  const registration = Promise.withResolvers(), callback = Promise.withResolvers()
  let registered = false, currentUrl = 'mikka://app/mikka', contexts = 0, closed = 0, sessionReads = 0
  const account = { userId: 'peer', storageStatePath: '/owned-fixture/peer-state.json' }
  const window = { mikka: { bundled: {
    signIn(input) {
      events.push('sign-in'); inputs.push(input)
      if (registrationError) { registration.reject(registrationError); return registration.promise }
      void shell.openExternal('http://localhost:3000/mikka/sign-in?desktop=1')
      const reply = () => { registered = true; events.push('registration-reply'); registration.resolve() }
      if (delayedReply) setImmediate(reply)
      else reply()
      return registration.promise
    },
    session() {
      events.push('public-session'); sessionReads++
      if (sessionError) throw sessionError
      return publicSession(actualOwner)
    },
  } } }
  page.url = () => currentUrl
  page.isClosed = () => false
  page.waitForURL = async (predicate, options) => {
    assert.equal(options.waitUntil, 'domcontentloaded')
    if (!predicate(new URL(currentUrl))) throw new Error('DOCUMENT_OUTSIDE_BUNDLED_NAMESPACE')
    events.push('bundled-document')
  }
  page.waitForFunction = async predicate => {
    assert.equal(vm.runInNewContext(`(${predicate})()`, { window }), true)
  }
  page.evaluate = async fn => vm.runInNewContext(`(${fn})()`, { window })
  page.waitForEvent = (event, { timeout }) => new Promise((resolve, reject) => {
    assert.equal(event, 'domcontentloaded')
    events.push('arm-return-document')
    const loaded = () => { clearTimeout(timer); page.off(event, loaded); resolve(page) }
    const timer = setTimeout(() => { page.off(event, loaded); reject(new Error('RETURN_DOCUMENT_TIMEOUT')) }, timeout)
    page.on(event, loaded)
  })
  const application = { evaluate: async fn => vm.runInNewContext(`(${fn})({ shell })`, { shell, globalThis: state }) }
  const browserPage = {
    waitForResponse(predicate) {
      const response = { url: () => 'http://127.0.0.1:41000/auth/callback', status: () => 200,
        text: async () => '<a id="open" href="mikka-dev-auth://auth/done">Open</a>' }
      assert.equal(predicate(response), true)
      return callback.promise.then(() => response)
    },
    async goto(url) { assert.equal(new URL(url).origin, 'http://localhost:3000'); events.push('browser-open') },
    getByTestId(id) {
      assert.equal(id, 'desktop-continue')
      return { async click() {
        events.push('browser-continue')
        if (callbackError) throw callbackError
        // A callback can replace the originating document before a delayed
        // Playwright evaluate reply. This is the exact CI failure ordering.
        if (!registered) registration.reject(contextLost())
        currentUrl = returnedUrl
        if (navigate === 'main') page.emit('domcontentloaded')
        else if (navigate === 'child') page.emit('child-domcontentloaded')
        callback.resolve()
      } }
    },
  }
  const browser = { async newContext(options) {
    contexts++
    assert.deepEqual(options, { storageState: account.storageStatePath })
    return { newPage: async () => browserPage, close: async () => { closed++; events.push('browser-close') } }
  } }
  const scope = { recordResource: async resource => { resources.push(resource); events.push('record-session') } }
  return { page, events, resources, inputs,
    run: () => signInBundledAccount({ application, page, browser, account, scope,
      origin: 'http://localhost:3000', mark: value => events.push(`phase:${value}`), timeout: 35 }),
    counts: () => ({ contexts, closed, sessionReads }),
  }
}

test('the delayed registration reply completes before the real browser continuation can navigate', async () => {
  const state = fixture({ delayedReply: true })
  assert.deepEqual(await state.run(), publicSession('peer'))
  assert.equal(state.inputs.length, 1)
  assert.ok(state.events.indexOf('registration-reply') < state.events.indexOf('browser-continue'))
  assert.ok(state.events.indexOf('arm-return-document') < state.events.indexOf('browser-continue'))
  assert.ok(state.events.indexOf('public-session') > state.events.indexOf('browser-continue'))
  assert.deepEqual(state.resources, [{ type: 'session', id: 'public-session-peer', ownerId: 'peer' }])
  assert.deepEqual(state.counts(), { contexts: 1, closed: 1, sessionReads: 1 })
  assert.equal(state.page.listenerCount('domcontentloaded'), 0)
})

test('ordinary reply ordering preserves the exact provider, next route, owner and session resource', async () => {
  const state = fixture()
  assert.deepEqual(await state.run(), publicSession('peer'))
  assert.equal(JSON.stringify(state.inputs), JSON.stringify([{ provider: 'google', locale: 'zh-CN', next: '/' }]))
  assert.deepEqual(state.resources, [{ type: 'session', id: 'public-session-peer', ownerId: 'peer' }])
  assert.equal(state.counts().closed, 1)
})

test('registration failure never opens a browser or repeats sign-in', async () => {
  const error = new Error('REGISTRATION_REFUSED'), state = fixture({ registrationError: error })
  await assert.rejects(state.run(), value => value === error || value.cause === error)
  assert.equal(state.inputs.length, 1)
  assert.equal(state.counts().contexts, 0)
  assert.deepEqual(state.resources, [])
})

test('an unrelated early context loss is still a failure, not proof of authentication', async () => {
  const error = contextLost(), state = fixture({ registrationError: error })
  await assert.rejects(state.run(), value => value === error || value.cause === error)
  assert.equal(state.inputs.length, 1)
  assert.equal(state.counts().contexts, 0)
  assert.deepEqual(state.resources, [])
})

test('a completed navigation with the retained prior owner never authorizes the expected new account', async () => {
  const state = fixture({ actualOwner: 'original-owner' })
  await assert.rejects(state.run(), /NATIVE_SESSION_WAIT_TIMEOUT/)
  assert.equal(state.inputs.length, 1)
  assert.equal(state.counts().closed, 1)
  assert.deepEqual(state.resources, [])
})

test('a correct session without a real main-document return does not pass', async () => {
  for (const navigate of ['none', 'child']) {
    const state = fixture({ navigate })
    await assert.rejects(state.run(), /RETURN_DOCUMENT_TIMEOUT/)
    assert.equal(state.inputs.length, 1)
    assert.equal(state.counts().closed, 1)
    assert.equal(state.counts().sessionReads, 0)
    assert.equal(state.page.listenerCount('domcontentloaded'), 0)
    assert.deepEqual(state.resources, [])
  }
})

test('public session IPC refusal retains its cause and closes the browser without recording a resource', async () => {
  const error = new Error('SESSION_IPC_REFUSED'), state = fixture({ sessionError: error })
  await assert.rejects(state.run(), value => value === error)
  assert.equal(state.inputs.length, 1)
  assert.equal(state.counts().closed, 1)
  assert.deepEqual(state.resources, [])
})

test('browser callback failure is not replaced by an auth success or another sign-in', async () => {
  const error = new Error('CALLBACK_REFUSED'), state = fixture({ callbackError: error })
  await assert.rejects(state.run(), value => value === error)
  assert.equal(state.inputs.length, 1)
  assert.equal(state.counts().closed, 1)
  assert.deepEqual(state.resources, [])
})
