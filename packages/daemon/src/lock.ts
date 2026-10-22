import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import lockfile from "proper-lockfile"

import { writeFileAtomic } from "./fs-util"

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly dataDir: string) {
    super(`Another daemon already runs for ${dataDir}`)
    this.name = "DaemonAlreadyRunningError"
  }
}

/**
 * Generous on purpose: a busy event loop or a laptop asleep must never let a
 * second daemon steal a live daemon's lock. Crash recovery does not wait for
 * staleness; it checks whether the holder is alive (see `acquireLock`).
 */
export const LOCK_STALE_MS = 5 * 60_000
export const LOCK_UPDATE_MS = 30_000
/** How long to wait for a holder that may still be starting or stopping. */
export const LOCK_TAKEOVER_MS = 6_000

export interface LockOptions {
  /** The holder's RPC socket: if it answers, the holder is alive. */
  socketPath?: string
  takeoverMs?: number
}

function pidFile(dataDir: string) {
  return join(dataDir, "daemon.pid")
}

function holderPid(dataDir: string): number | null {
  try {
    const pid = Number(readFileSync(pidFile(dataDir), "utf8").trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    const done = (alive: boolean) => {
      socket.destroy()
      resolve(alive)
    }
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
    socket.setTimeout(1_000, () => done(false))
  })
}

/**
 * One daemon per flavor data dir (ADR 0004). proper-lockfile keeps
 * `daemon.lock` fresh while we live, and `daemon.pid` names the holder.
 * When the lock is held: a holder that answers on its socket is a running
 * daemon (refused at once); a holder whose process is gone crashed (the
 * lock is taken over at once); otherwise we wait up to `takeoverMs` for it
 * to finish starting or stopping, then take over only if no pid is known.
 */
export async function acquireLock(
  dataDir: string,
  lockfilePath: string,
  onCompromised: (error: Error) => void = () => undefined,
  options: LockOptions = {}
): Promise<() => Promise<void>> {
  mkdirSync(dataDir, { recursive: true })
  const lock = async () => {
    const release = await lockfile.lock(dataDir, {
      lockfilePath,
      stale: LOCK_STALE_MS,
      update: LOCK_UPDATE_MS,
      realpath: false,
      // Default would throw from a timer and crash the daemon mid-run.
      onCompromised,
    })
    writeFileAtomic(pidFile(dataDir), `${process.pid}\n`)
    return async () => {
      rmSync(pidFile(dataDir), { force: true })
      await release()
    }
  }
  const deadline = Date.now() + (options.takeoverMs ?? LOCK_TAKEOVER_MS)
  for (;;) {
    try {
      return await lock()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error
    }
    if (options.socketPath && (await socketAnswers(options.socketPath))) {
      throw new DaemonAlreadyRunningError(dataDir)
    }
    const pid = holderPid(dataDir)
    const crashed = pid !== null && pid !== process.pid && !processAlive(pid)
    if (crashed || (pid === null && Date.now() >= deadline)) {
      // The holder is gone: its lock is left over from a crash.
      rmSync(lockfilePath, { recursive: true, force: true })
      try {
        return await lock()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
          throw new DaemonAlreadyRunningError(dataDir)
        }
        throw error
      }
    }
    if (Date.now() >= deadline) throw new DaemonAlreadyRunningError(dataDir)
    await sleep(250)
  }
}
