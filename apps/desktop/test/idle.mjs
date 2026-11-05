import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { launchElectron } from './electron-launch.mjs'
import { closeElectron, stopLocalDaemons } from './native-cleanup.mjs'
import { captureNativeResources } from './native-resources.mjs'
import { acquireTestAccounts, auditEvidence } from '../../../scripts/test-accounts/session.mjs'
import { loadEnvironment } from '../../../scripts/test-accounts/environment.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const environment = await loadEnvironment()
const runtime = JSON.parse(await readFile(resolve('.cache/desktop-runtime/processes.json'), 'utf8'))
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
assert.equal(runtime.revision, revision)
assert.equal(environment.deploymentSha, revision)
assert.equal(runtime.origin, environment.origin)
const durationMs = Number(process.env.MIKKA_DESKTOP_IDLE_MS ?? 3_600_000)
assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 10_000 && durationMs <= 7_200_000)
const output = resolve(process.env.MIKKA_DESKTOP_EVIDENCE ?? '.cache/desktop-evidence')
await mkdir(output, { recursive: true })
const report = {
  version: 1, revision, environmentId: environment.id, database: environment.database.name,
  origin: environment.origin, requestedDurationMs: durationMs, acceptanceRun: durationMs >= 3_600_000,
  method: 'simultaneous visible Coordinator screens; separate production Node processes; one isolated database and real live Worker',
  exclusions: ['setup and warmup', 'test-account lease maintenance in the harness process', 'PostgreSQL handshake and TCP/TLS overhead'],
}
let application
let browser
let scope
let nativeResources
let passed = false
const profile = join(tmpdir(), `mikka-idle-${process.pid}-${Date.now()}`)

