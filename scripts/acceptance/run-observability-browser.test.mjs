import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { runObservabilityWorkflow } from './run-observability-workflow.mjs'
import { startObservabilityBrowser, ObservabilityBrowserError } from './run-observability-browser.mjs'
import { CASES, fixtureTask, ORIGIN } from './run-observability.mjs'

const revision = 'a'.repeat(40), owner = 'synthetic-browser-owner'
const workspaceId = '77777777-7777-4777-8777-777777777777'
const otherWorkspace = '88888888-8888-4888-8888-888888888888'
const botId = '99999999-9999-4999-8999-999999999999'
const HOME = ORIGIN + '/mikka/en'
const EMAIL = 'actor-fixture@example.invalid'
const PASSWORD = 'SYNTHETIC_ONLY_BROWSER_PASSWORD'
const CANARY = 'PRIVATE_PLAYWRIGHT_PAYLOAD_CANARY'
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

function inputs() {
  let time = 1_800_000_000_000
  const item = CASES[0], fixture = fixtureTask(revision, item), controller = new AbortController()
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'alexj11324/Mikka',
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: revision, MIKKA_EXPECTED_DEPLOYMENT_SHA: revision,
    MIKKA_OBSERVABILITY_MODEL_CASE: item.id, ACME_DEMO_EMAIL: EMAIL, ACME_DEMO_PASSWORD: PASSWORD,
    PATH: '/usr/bin', HOME: '/synthetic-home', GITHUB_TOKEN: 'SYNTHETIC_GITHUB_TOKEN', PROVIDER_KEY: 'SYNTHETIC_PROVIDER_KEY' }
  const ready = { type: 'mikka_observability_browser_ready', version: 1, revision, case: item.id, workspaceId, botId,
    profileId: fixture.profileId, marker: fixture.marker, model: item.model, harness: item.harness, destination: 'cloud',
    input: fixture.input, artifact: { title: fixture.title, content: fixture.content }, expiresAt: new Date(time + 480_000).toISOString() }
  return { ready, env, signal: controller.signal, controller, now: () => time, expire: () => { time += 480_001 } }
}

