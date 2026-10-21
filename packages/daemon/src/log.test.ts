import { readdirSync, readFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { closeLogger, createLogger } from "./log"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe("daemon log", () => {
  it("redacts credential fields before they reach the log file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orvilo-log-"))
    dirs.push(dir)
    const secret = "sk-ant-api03-logredactionvalue"
    const log = createLogger({ dir, level: "info" })
    log.info({ accessToken: secret, vendor: "claude_code" }, "quota refreshed")
    await closeLogger(log)
    const text = readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("\n")
    expect(text).toContain("[REDACTED]")
    expect(text).toContain("claude_code")
    expect(text).not.toContain(secret)
  })
})
