// Real isolated Next/DB + Electron lifecycle acceptance. The only native stubs
// are the OS dialog selection and notification click, explicitly recorded below.
// Network failures use Chromium's actual transport/proxy controls, never mocked
// HTTP responses. No trace, auth token, cookie or browser-handoff URL is saved.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { acquireTestAccounts, auditEvidence } from '../../../scripts/test-accounts/session.mjs'
import { loadEnvironment } from '../../../scripts/test-accounts/environment.mjs'
import { createParityFixtures } from './parity-fixtures.mjs'
import { launchElectron } from './electron-launch.mjs'
import { closeElectron, stopLocalDaemons } from './native-cleanup.mjs'
import { captureNativeResources } from './native-resources.mjs'
import { waitForBundledSession } from './bundled-session.mjs'
import { readNativeDaemonMetadata } from './native-metadata.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const environment = await loadEnvironment()
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
assert.equal(environment.deploymentSha, revision, 'Lifecycle acceptance must test the attested application revision')
const output = resolve(process.env.MIKKA_DESKTOP_EVIDENCE ?? '.cache/desktop-evidence')
const pairs = Number(process.env.MIKKA_DESKTOP_COLD_PAIRS ?? 5)
if (!Number.isInteger(pairs) || pairs < 5 || pairs > 20) throw new Error('LIFECYCLE_REQUIRES_5_TO_20_COLD_PAIRS')
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'mikka-lifecycle-'))
const profiles = { bundled: join(directory, 'bundled'), hosted: join(directory, 'hosted') }
const viewport = { width: 1440, height: 960 }
const message = 'Review the desktop workspace, including conversations, tasks, artifacts and settings.'
const menuNames = Object.fromEntries(await Promise.all(['zh-CN', 'en'].map(async locale => [locale, JSON.parse(await readFile(join(root, 'messages', `${locale}.json`), 'utf8')).Nav.workspaceMenu])))
const evidence = {
  version: 1, revision,
  environmentId: environment.id, origin: environment.origin, database: environment.database.name,
  renderers: {
    bundled: { revision, mode: 'bundled', url: 'mikka://app/mikka', backend: environment.origin },
    hosted: { revision, mode: 'hosted', url: `${environment.origin}/mikka`, backend: environment.origin },
  },
  startedAt: new Date().toISOString(), viewport, checks: [], samples: [], nativeStates: [],
  measurement: {
    clock: 'Node performance.now, immediately before Electron launch to visible seeded message and enabled composer accepting a draft',
    process: 'same compiled shell/backend, bundled vs preserved hosted loading path; fresh Electron process for every sample, existing authenticated profile, same account/workspace',
    cache: 'normal profile/OS caches; no OS cache purge, artificial network delay or renderer response substitution',
    pairing: 'alternating bundled-first and hosted-first order',
    daemon: 'after every sample, cancel installers, close Electron and prove that exact profile daemon exited before launching the next process; drain time is outside readiness timing',
  },
}
const check = name => { evidence.checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`) }
let scope, browser, fixtures, nativeResources, application, ownerEmail
let passed = false
let cleanupFailure
const active = new Set()
const appProfiles = new WeakMap()

async function launch(mode, extraArgs = []) {
  await scope.assertActive()
  const started = performance.now()
  const app = await launchElectron({
    ...(process.env.MIKKA_DESKTOP_EXECUTABLE ? { executablePath: process.env.MIKKA_DESKTOP_EXECUTABLE } : {}),
    args: [...(process.env.MIKKA_DESKTOP_EXECUTABLE ? [] : [join(root, 'apps/desktop')]), ...extraArgs],
    cwd: root, env: { ...process.env, MIKKA_DESKTOP_RENDERER: mode, MIKKA_USER_DATA_DIR: profiles[mode] }, timeout: 90_000,
  })
  active.add(app)
  appProfiles.set(app, profiles[mode])
  const page = await app.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.name))
  await app.evaluate(({ BrowserWindow }, bounds) => { BrowserWindow.getAllWindows().find(window => !window.isDestroyed())?.setContentSize(bounds.width, bounds.height) }, viewport)
  return { app, page, errors, started }
}
async function close(app) {
  if (!app) return
  await closeElectron(app)
  // The installed service label is per OS user. Drain its exact profile before
  // another renderer/profile starts, outside the usable-chat timing interval.
  await stopLocalDaemons([appProfiles.get(app)])
  active.delete(app)
}

async function recordNativeState(page, phase, mode) {
  // This observes the actual local IPC state. It neither starts a service nor
  // performs a backend read, and always runs after readiness timing stops.
  const state = await page.evaluate(async () => {
    const [device, installer] = await Promise.all([window.mikka.device.status(), window.mikka.ssh?.state()])
    return {
      device: { status: device.status, signedIn: device.signedIn, server: device.server, deviceIdPresent: Boolean(device.deviceId) },
      installer: installer ? { status: installer.status, step: installer.step, retryable: installer.retryable ?? false } : null,
    }
  })
  evidence.nativeStates.push({ phase, mode, ...state, daemon: await readNativeDaemonMetadata(profiles[mode]) })
  return state
}

async function usable(page, draft = '') {
  await page.getByText(message, { exact: false }).first().waitFor({ state: 'visible' })
  const input = page.locator('textarea[data-chat-composer]').first()
  await input.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const input = document.querySelector('textarea[data-chat-composer]')
    return input instanceof HTMLTextAreaElement && !input.disabled && !input.readOnly && input.getBoundingClientRect().width > 100
  })
  await input.fill(draft)
  assert.equal(await input.inputValue(), draft)
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert.deepEqual(size, viewport)
}

async function selectFixture(page) {
  await page.waitForFunction(() => document.documentElement.lang === 'en' || document.documentElement.lang === 'zh-CN')
  const locale = await page.evaluate(() => document.documentElement.lang)
  await page.getByRole('button', { name: menuNames[locale], exact: true }).first().click()
  await page.getByRole('menuitem', { name: fixtures.fixture.workspaceName, exact: true }).click()
  await usable(page)
}

async function nativeSignIn(app, page, account = scope.owner) {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.mikka?.bundled))
  await app.evaluate(({ shell }) => {
    globalThis.__mikkaLifecycleExternal = null
    shell.openExternal = async url => { globalThis.__mikkaLifecycleExternal = url }
  })
  const handoff = page.evaluate(() => window.mikka.bundled.signIn({ provider: 'google', locale: 'zh-CN', next: '/' }))
  let rejection
  handoff.catch(error => { rejection = error })
  let external
  for (let attempt = 0; attempt < 150; attempt++) {
    if (rejection) throw new Error('LIFECYCLE_HANDOFF_FAILED', { cause: rejection })
    external = await app.evaluate(() => globalThis.__mikkaLifecycleExternal)
    if (external) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(external, 'main opens the ordinary system-browser handoff')
  assert.equal(new URL(external).origin, environment.origin)
  const context = await browser.newContext({ storageState: account.storageStatePath })
  try {
    const browserPage = await context.newPage()
    const returned = page.waitForEvent('domcontentloaded', { timeout: 60_000 })
    returned.catch(() => {})
    await browserPage.goto(external, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await handoff
    await returned
    const session = await waitForBundledSession(page, account.userId)
    assert.equal(session.user.id, account.userId)
    await scope.recordResource({ type: 'session', id: session.session.id, ownerId: account.userId })
    return session
  } finally { await context.close() }
}

async function seedHosted(app, page) {
  const state = JSON.parse(await readFile(scope.owner.storageStatePath, 'utf8'))
  await app.evaluate(async ({ session }, { cookies, origin }) => {
    const partition = session.fromPartition('persist:mikka-dev')
    for (const cookie of cookies) await partition.cookies.set({
      url: `${origin}${cookie.path}`, name: cookie.name, value: cookie.value,
      domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite === 'None' ? 'no_restriction' : cookie.sameSite?.toLowerCase(),
      ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
    })
    await partition.cookies.set({ url: origin, name: 'NEXT_LOCALE', value: 'zh-CN', path: '/' })
    await partition.cookies.flushStore()
  }, { cookies: state.cookies, origin: environment.origin })
  await page.goto(`${environment.origin}/mikka`, { waitUntil: 'domcontentloaded' })
}

async function offline(app, value) {
  await app.evaluate(async ({ session }, enabled) => {
    const backend = session.fromPartition('persist:mikka-dev-bundled-backend')
    if (enabled) backend.enableNetworkEmulation({ offline: true })
    else { backend.disableNetworkEmulation(); await backend.setProxy({ mode: 'direct' }); await backend.closeAllConnections() }
  }, value)
}

async function opaqueFrameBoundary(app, page) {
  const marker = `lifecycle-${process.pid}-${Date.now()}`
  // Observe the actual transport without replacing any response. Counting only
  // this unique query prevents normal live updates from affecting the check.
  await app.evaluate(({ session }, marker) => {
    const backend = session.fromPartition('persist:mikka-dev-bundled-backend')
    const probe = { backend, original: backend.fetch, marker, calls: 0 }
    globalThis.__mikkaLifecycleFrameProbe = probe
    backend.fetch = function (input, init) {
      const url = new URL(typeof input === 'string' ? input : input.url)
      if (url.searchParams.get('desktop-frame-boundary') === marker) probe.calls++
      return probe.original.call(this, input, init)
    }
  }, marker)
  try {
    await page.evaluate(() => new Promise(resolve => {
      const frame = document.createElement('iframe')
      frame.id = 'mikka-lifecycle-opaque-frame'
      frame.name = frame.id
      frame.hidden = true
      frame.sandbox.add('allow-scripts')
      frame.srcdoc = '<!doctype html><title>Untrusted frame</title><p>Boundary probe</p>'
      frame.addEventListener('load', () => resolve(), { once: true })
      document.body.append(frame)
    }))
    const frame = page.frame({ name: 'mikka-lifecycle-opaque-frame' })
    assert.ok(frame, 'the browser created the sandboxed frame')
    const result = await frame.evaluate(async marker => {
      let parentDenied = false
      try { void parent.document.body } catch { parentDenied = true }
      let fetchDenied = false
      let status = null
      try {
        status = (await fetch(`mikka://app/mikka/api/workspace?desktop-frame-boundary=${marker}`, { signal: AbortSignal.timeout(5000) })).status
      } catch { fetchDenied = true }
      return { bridge: typeof window.mikka, node: typeof window.require, parentDenied, fetchDenied, status }
    }, marker)
    assert.equal(result.bridge, 'undefined', 'subframes receive no native IPC bridge')
    assert.equal(result.node, 'undefined')
    assert.equal(result.parentDenied, true, 'an opaque frame cannot read the application or its bridge')
    assert.ok(result.fetchDenied || result.status === 403, 'the untrusted frame cannot read an authenticated API')
    assert.equal(await app.evaluate(() => globalThis.__mikkaLifecycleFrameProbe.calls), 0, 'the opaque frame must never reach the main bearer transport')
    check('real sandboxed frame has no IPC/Node or parent access, and its API request never reaches the main bearer transport')
  } finally {
    await page.evaluate(() => document.getElementById('mikka-lifecycle-opaque-frame')?.remove()).catch(() => {})
    await app.evaluate(() => {
      const probe = globalThis.__mikkaLifecycleFrameProbe
      if (probe) probe.backend.fetch = probe.original
      delete globalThis.__mikkaLifecycleFrameProbe
    })
  }
}