function browserFixture(input, options = {}) {
  const calls = [], reports = [], emitter = new EventEmitter(), login = deferred(), navigation = deferred()
  const state = { url: HOME + '/sign-in', signedIn: false, selected: options.switchWorkspace ? otherWorkspace : workspaceId,
    pageClosed: false, contextClosed: false, browserClosed: false, submissionSent: 0, submitAttempts: 0,
    signOuts: 0, versions: 0, pendingClick: null, navigationWaits: 0, replayHandlesDisposed: 0 }
  const response = (url, value, status = 200) => ({
    url: () => url, status: () => status, request: () => ({ method: () => 'POST', resourceType: () => 'fetch' }),
    body: async () => Buffer.from(JSON.stringify(value)), finished: async () => null, dispose: async () => {},
  })
  const session = () => state.signedIn ? { user: { id: owner, email: EMAIL, name: CANARY }, session: { token: CANARY } } : null
  const api = {
    async fetch(url, config) {
      const path = new URL(url).pathname
      calls.push({ type: 'api', path, method: config.method, pageClosed: state.pageClosed, contextClosed: state.contextClosed })
      assert.equal(state.contextClosed, false, 'logout/readback must retain the context cookie jar')
      assert.equal(config.maxRedirects, 0)
      assert.equal(new URL(url).origin, ORIGIN)
      assert.equal(Object.keys(config.headers).some(key => /cookie|authorization|posthog|traceparent/i.test(key)), false)
      if (path.endsWith('/api/version')) {
        state.versions++
        return response(url, { build: options.buildChange && state.versions > 1 ? 'b'.repeat(40) : revision })
      }
      if (path.endsWith('/api/auth/get-session')) return response(url, session())
      if (path.endsWith('/api/auth/sign-out')) {
        state.signOuts++
        // A pending click is still capable of dispatch if cleanup leaves its
        // page alive while awaiting the sign-out HTTP request.
        if (state.pendingClick && !state.pageClosed) state.submissionSent++
        if (options.signOutFails) throw new Error(CANARY)
        state.signedIn = false
        return response(url, { success: true })
      }
      if (path.endsWith('/api/workspace/switcher')) {
        const choices = [{ id: workspaceId, name: 'Synthetic personal' }]
        if (options.ambiguousWorkspace) choices.push({ id: otherWorkspace, name: 'Synthetic personal' })
        if (options.switchWorkspace && !options.ambiguousWorkspace) choices.push({ id: otherWorkspace, name: 'Synthetic team' })
        return response(url, { workspace: { id: state.selected }, accounts: [
          { id: options.otherOwner ? 'different-owner' : owner, email: EMAIL, choices },
        ] })
      }
      if (path.endsWith('/api/workspace')) return response(url, { currentUserId: owner,
        workspace: { id: state.selected, kind: 'personal' }, role: 'admin',
        members: [{ userId: owner, role: 'admin', status: 'active' }] })
      throw new Error('unexpected API path')
    },
  }
  const locator = descriptor => {
    const value = {
      descriptor,
      getByRole: (role, config = {}) => locator({ role, name: config.name, scope: descriptor }),
      getByText: (name, config = {}) => locator({ role: 'text', name, exact: config.exact, scope: descriptor }),
      getByLabel: (name, config = {}) => locator({ role: 'label', name, exact: config.exact, scope: descriptor }),
      filter: filter => locator({ ...descriptor, has: filter.has?.descriptor }),
      async count() {
        if (descriptor.role === 'combobox' && descriptor.name === 'Bot to hand it to') return options.noBotPicker ? 0 : 1
        if (descriptor.role === 'option' && descriptor.has?.name === input.ready.marker && options.ambiguousProfile) return 2
        return 1
      },
      async waitFor(config) {
        calls.push({ type: 'wait', role: descriptor.role, name: descriptor.name, state: config.state })
        if (descriptor.role === 'dialog' && descriptor.name === 'New task' && config.state === 'hidden' && options.submitUnknown) throw new Error(CANARY)
      },
      async isEnabled() { return !options.disabledSubmit },
      async fill(text) {
        calls.push({ type: 'fill', label: descriptor.name })
        if (descriptor.name === 'Email') assert.equal(text, EMAIL)
        else if (descriptor.name === 'Password') assert.equal(text, PASSWORD)
        else if (descriptor.name === 'Task description') {
          assert.equal(text, input.ready.input)
          if (options.expireBeforeSubmit) input.expire()
          if (options.abortBeforeSubmit) input.controller.abort()
        } else assert.fail('unexpected field')
      },
      async click() {
        calls.push({ type: 'click', role: descriptor.role, name: descriptor.name, has: descriptor.has?.name, scope: descriptor.scope })
        if (descriptor.name === 'Sign in to the workspace') {
          state.signedIn = !options.loginRefused
          state.url = HOME
          login.resolve(response(ORIGIN + '/mikka/api/auth/sign-in/email', null, options.loginRefused ? 401 : 200))
          if (options.foreignBusiness) emitter.emit('request', { url: () => 'https://synthetic-server.invalid/api/rpc' })
          if (!options.noCloudResponse) emitter.emit('response', response(ORIGIN + '/mikka/api/rpc', {}))
        } else if (descriptor.role === 'menuitem') {
          const complete = () => {
            state.selected = workspaceId
            state.url = HOME
            navigation.resolve(response(HOME, null))
          }
          if (options.delayedNavigation) setImmediate(complete)
          else complete()
        } else if (descriptor.name === 'Create task') {
          state.submitAttempts++
          if (options.abortPendingClick) {
            const pending = deferred()
            state.pendingClick = pending
            input.controller.abort()
            return pending.promise
          }
          state.submissionSent++
          if (options.submitThrows) throw new Error(PASSWORD + CANARY)
        }
      },
    }
    return value
  }
  const healthyReplay = { version: 1, sdkLoaded: true, sessionId: '12345678-1234-4234-8234-123456789abc',
    recordingStarted: true, snapshotObserved: true, sessionObservedAt: input.now() - 5,
    snapshotObservedAt: input.now() - 2, observedAt: input.now() }
  let replayState = Object.hasOwn(options, 'replayState') ? options.replayState : healthyReplay
  const browserContext = options.missingReplayBridge ? {} : { __mikkaReplayReadiness() {
    if (options.replayThrows) throw new Error(CANARY)
    return replayState
  } }
  const replayCall = fn => {
    const result = runInNewContext('(' + fn.toString() + ')()', browserContext)
    return result ? structuredClone(result) : null
  }
  const page = {
    async waitForFunction(fn, arg, config) {
      calls.push({ type: 'replayWait', timeout: config.timeout, polling: config.polling })
      assert.equal(arg, undefined)
      assert.equal(config.timeout > 0 && config.timeout <= 30_000, true)
      assert.equal(config.polling, 'raf')
      options.replayEntered?.resolve()
      if (options.replayWait) await options.replayWait.promise
      const value = replayCall(fn)
      if (!value) throw new Error(CANARY)
      return { async jsonValue() { return value }, async dispose() { state.replayHandlesDisposed++ } }
    },
    async evaluate(fn) {
      calls.push({ type: 'replayEvaluate' })
      if (Object.hasOwn(options, 'finalReplayState')) replayState = options.finalReplayState
      return replayCall(fn)
    },
    on: (event, handler) => emitter.on(event, handler),
    url: () => state.url,
    async goto(url) { calls.push({ type: 'goto', url }); state.url = options.foreignSignIn ? 'https://synthetic-server.invalid/sign-in' : url },
    getByRole: (role, config = {}) => locator({ role, name: config.name }),
    getByText: (name, config = {}) => locator({ role: 'text', name, exact: config.exact }),
    getByLabel: (name, config = {}) => locator({ role: 'label', name, exact: config.exact }),
    waitForResponse: predicate => { assert.equal(predicate(response(ORIGIN + '/mikka/api/auth/sign-in/email', null)), true); return login.promise },
    async waitForURL(predicate) { assert.equal(predicate(new URL(state.url)), true) },
    waitForNavigation: () => { state.navigationWaits++; return navigation.promise },
    async close() {
      calls.push({ type: 'close', resource: 'page' })
      if (options.pageCloseFails) throw new Error(CANARY)
      state.pageClosed = true
      state.pendingClick?.reject(new Error(CANARY))
    },
  }
  const context = {
    request: api,
    async newPage() { calls.push({ type: 'newPage' }); return page },
    async close() { calls.push({ type: 'close', resource: 'context' }); state.contextClosed = true },
  }
  const browser = {
    async newContext(config) {
      calls.push({ type: 'newContext', config })
      assert.deepEqual(config, { locale: 'en-US', viewport: { width: 1440, height: 900 } })
      return context
    },
    async close() {
      calls.push({ type: 'close', resource: 'browser' }); state.browserClosed = true
      state.contextClosed = true
      state.pendingClick?.reject(new Error(CANARY)); state.pendingClick = null
    },
  }
  const chromiumImpl = {
    async launch(config) {
      calls.push({ type: 'launch', config })
      assert.deepEqual(Object.keys(config.env).sort(), ['HOME', 'PATH'])
      assert.equal(config.headless, true)
      assert.equal(config.env.HOME, '/synthetic-home')
      if (options.delayedLaunch) return options.delayedLaunch.promise
      return browser
    },
  }
  const args = { ...input, chromiumImpl, writeReport: async report => {
    if (options.writeFails) throw new Error(CANARY)
    reports.push(structuredClone(report))
  } }
  if (options.fastTimers) {
    args.setTimeoutImpl = (callback, ms) => setTimeout(callback, Math.min(ms, 5))
    args.clearTimeoutImpl = clearTimeout
  }
  return { args, calls, reports, state, browser }
}

