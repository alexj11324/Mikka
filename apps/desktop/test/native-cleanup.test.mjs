import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stopLocalDaemons } from './native-cleanup.mjs'

async function daemon(t) {
  // Keep the Unix socket below macOS's path length limit.
  const profile = await mkdtemp('/tmp/mikka-drain-')
  const child = fork(fileURLToPath(new URL('./fixtures/native-daemon.mjs', import.meta.url)), [profile], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
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
  assert.equal(message, 'ready')
  return { profile, child }
}

test('drain authenticates exact profiles and waits past socket closure to process exit', async t => {
  const owned = await daemon(t)
  const foreign = await daemon(t)
  const started = performance.now()
  assert.deepEqual(await stopLocalDaemons([owned.profile, owned.profile]), { profilesStopped: true })
  assert.ok(performance.now() - started >= 200, 'socket close alone is not completion')
  assert.equal(owned.child.exitCode, 0)
  assert.equal(foreign.child.exitCode, null, 'a different profile remains running')
  assert.deepEqual(await stopLocalDaemons([foreign.profile]), { profilesStopped: true })
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

test('an already closed socket still waits for the recorded daemon process to finish', async t => {
  const { profile, child } = await daemon(t)
  const closed = once(child, 'message', { signal: AbortSignal.timeout(5000) })
  child.send('begin-stop')
  assert.equal((await closed)[0], 'socket-closed')
  const started = performance.now()
  assert.deepEqual(await stopLocalDaemons([profile]), { profilesStopped: true })
  assert.ok(performance.now() - started >= 200)
  assert.equal(child.exitCode, 0)
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
