import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { chromium } from '@playwright/test'
import { launchElectron } from './electron-launch.mjs'
import { acquireTestAccounts, auditEvidence } from '../../../scripts/test-accounts/session.mjs'
import { loadEnvironment } from '../../../scripts/test-accounts/environment.mjs'

// This is real production-build/DB acceptance. No test auth endpoint, browser
// cookie injection into the bundled renderer, provider response mock or trace.
const root = fileURLToPath(new URL('../../..', import.meta.url))
const environment = await loadEnvironment()
const output = resolve(process.env.MIKKA_DESKTOP_EVIDENCE ?? '.cache/desktop-evidence')
const started = Date.now()
await mkdir(output, { recursive: true })
const evidence = {
  version: 1, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  environmentId: environment.id, origin: environment.origin, database: environment.database.name,
  startedAt: new Date(started).toISOString(), checks: [],
}
const check = name => { evidence.checks.push({ name, result: 'passed' }); console.log(`PASS ${name}`) }
const nativeErrors = []
const profile = join(tmpdir(), `mikka-bundled-${process.pid}-${started}`)
let application
let browser
let scope
let passed = false

try {
  application = await launchElectron({
    ...(process.env.MIKKA_DESKTOP_EXECUTABLE ? { executablePath: process.env.MIKKA_DESKTOP_EXECUTABLE } : {}),
    args: process.env.MIKKA_DESKTOP_EXECUTABLE ? [] : [join(root, 'apps/desktop')],
    cwd: root,
    env: { ...process.env, MIKKA_DESKTOP_RENDERER: 'bundled', MIKKA_USER_DATA_DIR: profile },
    timeout: 90_000,
  })
  const page = await application.firstWindow({ timeout: 90_000 })
  page.setDefaultTimeout(30_000)
  page.on('pageerror', error => nativeErrors.push(error.name))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean(window.mikka?.bundled))
  assert.equal(new URL(page.url()).protocol, 'mikka:')
  assert.equal(new URL(page.url()).hostname, 'app')
  const boundary = await page.evaluate(() => ({
    require: typeof window.require, process: typeof window.process,
    cookies: document.cookie, flavor: window.mikka.app.flavor,
    mainFrame: window.top === window,
  }))
  assert.deepEqual(boundary, { require: 'undefined', process: 'undefined', cookies: '', flavor: 'dev', mainFrame: true })
  check('packaged local origin and isolated renderer')

  const csp = await page.evaluate(async () => (await fetch(location.href)).headers.get('content-security-policy'))
  assert.ok(csp?.includes("default-src 'none'"))
  assert.ok(csp.includes("object-src 'none'"))
  assert.ok(!csp.includes("'unsafe-eval'"))
  const blocked = await page.evaluate(async () => {
    try { await fetch('https://example.com/desktop-boundary'); return false } catch { return true }
  })
  assert.equal(blocked, true)
  check('local document CSP blocks external renderer fetches')

  await page.waitForFunction(() => document.body.innerText.trim().length > 30)
  await page.screenshot({ path: join(output, 'bundled-sign-in.png'), animations: 'disabled' })
  scope = await acquireTestAccounts({ runId: `desktop-${started}`, workerId: 'bundled-smoke', requestId: `desktop-${started}`, ttlMs: 300_000 })
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ storageState: scope.owner.storageStatePath })
  const systemBrowser = await context.newPage()

  // Observe the real system-browser handoff. The browser carries the leased
  // user's ordinary session; begin/return/PKCE exchange all execute normally.
  // This verifies handoff/reuse, not a new external Google/GitHub challenge.
  await application.evaluate(({ shell }) => {
    globalThis.__mikkaAcceptanceExternal = null
    shell.openExternal = async url => { globalThis.__mikkaAcceptanceExternal = url }
  })
  const handoff = page.evaluate(() => window.mikka.bundled.signIn({ provider: 'google', next: '/', locale: 'en' }))
  // Observe rejection while waiting, avoiding an unhandled promise on failure.
  let handoffError
  handoff.catch(error => { handoffError = error })
  let external
  for (let attempt = 0; attempt < 100; attempt++) {
    if (handoffError) throw new Error('Desktop handoff failed before browser navigation', { cause: handoffError })
    external = await application.evaluate(() => globalThis.__mikkaAcceptanceExternal)
    if (external) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(external, 'main must open the system browser')
  assert.equal(new URL(external).origin, environment.origin)
  await systemBrowser.goto(external, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await handoff
  await page.waitForFunction(() => window.mikka.bundled.session().then(value => Boolean(value?.user?.id)))
  const publicSession = await page.evaluate(() => window.mikka.bundled.session())
  assert.equal(publicSession.user.id, scope.owner.userId)
  assert.deepEqual(Object.keys(publicSession.session), ['id'])
  await scope.recordResource({ type: 'session', id: publicSession.session.id, ownerId: scope.owner.userId })
  check('system browser, loopback and single-use PKCE session handoff')

  const state = await readFile(scope.owner.storageStatePath, 'utf8')
  const secrets = JSON.parse(state).cookies.map(cookie => cookie.value).filter(Boolean)
  const rendererState = await page.evaluate(async () => ({
    cookie: document.cookie, local: { ...localStorage }, session: { ...sessionStorage },
    auth: await window.mikka.bundled.session(),
  }))
  for (const value of secrets) assert.ok(!JSON.stringify(rendererState).includes(value), 'browser credential reached renderer state')
  assert.equal(rendererState.cookie, '')
  check('no browser session credential in renderer-accessible state')

  await page.evaluate(() => window.mikka.notifications.setBadge(3))
  await page.evaluate(() => window.mikka.notifications.setBadge(0))
  const rejected = await page.evaluate(async () => {
    try { await window.mikka.notifications.show({ id: '', kind: 'awaiting', title: '', body: '', href: 'https://evil.example' }); return false } catch { return true }
  })
  assert.equal(rejected, true)
  const native = await page.evaluate(async () => ({ device: await window.mikka.device.status(), quota: await window.mikka.quota.get() }))
  assert.ok(['online', 'offline', 'connecting'].includes(native.device.status))
  assert.ok(Array.isArray(native.quota.quotas))
  check('native badge, payload validation, device and quota bridge')

  await page.goto('mikka://app/mikka/en/settings?section=computers', { waitUntil: 'domcontentloaded' })
  await page.getByText('Devices', { exact: true }).first().waitFor({ state: 'visible' })
  await page.screenshot({ path: join(output, 'bundled-devices.png'), animations: 'disabled' })
  assert.equal(nativeErrors.length, 0, `renderer uncaught errors: ${nativeErrors.join(',')}`)
  check('settings deep link and shared devices page')

  await page.evaluate(() => window.mikka.bundled.signOut())
  assert.equal(await page.evaluate(() => window.mikka.bundled.session()), null)
  check('sign-out clears the main-owned session')
  passed = true
} finally {
  await browser?.close().catch(() => {})
  await application?.close().catch(() => {})
  if (scope) await scope.release({ outcome: passed ? 'clean' : 'dirty' })
  evidence.finishedAt = new Date().toISOString()
  evidence.result = passed ? 'passed' : 'failed'
  await writeFile(join(output, 'smoke.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  await auditEvidence([output], { environment })
}
