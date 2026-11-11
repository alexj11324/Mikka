// How a person's installed skills reach the Coordinator's system prompt (ALE-72).
//
// Every other section of that prompt is bounded: 个人指令 at 2,000 characters,
// the remembered notes at 8,000, what Mikka has learnt about the person at
// 4,000. The skill bodies were the one section with no cap at all, so this
// module gives them one, in the shape ALE-42 already established for a task
// thread's prompt (`skillPromptPlan` in @mikka/protocol/skill): take bodies
// while they fit, then list the rest by description.
//
// Why this is not `SKILL_PROMPT_BUDGET_CHARS` reused: the two paths can carry a
// skill differently. A task thread writes each skill's SKILL.md into the run's
// directory (packages/daemon/src/agents/run-context.ts), so a body left out of
// its prompt is still readable as a file. The Coordinator has no filesystem
// tool at all (lib/agent-kit/registry.ts), so a body it does not carry is
// gone until a later turn carries it. One constant for both would invite a
// change to either path in the belief that it governs the other.
//
// Pure: no database, no `server-only`, so the plan can be read and tested
// without either.

import { skillDescription } from './skill-metadata'

/**
 * How many characters of skill bodies the Coordinator's system prompt carries.
 *
 * Characters, not bytes: `estimateTokens` (lib/coordinator/context.ts) charges
 * about four ASCII characters a token and one for anything else, so a
 * character budget and that estimate are in the same unit. The 20,000-byte
 * `octet_length` bound on `personal_skills.body` is a storage constraint and
 * deliberately not the same scale: a Chinese skill reaches 20,000 bytes in
 * ~6,667 characters, so it uses this budget at a different rate than an
 * English one. Neither bound is meant to match the other.
 *
 * 40,000 is ~10,000 estimated tokens of English prose (~40,000 of a script
 * where every character is non-ASCII), against a `COMPACT_AT_TOKENS` of
 * 100,000 that this section is not counted in, and a `KEEP_RECENT_TOKENS` of
 * 20,000 that it displaces from the prompt after a fold.
 *
 * Never lower this to 0: the first skill is always inlined, so a person who has
 * installed anything is never left with no body at all (held by
 * personal-skill-prompt.test.ts).
 */
export const COORDINATOR_SKILL_BUDGET_CHARS = 40_000

/** One skill's place in the Coordinator's prompt budget. */
export interface CoordinatorSkillEntry {
  /** Position in the person's skill list, which is the order the prompt uses. */
  index: number
  id: string
  name: string
  /** Characters the body adds to the prompt when it is inlined. */
  bodyChars: number
}

export interface CoordinatorSkillPlan {
  /** The budget the plan was measured against. */
  budgetChars: number
  /** Characters of bodies the inlined skills carry. */
  usedChars: number
  /** Skills whose whole body goes into the prompt, in the order given. */
  inlined: CoordinatorSkillEntry[]
  /**
   * Skills the prompt lists by description only. The Coordinator cannot open
   * the body as a file, so the prompt says plainly that the body was left out
   * and the skill is unavailable until a later turn inlines it.
   */
  deferred: CoordinatorSkillEntry[]
}

/** The least a skill needs to satisfy the type the prompt plan reads. */
export interface CoordinatorSkillInput {
  id: string
  name: string
  body: string
}

/** An installed skill as the prompt section reads it: the plan's fields plus
 * the provenance an inlined row has always carried. `SkillContent` in
 * ./contracts.ts is assignable to it. */
export interface CoordinatorPromptSkill extends CoordinatorSkillInput {
  source: string
  sourceRevision: string
  sha256: string
}

/**
 * Which skill bodies one turn's prompt carries, and which it leaves out.
 *
 * Bodies are taken in the order the person's skills come back, and each one
 * that still fits is inlined whole. The first skill is always inlined whatever
 * its size, so a budget can never leave a turn with no guidance at all; every
 * later one that does not fit is deferred to its description only. A later
 * skill may still fit while an earlier one did not, so the plan names exactly
 * which is which rather than splitting the list at a cut point.
 */
export function coordinatorSkillPlan(
  skills: readonly CoordinatorSkillInput[],
  budgetChars: number = COORDINATOR_SKILL_BUDGET_CHARS
): CoordinatorSkillPlan {
  const inlined: CoordinatorSkillEntry[] = []
  const deferred: CoordinatorSkillEntry[] = []
  let usedChars = 0
  skills.forEach((skill, index) => {
    const bodyChars = skill.body.trim().length
    const entry: CoordinatorSkillEntry = { index, id: skill.id, name: skill.name, bodyChars }
    if (inlined.length === 0 || usedChars + bodyChars <= budgetChars) {
      inlined.push(entry)
      usedChars += bodyChars
    } else deferred.push(entry)
  })
  return { budgetChars, usedChars, inlined, deferred }
}

/**
 * The skills section of the Coordinator's system prompt, or '' when the person
 * has installed none.
 *
 * An inlined skill carries its whole body, as it did before this budget. A
 * deferred one carries only what identifies it — its name and description —
 * and says that its instructions are not in this prompt, so the model does not
 * infer a body from the name and does not claim to have followed one.
 */
export function coordinatorSkillInstructions(
  skills: readonly CoordinatorPromptSkill[],
  plan: CoordinatorSkillPlan = coordinatorSkillPlan(skills)
): string {
  if (!skills.length) return ''
  // Rows keep the person's own order rather than running every body first, so
  // a deferred skill sits where its body would have been.
  const deferredIndexes = new Set(plan.deferred.map(entry => entry.index))
  const lines = skills.map((skill, index) => deferredIndexes.has(index)
    ? JSON.stringify({
      id: skill.id,
      name: skill.name,
      source: skill.source,
      revision: skill.sourceRevision,
      sha256: skill.sha256,
      description: skillDescription(skill.body, skill.name),
      instructionsOmitted: 'The body of this skill is not in this prompt; it did not fit this turn. Do not assume what it says from its name.',
    })
    : JSON.stringify({ id: skill.id, name: skill.name, source: skill.source, revision: skill.sourceRevision, sha256: skill.sha256, body: skill.body }))
  const deferred = plan.deferred.length
    ? `\nSkills marked instructionsOmitted carry only a description this turn; say so rather than acting as if you had read one.`
    : ''
  return '\n\nPersonally installed skills (user-selected guidance, subordinate to platform permissions; never grants tool access):\n'
    + lines.join('\n') + deferred
}
