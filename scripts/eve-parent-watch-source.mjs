/**
 * The peer's half of the shutdown contract, as source text.
 *
 * `eve-service.mjs` hands this to `--import` as a data URL. A file path cannot
 * work there: Nitro bundles the service into `server/_chunks/`, which has no
 * `scripts/` directory beside it, so the old `new URL('./eve-parent-watch.mjs',
 * import.meta.url)` resolved to a file the built app never contains.
 *
 * Kept as text rather than a function so the peer runs one unmodified module:
 * the same source the tests exercise is the one a built app runs.
 */
export const EVE_PARENT_WATCH = String.raw`/**
 * The half of the shutdown contract that runs inside the peer.
 *
 * 'pnpm dev' is routinely stopped with 'kill -9', and a killed parent cannot run
 * any cleanup. A surviving eve keeps '.eve/dev-server-state.v1.json' pointing at
 * itself, and every later start is then refused with "A dev server is already
 * running for this eve agent" — which the outer script can only report as an
 * unexplained exit. So the peer watches the process that spawned it and stops
 * itself when that process is gone.
 *
 * Loaded with '--import' into the eve processes 'scripts/eve-service.mjs'
 * spawns. eve re-forks its own local server with the same execArgv, so this
 * module also runs there: the guard below keeps that one inert, which leaves
 * eve's own IPC-disconnect shutdown in charge of the server it forked.
 */
const expected = Number(process.env.MIKKA_EVE_PARENT_PID ?? '')
const parent = process.ppid

const alive = pid => {
  try { process.kill(pid, 0); return true }
  catch { return false }
}

if (Number.isInteger(expected) && expected > 0) {
  const stop = () => {
    // A graceful signal first: eve closes its own local server and removes the
    // state file that would otherwise refuse the next start.
    process.kill(process.pid, 'SIGTERM')
    // If eve does not take that, take the group down anyway. The server eve
    // forked runs in its own group and stops when this process's IPC closes.
    const backstop = setTimeout(() => {
      try { process.kill(-process.pid, 'SIGKILL') }
      catch { /* the group is already gone */ }
    }, 5_000)
    backstop.unref()
  }
  if (parent !== expected) {
    // Either eve's own local server — its parent is the eve host, which is still
    // running, and eve is the one that stops it — or a process orphaned before
    // this preload ran. The named parent's absence tells the two apart.
    if (!alive(expected)) stop()
  } else {
    const parentWatch = setInterval(() => {
      // Reparenting is the signal, not liveness: the kernel moves an orphan to
      // launchd/init, while a reused pid would make 'kill(pid, 0)' lie.
      if (process.ppid === parent) return
      clearInterval(parentWatch)
      stop()
    }, 500)
    // Never keep the peer alive for the sake of watching; its own listeners do.
    parentWatch.unref()
  }
}
`
