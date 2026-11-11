import { describe, expect, it } from "vitest"

import {
  MAX_SKILL_INSTRUCTIONS_LENGTH,
  MAX_SKILLS_PER_RUN,
  runSkillSchema,
  SKILL_PROMPT_BUDGET_CHARS,
  skillFilePathSchema,
  skillMarkdown,
  skillPromptPlan,
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

describe("skillPromptPlan", () => {
  const body = (index: number, length: number): RunSkill =>
    skill({
      id: `0199f000-0000-7000-8000-${String(index).padStart(12, "0")}`,
      name: `Skill ${index}`,
      instructions: String.fromCharCode(96 + index).repeat(length),
    })
  const full = (index: number): RunSkill =>
    body(index, MAX_SKILL_INSTRUCTIONS_LENGTH)

  it("inlines everything a typical run carries", () => {
    const plan = skillPromptPlan([body(1, 1200), body(2, 900), body(3, 1500)])
    expect(plan.degraded).toEqual([])
    expect(plan.inlined).toHaveLength(3)
  })

  it("holds the worst case the section used to send whole", () => {
    // The reason this budget exists: 20 skills at the body cap would carry
    // 400,000 characters into every turn of the run.
    const skills = Array.from({ length: MAX_SKILLS_PER_RUN }, (_, i) => full(i + 1))
    const plan = skillPromptPlan(skills)
    expect(plan.usedChars).toBeLessThanOrEqual(SKILL_PROMPT_BUDGET_CHARS)
    expect(plan.degraded.length).toBeGreaterThan(0)
    expect(plan.inlined.length + plan.degraded.length).toBe(MAX_SKILLS_PER_RUN)
  })

  it("never leaves the run without a body, whatever the budget", () => {
    for (const budget of [0, 1, 100, MAX_SKILL_INSTRUCTIONS_LENGTH - 1]) {
      const plan = skillPromptPlan([full(1), body(2, 5)], budget)
      expect(plan.inlined[0]?.name).toBe("Skill 1")
    }
  })
})

describe("skillsPromptSection with a budget", () => {
  const body = (index: number, length: number): RunSkill =>
    skill({
      id: `0199f000-0000-7000-8000-${String(index).padStart(12, "0")}`,
      name: `Skill ${index}`,
      instructions: String.fromCharCode(96 + index).repeat(length),
    })

  it("degrades the body that does not fit and names its file instead", () => {
    const skills = [
      body(1, MAX_SKILL_INSTRUCTIONS_LENGTH),
      body(2, MAX_SKILL_INSTRUCTIONS_LENGTH),
      body(3, 500),
    ]
    const plan = skillPromptPlan(skills)
    const section = skillsPromptSection(skills, "/run/skills", plan)!
    expect(plan.inlined).toHaveLength(2)
    expect(plan.degraded.map((entry) => entry.name)).toEqual(["Skill 3"])
    // A deferred skill keeps its description, and points at its whole text.
    expect(section).toContain("### Skill 3")
    expect(section).toContain("Full text: /run/skills/skill-3/SKILL.md")
    // Never a partial body: the deferred text is absent, not truncated.
    expect(section).not.toContain("c".repeat(100))
    expect(section).toContain("One skill is listed by description only")
  })

  it("keeps every inlined body whole and no deferred body at all", () => {
    const skills = Array.from({ length: MAX_SKILLS_PER_RUN }, (_, i) =>
      body(i + 1, MAX_SKILL_INSTRUCTIONS_LENGTH)
    )
    const plan = skillPromptPlan(skills)
    const section = skillsPromptSection(skills, "/run/skills", plan)!
    for (let index = 1; index <= MAX_SKILLS_PER_RUN; index++) {
      const letter = String.fromCharCode(96 + index)
      const deferred = plan.degraded.some((entry) => entry.name === `Skill ${index}`)
      expect(section.includes(letter.repeat(100)), `Skill ${index}`).toBe(!deferred)
    }
  })

  it("keeps the attached files of a deferred skill reachable", () => {
    const skills = [1, 2, 3].map((index) =>
      skill({
        id: `0199f000-0000-7000-8000-${String(index).padStart(12, "0")}`,
        name: `Skill ${index}`,
        instructions: String.fromCharCode(96 + index).repeat(MAX_SKILL_INSTRUCTIONS_LENGTH),
        files: [{ path: "t.md", content: "x" }],
      })
    )
    const section = skillsPromptSection(skills, "/run/skills")!
    expect(section).toContain("Files: /run/skills/skill-1/t.md")
    expect(section).toContain("Files: /run/skills/skill-3/t.md")
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
