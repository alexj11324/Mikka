import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stopLocalDaemons } from './native-cleanup.mjs'
import { readNativeDaemonMetadata } from './native-metadata.mjs'

async function daemon(t, { delayedListen = false, helloPid } = {}) {
  // Keep the Unix socket below macOS's path length limit.
  const profile = await mkdtemp('/tmp/mikka-drain-')
  const child = fork(fileURLToPath(new URL('./fixtures/native-daemon.mjs', import.meta.url)), [profile, delayedListen ? 'delayed-listen' : '', helloPid ? String(helloPid) : ''], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
    await rm(profile, { recursive: true, force: true })
  })
  const ready = new AbortController()
  const timer = setTimeout(() => ready.abort(), 10_000)
  let message
  try {
    const result = await Promise.race([
      once(child, 'message', { signal: ready.signal }),
      once(child, 'exit', { signal: ready.signal }).then(() => { throw new Error(`NATIVE_DAEMON_FIXTURE_FAILED: ${stderr}`) }),
    ])
    message = result[0]
  } finally { clearTimeout(timer); ready.abort() }
  assert.equal(message, delayedListen ? 'starting' : 'ready')
  return { profile, child }
}

async function observeChildExit(child, stop) {
  // Linux can prove an exited/zombie PID before Node delivers its ChildProcess
  // exit event. Subscribe first, preserve assertions at the stop boundary, then
  // await that same child's bounded event before inspecting the exit code.
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(25_000) })
  const [, [code, signal]] = await Promise.all([stop(), exited])
  assert.equal(code, 0)
  assert.equal(signal, null)
  assert.equal(child.exitCode, 0)
}

test('drain authenticates exact profiles and waits past socket closure to process exit', async t => {
  const owned = await daemon(t)
  const foreign = await daemon(t)
  const started = performance.now()
  await observeChildExit(owned.child, async () => {
    assert.deepEqual(await stopLocalDaemons([owned.profile, owned.profile]), { profilesStopped: true })
    assert.ok(performance.now() - started >= 200, 'socket close alone is not completion')
  })
  assert.equal(foreign.child.exitCode, null, 'a different profile remains running')
  assert.deepEqual(await stopLocalDaemons([foreign.profile]), { profilesStopped: true })
})

test('a recorded starting daemon is drained when its socket appears within the same cleanup deadline', async t => {
  const owned = await daemon(t, { delayedListen: true })
  const foreign = await daemon(t)
  // Finish the dynamic client import before measuring the real startup race.
  await stopLocalDaemons([join(owned.profile, 'absent')])
  let stopped = false
  const started = performance.now()
  const cleanup = observeChildExit(owned.child, async () => {
    assert.deepEqual(await stopLocalDaemons([owned.profile]), { profilesStopped: true })
    stopped = true
  })
  void cleanup.catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(stopped, false, 'the live PID alone cannot authorize cleanup')
  assert.equal(owned.child.exitCode, null)
  await assert.rejects(lstat(join(owned.profile, 'daemon.sock')), { code: 'ENOENT' })
  const ready = once(owned.child, 'message', { signal: AbortSignal.timeout(5000) })
  owned.child.send('listen')
  assert.equal((await ready)[0], 'ready')
  await cleanup
  assert.ok(performance.now() - started < 20_000, 'startup, drain and exit share the existing deadline')
  assert.equal(foreign.child.exitCode, null, 'a different profile remains running')
})

test('an authenticated socket with a different PID cannot drain or authorize cleanup', async t => {
  const foreign = await daemon(t)
  const owned = await daemon(t, { helloPid: foreign.child.pid })
  await assert.rejects(stopLocalDaemons([owned.profile]), /NATIVE_DAEMON_STOP_UNPROVEN/)
  assert.equal(owned.child.exitCode, null)
  assert.equal(foreign.child.exitCode, null)
})

test('a wrong profile secret cannot drain or authorize cleanup', async t => {
  const { profile, child } = await daemon(t)
  const path = join(profile, 'daemon.secret')
  const secret = await readFile(path)
  await writeFile(path, 'wrong-secret')
  await assert.rejects(stopLocalDaemons([profile]), /Bad daemon secret/)
  assert.equal(child.exitCode, null)
  await writeFile(path, secret)
  assert.deepEqual(await stopLocalDaemons([profile]), { profilesStopped: true })
})

test('metadata reads only the actual authenticated hello and never leaks secrets or stops the daemon', async t => {
  const { profile, child } = await daemon(t)
  const path = join(profile, 'daemon.secret')
  const secret = await readFile(path)
  const observed = await readNativeDaemonMetadata(profile)
  assert.equal(observed.source, 'local_daemon_hello')
  assert.equal(observed.status, 'connected')
  assert.equal(observed.daemonVersion, '0.0.0-acceptance-fixture')
  assert.ok(Number.isSafeInteger(observed.protocolVersion) && observed.protocolVersion > 0)
  assert.deepEqual(Object.keys(observed).sort(), ['daemonVersion', 'protocolVersion', 'source', 'status'])
  assert.equal(JSON.stringify(observed).includes(secret.toString()), false)
  assert.equal(child.exitCode, null)
  await writeFile(path, 'wrong-secret')
  assert.deepEqual(await readNativeDaemonMetadata(profile), { source: 'local_daemon_hello', status: 'unavailable', reason: 'handshake_failed' })
  assert.equal(child.exitCode, null, 'metadata must never drain or repair a service')
  await writeFile(path, secret)
  await stopLocalDaemons([profile])
  assert.equal((await readNativeDaemonMetadata(profile)).status, 'unavailable')
  await assert.rejects(readNativeDaemonMetadata('relative-profile'), /NATIVE_METADATA_REQUIRES_EXACT_PROFILE/)
})

test('an already closed socket still waits for the recorded daemon process to finish', async t => {
  const { profile, child } = await daemon(t)
  const closed = once(child, 'message', { signal: AbortSignal.timeout(5000) })
  child.send('begin-stop')
  assert.equal((await closed)[0], 'socket-closed')
  const started = performance.now()
  await observeChildExit(child, async () => {
    assert.deepEqual(await stopLocalDaemons([profile]), { profilesStopped: true })
    assert.ok(performance.now() - started >= 200)
  })
})

test('PID removal before the production lock release cannot fail or authorize cleanup early', async t => {
  const profile = await mkdtemp('/tmp/mikka-drain-')
  t.after(() => rm(profile, { recursive: true, force: true }))
  const lock = join(profile, 'daemon.lock')
  await mkdir(lock)
  const result = stopLocalDaemons([profile])
  const pending = Symbol('pending')
  // The production release removes daemon.pid before awaiting lock removal.
  assert.equal(await Promise.race([result, new Promise(resolve => setTimeout(resolve, 200, pending))]), pending)
  await rm(lock, { recursive: true })
  assert.deepEqual(await result, { profilesStopped: true })
})

test('a refused socket without its daemon PID cannot authorize database cleanup', async t => {
  const { profile, child } = await daemon(t)
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  await rm(join(profile, 'daemon.pid'))
  await assert.rejects(stopLocalDaemons([profile]), /NATIVE_DAEMON_STOP_UNPROVEN/)
})

test('absent own profiles are stopped and relative paths are refused', async () => {
  const profile = await mkdtemp('/tmp/mikka-drain-')
  await rm(profile, { recursive: true })
  assert.deepEqual(await stopLocalDaemons([profile]), { profilesStopped: true })
  await assert.rejects(stopLocalDaemons(['relative-profile']), /exact native test profile/)
})
