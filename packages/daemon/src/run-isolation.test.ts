// Devices are runners (2026-10-31): a run's CLI sees only its own run home,
// any credential it writes there is gone when the run ends (or on the next
// daemon start after a crash), and the person's own ~/.claude and ~/.codex
// are never read or written.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { cleanupTempDirs, makeRepo, tempDir } from "../test/helpers"
import { ClaudeAdapter } from "./adapters/claude"
import { CodexAdapter } from "./adapters/codex"
import { prepareCodexHome, sweepRunCredentials, wipeRunCredentials } from "./agents/harness-home"
import { NoSandbox } from "./agents/sandbox"
import { ToolApprovalGate } from "./agents/tool-approval"
import { buildChildEnv } from "./env"
import { createLogger } from "./log"

const FAKES = resolve(import.meta.dirname, "../test/fakes")
let userHome: string
let saved: { HOME?: string; CODEX_HOME?: string; CLAUDE_CONFIG_DIR?: string }

/** The person's own CLI state, with every file's content and mtime. */
function seedUserHome(home: string) {
  for (const [file, body] of [
    [".claude/settings.json", '{"hooks":{"Stop":[{"command":"touch /tmp/pwned"}]}}'],
    [".claude/.credentials.json", '{"claudeAiOauth":{"accessToken":"person-own-claude"}}'],
    [".claude.json", '{"oauthAccount":{"emailAddress":"person@example.com"}}'],
    [".codex/auth.json", '{"tokens":{"account_id":"person-own","access_token":"person-own-codex"}}'],
    [".codex/config.toml", 'model = "person-choice"\n'],
  ] as const) {
    mkdirSync(join(home, file, ".."), { recursive: true })
    writeFileSync(join(home, file), body)
  }
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name)
      const stat = statSync(full)
      if (stat.isDirectory()) walk(full)
      else out[full] = `${stat.mtimeMs}:${readFileSync(full, "utf8")}`
    }
  }
  walk(dir)
  return out
}

/** Wraps a fake CLI: records what it was given and writes a credential into its home. */
function recordingCli(fake: string, record: string, credential: string) {
  const wrapper = join(tempDir(), "cli")
  writeFileSync(wrapper, [
    "#!/bin/sh",
    `printf '%s\\n%s\\n%s\\n' "$HOME" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" > "${record}"`,
    `mkdir -p "$(dirname "${credential}")" && echo injected > "${credential}"`,
    `exec node "${join(FAKES, fake)}" "$@"`,
    "",
  ].join("\n"))
  chmodSync(wrapper, 0o755)
  return wrapper
}

function gate(runId: string) {
  return new ToolApprovalGate(runId, { permission: () => "deny", ask: async () => "deny", isLive: id => id === runId })
}

async function runToExit(session: Awaited<ReturnType<ClaudeAdapter["start"]>>) {
  try {
    for await (const event of session.events()) if (event.type === "exit") return event
  } finally {
    await session.cancel()
  }
}

beforeEach(() => {
  saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
  userHome = tempDir("person-")
  seedUserHome(userHome)
  process.env.HOME = userHome
  delete process.env.CODEX_HOME
  delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  cleanupTempDirs()
})

describe("run homes", () => {
  it("Claude Code runs in its own home, and its credential is gone after the run", async () => {
    const before = snapshot(userHome)
    const stateDir = join(tempDir(), "adapters")
    const runDir = join(stateDir, "runs", "claude-isolated")
    const record = join(tempDir(), "record")
    const binary = recordingCli("fake-claude.mjs", record, join(runDir, "native-home", ".claude", ".credentials.json"))
    const adapter = new ClaudeAdapter({ stateDir, sandbox: new NoSandbox(), binary })
    const session = await adapter.start({ runId: "claude-isolated", cwd: await makeRepo(), prompt: "MODEL", env: buildChildEnv(),
      log: createLogger(), toolApproval: gate("claude-isolated") })
    expect((await runToExit(session))?.outcome).toBe("succeeded")
    const [home, configDir] = readFileSync(record, "utf8").split("\n")
    expect(home).toBe(join(runDir, "native-home"))
    expect(configDir).toBe(join(runDir, "native-home", ".claude"))
    expect(existsSync(join(runDir, "native-home", ".claude", ".credentials.json"))).toBe(false)
    expect(snapshot(userHome)).toEqual(before)
  })

  it("Codex runs in its own home with no link to the person's login, and its credential is gone after the run", async () => {
    const before = snapshot(userHome)
    const stateDir = join(tempDir(), "adapters")
    const runDir = join(stateDir, "runs", "codex-isolated")
    const record = join(tempDir(), "record")
    const binary = recordingCli("fake-codex.mjs", record, join(runDir, "codex-home", "auth.json"))
    const adapter = new CodexAdapter({ stateDir, sandbox: new NoSandbox(), binary })
    const session = await adapter.start({ runId: "codex-isolated", cwd: await makeRepo(), prompt: "MODEL", env: buildChildEnv(),
      log: createLogger(), toolApproval: gate("codex-isolated") })
    expect((await runToExit(session))?.outcome).toBe("succeeded")
    const codexHome = readFileSync(record, "utf8").split("\n")[2]
    expect(codexHome).toBe(join(runDir, "codex-home"))
    await expect.poll(() => existsSync(join(runDir, "codex-home", "auth.json"))).toBe(false)
    expect(readFileSync(join(runDir, "codex-home", "config.toml"), "utf8")).not.toContain("person-choice")
    expect(snapshot(userHome)).toEqual(before)
  })

  it("a new Codex home never links or copies the person's auth.json", () => {
    const home = prepareCodexHome(join(tempDir(), "codex-home"), createLogger())
    expect(readdirSync(home.home)).toEqual(["config.toml"])
  })
})

describe("credential cleanup", () => {
  it("wipes credentials from a run dir and keeps its history", () => {
    const runDir = tempDir()
    for (const file of ["codex-home/auth.json", "native-home/.claude/.credentials.json", "codex-home/sessions/thread.jsonl", "native-home/.claude/projects/p/s.jsonl"]) {
      mkdirSync(join(runDir, file, ".."), { recursive: true })
      writeFileSync(join(runDir, file), "x")
    }
    wipeRunCredentials(runDir)
    expect(existsSync(join(runDir, "codex-home/auth.json"))).toBe(false)
    expect(existsSync(join(runDir, "native-home/.claude/.credentials.json"))).toBe(false)
    expect(existsSync(join(runDir, "codex-home/sessions/thread.jsonl"))).toBe(true)
    expect(existsSync(join(runDir, "native-home/.claude/projects/p/s.jsonl"))).toBe(true)
  })

  it("on daemon start, wipes what a crashed or killed daemon left in every run", () => {
    const stateDir = tempDir()
    for (const run of ["killed-1", "killed-2"]) {
      mkdirSync(join(stateDir, "runs", run, "codex-home"), { recursive: true })
      writeFileSync(join(stateDir, "runs", run, "codex-home", "auth.json"), "x")
      mkdirSync(join(stateDir, "runs", run, "native-home", ".claude"), { recursive: true })
      writeFileSync(join(stateDir, "runs", run, "native-home", ".claude", ".credentials.json"), "x")
    }
    sweepRunCredentials(stateDir)
    for (const run of ["killed-1", "killed-2"]) {
      expect(existsSync(join(stateDir, "runs", run, "codex-home", "auth.json"))).toBe(false)
      expect(existsSync(join(stateDir, "runs", run, "native-home", ".claude", ".credentials.json"))).toBe(false)
    }
    expect(() => sweepRunCredentials(join(stateDir, "missing"))).not.toThrow()
  })
})
