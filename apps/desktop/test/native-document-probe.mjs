// Real Electron navigation diagnosis, without auth, database, network requests,
// daemon setup or application data. The product preload remains sandboxed.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchElectron } from './electron-launch.mjs'
import { observeNativeNavigation, waitForBundledRootDocument } from './native-document.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'mikka-native-document-'))
const profile = join(directory, 'profile')
const report = { version: 1, kind: 'credential-free-native-document-diagnostic',
  startedAt: new Date().toISOString(), acceptanceRun: false, events: [], overflow: false }
let application, closed = false
async function bounded(promise, timeout) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DOCUMENT_PROBE_TIMEOUT')), timeout) })]) }
  finally { clearTimeout(timer) }
}
try {
  await mkdir(profile)
  report.sources = Object.fromEntries(await Promise.all([
    'apps/desktop/test/native-document-probe.mjs', 'apps/desktop/test/native-document.mjs',
    'apps/desktop/test/electron-launch.mjs', 'apps/desktop/src/preload/index.ts',
  ].map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
  const pkg = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
  await build({ bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'silent',
    entryPoints: [join(root, 'apps/desktop/src/preload/index.ts')], outfile: join(directory, 'preload.cjs'),
    define: { __MIKKA_APP_URL__: JSON.stringify('http://127.0.0.1:1/mikka'), __MIKKA_APP_VERSION__: JSON.stringify(pkg.version), __MIKKA_FLAVOR__: JSON.stringify('dev') } })
  await writeFile(join(directory, 'main.cjs'), `
    const { app, BrowserWindow, protocol, session } = require('electron')
    const { join } = require('node:path')
    if (!process.env.MIKKA_DOCUMENT_PROBE_PROFILE) throw new Error('DOCUMENT_PROFILE_REQUIRED')
    app.setPath('userData', process.env.MIKKA_DOCUMENT_PROBE_PROFILE)
    app.enableSandbox()
    protocol.registerSchemesAsPrivileged([{ scheme: 'mikka', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
    app.on('window-all-closed', () => app.quit())
    app.whenReady().then(async () => {
      let phase = 'initial', release
      const gate = new Promise(resolve => { release = resolve })
      const headers = { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'self'; base-uri 'none'; object-src 'none'" }
      session.defaultSession.protocol.handle('mikka', async request => {
        const path = new URL(request.url).pathname
        if (path === '/mikka/initial-gate.js') { await gate; return new Response('globalThis.__initialScriptCompleted = true', { headers: { 'content-type': 'text/javascript' } }) }
        if (path !== '/mikka') return new Response('', { status: 404 })
        const script = phase === 'initial' ? '<script src="mikka://app/mikka/initial-gate.js"></script>' : ''
        return new Response('<!doctype html><html><head><title>' + phase + '</title>' + script + '</head><body><p>' + phase + '</p></body></html>', { headers })
      })
      const window = new BrowserWindow({ width: 800, height: 600, show: true, webPreferences: {
        preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true,
        allowRunningInsecureContent: false, experimentalFeatures: false, additionalArguments: ['--mikka-app-origin=mikka://app'],
      } })
      const blankReady = window.loadURL('about:blank')
      globalThis.__documentProbe = {
        blankReady,
        start() { void window.loadURL('mikka://app/mikka') },
        release() { release() },
        returned() { phase = 'returned'; void window.loadURL('mikka://app/mikka') },
      }
      await blankReady
    })
  `)
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'DISPLAY', 'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
    'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  application = await launchElectron({ args: [join(directory, 'main.cjs')], cwd: root,
    env: { ...env, MIKKA_DOCUMENT_PROBE_PROFILE: profile }, timeout: 30_000 })
  const page = await application.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(15_000)
  observeNativeNavigation(page, report)
  await application.evaluate(() => globalThis.__documentProbe.blankReady)
  await page.waitForURL('about:blank', { waitUntil: 'domcontentloaded' })
  await application.evaluate(() => globalThis.__documentProbe.start())
  await page.waitForFunction(() => Boolean(window.mikka?.bundled))
  assert.equal(await page.evaluate(() => document.readyState), 'loading')

  // The old load-state/bridge sequence is now satisfied even though the actual
  // initial document still waits on its parser-blocking script. Its next DOM
  // event therefore cannot prove an authentication-return navigation happened.
  const oldReturned = page.waitForEvent('domcontentloaded')
  const initialReady = waitForBundledRootDocument(page, { timeout: 15_000 })
  await application.evaluate(() => globalThis.__documentProbe.release())
  await oldReturned
  report.oldWaiterDocument = await page.title()
  assert.equal(report.oldWaiterDocument, 'initial')
  await initialReady

  const realReturned = page.waitForEvent('domcontentloaded')
  // Hold an ordinary renderer evaluation across the real second navigation.
  // This demonstrates context destruction mechanically, without claiming that
  // this controlled predicate is the precise unrecorded CI call site.
  const lostEvaluation = page.evaluate(() => new Promise(() => { globalThis.__evaluationPending = true })).then(
    () => false, error => /Execution context was destroyed|Cannot find context with specified id/.test(error.message))
  await page.waitForFunction(() => globalThis.__evaluationPending === true)
  await application.evaluate(() => globalThis.__documentProbe.returned())
  await realReturned
  await waitForBundledRootDocument(page, { timeout: 15_000 })
  report.correctWaiterDocument = await page.title()
  report.pendingEvaluationLostContext = await bounded(lostEvaluation, 15_000)
  report.bridgeStillPresent = await page.evaluate(() => typeof window.mikka?.bundled === 'object')
  report.runtime = await application.evaluate(() => ({ electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }))
  assert.equal(report.correctWaiterDocument, 'returned')
  assert.equal(report.pendingEvaluationLostContext, true)
  assert.equal(report.bridgeStillPresent, true)
  report.result = 'passed'
} finally {
  try { if (application) await application.close(); closed = true }
  finally {
    report.closed = closed; report.finishedAt = new Date().toISOString()
    console.log(JSON.stringify(report))
    if (closed) await rm(directory, { recursive: true, force: true })
  }
}