function safeFailure(error, reports) {
  assert.ok(error instanceof ObservabilityBrowserError)
  assert.equal(error.cause, undefined)
  assert.match(error.message, /^browser_[a-z_]+$/)
  const text = JSON.stringify(reports)
  for (const forbidden of [EMAIL, PASSWORD, CANARY, 'SYNTHETIC_GITHUB_TOKEN', 'SYNTHETIC_PROVIDER_KEY']) assert.equal(text.includes(forbidden), false)
}

test('one actual UI submit stays open, uses no API submission, and closes its own session once', async () => {
  const f = browserFixture(inputs())
  const handle = await startObservabilityBrowser(f.args)
  assert.equal(f.state.submissionSent, 1)
  assert.equal(f.state.pageClosed, false)
  assert.equal(f.reports[0].submissionOutcome, 'confirmed')
  assert.equal(f.reports[0].cloudBackendConfirmed, true)
  assert.equal(f.calls.some(call => call.type === 'newContext' && ('storageState' in call.config || 'recordVideo' in call.config || 'recordHar' in call.config)), false)
  await handle.close(); await handle.close()
  assert.equal(f.state.signOuts, 1)
  assert.deepEqual(f.calls.filter(call => call.type === 'api' && call.method !== 'GET').map(call => call.path), ['/mikka/api/auth/sign-out'])
  assert.equal(f.calls.find(call => call.type === 'api' && call.path.endsWith('/sign-out')).pageClosed, true)
  assert.deepEqual(f.calls.filter(call => call.type === 'close').map(call => call.resource), ['page', 'context', 'browser'])
  assert.equal(f.reports.at(-1).cleanup.status, 'closed')
  assert.equal(f.reports.at(-1).cleanup.anonymousAfterLogout, true)
  safeFailure(new ObservabilityBrowserError('browser_ui_failed'), f.reports)
})

