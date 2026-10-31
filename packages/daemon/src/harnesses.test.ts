import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { harnessFingerprint, knownAgentDirectories, loginShellPath } from "./harnesses"

let root: string
let savedPath: string | undefined

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnesses-"))
  savedPath = process.env.PATH
})

afterEach(() => {
  process.env.PATH = savedPath
  rmSync(root, { recursive: true, force: true })
})

describe("knownAgentDirectories", () => {
  it("covers official installers and every installed node version", () => {
    mkdirSync(join(root, ".nvm/versions/node/v24.0.0"), { recursive: true })
    mkdirSync(join(root, ".nvm/versions/node/v22.0.0"), { recursive: true })
    const directories = knownAgentDirectories(root)
    expect(directories).toContain(join(root, ".local/bin"))
    expect(directories).toContain(join(root, ".claude/local"))
    expect(directories).toContain(join(root, ".nvm/versions/node/v24.0.0/bin"))
    expect(directories).toContain(join(root, ".nvm/versions/node/v22.0.0/bin"))
  })
})

describe("loginShellPath", () => {
  it("reads the PATH through whatever startup files print", async () => {
    const shell = join(root, "shell")
    script(shell, `echo welcome; PATH=/from/rc:/usr/bin; eval "$2"; echo goodbye`)
    expect(await loginShellPath(shell)).toEqual(["/from/rc", "/usr/bin"])
  })

  it("does not wait for a startup file that hangs, or for a process it left holding the output", async () => {
    const shell = join(root, "hanging")
    script(shell, "sleep 30 &\nsleep 30")
    const started = Date.now()
    expect(await loginShellPath(shell)).toEqual([])
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 40_000)

  it("gives up on a shell that fails or is not a real path", async () => {
    const shell = join(root, "broken")
    script(shell, "exit 1")
    expect(await loginShellPath(shell)).toEqual([])
    expect(await loginShellPath("zsh")).toEqual([])
    expect(await loginShellPath(join(root, "missing"))).toEqual([])
  })
})

describe("harnessFingerprint", () => {
  it("changes when an agent appears on PATH, without running it", () => {
    process.env.PATH = root
    const before = harnessFingerprint()
    script(join(root, "codex"), `touch "${join(root, "ran")}"`)
    const after = harnessFingerprint()
    expect(after).not.toBe(before)
    expect(after).toContain(join(root, "codex"))
    expect(harnessFingerprint()).toBe(after)
  })
})