try {
  // The lease helper renews this five-minute lease while the process is alive.
  scope = await acquireTestAccounts({ runId: `desktop-lifecycle-${Date.now()}`, workerId: 'lifecycle', requestId: `lifecycle-${process.pid}-${Date.now()}`, ttlMs: 300_000 })
  fixtures = await createParityFixtures(scope)
  nativeResources = await captureNativeResources(scope)
  browser = await chromium.launch({ headless: true })
  let run = await launch('bundled')
  application = run.app
  ownerEmail = (await nativeSignIn(run.app, run.page)).user.email
  await selectFixture(run.page)
  await recordNativeState(run.page, 'authenticated-profile', 'bundled')
  await run.page.evaluate(() => localStorage.setItem('theme', 'light'))
  await close(run.app); application = null
  run = await launch('hosted')
  application = run.app
  await seedHosted(run.app, run.page)
  await selectFixture(run.page)
  await recordNativeState(run.page, 'authenticated-profile', 'hosted')
  await run.page.evaluate(() => localStorage.setItem('theme', 'light'))
  await run.app.evaluate(async ({ session }) => { await session.fromPartition('persist:mikka-dev').cookies.flushStore() })
  await close(run.app); application = null
  check('one leased account, ordinary native PKCE and hosted cookie profiles select the same real workspace')

  // Alternate order to avoid giving either renderer a consistent warm-backend advantage.
  for (let pair = 1; pair <= pairs; pair++) {
    const order = pair % 2 ? ['bundled', 'hosted'] : ['hosted', 'bundled']
    for (const mode of order) {
      run = await launch(mode)
      application = run.app
      await usable(run.page, 'Lifecycle readiness draft')
      const milliseconds = Math.round((performance.now() - run.started) * 100) / 100
      evidence.samples.push({ pair, order: order.indexOf(mode) + 1, mode, milliseconds })
      await recordNativeState(run.page, `cold-pair-${pair}`, mode)
      assert.equal(run.errors.length, 0, 'cold launch must not produce uncaught renderer errors')
      await run.page.locator('textarea[data-chat-composer]').first().fill('')
      await close(run.app); application = null
      console.log(`COLD ${pair} ${mode} ${milliseconds} ms`)
    }
  }
  const median = values => { const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }
  const bundled = median(evidence.samples.filter(item => item.mode === 'bundled').map(item => item.milliseconds))
  const hosted = median(evidence.samples.filter(item => item.mode === 'hosted').map(item => item.milliseconds))
  evidence.coldStart = { pairs, bundledMedianMs: bundled, hostedMedianMs: hosted, differenceMs: bundled - hosted, bundledFaster: bundled < hosted, improvementPercent: Math.round((hosted - bundled) / hosted * 10000) / 100 }
  check('at least five paired fresh-process launches reach the same usable seeded chat')

  run = await launch('bundled'); application = run.app
  // Both identities were already leased through ordinary server auth. Reuse
  // their real browser sessions through PKCE; do not fake a provider challenge.
  await nativeSignIn(run.app, run.page, scope.peer)
  const menuLocale = await run.page.evaluate(() => document.documentElement.lang)
  await run.page.getByRole('button', { name: menuNames[menuLocale], exact: true }).first().click()
  const ownerGroup = run.page.getByRole('group').filter({ has: run.page.getByText(ownerEmail, { exact: true }) })
  await ownerGroup.getByRole('menuitem', { name: fixtures.fixture.workspaceName, exact: true }).click()
  await waitForBundledSession(run.page, scope.owner.userId)
  await usable(run.page)
  await recordNativeState(run.page, 'retained-owner-after-account-switch', 'bundled')
  assert.equal(await run.page.evaluate(() => document.cookie), '')
  check('two leased browser identities remain private in main and the real account/workspace menu switches back to the retained owner')
  await opaqueFrameBoundary(run.app, run.page)
  await usable(run.page, 'Keep this unsent draft during the outage')
  await offline(run.app, true)
  const failedStatus = await run.page.evaluate(async () => (await fetch('/mikka/api/desktop/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, action: 'desktop.bootstrap', args: [] }) })).status)
  assert.equal(failedStatus, 503)
  await run.page.evaluate(() => window.dispatchEvent(new Event('offline')))
  assert.equal(await run.page.locator('textarea[data-chat-composer]').first().inputValue(), 'Keep this unsent draft during the outage')
  await run.page.getByText(message, { exact: false }).first().waitFor({ state: 'visible' })
  await run.page.screenshot({ path: join(output, 'lifecycle-offline-retained.png'), animations: 'disabled' })
  await offline(run.app, false)
  const restored = run.page.waitForResponse(response => response.url().endsWith('/api/desktop/rpc') && response.status() === 200)
  await run.page.evaluate(() => window.dispatchEvent(new Event('online')))
  await restored
  await usable(run.page, 'Keep this unsent draft during the outage')
  check('actual main HTTP transport outage preserves the loaded conversation and unsent draft; online notification recovers')

  // Exercise the real renderer → preload → main → native callback path; only
  // the OS presentation/click is injected because CI has no notification center.
  await run.app.evaluate(({ Notification }) => {
    Notification.isSupported = () => true
    Notification.prototype.show = function () { globalThis.__mikkaLifecycleNotification = this }
  })
  await run.page.evaluate(({ issue, thread }) => window.mikka.notifications.show({ id: 'lifecycle-native-click', kind: 'finished', title: 'Desktop acceptance', body: 'Open the review task', href: `/?issue=${issue}&thread=${thread}` }), { issue: fixtures.fixture.issue, thread: fixtures.fixture.run })
  await run.app.evaluate(() => { if (!globalThis.__mikkaLifecycleNotification) throw new Error('NATIVE_NOTIFICATION_NOT_CREATED'); globalThis.__mikkaLifecycleNotification.emit('click') })
  await run.page.waitForURL(url => url.searchParams.get('issue') === fixtures.fixture.issue)
  await run.page.getByText(fixtures.fixture.issueTitle, { exact: false }).first().waitFor({ state: 'visible' })
  check('native notification click event follows the real preload bridge to the requested task/thread')

  const repo = join(directory, 'picked-repository')
  await mkdir(repo)
  execFileSync('git', ['init', '--quiet', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.invalid/review.git'])
  await run.app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }) }, repo)
  const picked = await run.page.evaluate(() => window.mikka.device.pickRepo())
  assert.deepEqual(picked, { status: 'picked', repo: { path: await realpath(repo), name: basename(repo), remoteUrl: 'https://example.invalid/review.git' } })
  await run.app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }) })
  assert.deepEqual(await run.page.evaluate(() => window.mikka.device.pickRepo()), { status: 'cancelled' })
  check('native dialog result traverses real IPC and main validates the selected Git repository and cancellation')
  await close(run.app); application = null

  // A deliberately closed proxy blocks remote HTTP from process startup. The
  // native protocol itself still serves the installed HTML/CSS/JS from disk.
  const portProbe = createServer()
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
  const blockedPort = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  run = await launch('bundled', [`--proxy-server=http://127.0.0.1:${blockedPort}`, '--proxy-bypass-list=<-loopback>'])
  application = run.app
  await run.page.locator('.desktop-offline').waitFor({ state: 'visible' })
  assert.equal(new URL(run.page.url()).protocol, 'mikka:')
  assert.ok((await run.page.locator('.desktop-offline').innerText()).trim().length > 10)
  assert.equal(await run.page.evaluate(async () => (await fetch(location.href)).status), 200)
  await run.page.screenshot({ path: join(output, 'lifecycle-offline-cold-launch.png'), animations: 'disabled' })
  await offline(run.app, false)
  const recovered = run.page.waitForResponse(response => response.url().endsWith('/api/desktop/rpc') && response.status() === 200)
  await run.page.evaluate(() => window.dispatchEvent(new Event('online')))
  await recovered
  await usable(run.page)
  assert.equal(run.errors.length, 0, 'offline cold launch/recovery has no uncaught renderer exception')
  check('fresh-process offline launch serves installed assets and a meaningful local offline screen, then recovers without a reload')
  await run.page.evaluate(() => window.mikka.bundled.signOut())
  await close(run.app); application = null
  passed = true
} finally {
  const cleanupErrors = []
  if (application) await close(application).catch(error => cleanupErrors.push(error))
  for (const app of active) await close(app).catch(error => cleanupErrors.push(error))
  await browser?.close().catch(() => {})
  let drained = false
  try { drained = (await stopLocalDaemons(Object.values(profiles))).profilesStopped } catch (error) { cleanupErrors.push(error) }
  if (nativeResources && drained && !cleanupErrors.length) {
    try { evidence.nativeCleanup = await nativeResources.cleanup({ drained: true }) } catch (error) { cleanupErrors.push(error) }
  }
  if (fixtures) await fixtures.cleanup().catch(error => cleanupErrors.push(error))
  if (cleanupErrors.length) passed = false
  if (scope) await scope.release({ outcome: passed ? 'clean' : 'dirty' }).catch(error => { passed = false; cleanupErrors.push(error) })
  evidence.finishedAt = new Date().toISOString()
  evidence.result = passed ? 'passed' : 'failed'
  await writeFile(join(output, 'lifecycle.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  await auditEvidence([output], { environment })
  if (drained) await rm(directory, { recursive: true, force: true })
  if (cleanupErrors.length) cleanupFailure = new AggregateError(cleanupErrors, 'LIFECYCLE_NATIVE_CLEANUP_FAILED')
}
if (cleanupFailure) throw cleanupFailure
