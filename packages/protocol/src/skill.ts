// Skills: a reusable playbook a workspace writes once and mounts on an agent,
// so every run of that agent follows it. One shape, used by the settings page,
// the claim route and the daemon, the way ADR 0028's policy is.
//
// The body reaches the agent through the prompt (the guidance precedent), and
// the skill is also written to disk in the run's directory so its attached
// files can be read as files. It is deliberately not written into the
// worktree: that would show up in `git status` and be committed with the run's
// changes, ending up in the pull request.
import { z } from "zod"
export { SKILL_ARTIFACT_HEADER, TEAM_SKILL_HEADER, skillArtifactRefSchema, skillAssignmentReceiptSchema, type SkillArtifactRef, type SkillAssignmentReceipt } from './skill-artifact'
export { skillReceiptRevalidationSchema, type SkillReceiptRevalidation } from './skill-artifact'

/** How many skills one run carries; the rest wait for the next run. */
export const MAX_SKILLS_PER_RUN = 20

export const MAX_SKILL_NAME_LENGTH = 80
export const MAX_SKILL_DESCRIPTION_LENGTH = 500
export const MAX_SKILL_INSTRUCTIONS_LENGTH = 20_000
export const MAX_SKILL_FILES = 20
export const MAX_SKILL_FILE_PATH_LENGTH = 200
export const MAX_SKILL_FILE_CONTENT_LENGTH = 100_000

/** The heading over the skills section of the agent's brief. */
export const SKILLS_HEADING =
  "Skills from your workspace (apply them on this task):"

/**
 * How many characters of skill bodies one run's prompt carries. The prompt is
 * sent, and paid for, on every turn of the run, so the bodies are budgeted
 * rather than inlined without limit: a skill that does not fit is listed by
 * name and description only, with the file holding its body named so the
 * agent can still read it.
 *
 * Never lower this below `MAX_SKILL_INSTRUCTIONS_LENGTH`: the first skill
 * always fits whole, so a budget can never leave a run with no body at all
 * (`skill.test.ts` holds that).
 */
export const SKILL_PROMPT_BUDGET_CHARS = 40_000

/** One skill's place in the prompt budget. */
export interface SkillPromptEntry {
  /** Position in the run's skill list, which is the order the prompt uses. */
  index: number
  id: string
  name: string
  /** Characters the body adds to the prompt when it is inlined. */
  instructionsChars: number
}

export interface SkillPromptPlan {
  /** The budget the plan was measured against. */
  budgetChars: number
  /** Characters of bodies the inlined skills carry. */
  usedChars: number
  /** Skills whose whole body goes into the prompt, in the order given. */
  inlined: SkillPromptEntry[]
  /**
   * Skills the prompt lists by description only. Their body is still written
   * into the run directory, so the prompt names each one's `SKILL.md`.
   */
  degraded: SkillPromptEntry[]
}

/**
 * What the skills section of one run's prompt carries, and what it had to
 * leave out. Computed before any text is built so the caller can report the
 * same answer the prompt used.
 *
 * Bodies are taken in the order the run carries them, and each one that still
 * fits is inlined. One that does not is degraded to its name and description;
 * the prompt then names the `SKILL.md` that holds its text, and the run still
 * writes that file, so nothing is lost, only deferred. The first skill is
 * always inlined whole, which is why the budget may never be lowered below
 * `MAX_SKILL_INSTRUCTIONS_LENGTH`.
 */
export function skillPromptPlan(
  skills: readonly RunSkill[],
  budgetChars: number = SKILL_PROMPT_BUDGET_CHARS
): SkillPromptPlan {
  const inlined: SkillPromptEntry[] = []
  const degraded: SkillPromptEntry[] = []
  let usedChars = 0
  skills.forEach((skill, index) => {
    const instructionsChars = skill.instructions.trim().length
    const entry: SkillPromptEntry = {
      index,
      id: skill.id,
      name: skill.name,
      instructionsChars,
    }
    // A later skill may still fit while an earlier one did not; the plan says
    // exactly which is which rather than splitting the list at a cut point.
    if (inlined.length === 0 || usedChars + instructionsChars <= budgetChars) {
      inlined.push(entry)
      usedChars += instructionsChars
    } else degraded.push(entry)
  })
  return { budgetChars, usedChars, inlined, degraded }
}

/**
 * A path a skill file may use: relative, no `..`, no absolute path, no
 * backslash. Everything else (spaces, dots, subdirectories) is fine.
 */
