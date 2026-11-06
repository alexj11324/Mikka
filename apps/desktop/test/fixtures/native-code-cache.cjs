// No accounts, backend, preload, credentials, inspector or cache bypass flags.
const { app, BrowserWindow, session, protocol } = require('electron')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { profile, cache, scheme } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
assert.equal(scheme.scheme, 'mikka')
assert.equal(app.commandLine.hasSwitch('no-sandbox'), false)
assert.equal(app.commandLine.hasSwitch('disable-setuid-sandbox'), false)
app.setPath('userData', profile)
app.enableSandbox()
protocol.registerSchemesAsPrivileged([scheme])
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const target = session.fromPartition('persist:mikka-code-cache-proof')
  target.setCodeCachePath(cache)
  // Deterministic, credential-free JS exceeds the normal cache size threshold.
  const functions = Array.from({ length: 3000 }, (_, index) => `function f${index}(value){return (value+${index})%997};`)
  const calls = Array.from({ length: 3000 }, (_, index) => `f${index}(${index})`).join('+')
  const script = `${functions.join('\n')}\nglobalThis.probeValue=${calls};document.title='cache-ready';`
  target.protocol.handle('mikka', request => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response(null, { status: 403 })
    const headers = { 'content-security-policy': "default-src 'none'; script-src 'self'; base-uri 'none'", 'x-content-type-options': 'nosniff' }
    if (url.pathname === '/mikka/assets/probe.js') return new Response(script, { headers: { ...headers, 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' } })
    if (url.pathname === '/mikka') return new Response('<!doctype html><script type="module" src="/mikka/assets/probe.js"></script>', { headers: { ...headers, 'content-type': 'text/html', 'cache-control': 'no-store' } })
    return new Response(null, { status: 404 })
  })
  const window = new BrowserWindow({ show: false, webPreferences: { session: target, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  for (let index = 0; index < 3; index++) {
    await window.loadURL('mikka://app/mikka')
    assert.equal(await window.webContents.executeJavaScript('document.title'), 'cache-ready')
    assert.equal(await window.webContents.executeJavaScript('typeof require'), 'undefined')
  }
  const preferences = window.webContents.getLastWebPreferences()
  assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false)
  // This only gives the asynchronous cache write time to drain in the isolated
  // proof. It is not used by the app or the unchanged cold-start stopwatch.
  await new Promise(resolve => setTimeout(resolve, 1000))
  console.log(JSON.stringify({ status: 'passed', codeCache: scheme.privileges.codeCache, navigations: 3,
    sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, v8CacheOptions: preferences.v8CacheOptions ?? 'default',
    electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch }))
  window.destroy()
  app.quit()
}).catch(() => { console.log(JSON.stringify({ status: 'failed', code: 'NATIVE_CODE_CACHE_FIXTURE_FAILED' })); app.exit(1) })
