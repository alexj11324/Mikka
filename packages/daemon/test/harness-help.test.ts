// Permission modes are read from each CLI's own `--help`, so the server only
// offers what the installed version takes. The fixtures are excerpts of the
// real help of Claude Code 2.1.308 and Codex 0.163.0.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { flagChoices } from "../src/harnesses"

const help = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "help", name), "utf8")

describe("flagChoices", () => {
  it("reads commander's choices (Claude Code)", () => {
    expect(
      flagChoices(help("claude-2.1.308.txt"), "--permission-mode")
    ).toEqual(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"])
  })

  it("reads clap's long form (Codex --ask-for-approval)", () => {
    expect(
      flagChoices(help("codex-0.163.0.txt"), "--ask-for-approval")
    ).toEqual(["on-request", "never"])
  })

  it("reads clap's short form (Codex --sandbox)", () => {
    expect(flagChoices(help("codex-0.163.0.txt"), "--sandbox")).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ])
  })

  it("ignores a description that only mentions the flag", () => {
    const text = [
      "  --dangerously-skip-permissions  Same as --permission-mode bypassPermissions",
      "  --verbose                       Say more",
    ].join("\n")
    expect(flagChoices(text, "--permission-mode")).toEqual([])
  })
})