for (const kind of ['actions', 'event', 'repository', 'ref', 'sha', 'expiry', 'fixture', 'extra-ready', 'debug']) {
  test('refuses ' + kind + ' before launching or typing credentials', async () => {
    const input = inputs()
    if (kind === 'actions') input.env.GITHUB_ACTIONS = 'false'
    if (kind === 'event') input.env.GITHUB_EVENT_NAME = 'pull_request'
    if (kind === 'repository') input.env.GITHUB_REPOSITORY = 'other/repository'
    if (kind === 'ref') input.env.GITHUB_REF = 'refs/heads/feature'
    if (kind === 'sha') input.env.GITHUB_SHA = 'b'.repeat(40)
    if (kind === 'expiry') input.expire()
    if (kind === 'fixture') input.ready.input += CANARY
    if (kind === 'extra-ready') input.ready.extra = CANARY
    if (kind === 'debug') input.env.DEBUG = 'pw:api'
    const f = browserFixture(input)
    await assert.rejects(startObservabilityBrowser(f.args), error => { safeFailure(error, f.reports); return true })
    assert.equal(f.calls.length, 0)
    assert.equal(f.reports.at(-1).submitClicks, 0)
  })
}

test('workspace switch waits for the new HOME document, not the old HOME URL or hidden menu', async () => {
  const f = browserFixture(inputs(), { switchWorkspace: true, delayedNavigation: true })
  const handle = await startObservabilityBrowser(f.args)
  assert.equal(f.state.navigationWaits, 1)
  assert.equal(f.reports[0].workspaceSelection, 'switched_ui')
  assert.equal(f.state.submissionSent, 1)
  assert.equal(f.calls.some(call => call.type === 'api' && call.method === 'POST'), false)
  await handle.close()
})

