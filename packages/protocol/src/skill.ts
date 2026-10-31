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
 * The skills section of the agent's brief. The body is inlined so every
 * harness applies it without reading anything, and the directory is named so
 * the attached files can be opened.
 */
export function skillsPromptSection(
  skills: readonly RunSkill[],
  directory: string
): string | null {
  if (skills.length === 0) return null
  const parts = skills.map((skill) => {
    const lines = [`### ${skill.name}`]
    if (skill.description?.trim()) lines.push(skill.description.trim())
    lines.push("", skill.instructions.trim())
    if (skill.files.length > 0) {
      lines.push(
        "",
        `Files: ${skill.files.map((file) => `${directory}/${skillSlug(skill.name)}/${file.path}`).join(", ")}`
      )
    }
    return lines.join("\n")
  })
  return [SKILLS_HEADING, "", ...parts].join("\n")
}
