import type { ChildProcess } from 'node:child_process'

/** Call only for children spawned detached on POSIX. Closing the group also
 * stops launchers' native binaries and shell/MCP descendants after the leader
 * exits. Windows and PID-less spawn fixtures retain the direct-child fallback. */
export async function stopGroup(child: ChildProcess, graceMs = 3000) {
  if (child.pid === undefined) {
    try { child.kill('SIGKILL') } catch { /* Failed spawn or a PID-less fixture. */ }
    return
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, name)
      else child.kill(name)
    } catch { /* Already gone. */ }
  }
  if (child.exitCode === null && child.signalCode === null) {
    signal('SIGTERM')
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      const done = () => { clearTimeout(timer); child.off('exit', done); resolve() }
      const timer = setTimeout(done, graceMs)
      child.once('exit', done)
    })
  }
  signal('SIGKILL')
}