for (const kind of ['ambiguousWorkspace', 'otherOwner', 'ambiguousProfile', 'disabledSubmit', 'buildChange', 'foreignSignIn', 'foreignBusiness']) {
  test('rejects ' + kind + ' without submitting and closes allocated resources', async () => {
    const f = browserFixture(inputs(), { [kind]: true })
    await assert.rejects(startObservabilityBrowser(f.args), error => { safeFailure(error, f.reports); return true })
    assert.equal(f.state.submissionSent, 0)
    assert.equal(f.state.pageClosed && f.state.contextClosed && f.state.browserClosed, true)
    if (kind === 'foreignSignIn') assert.equal(f.calls.some(call => call.type === 'fill'), false)
  })
}

for (const kind of ['expireBeforeSubmit', 'abortBeforeSubmit']) {
  test('checks ' + kind + ' after filling but before the paid side effect', async () => {
    const f = browserFixture(inputs(), { [kind]: true })
    await assert.rejects(startObservabilityBrowser(f.args), error => { safeFailure(error, f.reports); return true })
    assert.equal(f.state.submitAttempts, 0)
    assert.equal(f.state.signOuts, 1)
    assert.equal(f.reports.at(-1).cleanup.status, 'closed')
  })
}

test('no renderer business response cannot be replaced by the independent version API check', async () => {
  const f = browserFixture(inputs(), { noCloudResponse: true, fastTimers: true })
  await assert.rejects(startObservabilityBrowser(f.args), error => { safeFailure(error, f.reports); return true })
  assert.equal(f.state.submitAttempts, 0)
  assert.equal(f.reports.at(-1).versionBefore, true)
  assert.equal(f.reports.at(-1).officialBusinessResponses, 0)
  assert.equal(f.reports.at(-1).cloudBackendConfirmed, false)
})

test('an already aborted signal creates no browser or session', async () => {
  const input = inputs(); input.controller.abort()
  const f = browserFixture(input)
  await assert.rejects(startObservabilityBrowser(f.args), error => { safeFailure(error, f.reports); return true })
  assert.equal(f.calls.length, 0)
})

for (const kind of ['submitThrows', 'submitUnknown']) {
  test('never retries a submission with ' + kind + ' and retains its unknown outcome', async () => {
    const f = browserFixture(inputs(), { [kind]: true })
    await assert.rejects(startObservabilityBrowser(f.args), error => { safeFailure(error, f.reports); return true })
    assert.equal(f.state.submitAttempts, 1)
    assert.equal(f.state.submissionSent, 1)
    assert.equal(f.reports.at(-1).submitClicks, 1)
    assert.equal(f.reports.at(-1).submissionObserved, false)
    assert.equal(f.reports.at(-1).submissionOutcome, 'unknown')
    assert.equal(f.reports.at(-1).cleanup.status, 'closed')
  })
}

test('abort cancels a pending actionable click before any logout await', async () => {
  const f = browserFixture(inputs(), { abortPendingClick: true })
  await assert.rejects(startObservabilityBrowser(f.args), error => { safeFailure(error, f.reports); return true })
  assert.equal(f.state.submitAttempts, 1)
  assert.equal(f.state.submissionSent, 0)
  assert.equal(f.calls.find(call => call.type === 'api' && call.path.endsWith('/sign-out')).pageClosed, true)
  assert.equal(f.state.contextClosed && f.state.browserClosed, true)
  assert.equal(f.reports.at(-1).submissionOutcome, 'unknown')
})

test('logout failure still closes every owned resource and makes idempotent close fail', async () => {
  const f = browserFixture(inputs(), { signOutFails: true })
  const handle = await startObservabilityBrowser(f.args)
  for (let i = 0; i < 2; i++) await assert.rejects(handle.close(), error => { safeFailure(error, f.reports); return error.code === 'browser_cleanup_failed' })
  assert.equal(f.state.signOuts, 1)
  assert.equal(f.state.pageClosed && f.state.contextClosed && f.state.browserClosed, true)
  assert.equal(f.reports.at(-1).cleanup.status, 'failed')
})

