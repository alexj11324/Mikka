import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { eveFailureReason, startEveService, EVE_PARENT_WATCH_IMPORT } from './eve-service.mjs'

/** The peer guard the service hands `--import`; a data URL, so a built chunk needs no scripts/ beside it. */
const parentWatch = EVE_PARENT_WATCH_IMPORT

/** Alive, not a zombie: `kill(pid, 0)` reports a reparented orphan as alive. */
function isRunning(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** A process stops in milliseconds, but not synchronously with the signal that
 * reached it. Poll instead of guessing a delay. */
async function waitForExit(pid, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

/** A test that failed before its subject did must not leave the subject running. */
function killQuietly(pid) {
  try { process.kill(pid, 'SIGKILL') }
  catch { return }
}

for (const development of [false,true]) test(`self-hosted ${development?'development':'packaged'} peer isolates Workflow storage and reads its app resources`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'eve-sidecar-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory=join(root,development?'apps/eve':'eve')
  await mkdir(join(directory, 'server'), { recursive: true })
  await writeFile(join(directory, 'server/index.mjs'), 'export default {}')
  await writeFile(join(directory, 'mikka-eve-build.json'), JSON.stringify({ version: 1, eve: '1.3.0', revision: 'a'.repeat(40), ...(!development ? { world: '@workflow/world-postgres' } : {}) }))
  const data = join(root, 'data')
  const env = { MIKKA_DATA_DIR: data, WORKFLOW_TARGET_WORLD: 'local', WORKFLOW_LOCAL_DATA_DIR: '/data/workflow', WORKFLOW_LOCAL_BASE_URL: 'https://main.test',
    NITRO_SSL_CERT: 'installation-certificate', NITRO_SSL_KEY: 'installation-tls-key', NITRO_UNIX_SOCKET: '/run/mikka/frontend.sock' }
  let spawned, stopped = 0
  const service = await startEveService({ root, env, development, allocatePort: async () => 43127, spawnProcess: (_command, _args, options) => {
    spawned = options
    const child = new EventEmitter()
    child.exitCode = null; child.signalCode = null
    child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.kill = signal => { assert.equal(signal, 'SIGTERM'); stopped++; child.exitCode = 0; child.emit('exit', 0) }
    // `eve dev --no-ui` prints "ready at"; the packaged Nitro server prints "Listening on".
    queueMicrotask(() => child.stdout.write(development ? '[DEV] ready at http://127.0.0.1:43127/\n' : '➜ Listening on: http://127.0.0.1:43127/\n'))
    return child
  } })
  assert.equal(env.MIKKA_EVE_ORIGIN, 'http://127.0.0.1:43127')
  assert.equal(spawned.env.WORKFLOW_TARGET_WORLD, development ? 'local' : '@workflow/world-postgres')
  assert.equal(spawned.env.WORKFLOW_LOCAL_BASE_URL, development ? 'http://127.0.0.1:3000/mikka/api/agents' : service.origin)
  assert.equal(spawned.env.EVE_PUBLIC_ROUTE_PREFIX, '')
  assert.equal(spawned.env.MIKKA_RUNTIME_RESOURCE_ROOT, development ? root : directory)
  assert.equal(spawned.env.WORKFLOW_LOCAL_DATA_DIR, development ? join(data, 'eve-workflow') : undefined)
  // realpath on both sides: macOS resolves a temp directory through /private,
  // so the link target and the directory it names are the same path written two ways.
  if (development) assert.equal(await realpath(join(directory, '.eve/.workflow-data')), await realpath(join(data, 'eve-workflow')))
  assert.equal(env.WORKFLOW_LOCAL_DATA_DIR, '/data/workflow')
  for (const key of ['NITRO_SSL_CERT', 'NITRO_SSL_KEY', 'NITRO_UNIX_SOCKET']) {
    assert.equal(spawned.env[key], undefined, `the loopback HTTP peer inherited ${key}`)
    assert.ok(env[key], `the public listener still needs ${key}`)
  }
  assert.equal(spawned.cwd, directory)
  await service.close(); await service.close()
  assert.equal(stopped, 1)
})

test('native development cwd can load the real cookie-auth resource from its explicit app root',()=>{
  const root=fileURLToPath(new URL('../',import.meta.url))
  const require=createRequire(import.meta.url)
  const module=new URL('../lib/abuse/signup.ts',import.meta.url).href
  const result=spawnSync(process.execPath,['--import',require.resolve('tsx'),'--import',join(root,'scripts/server-test.mjs'),'--input-type=module','-e',`const signup=await import(${JSON.stringify(module)});if(!signup.disposableEmail('fixture@10minutemail.com'))throw new Error('AUTH_RESOURCE_NOT_LOADED')`],{
    cwd:join(root,'apps/eve'),env:{...process.env,MIKKA_RUNTIME_RESOURCE_ROOT:root},encoding:'utf8',timeout:15000,
  })
  assert.equal(result.status,0,result.stderr)
})

test('managed output and an explicitly supplied peer never spawn another process', async () => {
  for (const env of [{ VERCEL: '1' }, { MIKKA_EVE_ORIGIN: 'https://peer.test' }]) {
    const service = await startEveService({ env, spawnProcess: () => { throw new Error('MUST_NOT_SPAWN') } })
    await service.close()
  }
})

test('startup preserves an existing session directory instead of replacing its data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'eve-preserve-storage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'eve/server'), { recursive: true })
  await mkdir(join(root, 'eve/.eve/.workflow-data'), { recursive: true })
  await writeFile(join(root, 'eve/.eve/.workflow-data/history'), 'recorded-session')
  await writeFile(join(root, 'eve/server/index.mjs'), 'export default {}')
  await writeFile(join(root, 'eve/mikka-eve-build.json'), JSON.stringify({ version: 1, eve: '1.3.0', revision: 'a'.repeat(40) }))
  await assert.rejects(startEveService({ root, env: {}, allocatePort: async () => 43127,
    spawnProcess: () => { throw new Error('MUST_NOT_SPAWN') } }), /EVE_SERVICE_STORAGE_MISMATCH/)
  assert.equal(await readFile(join(root, 'eve/.eve/.workflow-data/history'), 'utf8'), 'recorded-session')
})

