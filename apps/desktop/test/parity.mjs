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
import { createCaptureClock, installCaptureClock } from './parity-clock.mjs'
import { launchElectron } from './electron-launch.mjs'
import { waitForBundledSession } from './bundled-session.mjs'
import { closeElectron, stopLocalDaemons } from './native-cleanup.mjs'
import { captureNativeResources } from './native-resources.mjs'
import { captureGeneratedWorkspaceName } from './generated-workspace-name.mjs'
import { assertNativeViewport, assertViewportPng, setNativeViewport } from './native-viewport.mjs'
import { authDiagnosticRoute, nativeDiagnosticFailure, readNativeAuthDiagnostics, startNativeAuthDiagnostics, stopNativeAuthDiagnostics } from './native-auth-diagnostics.mjs'
import { observeReads, pageReadRequirements, pageReady, readActionIds, selectParityWorkspace } from './parity-page-ready.mjs'
import { settingsReadRequirements, settingsReady } from './parity-settings-ready.mjs'
import { waitForNativeDevice } from './native-device-ready.mjs'
import { continueInSystemBrowser } from './browser-handoff.mjs'

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
const initialWorkspaceMenuNames = [messages.Nav.workspaceMenu, JSON.parse(await readFile(join(root, 'messages/zh-CN.json'), 'utf8')).Nav.workspaceMenu]
const actionIds = await readActionIds(resolve(process.env.MIKKA_TEST_APP_DIR ?? process.cwd()))
const report = {
  version: 1, mode, appRevision: environment.deploymentSha, harnessRevision: revision,
  harnessSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).update(await readFile(new URL('./parity-fixtures.mjs', import.meta.url))).update(await readFile(new URL('./generated-workspace-name.mjs', import.meta.url))).update(await readFile(new URL('./parity-images.mjs', import.meta.url))).update(await readFile(new URL('./parity-clock.mjs', import.meta.url))).update(await readFile(new URL('./native-viewport.mjs', import.meta.url))).update(await readFile(new URL('./native-auth-diagnostics.mjs', import.meta.url))).update(await readFile(new URL('./parity-reader-defaults.mjs', import.meta.url))).update(await readFile(new URL('./parity-page-ready.mjs', import.meta.url))).update(await readFile(new URL('./parity-settings-ready.mjs', import.meta.url))).update(await readFile(new URL('./native-device-ready.mjs', import.meta.url))).update(await readFile(new URL('../../../scripts/acceptance/read-action-transport.mjs', import.meta.url))).digest('hex'),
  environmentId: environment.id, database: environment.database.name, origin: environment.origin,
  viewport: { width: 1440, height: 900 }, colorThreshold: 0, maximumChangedRatio: 0.001,
  timeZone: 'UTC',
  captureClock: createCaptureClock(started, process.env.MIKKA_DESKTOP_CAPTURE_TIME),
  nativeViewports: [],
  themes: ['light', 'dark'], masksAllowed: ['avatars', 'timestamps'], excludedDesktopOnly: ['data-desktop-only: server row, Settings › 服务器'], startedAt: new Date(started).toISOString(), screens: [],
}
await mkdir(output, { recursive: true })
let scope
let fixtures
let nativeResources
let generatedWorkspaceName
let systemBrowser
let webBrowser
const applications = new Set()
const nativeTimeZoneSessions = new Map()
const profiles = []
const pendingImages = new Map()
const errors = []
let passed = false
let cleaned = false
let cleanupError
let stage = 'prepare'

