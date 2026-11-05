import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { acquireTestAccounts, auditEvidence } from '../../../scripts/test-accounts/session.mjs'
import { loadEnvironment } from '../../../scripts/test-accounts/environment.mjs'
import { createParityFixtures } from './parity-fixtures.mjs'
import { compareImages, screenshot } from './parity-images.mjs'
import { launchElectron } from './electron-launch.mjs'
import { waitForBundledSession } from './bundled-session.mjs'
import { closeElectron, stopLocalDaemons } from './native-cleanup.mjs'
import { captureNativeResources } from './native-resources.mjs'

// A real production backend and one leased dataset serve both modes. These
// screenshots exercise application routes, components and RPCs; there are no
// response routes, fake auth hooks, component previews or browser UI substitutes.
const root = fileURLToPath(new URL('../../..', import.meta.url))
const environment = await loadEnvironment()
const mode = process.env.MIKKA_DESKTOP_PARITY_MODE ?? 'desktop'
assert.ok(['desktop', 'web-capture'].includes(mode), 'Unknown parity mode')
const output = resolve(process.env.MIKKA_DESKTOP_EVIDENCE ?? '.cache/desktop-evidence', 'parity')
const started = Date.now()
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
const messages = JSON.parse(await readFile(join(root, 'messages/en.json'), 'utf8'))
const report = {
  version: 1, mode, appRevision: environment.deploymentSha, harnessRevision: revision,
  harnessSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).update(await readFile(new URL('./parity-fixtures.mjs', import.meta.url))).update(await readFile(new URL('./parity-images.mjs', import.meta.url))).digest('hex'),
  environmentId: environment.id, database: environment.database.name, origin: environment.origin,
  viewport: { width: 1440, height: 900 }, colorThreshold: 0, maximumChangedRatio: 0.001,
  themes: ['light', 'dark'], masksAllowed: ['avatars', 'timestamps'], startedAt: new Date(started).toISOString(), screens: [],
}
await mkdir(output, { recursive: true })
let scope
let fixtures
let nativeResources
let systemBrowser
let webBrowser
const applications = new Set()
const profiles = []
const pendingImages = new Map()
const errors = []
let passed = false
let cleaned = false
let cleanupError

async function launch(mode) {
  // Both modes use the same real local daemon/device. Their Chromium session
  // partitions remain separate, and only one app owns this profile at a time.
  const profile = profiles[0] ?? join(tmpdir(), `mikka-parity-${process.pid}-${started}`)
  if (!profiles.length) profiles.push(profile)
  const application = await launchElectron({
    ...(process.env.MIKKA_DESKTOP_EXECUTABLE ? { executablePath: process.env.MIKKA_DESKTOP_EXECUTABLE } : {}),
    args: process.env.MIKKA_DESKTOP_EXECUTABLE ? [] : [join(root, 'apps/desktop')],
    cwd: root,
    env: { ...process.env, MIKKA_DESKTOP_RENDERER: mode, MIKKA_USER_DATA_DIR: profile },
    timeout: 90_000,
  })
  applications.add(application)
  const page = await application.firstWindow({ timeout: 90_000 })
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(1440, 900)
    window.webContents.setZoomFactor(1)
  })
  page.setDefaultTimeout(45_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push({ mode, name: error.name }))
  await page.waitForLoadState('domcontentloaded')
  const base = mode === 'bundled' ? 'mikka://app/mikka' : `${environment.origin}${environment.basePath}`
  if (mode === 'bundled') await page.waitForFunction(() => Boolean(window.mikka?.bundled))
  else assert.equal(new URL(page.url()).origin, environment.origin, 'Hosted comparison must use the attested backend')
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }))
  assert.deepEqual(size, { width: 1440, height: 900, scale: 1 })
  return { mode, application, page, base }
}

async function closeTarget(target) {
  await closeElectron(target.application)
  applications.delete(target.application)
}

