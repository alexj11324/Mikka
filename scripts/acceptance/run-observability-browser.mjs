/**
 * #1512's single runner-owned Chromium actor. Business submission is exclusively
 * through the ordinary UI. No storage injection, traces, screenshots or payload logs.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { CASES, fixtureTask, ORIGIN } from './run-observability.mjs'

const REPORT = 'production-run-observability-report/browser-actor.receipt.json'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/
const HOME = ORIGIN + '/mikka/en'
const SIGN_IN = HOME + '/sign-in'
const BUSINESS_PATHS = new Set(['/mikka/api/workspace', '/mikka/api/workspace/switcher', '/mikka/api/rpc', '/mikka/api/desktop/rpc',
  '/api/workspace', '/api/workspace/switcher', '/api/rpc', '/api/desktop/rpc'])
const CODES = new Set(['browser_configuration', 'browser_ready_invalid', 'browser_source_rejected', 'browser_expired',
  'browser_interrupted', 'browser_launch_failed', 'browser_ui_failed', 'browser_ui_timeout', 'browser_origin_rejected',
  'browser_identity_failed', 'browser_workspace_ambiguous', 'browser_workspace_failed', 'browser_cloud_unproven',
  'browser_selection_failed', 'browser_replay_unready', 'browser_submission_failed', 'browser_cleanup_failed', 'browser_report_failed'])
export class ObservabilityBrowserError extends Error {
  constructor(code) { super(CODES.has(code) ? code : 'browser_ui_failed'); this.code = this.message }
}
const refusal = code => new ObservabilityBrowserError(code)
const check = (condition, code) => { if (!condition) throw refusal(code) }
const closed = error => error instanceof ObservabilityBrowserError ? error : refusal('browser_ui_failed')

// This function is serialized into Chromium. It must have no Node/module closure.
export function readReplayReady(value) {
  try {
    const state = value === undefined
      ? globalThis.__mikkaReplayReadiness?.() : value
    if (!state || state.version !== 1 || state.sdkLoaded !== true
      || state.recordingStarted !== true || state.snapshotObserved !== true
      || typeof state.sessionId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(state.sessionId)
      || state.sessionId === '00000000-0000-0000-0000-000000000000') return null
    for (const key of ['sessionObservedAt', 'snapshotObservedAt', 'observedAt']) {
      if (!Number.isSafeInteger(state[key]) || state[key] <= 0 || state[key] > 8_640_000_000_000_000
        || state[key] > state.observedAt) return null
    }
    // Project only closed metadata even if a broken bridge returns extra fields.
    return { version: 1, sdkLoaded: true, sessionId: state.sessionId, recordingStarted: true,
      snapshotObserved: true, sessionObservedAt: state.sessionObservedAt,
      snapshotObservedAt: state.snapshotObservedAt, observedAt: state.observedAt }
  } catch { return null }
}

function configuration(ready, env, now) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && env.GITHUB_REF === 'refs/heads/main'
    && SHA.test(env.MIKKA_EXPECTED_DEPLOYMENT_SHA ?? '') && env.GITHUB_SHA === env.MIKKA_EXPECTED_DEPLOYMENT_SHA, 'browser_source_rejected')
  check(!env.MIKKA_ACCEPTANCE_BASE_URL || env.MIKKA_ACCEPTANCE_BASE_URL === ORIGIN + '/mikka', 'browser_origin_rejected')
  check(!env.DEBUG && !env.PWDEBUG && !env.PW_API_LOG, 'browser_configuration')
  const revision = env.MIKKA_EXPECTED_DEPLOYMENT_SHA, item = CASES.find(value => value.id === env.MIKKA_OBSERVABILITY_MODEL_CASE)
  const timeoutMs = Number(env.MIKKA_OBSERVABILITY_TIMEOUT_MS ?? 480_000)
  check(item && Number.isSafeInteger(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 600_000, 'browser_configuration')
  check(typeof env.ACME_DEMO_EMAIL === 'string' && /^[^@\s]+@[^@\s]+$/.test(env.ACME_DEMO_EMAIL)
    && typeof env.ACME_DEMO_PASSWORD === 'string' && env.ACME_DEMO_PASSWORD.length > 0, 'browser_configuration')
  const fixture = fixtureTask(revision, item), deadline = Date.parse(ready?.expiresAt)
  check(ready && UUID.test(ready.workspaceId ?? '') && UUID.test(ready.botId ?? '')
    && Number.isFinite(deadline) && ready.expiresAt === new Date(deadline).toISOString(), 'browser_ready_invalid')
  check(deadline > now + 10_000 && deadline <= now + timeoutMs, 'browser_expired')
  check(isDeepStrictEqual(ready, { type: 'mikka_observability_browser_ready', version: 1, revision, case: item.id,
    workspaceId: ready.workspaceId, botId: ready.botId, profileId: fixture.profileId, marker: fixture.marker,
    model: item.model, harness: item.harness, destination: 'cloud', input: fixture.input,
    artifact: { title: fixture.title, content: fixture.content }, expiresAt: ready.expiresAt }), 'browser_ready_invalid')
  return { revision, item, deadline }
}

async function persist(report) {
  await mkdir('production-run-observability-report', { recursive: true, mode: 0o700 })
  await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}

/** Exported dependency seams are for offline tests; the workflow supplies only
 * ready/env/signal. Chromium and its API context are created here, never supplied
 * a stored account, cookie, bearer token or copied trace/session identity. */
