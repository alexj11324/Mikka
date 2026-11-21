import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { LIFECYCLE_FILE, type DaemonLifecycleRecord } from "./lifecycle-record"

const MODULE = join(import.meta.dirname, "lifecycle-record.ts")

/** Runs `body` in a real Node process that tracks its lifecycle, then reads what it left behind. */
function exitWith(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "mikka-lifecycle-"))
  const script = join(dir, "daemon.ts")
  const file = join(dir, "logs", LIFECYCLE_FILE)
  writeFileSync(script, `import { writeFileSync } from "node:fs"\nimport { trackDaemonLifecycle } from ${JSON.stringify(MODULE)}\nconst lifecycle = trackDaemonLifecycle(${JSON.stringify(join(dir, "logs"))})\n${body.replaceAll("__FILE__", file)}\n`)
  const child = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", timeout: 30_000 })
  const record = JSON.parse(readFileSync(file, "utf8")) as DaemonLifecycleRecord
  return { child, record }
}

describe("daemon lifecycle record", () => {
  it("names an uncaught exception and keeps Node's crash exit", () => {
    const { child, record } = exitWith(`setTimeout(() => { throw Object.assign(new TypeError("token orv_secret rejected"), { code: "ERR_SOCKET" }) }, 0)`)
    expect(child.status).toBe(1)
    expect(child.stderr).toContain("token orv_secret rejected")
    expect(record).toMatchObject({ phase: "exited", reason: "uncaughtException", code: 1, error: { name: "TypeError", code: "ERR_SOCKET" } })
    expect(JSON.stringify(record)).not.toContain("orv_secret")
  })

  it("names an unhandled rejection", () => {
    const { child, record } = exitWith(`void Promise.reject(new Error("claim stream rejected"))`)
    expect(child.status).toBe(1)
    expect(record).toMatchObject({ phase: "exited", reason: "unhandledRejection", code: 1, error: { name: "Error" } })
  })

  it("keeps the first stop reason through the exit", () => {
    const { child, record } = exitWith(`lifecycle.stopping("signal:SIGTERM")\nlifecycle.stopping("drained")\nprocess.exit(0)`)
    expect(child.status).toBe(0)
    expect(record).toMatchObject({ phase: "exited", reason: "signal:SIGTERM", code: 0 })
  })

  it("leaves the record to the daemon that took over the data dir", () => {
    const { child, record } = exitWith(`writeFileSync(${JSON.stringify("__FILE__")}, JSON.stringify({ phase: "running", pid: 1 }))\nlifecycle.disown()\nprocess.exit(1)`)
    expect(child.status).toBe(1)
    expect(record).toMatchObject({ phase: "running", pid: 1 })
  })

  it("stays running when the process is killed before it can write", () => {
    const { child, record } = exitWith(`process.kill(process.pid, "SIGKILL")`)
    expect(child.signal).toBe("SIGKILL")
    expect(record.phase).toBe("running")
    expect(record.reason).toBeUndefined()
  })
})

describe("mikka daemon", () => {
  it("records the signal that stopped it", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mikka-daemon-"))
    const daemon = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "bin", "mikka.ts"), "daemon", "--dev", "--no-auto-update", "--server", "memory", "--data-dir", dataDir], { stdio: "ignore" })
    const exited = new Promise<number | null>(resolve => daemon.once("exit", resolve))
    const log = join(dataDir, "logs", "daemon.log")
    while (!(existsSync(log) && readFileSync(log, "utf8").includes("device session open"))) await new Promise(resolve => setTimeout(resolve, 100))
    daemon.kill("SIGTERM")
    expect(await exited).toBe(0)
    expect(JSON.parse(readFileSync(join(dataDir, "logs", LIFECYCLE_FILE), "utf8"))).toMatchObject({ phase: "exited", reason: "signal:SIGTERM", code: 0, pid: daemon.pid })
  })
})