test('report sink failure does not leak a page, context or browser', async () => {
  const f = browserFixture(inputs(), { writeFails: true })
  await assert.rejects(startObservabilityBrowser(f.args), error => { safeFailure(error, []); return error.code === 'browser_report_failed' })
  assert.equal(f.state.signOuts, 1)
  assert.equal(f.state.pageClosed && f.state.contextClosed && f.state.browserClosed, true)
})

test('a resource that arrives after bounded abort cleanup is closed, never reported as already closed', async () => {
  const input = inputs(), delayedLaunch = deferred()
  const f = browserFixture(input, { delayedLaunch, fastTimers: true })
  const started = startObservabilityBrowser(f.args).then(() => assert.fail('must abort'), error => error)
  await settle(); input.controller.abort()
  const error = await started
  safeFailure(error, f.reports)
  assert.equal(f.reports.at(-1).cleanup.pendingResourcesSettled, false)
  assert.equal(f.reports.at(-1).cleanup.browserClosed, null)
  delayedLaunch.resolve(f.browser)
  await settle()
  assert.equal(f.state.browserClosed, true)
})

test('a page-close failure stops the browser before any further cleanup wait can release a late click', async () => {
  const f = browserFixture(inputs(), { abortPendingClick: true, pageCloseFails: true })
  await assert.rejects(startObservabilityBrowser(f.args), error => { safeFailure(error, f.reports); return error.code === 'browser_cleanup_failed' })
  assert.equal(f.state.submissionSent, 0)
  const browserClosed = f.calls.findIndex(call => call.type === 'close' && call.resource === 'browser')
  const signOut = f.calls.findIndex(call => call.type === 'api' && call.path.endsWith('/sign-out'))
  assert.ok(browserClosed >= 0 && signOut > browserClosed)
  assert.equal(f.state.contextClosed && f.state.browserClosed, true)
  assert.equal(f.reports.at(-1).cleanup.pageClosed, false)
  assert.equal(f.reports.at(-1).cleanup.status, 'failed')
})

test('the actual workflow awaits actual actor session cleanup with no progress token in its environment', async () => {
  const input = inputs(), f = browserFixture(input), child = new EventEmitter(), signals = new EventEmitter(), output = []
  const progressToken = 'SYNTHETIC_PROGRESS_TOKEN'
  input.env.MIKKA_ACCEPTANCE_PROGRESS_TOKEN = progressToken
  child.stdout = new PassThrough(); child.stderr = new PassThrough()
  child.kill = signal => { child.stdout.end(); child.emit('close', 1, signal); return true }
  const code = await runObservabilityWorkflow({
    args: ['--execute', '--browser-submit', '--runner-browser'], env: input.env, now: input.now, signals,
    spawnImpl: (_file, argv, options) => {
      assert.equal(argv.includes('--runner-browser'), false)
      assert.equal(options.env.MIKKA_ACCEPTANCE_PROGRESS_TOKEN, undefined)
      queueMicrotask(() => child.stdout.write(JSON.stringify(input.ready) + '\n'))
      return child
    },
    fetchImpl: async () => ({ status: 201, body: { cancel: async () => {} } }),
    writeOutput: value => output.push(value),
    startBrowserImpl: async options => {
      assert.equal(options.env.MIKKA_ACCEPTANCE_PROGRESS_TOKEN, undefined)
      assert.equal(options.env.GITHUB_TOKEN, undefined)
      const handle = await startObservabilityBrowser({ ...options, chromiumImpl: f.args.chromiumImpl,
        now: input.now, writeReport: f.args.writeReport })
      queueMicrotask(() => { child.stdout.end(); child.emit('close', 0, null) })
      return handle
    },
  })
  assert.equal(code, 0)
  assert.equal(f.state.submissionSent, 1)
  assert.equal(f.state.signOuts, 1)
  assert.equal(f.state.pageClosed && f.state.contextClosed && f.state.browserClosed, true)
  assert.equal(f.reports.at(-1).cleanup.anonymousAfterLogout, true)
  for (const value of [progressToken, EMAIL, PASSWORD]) assert.equal(output.join('').includes(value), false)
})

