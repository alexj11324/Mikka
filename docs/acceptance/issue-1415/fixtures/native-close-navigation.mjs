import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const options = new Map()
for (let index = 2; index < process.argv.length; index += 2) options.set(process.argv[index], process.argv[index + 1])
assert.ok([...options.keys()].every(key => ['--repository', '--helper', '--expect'].includes(key)), 'CLOSE_FIXTURE_ARGUMENTS')
const repository = resolve(options.get('--repository') ?? process.cwd())
const helper = options.get('--helper') ?? join(repository, 'apps/desktop/test/native-cleanup.mjs')
const expected = options.get('--expect')
assert.ok(isAbsolute(helper) && helper.startsWith(`${repository}${sep}`), 'CLOSE_FIXTURE_HELPER_BOUNDARY')
assert.ok(expected === 'before' || expected === 'after', 'CLOSE_FIXTURE_EXPECTATION')
assert.notEqual(process.getuid?.(), 0, 'CLOSE_FIXTURE_REQUIRES_NON_ROOT')
const require = createRequire(join(repository, 'apps/desktop/package.json'))
const { _electron } = require('@playwright/test')
const { closeElectron } = await import(pathToFileURL(helper).href)

const main = `const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',process.env.MIKKA_CLOSE_FIXTURE_PROFILE);
let window;const state={navigationStarted:false,stateRequests:0,cancelRequests:0,status:'running'};
ipcMain.handle('fixture-state',()=>{
 state.stateRequests++;
 if(!state.navigationStarted){state.navigationStarted=true;setImmediate(()=>window.loadFile(path.join(__dirname,'second.html')).catch(()=>{}));return new Promise(resolve=>setTimeout(()=>resolve({id:'owned-fixture',status:state.status}),250));}
 return {id:'owned-fixture',status:state.status};
});
ipcMain.handle('fixture-cancel',(_event,id)=>{if(id!=='owned-fixture')throw new Error('FIXTURE_OWNER');state.cancelRequests++;state.status='cancelled';});
app.on('will-quit',()=>fs.writeFileSync(path.join(__dirname,'state.json'),JSON.stringify(state),{mode:0o600}));
app.whenReady().then(async()=>{window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'preload.cjs')}});await window.loadFile(path.join(__dirname,'first.html'));});
app.on('window-all-closed',()=>app.quit());`
const preload = `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('mikka',{ssh:{state:()=>ipcRenderer.invoke('fixture-state'),cancel:id=>ipcRenderer.invoke('fixture-cancel',id)}});`

const report = { version: 1, test: 'real-electron-navigation-during-cancel', expected, passed: false, platform: process.platform, architecture: process.arch, nodeVersion: process.version, electronVersion: require('electron/package.json').version, sandbox: false, contextLossObserved: false, processExited: false, cleanExit: false, secondCloseSucceeded: false, cleanup: 'pending' }
let directory, application, child, stage = 'prepare'
const reason = error => /Execution context was destroyed|Cannot find context with specified id/i.test(String(error?.message)) ? 'navigation'
  : /Target page, context or browser has been closed|Target closed|Session closed|has been closed/i.test(String(error?.message)) ? 'closed'
    : /TIMEOUT|Timeout|timed out/.test(String(error?.message)) ? 'timeout' : 'other'
try {
  report.fixtureSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')
  report.helperSha256 = createHash('sha256').update(await readFile(helper)).digest('hex')
  directory = await mkdtemp(join(tmpdir(), 'mikka-close-navigation-'))
  await mkdir(join(directory, 'profile'), { mode: 0o700 })
  await Promise.all([
    writeFile(join(directory, 'main.cjs'), main), writeFile(join(directory, 'preload.cjs'), preload),
    writeFile(join(directory, 'first.html'), '<!doctype html><html><body data-ready="yes">first</body></html>'),
    writeFile(join(directory, 'second.html'), '<!doctype html><html><body data-ready="yes">second</body></html>'),
  ])
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', '__CF_USER_TEXT_ENCODING']
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.includes(key)))
  stage = 'launch'
  application = await _electron.launch({ executablePath: require('electron'), args: [join(directory, 'main.cjs')], cwd: repository, chromiumSandbox: true,
    env: { ...env, MIKKA_CLOSE_FIXTURE_PROFILE: join(directory, 'profile') }, timeout: 30_000,
  })
  child = application.process()
  const flags = await application.evaluate(({ app }) => ({ noSandbox: app.commandLine.hasSwitch('no-sandbox'), mockKeychain: app.commandLine.hasSwitch('use-mock-keychain') }))
  assert.deepEqual(flags, { noSandbox: false, mockKeychain: false })
  report.sandbox = true
  const page = await application.firstWindow()
  await page.waitForFunction(() => document.body?.dataset.ready === 'yes' && Boolean(window.mikka?.ssh), undefined, { timeout: 10_000 })
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(25_000) })
  stage = 'close'
  let closeFailure
  try { await closeElectron(application) } catch (error) { closeFailure = error; report.closeFailure = reason(error); report.contextLossObserved = reason(error) === 'navigation' }
  const [code, signal] = await exited
  report.processExited = true
  report.cleanExit = code === 0 && signal === null
  const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
  assert.ok(Object.keys(state).every(key => ['navigationStarted', 'stateRequests', 'cancelRequests', 'status'].includes(key)))
  report.state = state
  try { await closeElectron(application); report.secondCloseSucceeded = true } catch (error) { report.secondCloseFailure = reason(error) }
  if (expected === 'before') {
    assert.ok(closeFailure && report.contextLossObserved)
    assert.equal(state.cancelRequests, 0)
  } else {
    assert.equal(closeFailure, undefined)
    assert.equal(state.navigationStarted, true)
    assert.equal(state.cancelRequests, 1)
    assert.equal(state.status, 'cancelled')
    assert.equal(report.secondCloseSucceeded, true)
  }
  assert.equal(report.cleanExit, true)
  report.passed = true
} catch (error) {
  report.failure = { stage, reason: reason(error) }
} finally {
  try {
    if (application && child?.exitCode === null && child?.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(15_000) })
      await application.close()
      await exited
    }
    assert.ok(!child || child.exitCode !== null || child.signalCode !== null, 'CLOSE_FIXTURE_PROCESS_STILL_RUNNING')
    if (directory) await rm(directory, { recursive: true, force: true })
    report.cleanup = 'passed'
  } catch { report.cleanup = 'failed'; report.passed = false }
}
console.log(JSON.stringify(report))
if (!report.passed) process.exitCode = 1
