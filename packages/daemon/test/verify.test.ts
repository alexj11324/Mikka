// The verify command's launch: a sandbox that aborts during its own setup
// (bwrap racing a rename of a file it masks) is started again; a command
// that began is never run twice.
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"

import { NoSandbox, shellJoin, type AgentSandbox, type SandboxedCommand } from "../src/agents/sandbox"
import { runVerify } from "../src/agents/verify"
import { cleanupTempDirs, tempDir } from "./helpers"

const SETUP_ERROR =
  "bwrap: Can't bind mount /oldroot/dev/null on /newroot/data/runs.json: Unable to find \"/newroot/data/runs.json\" in mount table"

/** Aborts its first `failures` launches before the command runs, as bwrap does. */
class SetupRaceSandbox implements AgentSandbox {
  readonly kind = "none" as const
  launches = 0
  constructor(private readonly failures: number) {}

  async wrap(argv: string[]): Promise<SandboxedCommand> {
    this.launches++
    if (this.launches > this.failures) return new NoSandbox().wrap(argv)
    return {
      command: `echo ${shellJoin([SETUP_ERROR])} >&2; exit 1`,
      annotate: (stderr) => stderr,
      release() {},
    }
  }
}

afterEach(() => cleanupTempDirs())

function verify(sandbox: AgentSandbox, command: string) {
  const privateDir = tempDir("orvp-")
  const worktree = tempDir("orvw-")
  return {
    worktree,
    result: runVerify(sandbox, {
      command,
      worktree,
      tmpRoot: join(privateDir, "verify"),
      privateDir,
      pidFile: join(privateDir, `${randomUUID()}.pgid`),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
      timeoutMs: 30_000,
    }),
  }
}

it("starts verify again when the sandbox aborted before the command ran", async () => {
  const sandbox = new SetupRaceSandbox(2)
  const { worktree, result } = verify(sandbox, "echo checked >> ran.txt && echo checked")
  expect(await result).toMatchObject({ exitCode: 0, timedOut: false })
  expect((await result).output).toContain("checked")
  expect(sandbox.launches).toBe(3)
  expect(readFileSync(join(worktree, "ran.txt"), "utf8")).toBe("checked\n")
})

it("never runs a command twice once it started, even when it fails", async () => {
  const sandbox = new SetupRaceSandbox(0)
  const { worktree, result } = verify(sandbox, "echo run >> ran.txt; exit 3")
  expect((await result).exitCode).toBe(3)
  expect(sandbox.launches).toBe(1)
  expect(readFileSync(join(worktree, "ran.txt"), "utf8")).toBe("run\n")
})

it("reports the sandbox failure when setup keeps failing", async () => {
  const sandbox = new SetupRaceSandbox(Number.POSITIVE_INFINITY)
  const { result } = verify(sandbox, "echo checked")
  const failed = await result
  expect(failed.exitCode).toBe(1)
  expect(failed.output).toContain("Can't bind mount")
  expect(sandbox.launches).toBe(3)
})