test('Replay becomes ready before the one paid click and reports no upload acknowledgement', async () => {
  const entered = deferred(), ready = deferred()
  const f = browserFixture(inputs(), { replayEntered: entered, replayWait: ready })
  const starting = startObservabilityBrowser(f.args)
  await entered.promise
  assert.equal(f.state.submitAttempts, 0)
  ready.resolve()
  const handle = await starting
  assert.equal(f.state.submitAttempts, 1)
  assert.equal(f.state.replayHandlesDisposed, 1)
  assert.equal(f.reports[0].replay.sessionId, '12345678-1234-4234-8234-123456789abc')
  assert.equal(f.reports[0].replay.snapshotObserved, true)
  assert.equal(f.reports[0].replay.uploadAcknowledged, null)
  await handle.close()
})

for (const [kind, override] of [
  ['missing bridge', { missingReplayBridge: true }],
  ['SDK exception', { replayThrows: true }],
  ['no SDK', { replayState: { sdkLoaded: false } }],
  ['unstarted recording', { replayState: { recordingStarted: false } }],
  ['no snapshot', { replayState: { snapshotObserved: false } }],
  ['malformed true', { replayState: { recordingStarted: 'true' } }],
  ['invalid session', { replayState: { sessionId: CANARY } }],
  ['last-moment session change', { finalReplayState: { sessionId: workspaceId } }],
]) {
  test('Replay ' + kind + ' fails closed before paid submission and cleans owned resources', async () => {
    const input = inputs()
    const base = { version: 1, sdkLoaded: true, sessionId: '12345678-1234-4234-8234-123456789abc',
      recordingStarted: true, snapshotObserved: true, sessionObservedAt: input.now() - 5,
      snapshotObservedAt: input.now() - 2, observedAt: input.now(), privateExtra: CANARY }
    const options = { ...override }
    for (const key of ['replayState', 'finalReplayState']) if (Object.hasOwn(options, key)) options[key] = { ...base, ...options[key] }
    const f = browserFixture(input, options)
    await assert.rejects(startObservabilityBrowser(f.args), error => {
      safeFailure(error, f.reports); assert.equal(error.code, 'browser_replay_unready'); return true
    })
    assert.equal(f.state.submitAttempts, 0)
    assert.equal(f.state.submissionSent, 0)
    assert.equal(f.reports.at(-1).submitClicks, 0)
    assert.equal(f.reports.at(-1).submissionOutcome, 'not_attempted')
    assert.equal(f.state.signOuts, 1)
    assert.equal(f.calls.find(call => call.type === 'api' && call.path.endsWith('/sign-out')).pageClosed, true)
    assert.equal(f.reports.at(-1).cleanup.status, 'closed')
  })
}

for (const kind of ['abort', 'timeout']) {
  test('Replay pending ' + kind + ' cannot submit after a late ready result', async () => {
    const input = inputs(), entered = deferred(), ready = deferred()
    const f = browserFixture(input, { replayEntered: entered, replayWait: ready, fastTimers: kind === 'timeout' })
    const starting = startObservabilityBrowser(f.args)
    await entered.promise
    if (kind === 'abort') input.controller.abort()
    await assert.rejects(starting, error => { safeFailure(error, f.reports); return true })
    ready.resolve()
    await settle()
    assert.equal(f.state.submitAttempts, 0)
    assert.equal(f.state.submissionSent, 0)
    assert.equal(f.state.pageClosed && f.state.contextClosed && f.state.browserClosed, true)
    assert.equal(f.state.signOuts, 1)
    assert.equal(f.calls.find(call => call.type === 'api' && call.path.endsWith('/sign-out')).pageClosed, true)
  })
}
