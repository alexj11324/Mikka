import assert from 'node:assert/strict'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tsImport } from 'tsx/esm/api'

const closingApplications = new WeakMap()

function navigationContextLost(error) {
  return /Execution context was destroyed|Cannot find context with specified id/.test(String(error?.message))
}

async function bounded(promise, milliseconds, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

/** Use the actual preload cancellation path while the app can still receive
 * IPC. Closing Electron alone does not cancel a child installer command. */
export async function cancelLocalSetup(application) {
  if (!application || application.process().exitCode !== null) return
  for (const page of application.windows()) {
    if (page.isClosed()) continue
    const cancel = () => page.evaluate(async () => {
      const ssh = window.mikka?.ssh
      if (!ssh) return
      const state = await ssh.state()
      if (!state || !['running', 'fingerprint'].includes(state.status)) return
      try { await ssh.cancel(state.id) } catch (error) {
        // The real installer can finish between the state read and cancel.
        const current = await ssh.state()
        if (current && ['running', 'fingerprint'].includes(current.status)) throw error
      }
      const remaining = await ssh.state()
      if (remaining && ['running', 'fingerprint'].includes(remaining.status)) throw new Error('NATIVE_INSTALLER_STILL_RUNNING')
    })
    const deadline = Date.now() + 20_000
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('NATIVE_INSTALLER_CANCEL_TIMEOUT')
      try {
        await bounded(cancel(), remaining, 'NATIVE_INSTALLER_CANCEL_TIMEOUT')
        break
      } catch (error) {
        // A hosted page can finish an ordinary redirect or switch to its local
        // offline page during this read. Retry only that destroyed context;
        // never treat navigation, a missing process or a closed page as proof
        // that an active installer was cancelled.
        if (!navigationContextLost(error) || page.isClosed()
          || application.process().exitCode !== null || application.process().signalCode !== null) throw error
        const wait = deadline - Date.now()
        if (wait <= 0) throw new Error('NATIVE_INSTALLER_CANCEL_TIMEOUT')
        await bounded(page.waitForLoadState('domcontentloaded', { timeout: wait }), wait, 'NATIVE_INSTALLER_CANCEL_TIMEOUT')
      }
    }
  }
}

export function closeElectron(application) {
  if (!application) return Promise.resolve()
  const existing = closingApplications.get(application)
  if (existing) return existing
  // Retain both success and rejection for this exact application object.
  // Cleanup must not issue a second SDK close after the first already exited,
  // or forget an earlier failure to cancel its installer.
  const closing = (async () => {
    try { await cancelLocalSetup(application) } finally { await application.close() }
  })()
  closingApplications.set(application, closing)
  return closing
}

async function processStopped(pid) {
  try { process.kill(pid, 0) } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
  if (process.platform === 'linux') {
    try {
      // A reparented zombie has finished all work and only awaits reaping.
      const state = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ').at(-1)?.split(' ')[0]
      if (state === 'Z') return true
    } catch (error) { if (error.code === 'ENOENT') return true; throw error }
  }
  return false
}

async function waitForExit(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid, 'Native daemon must have its own process')
  const deadline = Date.now() + 20_000
  while (!await processStopped(pid)) {
    if (Date.now() >= deadline) throw new Error('NATIVE_DAEMON_EXIT_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function recordedPid(directory) {
  const path = join(directory, 'daemon.pid')
  let info
  try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  assert.ok(info.isFile() && info.size <= 32, 'Native daemon PID record must be a small regular file')
  let text
  try { text = (await readFile(path, 'utf8')).trim() } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  assert.match(text, /^[1-9][0-9]*$/, 'Native daemon PID record is invalid')
  const pid = Number(text)
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid, 'Native daemon PID record is invalid')
  return pid
}

async function proveNotRunning(directory, pid, refused = false) {
  // The production lock publishes this PID before device state is read. Its
  // socket disappears before final flush, so absence/refusal alone is unsafe.
  const recorded = pid ?? await recordedPid(directory)
  if (recorded !== null) { await waitForExit(recorded); return }
  let locked = false
  try { await lstat(join(directory, 'daemon.lock')); locked = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (refused || locked) throw new Error('NATIVE_DAEMON_STOP_UNPROVEN')
}

/** Drain only the exact profiles created by this harness. The daemon secret
 * stays inside the existing authenticated local client. Do not enumerate or
 * kill other users' processes, remove services, or clear shared device data.
 * Call after all installer cancellations and Electron closes; only after this
 * resolves may the lease's native database resources be cleaned. */
export async function stopLocalDaemons(profiles) {
  const { connectDaemonInDataDir, isNoDaemon, isProtocolMismatch } = await tsImport('@mikka/daemon/client', import.meta.url)
  for (const profile of new Set(profiles)) {
    assert.ok(typeof profile === 'string' && isAbsolute(profile), 'An exact native test profile is required')
    let directory
    try { directory = await realpath(profile) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const pid = await recordedPid(directory)
    const socketPath = join(directory, 'daemon.sock')
    try { assert.ok((await lstat(socketPath)).isSocket(), 'Native profile socket must be a Unix socket') } catch (error) {
      if (error.code === 'ENOENT') { await proveNotRunning(directory, pid); continue }
      throw error
    }
    let client
    try {
      client = await connectDaemonInDataDir(directory, { name: 'mikka-native-acceptance-cleanup', version: '1' }, { drainOnMismatch: true })
    } catch (error) {
      if (isProtocolMismatch(error)) {
        // The client authenticates before requesting the stable drain method.
        await waitForExit(error.data?.pid)
        continue
      }
      if (isNoDaemon(error) && error.code !== 'ENOENT') { await proveNotRunning(directory, pid, true); continue }
      if (error.code === 'ENOENT') {
        try { await lstat(socketPath) } catch (missing) {
          if (missing.code === 'ENOENT') { await proveNotRunning(directory, pid); continue }
          throw missing
        }
      }
      throw error
    }
    try {
      const closed = new Promise(resolve => client.onClose(resolve))
      await bounded(client.request('daemon.drain'), 5000, 'NATIVE_DAEMON_DRAIN_TIMEOUT')
      await bounded(closed, 20_000, 'NATIVE_DAEMON_SOCKET_CLOSE_TIMEOUT')
      // Socket close precedes outbox/tracing shutdown in the real daemon. Wait
      // for process exit as well so no late database write can escape cleanup.
      await waitForExit(client.hello.pid)
    } finally { client.close() }
  }
  return { profilesStopped: true }
}