export const skillFilePathSchema = z
  .string()
  .min(1)
  .max(MAX_SKILL_FILE_PATH_LENGTH)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").some((segment) => segment === ".." || segment === ""),
    { message: "A skill file path must be relative and stay inside the skill." }
  )

export const skillFileSchema = z.object({
  path: skillFilePathSchema,
  content: z.string().max(MAX_SKILL_FILE_CONTENT_LENGTH),
})
export type SkillFile = z.infer<typeof skillFileSchema>

export const skillFilesSchema = z.array(skillFileSchema).max(MAX_SKILL_FILES)

export const skillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SKILL_NAME_LENGTH)

export const skillDescriptionSchema = z
  .string()
  .trim()
  .max(MAX_SKILL_DESCRIPTION_LENGTH)

export const skillInstructionsSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SKILL_INSTRUCTIONS_LENGTH)

/**
 * A skill as it travels with a run (`RunAssignment.skills`). `id` and `name`
 * are what the run record keeps, so a run still says which skills it used
 * after the skill is renamed or deleted.
 */
export const runSkillSchema = z.object({
  id: z.uuid(),
  name: skillNameSchema,
  description: z.string().nullable(),
  instructions: skillInstructionsSchema,
  files: skillFilesSchema,
})
export type RunSkill = z.infer<typeof runSkillSchema>

/** What `agent_run.skills` records: the skills the run was given. */
export const runSkillRefSchema = z.object({
  id: z.uuid(),
  name: skillNameSchema,
})
export type RunSkillRef = z.infer<typeof runSkillRefSchema>

/**
 * The directory name a skill's files live under in the run directory. Derived
 * from the name, so two skills with names that differ only in case or
 * punctuation share one directory; the daemon suffixes a repeat.
 */
export function skillSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return slug || "skill"
}

/** Where a run's skills are written, under the run's own directory. */
export const SKILLS_DIR = "skills"

/** The file a skill's body is written to inside its directory. */
export const SKILL_BODY_FILE = "SKILL.md"

/** The Markdown a skill's `SKILL.md` holds: front matter plus the body. */
export function skillMarkdown(skill: {
  name: string
  description?: string | null
  instructions: string
}): string {
  const description = skill.description?.trim()
  return [
    "---",
    `name: ${skill.name}`,
    ...(description ? [`description: ${description}`] : []),
    "---",
    "",
    skill.instructions.trim(),
    "",
  ].join("\n")
}

/**
 * The skills section of the agent's brief. A body that fits is inlined so
 * every harness applies it without reading anything, and the directory is
 * named so the attached files can be opened.
 *
 * Bodies are taken in order until `budgetChars` is reached; the rest are
 * listed by name and description, with the file holding their text named
 * instead of the text itself. Pass the `plan` the caller will report, so the
 * prompt and what the app shows can never disagree.
 */
export function skillsPromptSection(
  skills: readonly RunSkill[],
  directory: string,
  plan: SkillPromptPlan = skillPromptPlan(skills)
): string | null {
  if (skills.length === 0) return null
  const degradedIndexes = new Set(plan.degraded.map((entry) => entry.index))
  const parts = skills.map((skill, index) => {
    const lines = [`### ${skill.name}`]
    if (skill.description?.trim()) lines.push(skill.description.trim())
    if (degradedIndexes.has(index)) {
      // Never a truncated body: the whole text is in the file, and the prompt
      // says so, so the agent reads it instead of applying half a skill.
      lines.push("", `Full text: ${skillBodyPath(directory, skill)}`)
    } else {
      lines.push("", skill.instructions.trim())
    }
    if (skill.files.length > 0) {
      lines.push(
        "",
        `Files: ${skill.files.map((file) => `${directory}/${skillSlug(skill.name)}/${file.path}`).join(", ")}`
      )
    }
    return lines.join("\n")
  })
  const degraded = plan.degraded.length
  const note = degraded === 0 ? [] : [
    `${degraded === 1 ? "One skill is" : `${degraded} skills are`} listed by description only: the full text of every skill would not fit this run's prompt. Read its file before applying it.`,
    "",
  ]
  return [SKILLS_HEADING, "", ...note, ...parts].join("\n")
}

/** Where a skill's body is written, for a prompt that lists it without the text. */
export function skillBodyPath(directory: string, skill: { name: string }): string {
  return `${directory}/${skillSlug(skill.name)}/${SKILL_BODY_FILE}`
}
