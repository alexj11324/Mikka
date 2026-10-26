// Explicit diagnostic only: one blank synthetic browser, retained on every outcome.
// No close, signal, unlink or recursive cleanup; not the executor lifecycle suite.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { open, lstat, realpath, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createAcceptanceResourceRegistry, ownNodeChildren, readLinuxProcess, processSnapshot, writeRetainedReceipt } from '../lib/credentials/acceptance-resource-registry.ts'
const root = process.env.MIKKA_CREDENTIAL_STARTUP_ROOT
assert.match(root ?? '', /^\/tmp\/credential-startup-[A-Za-z0-9]+$/)
assert.equal(await realpath(root), root)
const st = await lstat(root)
assert.ok(st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && (st.mode & 0o077) === 0)
const host = await processSnapshot(process.pid)
await writeFile(join(root, 'host.json'), JSON.stringify({ pid: process.pid, starttime: host.starttime, uid: process.getuid() }), { flag: 'wx', mode: 0o600 })
setInterval(() => {}, 60000) // Keep the owner alive; no exit cleanup hooks.
let browser
try {
  const registry = await createAcceptanceResourceRegistry(root, { profiles: 1, launches: 1 })
  const resources = registry.acceptanceResources(), profile = await resources.prepareProfile()
  const output = await open(join(root, 'chromium.log'), 'wx', 0o600)
  browser = spawn('/usr/lib/chromium/chromium', [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions',
    '--disable-sync', '--disable-background-networking', '--disable-component-update',
    '--no-first-run', '--no-default-browser-check', '--disable-breakpad',
    '--host-resolver-rules=MAP * ~NOTFOUND', `--user-data-dir=${profile.profile}`, 'about:blank',
  ], { env: { PATH: '/usr/bin:/bin', HOME: registry.root, TMPDIR: registry.root, LANG: 'C.UTF-8' }, stdio: ['ignore', output.fd, output.fd] })
  browser.on('exit', (code, signal) => { void writeRetainedReceipt(join(root, 'browser-exit.json'), { code, signal, requestedByHarness: false }) })
  await new Promise((resolve, reject) => { browser.once('spawn', resolve); browser.once('error', reject) })
  await new Promise(resolve => setTimeout(resolve, 2000))
  assert.equal(browser.exitCode, null, 'browser exited before registration')
  assert.equal(browser.signalCode, null)
  assert.ok((await ownNodeChildren()).includes(browser.pid))
  await resources.started(profile)
  const registered = await registry.matchesRegistered(profile.id)
  assert.equal(registered.pid, browser.pid)
  assert.equal((await readLinuxProcess(browser.pid)).profile, profile.profile)
  await assert.rejects(resources.started({ ...profile, id: 'foreign-owner' }), /unknown acceptance/)
  await assert.rejects(resources.started({ ...profile, profile: root }), /Expected values/)
  await assert.rejects(registry.reserveLaunch(), /budget exhausted/)
  assert.deepEqual(await registry.matchesRegistered(profile.id), registered)
  const rows = [], ownedRootReferences = []
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) <= 1) continue
    try {
      const { args, ...row } = await processSnapshot(Number(entry))
      rows.push(row)
      // References are association evidence only, NOT complete ownership or disposal authority.
      if (args.some(arg => arg.includes(registry.root))) ownedRootReferences.push(row)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const descendants = [], parents = new Set([process.pid])
  for (let changed = true; changed;) {
    changed = false
    for (const row of rows) if (parents.has(row.ppid) && !parents.has(row.pid)) { parents.add(row.pid); descendants.push(row); changed = true }
  }
  const result = { pass: true, scope: 'blank browser startup and registry only', runId: registry.runId, host: { pid: process.pid, starttime: host.starttime, uid: process.getuid() }, registered, descendants, ownedRootReferences, profile: { dev: (await lstat(profile.profile)).dev, inode: (await lstat(profile.profile)).ino }, unauthorizedCleanup: false, cleanupExecuted: false, executorLifecycleValidated: false }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ pass: true, scope: result.scope, retained: true }))
} catch (error) {
  await writeRetainedReceipt(join(root, 'failure.json'), { error: String(error), stack: error.stack, browserPid: browser?.pid, exitCode: browser?.exitCode, signalCode: browser?.signalCode, cleanupExecuted: false })
  console.log(JSON.stringify({ pass: false, retained: true, diagnosis: 'inspect private failure and chromium logs; do not relaunch blindly' }))
}
