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

const root = fileURLToPath(new URL('../../..', import.meta.url))
const environment = await loadEnvironment()
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
  version: 1, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  environmentId: environment.id, origin: environment.origin, database: environment.database.name,
  startedAt: new Date().toISOString(), viewport, checks: [], samples: [],
  measurement: {
    clock: 'Node performance.now, immediately before Electron launch to visible seeded message and enabled composer accepting a draft',
    process: 'fresh Electron process for every sample; existing authenticated profile; same backend/account/workspace',
    cache: 'normal profile/OS caches; no OS cache purge, artificial network delay or renderer response substitution',
    pairing: 'alternating bundled-first and hosted-first order',
  },
}
const check = name => { evidence.checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`) }
let scope, browser, fixtures, application, ownerEmail
let passed = false
const active = new Set()

async function launch(mode, extraArgs = []) {
  await scope.assertActive()
  const started = performance.now()
  const app = await launchElectron({
    ...(process.env.MIKKA_DESKTOP_EXECUTABLE ? { executablePath: process.env.MIKKA_DESKTOP_EXECUTABLE } : {}),
    args: [...(process.env.MIKKA_DESKTOP_EXECUTABLE ? [] : [join(root, 'apps/desktop')]), ...extraArgs],
    cwd: root, env: { ...process.env, MIKKA_DESKTOP_RENDERER: mode, MIKKA_USER_DATA_DIR: profiles[mode] }, timeout: 90_000,
  })
  active.add(app)
  const page = await app.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.name))
  await app.evaluate(({ BrowserWindow }, bounds) => { BrowserWindow.getAllWindows().find(window => !window.isDestroyed())?.setContentSize(bounds.width, bounds.height) }, viewport)
  return { app, page, errors, started }
}
async function close(app) { if (!app) return; try { await app.close() } finally { active.delete(app) } }

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
    await page.waitForFunction(expected => window.mikka.bundled.session().then(session => session?.user?.id === expected), account.userId)
    const session = await page.evaluate(() => window.mikka.bundled.session())
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

try {
  // The lease helper renews this five-minute lease while the process is alive.
  scope = await acquireTestAccounts({ runId: `desktop-lifecycle-${Date.now()}`, workerId: 'lifecycle', requestId: `lifecycle-${process.pid}-${Date.now()}`, ttlMs: 300_000 })
  fixtures = await createParityFixtures(scope)
  browser = await chromium.launch({ headless: true })
  let run = await launch('bundled')
  application = run.app
  ownerEmail = (await nativeSignIn(run.app, run.page)).user.email
  await selectFixture(run.page)
  await run.page.evaluate(() => localStorage.setItem('theme', 'light'))
  await close(run.app); application = null
  run = await launch('hosted')
  application = run.app
  await seedHosted(run.app, run.page)
  await selectFixture(run.page)
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
  await run.page.waitForFunction(owner => window.mikka.bundled.session().then(session => session?.user.id === owner), scope.owner.userId)
  await usable(run.page)
  assert.equal(await run.page.evaluate(() => document.cookie), '')
  check('two leased browser identities remain private in main and the real account/workspace menu switches back to the retained owner')
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
  if (application) await close(application).catch(() => {})
  for (const app of active) await close(app).catch(() => {})
  await browser?.close().catch(() => {})
  if (fixtures) await fixtures.cleanup().catch(() => { passed = false })
  if (scope) await scope.release({ outcome: passed ? 'clean' : 'dirty' })
  evidence.finishedAt = new Date().toISOString()
  evidence.result = passed ? 'passed' : 'failed'
  await writeFile(join(output, 'lifecycle.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  await auditEvidence([output], { environment })
  await rm(directory, { recursive: true, force: true })
}