test('a peer that refuses to start reports its exit status and its own last words', async () => {
  // eve explains a refused start — "A dev server is already running for this eve
  // agent" — on its stderr and nowhere else. Reporting only the exit turned that
  // into an unexplained EVE_SERVICE_EXITED and sent the developer hunting.
  const refusal = 'A dev server is already running for this eve agent.'
  const error = await startEveService({ env: {}, development: true, allocatePort: async () => 43127,
    spawnProcess: () => spawn(process.execPath,
      ['-e', `process.stderr.write(${JSON.stringify(`${refusal}\n`)}); process.exit(1)`],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: true }) }).then(() => undefined, cause => cause)
  assert.equal(error?.code, 'EVE_SERVICE_EXITED')
  assert.equal(error.detail.exitCode, 1)
  assert.match(error.detail.stderr, /already running for this eve agent/)
  assert.match(error.detail.reason, /already running for this eve agent/)
})

test('a failed start reports the sentence, not the bundler warnings around it', () => {
  // eve builds the agent app before it serves, so its stderr ends in hundreds of
  // rolldown warnings. A tail of them says nothing about why the start failed.
  const stderr = [
    'A dev server is already running for this eve agent.',
    'To connect to the existing instance, run: pnpm exec eve remote connect --url http://127.0.0.1:63999/',
    '\u001B[33m[INEFFECTIVE_DYNAMIC_IMPORT] \u001B[0m../../lib/a.ts is dynamically imported by ../b.ts',
    '../../app/actions/projects.ts (1:0) \u001B[33m[MODULE_LEVEL_DIRECTIVE] \u001B[0mThe semantics of the module level directive',
    '\u001B[38;5;246m╭\u001B[0m\u001B[38;5;246m─\u001B[0m[ ../../app/actions/projects.ts:1:1 ]',
    '\u001B[38;5;240m  │\u001B[0m',
    '\u001B[38;5;246m───╯\u001B[0m',
  ].join('\n')
  const reason = eveFailureReason(stderr)
  assert.match(reason, /already running for this eve agent/)
  assert.match(reason, /remote connect/)
  for (const noise of ['INEFFECTIVE_DYNAMIC_IMPORT', 'MODULE_LEVEL_DIRECTIVE', '│', '╯']) assert.equal(reason.includes(noise), false, `the reason still carries ${noise}`)
})

