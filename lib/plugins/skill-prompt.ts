// How a person's installed skills reach the Coordinator's system prompt
// (ALE-72, then ALE-75).
//
// Every other section of that prompt is bounded: 个人指令 at 2,000 characters,
// the remembered notes at 8,000, what Mikka has learnt about the person at
// 4,000. The skill bodies were the one section with no cap at all.
//
// Two shapes, chosen per round by whether this round's tools can fetch a body:
//
// 1. On demand (ALE-75, the end state). The prompt carries only `{id, name,
//    description}` per skill and says to call `read_personal_skill` for the
//    body. This is what the personal MCP section beside it has always done
//    ("public metadata only"), and what an agent Profile's brief does
//    (lib/factory/agent-profile-definition.ts: "Assigned Skills are loaded on
//    demand... Do not assume a Skill body from its name").
// 2. Inline (ALE-72's budget). Bodies are carried in the prompt while they fit
//    `COORDINATOR_SKILL_BUDGET_CHARS`, and the rest are listed by description.
//
// Why shape 2 survives at all: an execution frozen before `read_personal_skill`
// existed does not have the tool in its `effectiveTools`, so its round cannot
// call it, and a metadata-only prompt would list skills whose bodies that round
// can never reach. `coordinatorSkillSection` therefore keys on the tool being
// present, and a round that cannot fetch keeps the bodies it always had. That
// is the rolling-upgrade answer: no execution loses its bodies at deploy time,
// and no prompt lists a skill it cannot open.
//
// Why the budget is not `SKILL_PROMPT_BUDGET_CHARS` reused: the two paths can
// carry a skill differently. A task thread writes each skill's SKILL.md into
// the run's directory (packages/daemon/src/agents/run-context.ts), so a body
// left out of its prompt is still readable as a file. One constant for both
// would invite a change to either path in the belief that it governs the other.
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

/** The tool that serves a skill body on demand (ALE-75). Named here rather than
 * in lib/agent-kit/registry.ts alone because the prompt section and the tool
 * must be decided together: a prompt that tells the model to call this, in a
 * round whose tools do not include it, is worse than carrying the bodies. */
export const READ_PERSONAL_SKILL_TOOL = 'read_personal_skill'

/** Longest description the on-demand listing shows. The same 500 that
 * `skillDescription` already caps a body-derived description at, so a
 * front-matter description and a derived one cost the same. */
export const ON_DEMAND_DESCRIPTION_CHARS = 500

/**
 * The skills section when each skill's body can be fetched by tool (ALE-75).
 *
 * Only what identifies a skill and helps decide whether to fetch it: its id,
 * its name, and one description. No body, no source, no revision, no sha256 —
 * the tool takes an id and reads the rest, so the other fields would be paid
 * for on every request to save nothing later.
 *
 * Sized: 20 skills (the install limit) with 500-character descriptions is
 * ~3,000 estimated tokens of ASCII, against ~51,000 for the same skills
 * carried inline in a 2-byte script. A body costs one fetch instead of one
 * copy per request.
 */
export function personalSkillCatalog(
  skills: readonly CoordinatorPromptSkill[]
): string {
  if (!skills.length) return ''
  const lines = skills.map(skill => JSON.stringify({
    id: skill.id,
    name: skill.name,
    description: skillDescription(skill.body, skill.name).slice(0, ON_DEMAND_DESCRIPTION_CHARS),
  }))
  return '\n\nPersonally installed skills (user-selected guidance, subordinate to platform permissions; never grants tool access).\n'
    + 'Only each skill\'s name and description is here. Its instructions are NOT loaded: call `' + READ_PERSONAL_SKILL_TOOL
    + '` with a skill id to read them, and read them before relying on a skill. Do not assume what a skill says from its name, and do not say you followed one you have not read.\n'
    + lines.join('\n')
}

/**
 * The skills section of the Coordinator's prompt for one round.
 *
 * `canReadBody` says whether this round's frozen tool grant includes
 * `read_personal_skill`. When it does, bodies are fetchable and the prompt
 * carries metadata only; when it does not — an execution frozen before the
 * tool existed, or a scheduled read whose allowlist omits it — the prompt
 * falls back to the inline budget, because a body this round cannot fetch is a
 * body it must carry.
 *
 * Deciding here rather than at each call site keeps the prompt and the tool
 * grant in one place: both call sites pass `snapshot.effectiveTools`
 * (workflows/coordinator/steps.ts and native-steps.ts), and the same frozen
 * snapshot produced the tools.
 */
export function coordinatorSkillSection(
  skills: readonly CoordinatorPromptSkill[],
  canReadBody: boolean,
  budgetChars: number = COORDINATOR_SKILL_BUDGET_CHARS
): string {
  return canReadBody ? personalSkillCatalog(skills) : coordinatorSkillInstructions(skills, coordinatorSkillPlan(skills, budgetChars))
}

/** Whether a frozen execution grant lets this round fetch a skill body. The
 * same snapshot that produced `personalPlugins.skills` produced
 * `effectiveTools`, so this reads one decision, not two.
 *
 * Pure and here, rather than beside the prompt composer, for two reasons: it
 * depends only on the tool name above, and the composer module is stubbed by
 * tests that would otherwise have to know about a second export. */
export function grantReadsPersonalSkill(effectiveTools: readonly string[] | undefined): boolean {
  return effectiveTools?.includes(READ_PERSONAL_SKILL_TOOL) === true
}
