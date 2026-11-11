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
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error }
  }
  return false
}

function remainingTime(deadline, maximum = 20_000) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('NATIVE_DAEMON_EXIT_TIMEOUT')
  return Math.min(remaining, maximum)
}

function assertDaemonPid(pid, expected = null) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid, 'Native daemon must have its own process')
  assert.ok(expected === null || pid === expected, 'NATIVE_DAEMON_STOP_UNPROVEN')
}

async function waitForExit(pid, deadline) {
  assertDaemonPid(pid)
  while (!await processStopped(pid)) {
    await new Promise(resolve => setTimeout(resolve, remainingTime(deadline, 100)))
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
  if (pid !== null) return processStopped(pid)
  let locked = false
  try { await lstat(join(directory, 'daemon.lock')); locked = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (refused || locked) throw new Error('NATIVE_DAEMON_STOP_UNPROVEN')
  return true
}

async function socketExists(socketPath) {
  try { assert.ok((await lstat(socketPath)).isSocket(), 'Native profile socket must be a Unix socket') } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
  return true
}

async function connectForCleanup(connect, directory, deadline, protocolVersion) {
  let accepting = true
  const connecting = connect(directory, { name: 'mikka-native-acceptance-cleanup', version: '1' }, {
    drainOnMismatch: false, protocolVersion, timeoutMs: remainingTime(deadline, 3000),
  }).then(client => {
    // A late hello must not retain a client after the cleanup deadline.
    if (!accepting) client.close()
    return client
  })
  try { return await bounded(connecting, remainingTime(deadline), 'NATIVE_DAEMON_EXIT_TIMEOUT') } finally { accepting = false }
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
    const deadline = Date.now() + 20_000
    let pid = await recordedPid(directory)
    const socketPath = join(directory, 'daemon.sock')
    while (true) {
      const currentPid = await recordedPid(directory)
      if (currentPid !== null) { assertDaemonPid(currentPid, pid); pid ??= currentPid }
      let client
      let refused = false
      if (await socketExists(socketPath)) {
        try {
          try {
            client = await connectForCleanup(connectDaemonInDataDir, directory, deadline)
          } catch (error) {
            if (!isProtocolMismatch(error)) throw error
            // Inspect the authenticated PID before any drain. Reconnect using
            // the daemon's version so the client's automatic drain cannot run
            // before this profile/PID ownership check.
            assertDaemonPid(error.data?.pid, pid)
            const protocolVersion = error.data?.protocolVersion
            assert.ok(Number.isSafeInteger(protocolVersion) && protocolVersion > 0, 'Native daemon protocol version is invalid')
            client = await connectForCleanup(connectDaemonInDataDir, directory, deadline, protocolVersion)
          }
        } catch (error) {
          if (isNoDaemon(error) && error.code !== 'ENOENT') refused = true
          else if (error.code !== 'ENOENT' || await socketExists(socketPath)) throw error
        }
      }
      if (client) {
        try {
          assertDaemonPid(client.hello.pid, pid)
          assertDaemonPid(client.hello.pid, await recordedPid(directory))
          const closed = new Promise(resolve => client.onClose(resolve))
          const drainBudget = remainingTime(deadline, 5000)
          await bounded(client.request('daemon.drain'), drainBudget, 'NATIVE_DAEMON_DRAIN_TIMEOUT')
          await bounded(closed, remainingTime(deadline), 'NATIVE_DAEMON_SOCKET_CLOSE_TIMEOUT')
          // Socket close precedes outbox/tracing shutdown in the real daemon.
          // Prove actual process exit within this same cleanup deadline.
          await waitForExit(client.hello.pid, deadline)
        } finally { client.close() }
        break
      }
      // A live PID without a socket can be starting, not just stopping. Keep
      // observing the exact profile within the existing exit budget so a late
      // listener receives the normal authenticated drain request.
      pid ??= await recordedPid(directory)
      if (await proveNotRunning(directory, pid, refused)) break
      await new Promise(resolve => setTimeout(resolve, remainingTime(deadline, 100)))
    }
  }
  return { profilesStopped: true }
}
