// Credential-free diagnosis of the exact sandboxed srcdoc frame used by
// lifecycle.mjs. This runs real Electron with the product protocol, CSP and
// preload; its deliberately empty transport has no identity or database.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { launchElectron } from './electron-launch.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'mikka-native-frame-'))
const renderer = join(directory, 'renderer'), profile = join(directory, 'profile')
const name = 'mikka-lifecycle-opaque-frame'
const events = []
let application, closed = false
const report = { version: 1, kind: 'credential-free-native-frame-diagnostic', startedAt: new Date().toISOString() }
try {
  await mkdir(renderer); await mkdir(profile)
  await writeFile(join(renderer, 'index.html'), '<!doctype html><html><head><title>Frame diagnostic</title></head><body><p>Native parent</p></body></html>')
  const pkg = JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8'))
  const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'silent' }
  await build({ ...common, entryPoints: [join(root, 'apps/desktop/src/preload/index.ts')], outfile: join(directory, 'preload.cjs'),
    define: { __MIKKA_APP_URL__: JSON.stringify('http://127.0.0.1:1/mikka'), __MIKKA_APP_VERSION__: JSON.stringify(pkg.version), __MIKKA_FLAVOR__: JSON.stringify('dev') } })
  await build({ ...common, outfile: join(directory, 'main.cjs'), stdin: { sourcefile: 'native-frame-probe.ts', resolveDir: root, loader: 'ts', contents: `
    import { app, BrowserWindow, protocol, session } from 'electron'
    import { bundledProtocol } from './apps/desktop/src/main/bundled-protocol'
    import { join } from 'node:path'
    if (!process.env.MIKKA_FRAME_PROBE_PROFILE) throw new Error('FRAME_PROFILE_REQUIRED')
    app.setPath('userData', process.env.MIKKA_FRAME_PROBE_PROFILE)
    app.enableSandbox()
    protocol.registerSchemesAsPrivileged([{ scheme: 'mikka', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])
    globalThis.__frameProbeCalls = { main: 0, frame: 0 }
    app.on('window-all-closed', () => app.quit())
    app.whenReady().then(async () => {
      session.defaultSession.protocol.handle('mikka', bundledProtocol(join(__dirname, 'renderer'), { request: async path => {
        const mode = new URL(path, 'http://local.invalid').searchParams.get('probe')
        if (mode === 'main' || mode === 'frame') globalThis.__frameProbeCalls[mode]++
        return Response.json({ fixture: true })
      } }))
      const window = new BrowserWindow({ width: 800, height: 600, show: true, webPreferences: {
        preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true,
        allowRunningInsecureContent: false, experimentalFeatures: false, additionalArguments: ['--mikka-app-origin=mikka://app'],
      } })
      await window.loadURL('mikka://app/mikka')
    })
  ` } })
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  application = await launchElectron({ args: [join(directory, 'main.cjs')], cwd: root, env: { ...env, MIKKA_FRAME_PROBE_PROFILE: profile }, timeout: 30_000 })
  const page = await application.firstWindow({ timeout: 30_000 })
  page.setDefaultTimeout(60_000)
  await page.waitForLoadState('load')
  assert.equal(await page.evaluate(() => typeof window.mikka), 'object')
  assert.equal(await page.evaluate(async () => (await fetch('/mikka/api/workspace?probe=main')).status), 200)
  const describe = frame => ({ named: frame.name() === name, nameEmpty: frame.name() === '', srcdoc: frame.url() === 'about:srcdoc', top: frame === page.mainFrame(), detached: frame.isDetached() })
  for (const type of ['frameattached', 'framenavigated', 'framedetached']) page.on(type, frame => { events.push({ type, ...describe(frame) }) })
  await page.evaluate(name => new Promise(resolve => {
    const frame = document.createElement('iframe')
    frame.id = name; frame.name = name; frame.hidden = true
    frame.sandbox.add('allow-scripts')
    frame.srcdoc = '<!doctype html><title>Untrusted frame</title><p>Boundary probe</p>'
    frame.addEventListener('load', () => resolve(), { once: true })
    document.body.append(frame)
  }), name)
  report.immediateNameLookup = Boolean(page.frame({ name }))
  report.immediateFrames = page.frames().map(describe)
  report.dom = await page.locator(`#${name}`).evaluate(frame => ({ exists: frame.isConnected, sandbox: frame.getAttribute('sandbox'), srcdoc: frame.hasAttribute('srcdoc'), hidden: frame.hidden }))
  report.byElement = await page.frameLocator(`#${name}`).locator('p').evaluate(async () => {
    let parentDenied = false, fetchDenied = false, status = null
    try { void parent.document.body } catch { parentDenied = true }
    try { status = (await fetch('mikka://app/mikka/api/workspace?probe=frame', { signal: AbortSignal.timeout(5000) })).status } catch { fetchDenied = true }
    return { body: document.body.textContent?.includes('Boundary probe') === true, bridge: typeof window.mikka, node: typeof window.require, parentDenied, fetchDenied, status }
  })
  report.finalFrames = page.frames().map(describe)
  report.events = events
  report.transport = await application.evaluate(() => globalThis.__frameProbeCalls)
  assert.equal(report.byElement.body, true)
  assert.equal(report.byElement.bridge, 'undefined')
  assert.equal(report.byElement.node, 'undefined')
  assert.equal(report.byElement.parentDenied, true)
  assert.ok(report.byElement.fetchDenied || report.byElement.status === 403)
  assert.deepEqual(report.transport, { main: 1, frame: 0 })
  report.result = 'passed'
} finally {
  try { if (application) await application.close(); closed = true }
  finally {
    report.closed = closed; report.finishedAt = new Date().toISOString()
    console.log(JSON.stringify(report))
    if (closed) await rm(directory, { recursive: true, force: true })
  }
}