test('closing the peer takes the process group it started with it', async t => {
  // eve forks its own local server, so a pid-only signal leaves that server, its
  // listening port and its workflow world behind. That residue is what refused
  // every later start, so the peer is spawned as a group leader and closed as one.
  const root = await mkdtemp(join(tmpdir(), 'eve-peer-group-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const marker = join(root, 'local-server.pid')
  await mkdir(join(root, 'node_modules/eve/bin'), { recursive: true })
  await mkdir(join(root, 'apps/eve'), { recursive: true })
  await writeFile(join(root, 'node_modules/eve/bin/eve.js'), [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    `writeFileSync(${JSON.stringify(marker)}, String(server.pid))`,
    "console.log('Listening on: http://127.0.0.1:' + process.env.PORT + '/')",
    'setInterval(() => {}, 1000)',
  ].join('\n'))
  const service = await startEveService({ root, env: {}, development: true, allocatePort: async () => 43127 })
  const forked = Number(await readFile(marker, 'utf8'))
  t.after(() => killQuietly(forked))
  assert.ok(isRunning(forked), 'the fixture never started the server it is meant to leave behind')
  await service.close()
  assert.equal(await waitForExit(forked), true, 'the forked server survived the peer being closed')
})

test('the peer stops itself when the process that spawned it is killed outright', async t => {
  // `kill -9` gives the parent no chance to clean up, and an eve that outlives it
  // poisons every later start. The peer's half of the contract closes that gap.
  const root = await mkdtemp(join(tmpdir(), 'eve-parent-watch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'peer.mjs')
  // A file entry, not `-e`: with `-e` Node defers `--import` until the ESM loader
  // starts, which is later than the peer would have loaded it.
  await writeFile(entry, 'setInterval(() => {}, 1000)\n')
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['--import', ${JSON.stringify(parentWatch)}, ${JSON.stringify(entry)}],
      { stdio: 'ignore', env: { ...process.env, MIKKA_EVE_PARENT_PID: String(process.pid) } })
    console.log(child.pid)
    setInterval(() => {}, 1000)
  `], { stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => killQuietly(parent.pid))
  const [chunk] = await once(parent.stdout, 'data')
  const peer = Number(String(chunk).trim())
  t.after(() => killQuietly(peer))
  // Let the peer finish booting, so this exercises the watch itself rather than
  // the "orphaned before the preload ran" fallback.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.ok(isRunning(peer))
  parent.kill('SIGKILL')
  assert.equal(await waitForExit(peer), true, 'the peer outlived the process that spawned it')
})

test('the watchdog stays inert in eve’s own local server', async t => {
  // eve re-forks its local server with the same execArgv, so this preload also
  // runs there. Its parent is the eve host — not the pid it was told about, which
  // is still running — and it must not read that mismatch as "my parent died".
  const root = await mkdtemp(join(tmpdir(), 'eve-parent-watch-inert-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'local-server.mjs')
  await writeFile(entry, 'setInterval(() => {}, 1000)\n')
  const host = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['--import', ${JSON.stringify(parentWatch)}, ${JSON.stringify(entry)}],
      { stdio: 'ignore', env: { ...process.env, MIKKA_EVE_PARENT_PID: ${JSON.stringify(String(process.pid))} } })
    console.log(child.pid)
    setInterval(() => {}, 1000)
  `], { stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => killQuietly(host.pid))
  const [chunk] = await once(host.stdout, 'data')
  const local = Number(String(chunk).trim())
  t.after(() => killQuietly(local))
  await new Promise(resolve => setTimeout(resolve, 1_200))
  assert.equal(isRunning(local), true, 'the local server killed itself because its ppid is not the recorded one')
})