async function go(target, suffix = '/') {
  await scope?.assertActive()
  await target.page.goto(`${target.base}/en${suffix === '/' ? '' : suffix}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await target.page.getByRole('button', { name: messages.Nav.workspaceMenu, exact: true }).first().waitFor()
}

async function theme(target, value) {
  // Apply the ordinary persisted appearance preference to each renderer
  // partition. This changes no application response or business state.
  await target.page.evaluate(value => localStorage.setItem('theme', value), value)
  await target.page.emulateMedia({ colorScheme: value, reducedMotion: 'reduce' })
  await target.page.reload({ waitUntil: 'domcontentloaded' })
  await target.page.waitForFunction(value => document.documentElement.classList.contains(value), value)
}

async function pair(name, appearance, targets, open) {
  const key = `${appearance}/${name}`
  const images = pendingImages.get(key) ?? new Map()
  for (const target of targets) {
    await open(target)
    assert.ok(!images.has(target.mode), 'Each native mode is captured once per screen')
    images.set(target.mode, await screenshot(target.page, join(output, `${appearance}-${name}-${target.mode}.png`)))
  }
  pendingImages.set(key, images)
  if (!images.has('hosted') || !images.has('bundled')) return
  const comparison = await compareImages(images.get('hosted'), images.get('bundled'), join(output, `${appearance}-${name}-diff.png`))
  pendingImages.delete(key)
  const result = { name, theme: appearance, ...comparison }
  report.screens.push(result)
  await writeFile(join(output, 'parity.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`${comparison.passed ? 'PASS' : 'FAIL'} ${appearance}/${name}: ${(comparison.changedRatio * 100).toFixed(5)}% pixels${comparison.maskGeometryMatches ? '' : '; mask geometry differs'}`)
}

async function offlinePairs(targets) {
  const portProbe = createServer()
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
  const closedPort = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  async function network(target, blocked) {
    // Chromium performs the real failed connection. Only these isolated app
    // sessions use the closed proxy; the shared backend and lease stay live.
    await target.application.evaluate(async ({ BrowserWindow, session }, { mode, blocked, port }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const transport = mode === 'bundled' ? session.fromPartition('persist:mikka-dev-bundled-backend') : window.webContents.session
      await transport.setProxy(blocked
        ? { proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' }
        : { mode: 'direct' })
      await transport.closeAllConnections()
      if (blocked) await transport.clearCache()
    }, { mode: target.mode, blocked, port: closedPort })
  }
  for (const appearance of report.themes) {
    for (const target of targets) await theme(target, appearance)
    try {
      await pair('offline', appearance, targets, async target => {
        await network(target, true)
        await target.page.reload({ waitUntil: 'domcontentloaded' }).catch(error => {
          if (target.mode !== 'hosted' || !/ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)/.test(error.message)) throw error
        })
        if (target.mode === 'hosted') await target.page.waitForURL('file:**/offline.html?**')
        else await target.page.locator('.desktop-offline').waitFor()
        await target.page.getByRole('status').waitFor()
        assert.equal(new URL(target.page.url()).protocol, target.mode === 'hosted' ? 'file:' : 'mikka:')
      })
    } finally {
      for (const target of targets) await network(target, false)
      for (const target of targets) await go(target)
    }
  }
}

async function authenticateHosted(hosted) {
  const state = JSON.parse(await readFile(scope.owner.storageStatePath, 'utf8'))
  // Hosted fallback remains a normal web session. Bundled receives no cookies;
  // its session goes through the actual browser/loopback/PKCE implementation.
  await hosted.application.evaluate(async ({ BrowserWindow }, { cookies, origin }) => {
    // Electron uses its explicitly named window session, which need not be
    // Playwright's default browser context. Seed only the hosted window.
    const partition = BrowserWindow.getAllWindows()[0].webContents.session
    for (const cookie of cookies) await partition.cookies.set({
      url: `${origin}${cookie.path}`, name: cookie.name, value: cookie.value,
      domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite === 'None' ? 'no_restriction' : cookie.sameSite?.toLowerCase(),
      ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
    })
    await partition.cookies.set({ url: origin, name: 'NEXT_LOCALE', value: 'en', path: '/' })
    await partition.cookies.flushStore()
  }, { cookies: state.cookies, origin: environment.origin })
  await selectFixtureWorkspace(hosted)
}

async function authenticateBundled(bundled) {
  systemBrowser = await chromium.launch({ headless: true })
  const context = await systemBrowser.newContext({ storageState: scope.owner.storageStatePath })
  const page = await context.newPage()
  await bundled.application.evaluate(({ shell }) => {
    globalThis.__mikkaParityExternal = null
    shell.openExternal = async url => { globalThis.__mikkaParityExternal = url }
  })
  const handoff = bundled.page.evaluate(() => window.mikka.bundled.signIn({ provider: 'google', next: '/', locale: 'en' }))
  let handoffError
  handoff.catch(error => { handoffError = error })
  let external
  for (let attempt = 0; attempt < 150; attempt++) {
    if (handoffError) throw new Error('Desktop browser handoff failed', { cause: handoffError })
    external = await bundled.application.evaluate(() => globalThis.__mikkaParityExternal)
    if (external) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(external, 'Main must open the real sign-in continuation')
  assert.equal(new URL(external).origin, environment.origin)
  await page.goto(external, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await handoff
  const identity = await waitForBundledSession(bundled.page, scope.owner.userId)
  assert.equal(identity.user.id, scope.owner.userId)
  assert.deepEqual(Object.keys(identity.session), ['id'])
  await scope.recordResource({ type: 'session', id: identity.session.id, ownerId: scope.owner.userId })
  await systemBrowser.close(); systemBrowser = undefined
  await selectFixtureWorkspace(bundled)
}

async function selectFixtureWorkspace(target) {
  await go(target)
  await target.page.getByRole('button', { name: messages.Nav.workspaceMenu, exact: true }).first().click()
  await target.page.getByRole('menuitem', { name: fixtures.fixture.workspaceName, exact: false }).click()
  await target.page.waitForURL(url => url.pathname === `${environment.basePath}/en` || url.pathname === `${environment.basePath}/en/`)
  await target.page.getByRole('button', { name: messages.Nav.workspaceMenu, exact: true }).first().waitFor()
  await coordinatorReady(target.page)
}

async function coordinatorReady(page) {
  await page.getByRole('region', { name: messages.Coordinator.conversation, exact: true }).getByText('Review the desktop workspace, including conversations, tasks, artifacts and settings.', { exact: true }).waitFor()
}

async function nativeDeviceReady(target) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    await scope.assertActive()
    const state = await target.page.evaluate(async () => ({ device: await window.mikka.device.status(), install: await window.mikka.ssh.state() }))
    if (state.device.status === 'online' && state.device.deviceId && state.device.signedIn === true && state.device.server === 'online' && !['running', 'fingerprint'].includes(state.install?.status)) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('PARITY_NATIVE_DEVICE_NOT_READY')
}

function screens(fixture) {
  const route = (name, path, ready) => ({ name, open: async target => { await go(target, path); if (ready) await ready(target.page) } })
  const text = value => page => page.getByText(value, { exact: true }).first().waitFor()
  const panel = (bot, tab) => ({
    name: `${bot ? 'bot' : 'coordinator'}-${tab}`,
    open: async target => {
      await go(target, bot ? `/?bot=${fixture.bot}` : '/')
      await target.page.getByRole('tab', { name: messages.Shell.panel[tab], exact: true }).click()
      await target.page.getByRole('tab', { name: messages.Shell.panel[tab], exact: true }).getAttribute('aria-selected').then(value => assert.equal(value, 'true'))
    },
  })
  return [
    { name: 'workspace-link', open: async target => {
      // The web's slug entry is intentionally outside its locale segment.
      await target.page.goto(`${target.base}/w/${fixture.workspaceSlug}`, { waitUntil: 'domcontentloaded' })
      await target.page.waitForURL(url => [environment.basePath, `${environment.basePath}/`, `${environment.basePath}/en`, `${environment.basePath}/en/`].includes(url.pathname))
      await go(target)
      await coordinatorReady(target.page)
    } },
    ...['details', 'threads', 'prs', 'computer'].map(tab => panel(false, tab)),
    ...['details', 'threads', 'prs', 'computer'].map(tab => panel(true, tab)),
    route('group', `/?group=${fixture.group}`, text('The desktop review is ready. Please check the task and its artifacts.')),
    route('task', `/?issue=${fixture.issue}`, page => page.getByRole('region', { name: fixture.issueTitle, exact: true }).waitFor()),
    route('task-thread', `/?issue=${fixture.issue}&thread=${fixture.run}`, text('The review is complete. Conversations, task details and artifacts are ready.')),
    route('all-threads', '/?threads=all'),
    route('bot-threads', `/?bot=${fixture.bot}&threads=${fixture.bot}`),
    route('thread', `/?bot=${fixture.bot}&thread=${fixture.run}`, text('The review is complete. Conversations, task details and artifacts are ready.')),
    { name: 'board', open: async target => { await go(target, '/?section=all-issues'); await target.page.getByLabel(messages.Shell.board.viewBoard, { exact: true }).click(); await target.page.getByText(fixture.issueTitle, { exact: true }).first().waitFor() } },
    { name: 'list', open: async target => { await go(target, '/?section=all-issues'); await target.page.getByLabel(messages.Shell.board.viewList, { exact: true }).click(); await target.page.getByText(fixture.issueTitle, { exact: true }).first().waitFor() } },
    route('projects', '/?section=projects'),
    route('team-home', `/?team=${fixture.team}`),
    route('team-tasks', `/?section=team-issues&team=${fixture.team}`, text(fixture.issueTitle)),
    route('team-projects', `/?section=team-projects&team=${fixture.team}`),
    route('plugins', '/?section=plugins'),
    route('suggestions', '/?section=suggestions'),
    route('artifact-library', '/?section=artifacts', text(fixture.artifactTitle)),
    route('artifact-markdown', `/?artifact=${fixture.markdown}`, page => page.getByRole('dialog').getByText('Desktop review', { exact: true }).waitFor()),
    route('artifact-html', `/?artifact=${fixture.html}`, page => page.getByRole('dialog').locator('iframe').waitFor()),
    { name: 'new-task', open: async target => { await go(target); await target.page.getByRole('button', { name: messages.Nav.newTask, exact: true }).first().click(); await target.page.getByRole('dialog', { name: messages.Shell.newTaskDialog.title, exact: true }).waitFor() } },
    ...Object.entries(messages.Settings.sections).filter(([id]) => id !== 'developer').map(([id, section]) => route(`settings-${id}`, ['members', 'teams'].includes(id) ? `/settings/${id}?workspace=${fixture.workspace}` : `/settings?workspace=${fixture.workspace}&section=${id}`, page => page.getByRole('heading', { name: section.title, exact: true }).first().waitFor())),
  ]
}

function publicScreens(fixture) {
  return [
    { name: 'shared-markdown', token: fixture.markdownToken, ready: page => page.getByRole('heading', { name: fixture.artifactTitle, exact: true }).first().waitFor() },
    { name: 'shared-html', token: fixture.htmlToken, ready: page => page.frameLocator('iframe').getByRole('heading', { name: 'Desktop review', exact: true }).waitFor() },
    { name: 'shared-missing', token: 'mks_missing-desktop-review', ready: page => page.getByText(messages.Artifact.sharedNotFoundHint, { exact: true }).waitFor() },
  ].map(({ name, token, ready }) => ({ name, open: async target => {
    // Public capability links are exercised before either app receives a
    // leased session. Tokens are recorded only in the private evidence scanner.
    try { await target.page.goto(`${target.base}/en/a/${token}`, { waitUntil: 'domcontentloaded' }) }
    catch { throw new Error(`Public artifact navigation failed: ${name}`) }
    await ready(target.page)
  } }))
}

try {
  scope = await acquireTestAccounts({ runId: `parity-${started}`, workerId: 'desktop-parity', requestId: `parity-${started}`, ttlMs: 300_000 })
  fixtures = await createParityFixtures(scope)
  if (mode === 'desktop') nativeResources = await captureNativeResources(scope)
  if (mode === 'web-capture') {
    webBrowser = await chromium.launch({ headless: true })
    const context = await webBrowser.newContext({ viewport: report.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', timezoneId: 'UTC' })
    const page = await context.newPage()
    page.setDefaultTimeout(45_000)
    page.on('pageerror', error => errors.push({ mode: 'web', name: error.name }))
    const target = { mode: 'web', page, base: `${environment.origin}${environment.basePath}` }
    async function capture(name, appearance, open) {
      await open(target)
      const filename = `${appearance}-${name}-web.png`
      const result = await screenshot(page, join(output, filename), { identities: fixtures.fixture.dynamicIdentityEmails })
      report.screens.push({ name, theme: appearance, filename, masks: result.masks, sha256: createHash('sha256').update(result.bytes).digest('hex') })
      await writeFile(join(output, 'parity.json'), `${JSON.stringify(report, null, 2)}\n`)
      console.log(`CAPTURE ${appearance}/${name}`)
    }
    for (const appearance of report.themes) {
      await page.goto(`${target.base}/en/sign-in`, { waitUntil: 'domcontentloaded' })
      await theme(target, appearance)
      await capture('sign-in', appearance, async () => { await page.locator('input[type="email"]').waitFor() })
      for (const screen of publicScreens(fixtures.fixture)) await capture(screen.name, appearance, screen.open)
    }
    await context.addCookies(JSON.parse(await readFile(scope.owner.storageStatePath, 'utf8')).cookies)
    await selectFixtureWorkspace(target)
    const matrix = screens(fixtures.fixture)
    report.requiredScreens = ['sign-in', ...publicScreens(fixtures.fixture).map(screen => screen.name), ...matrix.map(screen => screen.name)]
    for (const appearance of report.themes) {
      await theme(target, appearance)
      for (const screen of matrix) await capture(screen.name, appearance, screen.open)
    }
    assert.deepEqual(errors, [], 'Web capture must have no uncaught page errors')
    assert.equal(report.screens.length, report.requiredScreens.length * report.themes.length)
    passed = true
  } else {
    const matrix = screens(fixtures.fixture)
    report.requiredScreens = ['sign-in', ...publicScreens(fixtures.fixture).map(screen => screen.name), ...matrix.map(screen => screen.name), 'offline']
    report.nativeModeOrder = ['hosted-anonymous', 'bundled-anonymous', 'bundled-authenticated', 'hosted-authenticated']
    report.nativeProfiles = 1
    async function captureAnonymous(target) {
      for (const appearance of report.themes) {
        await target.page.goto(`${target.base}/en/sign-in`, { waitUntil: 'domcontentloaded' })
        await theme(target, appearance)
        await pair('sign-in', appearance, [target], async () => { await target.page.locator('input[type="email"]').waitFor() })
        for (const screen of publicScreens(fixtures.fixture)) await pair(screen.name, appearance, [target], screen.open)
      }
    }
    async function captureAuthenticated(target) {
      await nativeDeviceReady(target)
      for (const appearance of report.themes) {
        await theme(target, appearance)
        for (const screen of matrix) await pair(screen.name, appearance, [target], screen.open)
      }
      await offlinePairs([target])
    }
    // Anonymous screens precede the native vault login. Close only the window
    // between modes; the shared daemon is drained once, after all captures.
    const anonymousHosted = await launch('hosted')
    await captureAnonymous(anonymousHosted)
    await closeTarget(anonymousHosted)
    const bundled = await launch('bundled')
    await captureAnonymous(bundled)
    await authenticateBundled(bundled)
    await captureAuthenticated(bundled)
    await closeTarget(bundled)
    const hosted = await launch('hosted')
    await authenticateHosted(hosted)
    await captureAuthenticated(hosted)
    await closeTarget(hosted)
    assert.deepEqual(errors, [], 'The reused renderer must have no uncaught page errors')
    assert.equal(pendingImages.size, 0, 'Every native screenshot needs its corresponding mode')
    assert.equal(report.screens.length, report.requiredScreens.length * report.themes.length, 'Every screen must be captured in both themes')
    assert.equal(report.screens.filter(screen => !screen.passed).length, 0, 'Every screenshot must differ by at most 0.1% with identical dynamic-mask geometry')
    passed = true
  }
} finally {
  const failedCleanup = error => { cleanupError ??= error }
  let closed = true
  const failedClose = error => { closed = false; failedCleanup(error) }
  await systemBrowser?.close().catch(failedClose)
  await webBrowser?.close().catch(failedClose)
  for (const application of [...applications].reverse()) await closeElectron(application).catch(failedClose)
  let drained = profiles.length === 0
  if (closed && profiles.length) {
    try { drained = (await stopLocalDaemons(profiles)).profilesStopped } catch (error) { failedCleanup(error) }
  }
  if (closed && drained) {
    try {
      if (nativeResources) report.nativeCleanup = await nativeResources.cleanup({ drained: true })
      if (fixtures) { await fixtures.cleanup(); cleaned = true }
    } catch (error) { failedCleanup(error) }
  }
  // The pool re-fingerprints both users. A visual mismatch can release a clean
  // pair only after exact cleanup; unknown or leftover writes quarantine it.
  try { if (scope) await scope.release({ outcome: cleaned && !cleanupError ? 'clean' : 'dirty' }) } catch (error) { failedCleanup(error) }
  if (!cleanupError) for (const profile of profiles) await rm(profile, { recursive: true, force: true })
  report.result = passed && !cleanupError ? 'passed' : 'failed'
  report.cleanup = cleanupError ? 'failed' : cleaned ? 'passed' : 'not-created'
  if (cleanupError) report.cleanupErrorCode = /^[A-Za-z0-9_]{1,100}$/.test(cleanupError.code ?? '') ? cleanupError.code : cleanupError.name
  report.finishedAt = new Date().toISOString()
  report.pageErrors = errors
  await writeFile(join(output, 'parity.json'), `${JSON.stringify(report, null, 2)}\n`)
  await auditEvidence([output], { environment })
}
if (cleanupError) throw cleanupError