async function launch(mode) {
  stage = `launch-${mode}`
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
  stage = `renderer-ready-${mode}`
  page.setDefaultTimeout(45_000)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', error => errors.push({ mode, name: error.name }))
  await page.waitForLoadState('domcontentloaded')
  // Initial hosted navigation may still be redirecting to sign-in after the
  // first DOMContentLoaded. Wait for the real anonymous or signed-in surface
  // before reading its viewport; keep all dimension assertions unchanged.
  let initialSurface = page.locator('input[type="email"]')
  for (const name of initialWorkspaceMenuNames) initialSurface = initialSurface.or(page.getByRole('button', { name, exact: true }))
  await initialSurface.first().waitFor()
  const base = mode === 'bundled' ? 'mikka://app/mikka' : `${environment.origin}${environment.basePath}`
  if (mode === 'bundled') await page.waitForFunction(() => Boolean(window.mikka?.bundled))
  else assert.equal(new URL(page.url()).origin, environment.origin, 'Hosted comparison must use the attested backend')
  stage = `viewport-${mode}`
  const nativeViewport = await setNativeViewport(application, page, report.viewport)
  // Keep the public CDP session attached until this app closes. The same UTC
  // reader defaults are exercised by the ordinary web comparison context.
  const timeZoneSession = await page.context().newCDPSession(page)
  await timeZoneSession.send('Emulation.setTimezoneOverride', { timezoneId: report.timeZone })
  nativeTimeZoneSessions.set(application, timeZoneSession)
  const actualTimeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  assert.equal(actualTimeZone, report.timeZone)
  report.nativeViewports.push({ mode, ...nativeViewport, timeZone: { method: 'cdp_timezone_override', actual: actualTimeZone } })
  await assertNativeViewport(page, report.viewport)
  // Anonymous capture navigates and reloads after this point, so the shared
  // provider's first render in every captured document sees the fixed Date.
  await installCaptureClock(page, report.captureClock)
  return { mode, application, page, base }
}

async function closeTarget(target) {
  stage = `close-${target.mode}`
  await closeElectron(target.application)
  applications.delete(target.application)
  nativeTimeZoneSessions.delete(target.application)
}

async function go(target, suffix = '/') {
  await scope?.assertActive()
  const href = `${target.base}/en${suffix === '/' ? '' : suffix}`
  await target.page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // The artifact opens a real modal, which correctly hides the background
  // workspace control from the accessibility tree. Wait for that surface.
  if (new URL(href).searchParams.has('artifact')) await target.page.getByRole('dialog').waitFor()
  else await target.page.getByRole('button', { name: messages.Nav.workspaceMenu, exact: true }).first().waitFor()
}

async function theme(target, value) {
  stage = `theme-${target.mode}-${value}`
  // Apply the ordinary persisted appearance preference to each renderer
  // partition. A hosted auth redirect can replace its document after native
  // readiness: Playwright retries this idempotent predicate in the new context.
  await target.page.waitForFunction(value => {
    localStorage.setItem('theme', value)
    return localStorage.getItem('theme') === value
  }, value)
  await target.page.emulateMedia({ colorScheme: value, reducedMotion: 'reduce' })
  await target.page.reload({ waitUntil: 'domcontentloaded' })
  await target.page.waitForFunction(value => document.documentElement.classList.contains(value), value)
}

async function pair(name, appearance, targets, open, check) {
  const key = `${appearance}/${name}`
  const images = pendingImages.get(key) ?? new Map()
  for (const target of targets) {
    stage = `capture-${target.mode}-${name}`
    await open(target)
    assert.ok(!images.has(target.mode), 'Each native mode is captured once per screen')
    await assertNativeViewport(target.page, report.viewport)
    assert.equal(await target.page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), report.timeZone)
    const captured = await screenshot(target.page, join(output, `${appearance}-${name}-${target.mode}.png`))
    await check?.(target)
    assertViewportPng(captured.bytes, report.viewport)
    images.set(target.mode, captured)
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
  stage = 'bundled-auth-browser'
  systemBrowser = await chromium.launch({ headless: true })
  const context = await systemBrowser.newContext({ storageState: scope.owner.storageStatePath })
  const page = await context.newPage()
  const browserResponses = []
  const observeResponse = response => {
    if (browserResponses.length < 200) browserResponses.push({ at: Date.now(), route: authDiagnosticRoute(response.url()), status: response.status() })
  }
  await startNativeAuthDiagnostics(bundled.application, { profile: profiles[0], ownerId: scope.owner.userId, serverUrl: environment.origin + environment.basePath })
  page.on('response', observeResponse)
  try {
    await bundled.application.evaluate(({ shell }) => {
      globalThis.__mikkaParityExternal = null
      shell.openExternal = async url => { globalThis.__mikkaParityExternal = url }
    })
    stage = 'bundled-auth-open'
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
    stage = 'bundled-auth-handoff'
    await continueInSystemBrowser(page, external)
    await handoff
    stage = 'bundled-auth-session'
    const identity = await waitForBundledSession(bundled.page, scope.owner.userId)
    assert.equal(identity.user.id, scope.owner.userId)
    assert.deepEqual(Object.keys(identity.session), ['id'])
    await scope.recordResource({ type: 'session', id: identity.session.id, ownerId: scope.owner.userId })
  } catch (error) {
    report.authFailure = { stage, error: nativeDiagnosticFailure(error), browserResponses,
      main: await readNativeAuthDiagnostics(bundled.application).catch(() => ({ available: false })) }
    throw error
  } finally {
    page.off('response', observeResponse)
    await stopNativeAuthDiagnostics(bundled.application)
  }
  await systemBrowser.close(); systemBrowser = undefined
  stage = 'bundled-auth-workspace'
  await selectFixtureWorkspace(bundled)
}

