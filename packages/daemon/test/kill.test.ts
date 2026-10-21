// AC4: SIGKILL the headless daemon mid-run, start it again, and the run
// resumes to completion. Uses the real CLI entry (`orvilo daemon --dev
// --server memory`) in a child process.
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

import { execa, type ResultPromise } from "execa"
import { afterEach, describe, expect, it } from "vitest"

import { writeJsonAtomic } from "../src/fs-util"
import { daemonPaths } from "../src/paths"
import { connectDaemonInDataDir, type DaemonClient } from "../src/rpc/client"
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from "./helpers"

const BIN = resolve(import.meta.dirname, "../bin/orvilo.ts")
const children: ResultPromise[] = []

function spawnDaemon(dataDir: string) {
  const child = execa(
    process.execPath,
    [
      "--import",
      "tsx",
      BIN,
      "daemon",
      "--dev",
      "--server",
      "memory",
      "--data-dir",
      dataDir,
      "--mock-speed",
      "20",
    ],
    { reject: false, stdio: "ignore", cwd: resolve(import.meta.dirname, "..") }
  )
  children.push(child)
  return child
}

async function connect(dataDir: string): Promise<DaemonClient> {
  return waitFor(
    () =>
      connectDaemonInDataDir(dataDir, { name: "t", version: "0" }).catch(
        () => undefined
      ),
    20_000,
    100
  )
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  cleanupTempDirs()
})

describe("daemon crash and resume", () => {
  it("resumes a run after SIGKILL", async () => {
    const repo = await makeRepo()
    const dataDir = tempDir()
    writeJsonAtomic(daemonPaths(dataDir).devRepos, {
      repos: [{ repoId: "sandbox", name: "sandbox", path: repo }],
    })

    const first = spawnDaemon(dataDir)
    let client = await connect(dataDir)
    const started = await client.request("dev.mockRun", {
      repoId: "sandbox",
      fixture: "long-running",
      baseBranch: "main",
    })
    await waitFor(async () => {
      const runs = await client.request("runs.list")
      return (runs.find((r) => r.runId === started.runId)?.chunks ?? 0) > 10
    })
    client.close()
    first.kill("SIGKILL")
    await first

    spawnDaemon(dataDir)
    client = await connect(dataDir)
    const done = await waitFor(
      async () => {
        const runs = await client.request("runs.list")
        const run = runs.find((r) => r.runId === started.runId)
        return run?.state === "succeeded" ? run : undefined
      },
      20_000,
      100
    )
    expect(existsSync(join(done.worktree as string, "notes/long-run.md"))).toBe(
      true
    )
    client.close()
  }, 60_000)
})
