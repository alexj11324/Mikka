// What a run does with the skills it was given: writes them under its own
// run dir (never the worktree, where `git status` and the run's commit would
// pick them up) and reads them into the agent's instructions.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import type { RunSkill } from "@orvilo/protocol"

import { RunContext } from "../src/agents/run-context"
import { cleanupTempDirs, makeRepo, tempDir } from "./helpers"

afterAll(cleanupTempDirs)

const skill = (extra: Partial<RunSkill> = {}): RunSkill => ({
  id: "0199f000-0000-7000-8000-000000000001",
  name: "Triage",
  description: "Sort the inbox first.",
  instructions: "Read the inbox, then label everything.",
  files: [],
  ...extra,
})

async function context(skills: readonly RunSkill[]) {
  const worktree = await makeRepo()
  const stateDir = tempDir("orvs-")
  const runDir = join(stateDir, "runs", "run-1")
  return new RunContext({
    harness: "claude_code",
    worktree,
    skills,
    runDir,
    privateDir: stateDir,
  })
}

describe("run skills", () => {
  it("writes each skill's body and files under the run dir", async () => {
    const ctx = await context([
      skill({ files: [{ path: "notes/template.md", content: "# Notes" }] }),
      skill({
        id: "0199f000-0000-7000-8000-000000000002",
        name: "Release notes",
        description: null,
        instructions: "Follow the template.",
      }),
    ])
    expect(
      readFileSync(join(ctx.skillsDir, "triage", "SKILL.md"), "utf8")
    ).toBe(
      [
        "---",
        "name: Triage",
        "description: Sort the inbox first.",
        "---",
        "",
        "Read the inbox, then label everything.",
        "",
      ].join("\n")
    )
    expect(
      readFileSync(
        join(ctx.skillsDir, "triage", "notes", "template.md"),
        "utf8"
      )
    ).toBe("# Notes")
    expect(existsSync(join(ctx.skillsDir, "release-notes", "SKILL.md"))).toBe(
      true
    )
    // Nothing lands in the worktree: the run's commit must not carry it.
    expect(existsSync(join(ctx.worktree, "skills"))).toBe(false)
    expect(existsSync(join(ctx.worktree, "SKILL.md"))).toBe(false)
  })

  it("gives two names that share a slug a directory each", async () => {
    const ctx = await context([
      skill({ name: "Release notes" }),
      skill({
        id: "0199f000-0000-7000-8000-000000000002",
        name: "release-notes",
      }),
    ])
    expect(existsSync(join(ctx.skillsDir, "release-notes", "SKILL.md"))).toBe(
      true
    )
    expect(existsSync(join(ctx.skillsDir, "release-notes-2", "SKILL.md"))).toBe(
      true
    )
  })

  it("reads the skills into the instructions, with the run's rules", async () => {
    const ctx = await context([skill()])
    const instructions = ctx.instructions()
    expect(instructions).toContain("You are running as an Orvilo agent")
    expect(instructions).toContain("Skills from your workspace")
    expect(instructions).toContain("### Triage")
    expect(instructions).toContain("Read the inbox, then label everything.")
  })

  it("leaves the instructions alone when the run has no skills", async () => {
    const ctx = await context([])
    const instructions = ctx.instructions()
    expect(instructions).not.toContain("Skills from your workspace")
    expect(existsSync(ctx.skillsDir)).toBe(false)
  })
})