export async function startObservabilityBrowser({ ready, env = process.env, signal, chromiumImpl,
  now = Date.now, writeReport = persist, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const report = { version: 1, issue: 1512, kind: 'run-observability-browser', status: 'starting', stage: 'configuration',
    revision: null, case: null, sourceVerified: false, versionBefore: false, versionBeforeSubmit: false,
    freshContext: false, signInAttempted: false, signInResponseCompleted: false, normalSession: false,
    workspaceMatched: false, workspaceSelection: null, officialBusinessResponses: 0, foreignBusinessRequests: 0,
    cloudBackendConfirmed: false, coordinatorSelected: false, cloudDestinationSelected: false, profileMatched: false,
    replay: { sessionId: null, sdkLoaded: null, recordingStarted: null, snapshotObserved: null,
      sessionObservedAt: null, snapshotObservedAt: null, checkedAt: null, uploadAcknowledged: null },
    submitClicks: 0, submissionObserved: false, submissionOutcome: 'not_attempted', pageErrorCount: 0,
    cleanup: { status: 'pending', signOutAttempted: false, signOutSucceeded: false, anonymousAfterLogout: false,
      pageClosed: null, contextClosed: null, browserClosed: null, pendingResourcesSettled: null },
    startedAt: new Date(now()).toISOString(), finishedAt: null }
  const owned = { browser: null, context: null, page: null }, allocating = new Set()
  let config, closing = null, disposed = false, failure = null, ownerId, cloudResolve, signInCompletion
  const cloudObserved = new Promise(resolve => { cloudResolve = resolve })
  const gate = () => {
    check(!signal?.aborted, 'browser_interrupted')
    check(config && now() < config.deadline, 'browser_expired')
    check(report.foreignBusinessRequests === 0, 'browser_origin_rejected')
  }
  async function bounded(work, milliseconds, code, abortSignal) {
    let timer, abort
    try {
      const operation = Promise.resolve().then(work)
      const expires = new Promise((_, reject) => { timer = setTimeoutImpl(() => reject(refusal(code)), Math.max(1, milliseconds)) })
      const interrupted = new Promise((_, reject) => {
        if (!abortSignal) return
        abort = () => reject(refusal('browser_interrupted'))
        if (abortSignal.aborted) abort()
        else abortSignal.addEventListener('abort', abort, { once: true })
      })
      return await Promise.race([operation, expires, interrupted])
    } finally {
      clearTimeoutImpl(timer)
      if (abort) abortSignal?.removeEventListener('abort', abort)
    }
  }
  async function run(work, cap = 30_000) {
    gate()
    const ms = Math.max(1, Math.min(cap, config.deadline - now()))
    const value = await bounded(() => { gate(); return work(ms) }, ms, 'browser_ui_timeout', signal)
    gate()
    return value
  }
  async function allocate(kind, work) {
    gate()
    const task = Promise.resolve().then(work).then(async resource => {
      owned[kind] = resource
      // A locally delayed create must still dispose its own result after a
      // timed-out cleanup; never claim a missing resource was closed.
      if (disposed) await bounded(() => resource.close(), 5_000, 'browser_cleanup_failed')
      return resource
    })
    allocating.add(task)
    void task.then(() => allocating.delete(task), () => allocating.delete(task))
    return run(() => task)
  }
  const pageIsOfficial = () => {
    const value = new URL(owned.page.url())
    check(value.origin === ORIGIN && !value.username && !value.password, 'browser_origin_rejected')
  }
  const homeOnly = () => {
    pageIsOfficial()
    const value = new URL(owned.page.url())
    check([HOME, HOME + '/'].includes(value.href), 'browser_selection_failed')
  }
  async function unique(locator, code = 'browser_ui_failed') {
    await run(ms => locator.waitFor({ state: 'visible', timeout: ms }))
    check(await run(() => locator.count()) === 1, code)
    return locator
  }
  async function click(locator, code) {
    await unique(locator, code)
    gate(); pageIsOfficial()
    await run(ms => locator.click({ timeout: ms }))
  }
  async function read(path, method = 'GET', cleanupUntil) {
    check(['/api/version', '/api/auth/get-session', '/api/workspace', '/api/workspace/switcher', '/api/auth/sign-out'].includes(path)
      && (method === 'GET' && path !== '/api/auth/sign-out' || method === 'POST' && path === '/api/auth/sign-out'), 'browser_configuration')
    const action = async ms => {
      const url = ORIGIN + '/mikka' + path
      let response
      try {
        response = await owned.context.request.fetch(url, { method, maxRedirects: 0, failOnStatusCode: false, timeout: ms,
          headers: { origin: ORIGIN, accept: 'application/json', 'cache-control': 'no-store' },
          ...(method === 'POST' ? { data: {} } : {}) })
        check(response.status() === 200 && response.url() === url, 'browser_identity_failed')
        const body = await response.body()
        check(body.byteLength <= 262_144, 'browser_identity_failed')
        return JSON.parse(body.toString('utf8'))
      } finally { await response?.dispose() }
    }
    if (cleanupUntil !== undefined) return bounded(() => action(Math.max(1, Math.min(5_000, cleanupUntil - now()))),
      Math.max(1, Math.min(5_000, cleanupUntil - now())), 'browser_cleanup_failed')
    return run(action)
  }
  async function save() {
    try { await bounded(() => writeReport(structuredClone(report)), 5_000, 'browser_report_failed') }
    catch { throw refusal('browser_report_failed') }
  }
  async function close() {
    if (closing) return closing
    closing = (async () => {
      const until = now() + 30_000
      let cleanupFailed = false
      const attempt = async (key, work) => {
        try {
          await bounded(work, Math.max(1, Math.min(5_000, until - now())), 'browser_cleanup_failed')
          report.cleanup[key] = true
        } catch { report.cleanup[key] = false; cleanupFailed = true }
      }
      let pageAttempted = false
      const stopPage = async () => {
        if (owned.page && !pageAttempted) {
          pageAttempted = true
          await attempt('pageClosed', () => owned.page.close({ runBeforeUnload: false }))
          if (report.cleanup.pageClosed === false && owned.browser) {
            // If the page cannot be stopped, stop the owning process before
            // another async cleanup step can leave a pending click actionable.
            await attempt('browserClosed', () => owned.browser.close())
          }
        }
      }
      // Cancel pending locator actions before waiting on authentication cleanup.
      // The context retains its cookie jar/API client after this page closes.
      await stopPage()
      if (allocating.size) await attempt('pendingResourcesSettled', () => Promise.allSettled(allocating))
      else report.cleanup.pendingResourcesSettled = true
      await stopPage()
      if (report.signInAttempted && owned.context) {
        if (signInCompletion && !report.signInResponseCompleted) {
          try { await bounded(() => signInCompletion, Math.max(1, Math.min(5_000, until - now())), 'browser_cleanup_failed') }
          catch { cleanupFailed = true }
        }
        report.cleanup.signOutAttempted = true
        await attempt('signOutSucceeded', async () => { await read('/api/auth/sign-out', 'POST', until) })
        await attempt('anonymousAfterLogout', async () => { check(await read('/api/auth/get-session', 'GET', until) === null, 'browser_cleanup_failed') })
        if (!report.signInResponseCompleted) cleanupFailed = true
      }
      // Session cleanup must happen while its API context still owns cookies.
      for (const kind of ['context', 'browser']) {
        if (owned[kind] && report.cleanup[kind + 'Closed'] !== true) await attempt(kind + 'Closed', () => owned[kind].close())
      }
      disposed = true
      report.cleanup.status = cleanupFailed ? 'failed' : 'closed'
      report.finishedAt = new Date(now()).toISOString()
      if (cleanupFailed) { report.status = 'failed'; report.code = 'browser_cleanup_failed' }
      else if (!failure) report.status = report.submissionObserved ? 'submitted' : 'not_submitted'
      try { await bounded(() => writeReport(structuredClone(report)), Math.max(1, until - now()), 'browser_report_failed') }
      catch { throw refusal('browser_report_failed') }
      if (cleanupFailed) throw refusal('browser_cleanup_failed')
    })()
    return closing
  }
  try {
    config = configuration(ready, env, now())
    Object.assign(report, { revision: config.revision, case: config.item.id, sourceVerified: true })
    gate()
    const chromium = chromiumImpl ?? (await import('@playwright/test')).chromium
    gate()
    report.stage = 'launch'
    // Only OS launch prerequisites cross into Chromium; never account or CI secrets.
    const launchEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'XDG_CACHE_HOME']
      .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]))
    await allocate('browser', () => chromium.launch({ headless: true, timeout: Math.min(30_000, config.deadline - now()), env: launchEnv }))
    await allocate('context', () => owned.browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } }))
    report.freshContext = true
    await allocate('page', () => owned.context.newPage())
    owned.page.on('pageerror', () => { report.pageErrorCount = Math.min(1_000_000, report.pageErrorCount + 1) })
    owned.page.on('request', request => {
      try {
        const url = new URL(request.url())
        if (BUSINESS_PATHS.has(url.pathname) && url.origin !== ORIGIN) report.foreignBusinessRequests++
      } catch { report.foreignBusinessRequests++ }
    })
    owned.page.on('response', response => {
      try {
        const url = new URL(response.url())
        if (url.origin === ORIGIN && BUSINESS_PATHS.has(url.pathname) && response.status() === 200
          && ['fetch', 'xhr'].includes(response.request().resourceType())) {
          report.officialBusinessResponses = Math.min(1_000_000, report.officialBusinessResponses + 1)
          cloudResolve()
        }
      } catch { /* No response text, headers or arbitrary URL enters a report. */ }
    })
    report.stage = 'version'
    check((await read('/api/version'))?.build === config.revision, 'browser_source_rejected')
    report.versionBefore = true
    check(await read('/api/auth/get-session') === null, 'browser_identity_failed')
    report.stage = 'sign_in'
    await run(ms => owned.page.goto(SIGN_IN, { waitUntil: 'domcontentloaded', timeout: ms }))
    pageIsOfficial()
    check(new URL(owned.page.url()).pathname === '/mikka/en/sign-in', 'browser_origin_rejected')
    await run(ms => owned.page.getByLabel('Email', { exact: true }).fill(env.ACME_DEMO_EMAIL, { timeout: ms }))
    gate(); pageIsOfficial()
    await run(ms => owned.page.getByLabel('Password', { exact: true }).fill(env.ACME_DEMO_PASSWORD, { timeout: ms }))
    const reply = owned.page.waitForResponse(response => response.url() === ORIGIN + '/mikka/api/auth/sign-in/email'
      && response.request().method() === 'POST', { timeout: Math.min(30_000, config.deadline - now()) })
    signInCompletion = reply.then(async response => { await response.finished(); report.signInResponseCompleted = true; return response })
    void signInCompletion.catch(() => {})
    const signInButton = owned.page.getByRole('button', { name: 'Sign in to the workspace', exact: true })
    await unique(signInButton)
    gate(); pageIsOfficial()
    report.signInAttempted = true
    await run(ms => signInButton.click({ timeout: ms }))
    const loginResponse = await run(() => signInCompletion)
    check(loginResponse.status() === 200, 'browser_identity_failed')
    await run(ms => owned.page.waitForURL(url => url.origin === ORIGIN && [HOME, HOME + '/'].includes(url.href), { timeout: ms }))
    const session = await read('/api/auth/get-session')
    check(session?.user?.email?.toLowerCase() === env.ACME_DEMO_EMAIL.toLowerCase()
      && typeof session.user.id === 'string' && session.user.id.length > 0, 'browser_identity_failed')
    ownerId = session.user.id; report.normalSession = true
    report.stage = 'workspace'
    const switcher = await read('/api/workspace/switcher')
    check(Array.isArray(switcher?.accounts), 'browser_workspace_failed')
    const owners = switcher.accounts.filter(value => value.id === ownerId && value.email?.toLowerCase() === env.ACME_DEMO_EMAIL.toLowerCase())
    check(owners.length === 1 && switcher.accounts[0]?.id === ownerId, 'browser_workspace_ambiguous')
    const choices = Array.isArray(owners[0].choices) ? owners[0].choices : []
    const matches = choices.filter(value => value.id === ready.workspaceId)
    check(matches.length === 1 && typeof matches[0].name === 'string' && matches[0].name.length > 0
      && choices.filter(value => value.name === matches[0].name).length === 1, 'browser_workspace_ambiguous')
    if (switcher.workspace?.id !== ready.workspaceId) {
      await click(owned.page.getByRole('button', { name: 'Workspace menu', exact: true }))
      const menu = owned.page.getByRole('menu', { name: 'Workspace menu', exact: true })
      await unique(menu)
      const group = menu.getByRole('group').filter({ has: owned.page.getByText(owners[0].email, { exact: true }) })
      await unique(group, 'browser_workspace_ambiguous')
      // The old page can already be HOME. Wait for the next actual document
      // navigation, not an immediately true URL or the menu's close animation.
      const moved = owned.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: Math.min(30_000, config.deadline - now()) })
      void moved.catch(() => {})
      await click(group.getByRole('menuitem', { name: matches[0].name, exact: true }), 'browser_workspace_ambiguous')
      const navigation = await run(() => moved)
      check(navigation?.status() === 200 && [HOME, HOME + '/'].includes(navigation.url()), 'browser_workspace_failed')
      report.workspaceSelection = 'switched_ui'
      homeOnly()
    } else report.workspaceSelection = 'already_selected'
    const workspace = await read('/api/workspace')
    check(workspace?.currentUserId === ownerId && workspace.workspace?.id === ready.workspaceId
      && workspace.workspace.kind === 'personal' && workspace.role === 'admin'
      && Array.isArray(workspace.members) && workspace.members.length === 1
      && workspace.members[0]?.userId === ownerId && workspace.members[0]?.role === 'admin'
      && workspace.members[0]?.status === 'active', 'browser_workspace_failed')
    report.workspaceMatched = true
    homeOnly()
    report.stage = 'new_task'
    // The existing global-search quick action is available on the root page;
    // unlike a board-only button, it cannot inherit a project selection here.
    await click(owned.page.getByRole('button', { name: 'Search everything', exact: true }))
    const search = owned.page.getByRole('dialog', { name: 'Search everything', exact: true })
    await unique(search)
    await click(search.getByRole('option', { name: 'New task', exact: true }))
    await run(ms => search.waitFor({ state: 'hidden', timeout: ms }))
    const dialog = owned.page.getByRole('dialog', { name: 'New task', exact: true })
    await unique(dialog)
    const bot = dialog.getByRole('combobox', { name: 'Bot to hand it to', exact: true })
    const botCount = await run(() => bot.count())
    check(botCount <= 1, 'browser_selection_failed')
    if (botCount === 1) {
      await click(bot)
      await click(owned.page.getByRole('option', { name: 'Coordinator', exact: true }))
      await unique(bot.getByText('Coordinator', { exact: true }), 'browser_selection_failed')
    }
    report.coordinatorSelected = true
    const machine = dialog.getByRole('combobox', { name: 'Machine', exact: true })
    await click(machine)
    await click(owned.page.getByRole('option').filter({ has: owned.page.getByText('Mikka Cloud', { exact: true }) }), 'browser_selection_failed')
    await unique(machine.getByText('Mikka Cloud', { exact: true }), 'browser_selection_failed')
    report.cloudDestinationSelected = true
    const profile = dialog.getByRole('combobox', { name: 'Agent profile', exact: true })
    await click(profile)
    await click(owned.page.getByRole('option').filter({ has: owned.page.getByText(ready.marker, { exact: true }) }), 'browser_selection_failed')
    await unique(profile.getByText(ready.marker, { exact: true }), 'browser_selection_failed')
    report.profileMatched = true
    await run(ms => dialog.getByLabel('Task description', { exact: true }).fill(ready.input, { timeout: ms }))
    report.stage = 'submit'
    await run(() => cloudObserved)
    check(report.freshContext && report.normalSession && report.workspaceMatched && report.profileMatched
      && report.officialBusinessResponses > 0 && report.foreignBusinessRequests === 0, 'browser_cloud_unproven')
    report.cloudBackendConfirmed = true
    check((await read('/api/version'))?.build === config.revision, 'browser_source_rejected')
    report.versionBeforeSubmit = true
    check((await read('/api/workspace'))?.workspace?.id === ready.workspaceId, 'browser_workspace_failed')
    homeOnly()
    if (await run(() => bot.count()) === 1) await unique(bot.getByText('Coordinator', { exact: true }), 'browser_selection_failed')
    const submit = dialog.getByRole('button', { name: 'Create task', exact: true })
    await unique(submit)
    check(await run(() => submit.isEnabled()), 'browser_selection_failed')
    report.stage = 'replay'
    let replay
    try {
      const handle = await run(ms => owned.page.waitForFunction(readReplayReady, undefined, { timeout: ms, polling: 'raf' }))
      try { replay = readReplayReady(await run(() => handle.jsonValue())) }
      finally { await run(() => handle.dispose()) }
      const current = readReplayReady(await run(() => owned.page.evaluate(readReplayReady)))
      check(replay && current && current.sessionId === replay.sessionId, 'browser_replay_unready')
      report.replay = { sessionId: current.sessionId, sdkLoaded: true, recordingStarted: true, snapshotObserved: true,
        sessionObservedAt: new Date(current.sessionObservedAt).toISOString(),
        snapshotObservedAt: new Date(current.snapshotObservedAt).toISOString(),
        checkedAt: new Date(current.observedAt).toISOString(), uploadAcknowledged: null }
    } catch (error) {
      if (error instanceof ObservabilityBrowserError
        && ['browser_interrupted', 'browser_expired', 'browser_origin_rejected'].includes(error.code)) throw error
      throw refusal('browser_replay_unready')
    }
    report.stage = 'submit'
    gate(); pageIsOfficial()
    report.submitClicks = 1; report.submissionOutcome = 'unknown'
    // Never retry, even if the click's result is unknown. The driver observes
    // and cleans the one fixture; another click can create paid duplicate work.
    await run(ms => submit.click({ timeout: ms }))
    await run(ms => dialog.waitFor({ state: 'hidden', timeout: ms }))
    report.submissionObserved = true; report.submissionOutcome = 'confirmed'
    report.status = 'submitted'; report.stage = 'observing'
    await save()
    return { close }
  } catch (error) {
    failure = closed(error)
    report.status = 'failed'; report.code = failure.code
    try { await close() } catch (cleanupError) { throw closed(cleanupError) }
    // Playwright errors can contain typed account fields. Never retain their
    // free-form message, stack or cause in the caller's error or safe receipt.
    throw failure
  }
}