async function selectFixtureWorkspace(target) {
  await go(target)
  await selectParityWorkspace(target.page, { menuName: messages.Nav.workspaceMenu, workspaceName: fixtures.fixture.workspaceName, basePath: environment.basePath })
  await coordinatorReady(target.page)
}

async function coordinatorReady(page) {
  await page.getByRole('region', { name: messages.Coordinator.conversation, exact: true }).getByText('Review the desktop workspace, including conversations, tasks, artifacts and settings.', { exact: true }).waitFor()
}

function screens(fixture) {
  const route = (name, path, ready) => ({ name, open: async target => { await go(target, path); if (ready) await ready(target.page) } })
  const text = value => page => page.getByText(value, { exact: true }).first().waitFor()
  const panel = (bot, tab) => ({
    name: `${bot ? 'bot' : 'coordinator'}-${tab}`,
    open: async target => {
      await go(target, bot ? `/?bot=${fixture.bot}` : '/')
      // Before the real roster arrives, a bot URL briefly renders the
      // Coordinator's panel. Wait for the requested conversation before
      // acting; a registered tab alone can still belong to that placeholder.
      await target.page.getByRole('list', { name: messages.Nav.bots, exact: true }).getByRole('button', { name: fixture.botName, exact: true }).waitFor()
      const overview = target.page.getByRole('complementary', { name: messages.Shell.panel.label, exact: true })
      await overview.getByRole('heading', { name: bot ? fixture.botName : messages.Nav.coordinator, exact: true }).waitFor()
      await overview.getByRole('tablist', { name: messages.Shell.panel.tabs, exact: true }).locator('[role="tab"][aria-selected="true"][aria-controls]').waitFor()
      await overview.getByRole('tab', { name: messages.Shell.panel[tab], exact: true }).click()
      await overview.getByRole('tab', { name: messages.Shell.panel[tab], exact: true, selected: true }).waitFor()
      await overview.getByRole('tabpanel', { name: messages.Shell.panel[tab], exact: true }).waitFor()
    },
    check: async target => {
      const overview = target.page.getByRole('complementary', { name: messages.Shell.panel.label, exact: true })
      const heading = overview.getByRole('heading', { name: bot ? fixture.botName : messages.Nav.coordinator, exact: true })
      assert.equal(await heading.count(), 1, 'Captured panel must belong to the requested conversation')
      assert.equal(await heading.isVisible(), true, 'Captured conversation heading must be visible')
      assert.equal(await overview.getByRole('tab', { name: messages.Shell.panel[tab], exact: true }).getAttribute('aria-selected'), 'true', 'Captured panel must still be the requested tab')
    },
  })
  const taskView = view => ({
    name: view,
    open: async target => {
      await go(target, '/?section=all-issues')
      const layout = target.page.getByRole('group', { name: messages.Shell.board.viewLabel, exact: true })
      // The initial HTML selects Board while the browser preference is still
      // restoring. Wait for registration and that existing preference's commit
      // before selecting a view once; never replace the saved preference here.
      await layout.locator('button[tabindex="0"]').waitFor()
      const saved = await target.page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('mikka:board-v2') ?? 'null')?.view ?? null }
        catch { return null }
      })
      assert.ok(saved === null || saved === 'board' || saved === 'list', 'Board fixture preference must be a known layout')
      const initial = messages.Shell.board[saved === 'list' ? 'viewList' : 'viewBoard']
      await layout.getByRole('button', { name: initial, exact: true, pressed: true }).waitFor()
      const label = messages.Shell.board[view === 'board' ? 'viewBoard' : 'viewList']
      await layout.getByRole('button', { name: label, exact: true }).click()
      await layout.getByRole('button', { name: label, exact: true, pressed: true }).waitFor()
      await target.page.getByText(fixture.issueTitle, { exact: true }).first().waitFor()
    },
    check: async target => assert.equal(await target.page.getByRole('button', { name: messages.Shell.board[view === 'board' ? 'viewBoard' : 'viewList'], exact: true }).getAttribute('aria-pressed'), 'true', 'Captured task layout must still be the requested view'),
  })
  const matrix = [
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
    route('bot-thread-list', `/?bot=${fixture.bot}&threads=${fixture.bot}`),
    route('thread', `/?bot=${fixture.bot}&thread=${fixture.run}`, text('The review is complete. Conversations, task details and artifacts are ready.')),
    taskView('board'),
    taskView('list'),
    route('projects', '/?section=projects'),
    route('team-home', `/?team=${fixture.team}`, async page => {
      await page.getByRole('heading', { name: fixture.teamName, exact: true, level: 1 }).waitFor()
      // The two leased members and their avatars arrive after the team shell.
      // Include their actual DOM in the existing semantic mask measurement.
      await page.getByRole('tab', { name: `${messages.Invite.roles.member} · 2`, exact: true }).waitFor()
    }),
    route('team-tasks', `/?section=team-issues&team=${fixture.team}`, text(fixture.issueTitle)),
    route('team-projects', `/?section=team-projects&team=${fixture.team}`),
    route('plugins', '/?section=plugins'),
    route('suggestions', '/?section=suggestions'),
    route('artifact-library', '/?section=artifacts', text(fixture.artifactTitle)),
    route('artifact-markdown', `/?artifact=${fixture.markdown}`, page => page.getByRole('dialog').getByText('Desktop review', { exact: true }).waitFor()),
    route('artifact-html', `/?artifact=${fixture.html}`, page => page.getByRole('dialog').locator('iframe').waitFor()),
    { name: 'new-task', open: async target => {
      await go(target)
      await target.page.getByRole('button', { name: messages.Shell.searchLabel, exact: true }).click()
      await target.page.getByRole('dialog', { name: messages.Shell.searchLabel, exact: true }).getByRole('option', { name: messages.Shell.newTask, exact: true }).click()
      await target.page.getByRole('dialog', { name: messages.Shell.newTaskDialog.title, exact: true }).waitFor()
    } },
    // This parity environment is the cloud edition (desktop.yml). The Mikka
    // cloud connection page exists only for community server administrators;
    // its real component states are captured by self-hosting-ui.yml instead.
    // 组织 (organization) is drawn only by a UI layer; the open-source package
    // under test has no such page (tests/settings-sections.test.mjs LAYER_ONLY).
    ...Object.entries(messages.Settings.sections).filter(([id]) => id !== 'developer' && id !== 'cloud' && id !== 'organization').map(([id, section]) => ({
      name: `settings-${id}`,
      open: async target => {
        if (id === 'audit') {
          // Exercise the ordinary in-Settings navigation in both builds. The
          // unmodified web baseline predates the cold infinite-read repair.
          await go(target, `/settings?workspace=${fixture.workspace}&section=general`)
          await target.page.getByRole('textbox', { name: messages.Settings.workspaceForm.name, exact: true }).waitFor()
          await target.page.getByRole('link', { name: section.title, exact: true }).click()
        } else await go(target, ['members', 'teams'].includes(id) ? `/settings/${id}?workspace=${fixture.workspace}` : `/settings?workspace=${fixture.workspace}&section=${id}`)
        await target.page.getByRole('heading', { name: section.title, exact: true }).first().waitFor()
      },
    })),
  ]
  assert.equal(new Set(matrix.map(screen => screen.name)).size, matrix.length, 'Every parity screen needs a unique evidence name')
  return matrix.map(screen => ({ ...screen, open: async target => {
    const section = screen.name.startsWith('settings-') ? screen.name.slice('settings-'.length) : null
    const requirements = section ? settingsReadRequirements(section, fixture) : pageReadRequirements(screen.name, fixture)
    const readsFinished = observeReads(target.page, requirements, actionIds, environment.basePath)
    await screen.open(target)
    const observed = await readsFinished()
    if (section) await settingsReady(target.page, section, fixture, messages, observed)
    else await pageReady(target.page, screen.name, fixture, messages, observed)
  } }))
}