function metrics(socketPath, reset = false) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: reset ? '/reset' : '/metrics', method: reset ? 'POST' : 'GET' }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', value => { text += value })
      response.on('end', () => {
        try { assert.equal(response.statusCode, 200); resolve(JSON.parse(text)) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

try {
  scope = await acquireTestAccounts({ runId: `desktop-idle-${Date.now()}`, workerId: 'hour', requestId: `hour-${Date.now()}`, ttlMs: 300_000 })
  nativeResources = await captureNativeResources(scope)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ storageState: scope.owner.storageStatePath, viewport: { width: 1440, height: 900 } })
  const web = await context.newPage()
  const webLive = { ready: 0, pong: 0 }
  web.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    const data = typeof payload === 'string' ? payload : payload.toString()
    if (data === 'pong') webLive.pong++
    else { try { if (JSON.parse(data).type === 'live_ready') webLive.ready++ } catch { /* not a live control frame */ } }
  }))
  application = await launchElectron({
    args: [join(root, 'apps/desktop')], cwd: root,
    env: { ...process.env, MIKKA_DESKTOP_RENDERER: 'bundled', MIKKA_USER_DATA_DIR: profile }, timeout: 90_000,
  })
  const page = await application.firstWindow({ timeout: 90_000 })
  await page.waitForFunction(() => Boolean(window.mikka?.bundled))
  await page.evaluate(() => {
    window.__mikkaIdleLive = { ready: 0, pong: 0 }
    window.mikka.bundled.live.onEvent(event => {
      if (event.type !== 'message') return
      if (event.data === 'pong') window.__mikkaIdleLive.pong++
      else { try { if (JSON.parse(event.data).type === 'live_ready') window.__mikkaIdleLive.ready++ } catch { /* not a live control frame */ } }
    })
  })
  await application.evaluate(({ shell, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setContentSize(1440, 900)
    globalThis.__mikkaIdleBrowser = null
    shell.openExternal = async url => { globalThis.__mikkaIdleBrowser = url }
  })
  const handoff = page.evaluate(() => window.mikka.bundled.signIn({ provider: 'google', locale: 'en', next: '/' }))
  let handoffError
  handoff.catch(error => { handoffError = error })
  let external
  for (let attempt = 0; attempt < 150; attempt++) {
    if (handoffError) throw new Error('DESKTOP_IDLE_HANDOFF_FAILED', { cause: handoffError })
    external = await application.evaluate(() => globalThis.__mikkaIdleBrowser)
    if (external) break
    await delay(100)
  }
  assert.equal(new URL(external).origin, environment.origin)
  const systemBrowser = await context.newPage()
  await systemBrowser.goto(external, { waitUntil: 'domcontentloaded' })
  await handoff
  await systemBrowser.close()
  const identity = await page.evaluate(() => window.mikka.bundled.session())
  assert.equal(identity.user.id, scope.owner.userId)
  await scope.recordResource({ type: 'session', id: identity.session.id, ownerId: scope.owner.userId })
  const webOrigin = new URL(environment.origin)
  webOrigin.port = String(runtime.hosted.port)
  await web.goto(`${webOrigin.origin}/mikka/en`, { waitUntil: 'domcontentloaded' })
  await page.goto('mikka://app/mikka/en', { waitUntil: 'domcontentloaded' })
  // Reinstall the observer after navigation; its only output is control-frame counts.
  await page.evaluate(() => {
    window.__mikkaIdleLive = { ready: 0, pong: 0 }
    window.mikka.bundled.live.onEvent(event => {
      if (event.type !== 'message') return
      if (event.data === 'pong') window.__mikkaIdleLive.pong++
      else { try { if (JSON.parse(event.data).type === 'live_ready') window.__mikkaIdleLive.ready++ } catch { /* not a live control frame */ } }
    })
  })
  for (const target of [web, page]) {
    await target.locator('textarea[data-chat-composer]').first().waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(await target.evaluate(() => document.visibilityState), 'visible')
  }
  await delay(35_000)
  assert.ok(webLive.ready > 0 && webLive.pong > 0, 'Web live channel must be healthy before measurement')
  const nativeLive = await page.evaluate(() => window.__mikkaIdleLive)
  assert.ok(nativeLive.pong > 0, 'Native live channel must be healthy before measurement')
  const [nativeWarmup, webWarmup] = await Promise.all([metrics(runtime.bundled.socket), metrics(runtime.hosted.socket)])
  for (const sample of [nativeWarmup, webWarmup]) {
    assert.ok(sample.queryCalls > 0 && sample.pgProtocolReceiveBytes > 0, 'Warmup must prove the real PostgreSQL driver is instrumented')
    assert.equal(sample.unknownReadings, 0)
  }
  report.warmup = { bundled: nativeWarmup, web: webWarmup }
  const [nativeStart, webStart] = await Promise.all([metrics(runtime.bundled.socket, true), metrics(runtime.hosted.socket, true)])
  report.startedAt = new Date().toISOString()
  report.measurementStart = { bundled: nativeStart, web: webStart }
  await writeFile(join(output, 'idle-progress.json'), `${JSON.stringify({ ...report, status: 'measuring' }, null, 2)}\n`)
  console.log(`MEASURING ${durationMs}ms of real idle time; ${report.acceptanceRun ? 'one-hour acceptance' : 'diagnostic only'}`)
  const start = performance.now()
  await delay(durationMs)
  report.elapsedMonotonicMs = performance.now() - start
  await scope.assertActive()
  const [bundled, hosted] = await Promise.all([metrics(runtime.bundled.socket), metrics(runtime.hosted.socket)])
  report.finishedAt = new Date().toISOString()
  report.bundled = bundled
  report.web = hosted
  report.live = { bundled: await page.evaluate(() => window.__mikkaIdleLive), web: webLive }
  for (const target of [web, page]) assert.equal(await target.evaluate(() => document.visibilityState), 'visible')
  assert.equal(bundled.unknownReadings, 0)
  assert.equal(hosted.unknownReadings, 0)
  assert.ok(report.elapsedMonotonicMs >= durationMs)
  assert.ok(bundled.queryCalls <= hosted.queryCalls, `Native queries ${bundled.queryCalls} > web ${hosted.queryCalls}`)
  assert.ok(bundled.pgProtocolReceiveBytes <= hosted.pgProtocolReceiveBytes, `Native DB bytes ${bundled.pgProtocolReceiveBytes} > web ${hosted.pgProtocolReceiveBytes}`)
  assert.ok(report.live.bundled.pong >= Math.floor(durationMs / 30_000) - 3)
  assert.ok(report.live.web.pong >= Math.floor(durationMs / 30_000) - 3)
  passed = true
} finally {
  const cleanupErrors = []
  const failedCleanup = error => { passed = false; cleanupErrors.push(error) }
  await browser?.close().catch(failedCleanup)
  let closed = true
  await closeElectron(application).catch(error => { closed = false; failedCleanup(error) })
  let drained = false
  if (closed) {
    try { drained = (await stopLocalDaemons([profile])).profilesStopped } catch (error) { failedCleanup(error) }
  }
  if (drained && nativeResources) {
    try { report.nativeCleanup = await nativeResources.cleanup({ drained: true }) } catch (error) { failedCleanup(error) }
  }
  if (scope) await scope.release({ outcome: passed ? 'clean' : 'dirty' }).catch(failedCleanup)
  report.result = passed ? 'passed' : 'failed'
  await writeFile(join(output, 'idle.json'), `${JSON.stringify(report, null, 2)}\n`)
  await auditEvidence([output], { environment })
  if (!cleanupErrors.length) await rm(profile, { recursive: true, force: true })
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'DESKTOP_IDLE_CLEANUP_FAILED')
}
