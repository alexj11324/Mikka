import { describe, expect, it } from "vitest"

import {
  runSkillSchema,
  skillFilePathSchema,
  skillMarkdown,
  skillSlug,
  skillsPromptSection,
  type RunSkill,
} from "./skill"

const skill = (extra: Partial<RunSkill> = {}): RunSkill => ({
  id: "0199f000-0000-7000-8000-000000000001",
  name: "Triage",
  description: "Sort the inbox first.",
  instructions: "Read the inbox, then label everything.",
  files: [],
  ...extra,
})

describe("skill paths", () => {
  it("takes a nested relative path and refuses what leaves the skill", () => {
    expect(skillFilePathSchema.safeParse("notes/template.md").success).toBe(
      true
    )
    expect(skillFilePathSchema.safeParse("./a.md").success).toBe(true)
    for (const path of [
      "/etc/passwd",
      "../outside.md",
      "notes/../../outside.md",
      "notes\\win.md",
      "notes//a.md",
      "",
    ]) {
      expect(skillFilePathSchema.safeParse(path).success, path).toBe(false)
    }
  })
})

describe("skillSlug", () => {
  it("makes a filesystem-safe directory name", () => {
    expect(skillSlug("Triage")).toBe("triage")
    expect(skillSlug("Release notes / v2")).toBe("release-notes-v2")
    expect(skillSlug("  —  ")).toBe("skill")
    expect(skillSlug("日本語")).toBe("skill")
  })
})

describe("skillMarkdown", () => {
  it("writes front matter with the body under it", () => {
    expect(skillMarkdown(skill())).toBe(
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
  })

  it("leaves out a description the skill does not have", () => {
    expect(skillMarkdown(skill({ description: null }))).not.toContain(
      "description:"
    )
  })
})

describe("skillsPromptSection", () => {
  it("is absent when the run has no skills", () => {
    expect(skillsPromptSection([], "/run/skills")).toBeNull()
  })

  it("inlines the body and names the attached files", () => {
    const section = skillsPromptSection(
      [
        skill(),
        skill({
          id: "0199f000-0000-7000-8000-000000000002",
          name: "Release notes",
          description: null,
          instructions: "Follow the template.",
          files: [{ path: "template.md", content: "# Notes" }],
        }),
      ],
      "/run/skills"
    )
    expect(section).toContain("Skills from your workspace")
    expect(section).toContain("### Triage")
    expect(section).toContain("Read the inbox, then label everything.")
    expect(section).toContain("### Release notes")
    expect(section).toContain("Follow the template.")
    expect(section).toContain("/run/skills/release-notes/template.md")
    // The first skill has no files, so no file line under it.
    expect(section).not.toContain("/run/skills/triage/")
  })
})

describe("runSkillSchema", () => {
  it("keeps a skill that came through the assignment intact", () => {
    const parsed = runSkillSchema.parse({
      ...skill(),
      files: [{ path: "a/b.md", content: "x" }],
    })
    expect(parsed.files).toEqual([{ path: "a/b.md", content: "x" }])
  })

  it("refuses a body that is empty or over-long", () => {
    expect(
      runSkillSchema.safeParse({ ...skill(), instructions: "   " }).success
    ).toBe(false)
    expect(
      runSkillSchema.safeParse({
        ...skill(),
        instructions: "x".repeat(20_001),
      }).success
    ).toBe(false)
  })
})
