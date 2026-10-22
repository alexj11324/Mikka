import { describe, expect, it } from "vitest"

import {
  skillDescriptionSchema,
  skillInstructionsSchema,
  skillNameSchema,
} from "../skill"
import { SKILL_PRESETS, skillDraftFromPreset } from "./index"

describe("skill presets", () => {
  it("ships the five presets with unique keys and names", () => {
    expect(SKILL_PRESETS.map((preset) => preset.key)).toEqual([
      "reviewer",
      "security-reviewer",
      "tester",
      "planner",
      "researcher",
    ])
    const names = SKILL_PRESETS.map((preset) => preset.name.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(SKILL_PRESETS)("$key passes the skill schemas", (preset) => {
    expect(skillNameSchema.safeParse(preset.name).success).toBe(true)
    expect(skillDescriptionSchema.safeParse(preset.description).success).toBe(
      true
    )
    expect(skillInstructionsSchema.safeParse(preset.instructions).success).toBe(
      true
    )
  })

  it.each(SKILL_PRESETS)("$key carries no third-party tooling", (preset) => {
    expect(preset.instructions).not.toMatch(
      /claude-flow|ruflo|swarm|sparc|npx |mcp__|memory_store/i
    )
  })

  it("points the review presets at the repository's REVIEW.md", () => {
    for (const key of ["reviewer", "security-reviewer"]) {
      const preset = SKILL_PRESETS.find((candidate) => candidate.key === key)
      expect(preset?.instructions).toContain("REVIEW.md")
    }
  })
})

describe("skillDraftFromPreset", () => {
  const reviewer = SKILL_PRESETS[0]!

  it("copies the preset's fields", () => {
    expect(skillDraftFromPreset(reviewer, [])).toEqual({
      name: "Reviewer",
      description: reviewer.description,
      instructions: reviewer.instructions.trim(),
    })
  })

  it("suffixes the name when the workspace already uses it", () => {
    expect(skillDraftFromPreset(reviewer, ["reviewer"]).name).toBe("Reviewer 2")
    expect(
      skillDraftFromPreset(reviewer, ["Reviewer", "Reviewer 2"]).name
    ).toBe("Reviewer 3")
  })
})