function publicScreens(fixture) {
  return [
    { name: 'shared-markdown', token: fixture.markdownToken, ready: async page => {
      await page.getByRole('heading', { name: fixture.artifactTitle, exact: true }).first().waitFor()
      await page.getByText('The workspace shares its components with the web application.', { exact: true }).waitFor()
    } },
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
  stage = 'acquire-lease'
  scope = await acquireTestAccounts({ runId: `parity-${started}`, workerId: 'desktop-parity', requestId: `parity-${started}`, ttlMs: 300_000 })
  if (mode === 'desktop') {
    stage = 'capture-generated-workspace-name'
    generatedWorkspaceName = await captureGeneratedWorkspaceName(scope)
  }
  stage = 'create-fixtures'
  fixtures = await createParityFixtures(scope)
  report.fixtureEpoch = fixtures.fixture.epoch
  stage = 'capture-native-baseline'
  if (mode === 'desktop') nativeResources = await captureNativeResources(scope)
  if (mode === 'web-capture') {
    webBrowser = await chromium.launch({ headless: true })
    const context = await webBrowser.newContext({ viewport: report.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', timezoneId: 'UTC' })
    const page = await context.newPage()
    await installCaptureClock(page, report.captureClock)
    page.setDefaultTimeout(45_000)
    page.on('pageerror', error => errors.push({ mode: 'web', name: error.name }))
    const target = { mode: 'web', page, base: `${environment.origin}${environment.basePath}` }
    async function capture(name, appearance, open, check) {
      stage = `capture-web-${name}`
      await open(target)
      assert.equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), report.timeZone)
      const filename = `${appearance}-${name}-web.png`
      const result = await screenshot(page, join(output, filename), { identities: fixtures.fixture.dynamicIdentityEmails })
      await check?.(target)
      assertViewportPng(result.bytes, report.viewport)
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
      for (const screen of matrix) await capture(screen.name, appearance, screen.open, screen.check)
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
      stage = `native-device-${target.mode}`
      await waitForNativeDevice(target, { scope, profile: profiles[0], record: value => { (report.nativeDeviceChecks ??= []).push(value) } })
      for (const appearance of report.themes) {
        await theme(target, appearance)
        for (const screen of matrix) await pair(screen.name, appearance, [target], screen.open, screen.check)
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
} catch (error) {
  report.failure = { stage, error: nativeDiagnosticFailure(error) }
  throw error
} finally {
  const failedCleanup = error => {
    cleanupError ??= error
    report.cleanupFailures ??= []
    if (report.cleanupFailures.length < 8) report.cleanupFailures.push({ stage, error: nativeDiagnosticFailure(error) })
  }
  let closed = true
  const failedClose = error => { closed = false; failedCleanup(error) }
  stage = 'close-browser'
  await systemBrowser?.close().catch(failedClose)
  await webBrowser?.close().catch(failedClose)
  stage = 'close-applications'
  for (const application of [...applications].reverse()) await closeElectron(application).catch(failedClose)
  nativeTimeZoneSessions.clear()
  let drained = profiles.length === 0
  if (closed && profiles.length) {
    stage = 'drain-profiles'
    try { drained = (await stopLocalDaemons(profiles)).profilesStopped } catch (error) { failedCleanup(error) }
  }
  if (closed && drained) {
    try {
      stage = 'cleanup-native-resources'
      if (nativeResources) report.nativeCleanup = await nativeResources.cleanup({ drained: true })
      stage = 'cleanup-fixtures'
      if (fixtures) { await fixtures.cleanup(); cleaned = true }
      if (cleaned && report.nativeCleanup?.cleaned === true && generatedWorkspaceName) {
        stage = 'cleanup-generated-workspace-name'
        try { await generatedWorkspaceName.restore({ drained: true }) }
        finally { report.workspaceNameCleanup = generatedWorkspaceName.read() }
      }
    } catch (error) { failedCleanup(error) }
  }
  // The pool re-fingerprints both users. A visual mismatch can release a clean
  // pair only after exact cleanup; unknown or leftover writes quarantine it.
  stage = 'release-lease'
  try { if (scope) await scope.release({ outcome: cleaned && !cleanupError ? 'clean' : 'dirty' }) } catch (error) { failedCleanup(error) }
  if (!cleanupError) for (const profile of profiles) await rm(profile, { recursive: true, force: true })
  report.result = passed && !cleanupError ? 'passed' : 'failed'
  report.cleanup = cleanupError ? 'failed' : cleaned ? 'passed' : 'not-created'
  if (cleanupError) report.cleanupError = nativeDiagnosticFailure(cleanupError)
  report.finishedAt = new Date().toISOString()
  report.pageErrors = errors
  await writeFile(join(output, 'parity.json'), `${JSON.stringify(report, null, 2)}\n`)
  await auditEvidence([output], { environment })
}
if (cleanupError) throw cleanupError
