// The daemon's last lifecycle state, kept beside `daemon.log` so a machine's
// log tail (thread_machines.logTail) says why its device went offline. The
// file is written synchronously: pino's file stream is asynchronous and loses
// its last lines when the process exits. A record still in `running` after
// the device went offline means the process was killed without a chance to
// write (SIGKILL, OOM) or never left a live process (frozen sandbox).
import { join } from "node:path"

import { writeJsonAtomic } from "./fs-util"

export const LIFECYCLE_FILE = "lifecycle.json"
export interface DaemonLifecycleRecord {
  phase: "running" | "stopping" | "exited"
  pid: number
  startedAt: string
  reason?: string
  /** Name and code only: messages and stacks can carry credentials (decision 2026-11-05-0330). */
  error?: { name: string; code?: string }
  code?: number
  at: string
}

type LifecycleProcess = Pick<NodeJS.Process, "pid" | "once" | "on">

/** Records `running` now, then the reason and exit code on the way out. Call only once the daemon holds its data dir lock. */
export function trackDaemonLifecycle(logsDir: string, proc: LifecycleProcess = process, now = () => new Date()) {
  const file = join(logsDir, LIFECYCLE_FILE)
  const startedAt = now().toISOString()
  let reason: string | undefined, error: DaemonLifecycleRecord["error"], owned = true
  const write = (phase: DaemonLifecycleRecord["phase"], code?: number) => {
    if (!owned) return
    const record: DaemonLifecycleRecord = { phase, pid: proc.pid, startedAt, ...(reason ? { reason } : {}), ...(error ? { error } : {}), ...(code === undefined ? {} : { code }), at: now().toISOString() }
    try { writeJsonAtomic(file, record) } catch { /* diagnostics never change how the daemon exits */ }
  }
  write("running")
  // The monitor leaves Node's default crash behaviour (stack on stderr, exit 1) unchanged.
  proc.on("uncaughtExceptionMonitor", (thrown, origin) => {
    reason ??= origin
    if (error) return
    const code = (thrown as { code?: unknown } | null)?.code
    error = { name: thrown instanceof Error ? thrown.name : typeof thrown, ...(typeof code === "string" ? { code } : {}) }
  })
  proc.once("exit", code => { reason ??= "exit"; write("exited", code) })
  return {
    stopping(why: string) {
      reason ??= why
      write("stopping")
    },
    /** Another daemon took the data dir; the record is its to write from now on. */
    disown() { owned = false },
  }
}
