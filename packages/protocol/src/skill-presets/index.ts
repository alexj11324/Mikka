// Built-in preset skills (ADR ORV-277). A preset is not stored anywhere: the
// Skills settings page copies one into the workspace's `skill` table, and from
// then on it is an ordinary skill the workspace owns and can edit. Presets are
// written for Mikka; the role split was inspired by Ruflo's core agents
// (MIT, see THIRD_PARTY_NOTICES.md).
import { plannerInstructions } from "./planner"
import { researcherInstructions } from "./researcher"
import { reviewerInstructions } from "./reviewer"
import { securityReviewerInstructions } from "./security-reviewer"
import { testerInstructions } from "./tester"

export interface SkillPreset {
  /** Stable key; never shown, never stored. */
  key: string
  name: string
  description: string
  instructions: string
}

export const SKILL_PRESETS: readonly SkillPreset[] = [
  {
    key: "reviewer",
    name: "Reviewer",
    description:
      "Reviews a pull request: Important / Nit / Pre-existing findings with file:line evidence, at most 3 rounds. Follows the repo's REVIEW.md when present.",
    instructions: reviewerInstructions,
  },
  {
    key: "security-reviewer",
    name: "Security reviewer",
    description:
      "Security-only pass over a change: injection, authorization, tenant isolation, credentials, exposed surface, untrusted content.",
    instructions: securityReviewerInstructions,
  },
  {
    key: "tester",
    name: "Tester",
    description:
      "Writes and runs the tests that prove a change and its acceptance criteria, using the repo's own test commands; reports real output.",
    instructions: testerInstructions,
  },
  {
    key: "planner",
    name: "Planner",
    description:
      "Turns a request into small, ordered, revertable steps, each with acceptance criteria and its risks called out.",
    instructions: plannerInstructions,
  },
  {
    key: "researcher",
    name: "Researcher",
    description:
      "Answers a question from primary sources, citing links or file:line, and keeps verified facts apart from inference.",
    instructions: researcherInstructions,
  },
]

/**
 * The fields a new skill starts from when created from a preset. If the
 * workspace already has a skill with the preset's name (names are unique per
 * workspace), the copy gets a numbered suffix.
 */
export function skillDraftFromPreset(
  preset: SkillPreset,
  existingNames: readonly string[]
): { name: string; description: string; instructions: string } {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()))
  let name = preset.name
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    name = `${preset.name} ${n}`
  }
  return {
    name,
    description: preset.description,
    instructions: preset.instructions.trim(),
  }
}
