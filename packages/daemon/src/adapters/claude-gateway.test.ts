import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readClaudeGateway } from "./claude-gateway"

let dir: string

function settings(value: unknown) {
  writeFileSync(join(dir, "settings.json"), typeof value === "string" ? value : JSON.stringify(value))
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "claude-gateway-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe("readClaudeGateway", () => {
  it("carries only the gateway variables and names its host", () => {
    settings({
      hooks: { Stop: [] },
      env: {
        ANTHROPIC_BASE_URL: "https://gateway.example.com/v1",
        ANTHROPIC_AUTH_TOKEN: "token",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus",
        NODE_OPTIONS: "--require /tmp/evil.js",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1",
      },
    })
    expect(readClaudeGateway(dir)).toEqual({
      domain: "gateway.example.com",
      env: {
        ANTHROPIC_BASE_URL: "https://gateway.example.com/v1",
        ANTHROPIC_AUTH_TOKEN: "token",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "custom-opus",
      },
    })
  })

  it("is null for a normal login, with or without a settings file", () => {
    expect(readClaudeGateway(dir)).toBeNull()
    settings({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "x" } })
    expect(readClaudeGateway(dir)).toBeNull()
  })

  it("ignores settings it cannot trust", () => {
    for (const bad of ["not json", "null", { env: "text" }, { env: { ANTHROPIC_BASE_URL: "not a url" } }, { env: { ANTHROPIC_BASE_URL: "file:///etc/passwd" } }, { env: { ANTHROPIC_BASE_URL: 1 } }]) {
      settings(bad)
      expect(readClaudeGateway(dir)).toBeNull()
    }
  })
})
