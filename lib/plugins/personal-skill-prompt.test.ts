import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COORDINATOR_SKILL_BUDGET_CHARS,
  coordinatorSkillInstructions,
  coordinatorSkillPlan,
  type CoordinatorPromptSkill,
} from './skill-prompt'

// ALE-72: the Coordinator's system prompt carried every installed skill body
// with no cap, the one section of that prompt that had none. These hold the
// budget, its degradation order, and the upper bound on how large the section
// can get, so a later change cannot quietly hand the money back.

const skill = (over: Partial<CoordinatorPromptSkill> = {}): CoordinatorPromptSkill => ({
  id: '0199f000-0000-7000-8000-000000000001',
  name: 'Triage',
  source: 'example/skills',
  sourceRevision: 'a'.repeat(40),
  sha256: 'b'.repeat(64),
  body: 'Read the inbox, then label everything.',
  ...over,
})

/** Bodies of `count` skills, each `size` characters, with distinct names so a
 * deferred row is identifiable. */
function many(count: number, size: number, char = 'a'): CoordinatorPromptSkill[] {
  return Array.from({ length: count }, (_, index) => skill({
    id: `0199f000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    name: `skill-${index}`,
    body: char.repeat(size),
  }))
}

/** The same estimator the Coordinator's compaction uses (lib/coordinator/context.ts
 * estimateTokens), so this file's bound is in the unit the prompt is judged in. */
function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4) + other
}

test('the budget is the constant the module documents, not a second copy of ALE-42s', () => {
  assert.equal(COORDINATOR_SKILL_BUDGET_CHARS, 40_000)
})

test('skills that fit are inlined whole, in the order given', () => {
  const skills = many(3, 1_000)
  const plan = coordinatorSkillPlan(skills, 10_000)
  assert.deepEqual(plan.inlined.map(entry => entry.name), ['skill-0', 'skill-1', 'skill-2'])
  assert.deepEqual(plan.deferred, [])
  assert.equal(plan.usedChars, 3_000)
  // Never a truncated body: an inlined row carries exactly what was stored.
  for (const entry of plan.inlined) assert.equal(entry.bodyChars, 1_000)
})

test('a skill that does not fit is deferred to its description, not cut in half', () => {
  const skills = [skill({ name: 'small', body: 'a'.repeat(1_000) }), skill({ id: 'x', name: 'huge', body: 'b'.repeat(20_000) })]
  const plan = coordinatorSkillPlan(skills, 5_000)
  assert.deepEqual(plan.inlined.map(entry => entry.name), ['small'])
  assert.deepEqual(plan.deferred.map(entry => entry.name), ['huge'])

  const section = coordinatorSkillInstructions(skills, plan)
  assert.match(section, /"name":"small"/)
  assert.match(section, /"body":"a{1000}"/)
  // The deferred skill keeps its identity and description, and no body.
  assert.match(section, /"name":"huge"/)
  assert.match(section, /"instructionsOmitted":/)
  assert.doesNotMatch(section, /"body":"b/)
  // And the model is told what an omitted body means.
  assert.match(section, /carry only a description this turn/)
})

test('the cut is per skill, not a split of the list at one point', () => {
  // A skill too large for the room left is skipped, and a later smaller one may
  // still fit: the plan names exactly which is which (as ALE-42's does).
  const skills = [
    skill({ name: 'first', body: 'a'.repeat(600) }),
    skill({ id: 'y', name: 'too-large', body: 'b'.repeat(900) }),
    skill({ id: 'z', name: 'fits-again', body: 'c'.repeat(300) }),
  ]
  const plan = coordinatorSkillPlan(skills, 1_000)
  assert.deepEqual(plan.inlined.map(entry => entry.name), ['first', 'fits-again'])
  assert.deepEqual(plan.deferred.map(entry => entry.name), ['too-large'])
  assert.equal(plan.usedChars, 900)
})

test('rows keep the persons order, deferred ones where their body would have been', () => {
  const skills = [
    skill({ name: 'first', body: 'a'.repeat(600) }),
    skill({ id: 'y', name: 'too-large', body: 'b'.repeat(900) }),
    skill({ id: 'z', name: 'last', body: 'c'.repeat(300) }),
  ]
  const section = coordinatorSkillInstructions(skills, coordinatorSkillPlan(skills, 1_000))
  const order = section.split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line).name)
  assert.deepEqual(order, ['first', 'too-large', 'last'])
})

test('the first skill is always inlined, so no budget leaves a turn with no guidance', () => {
  // The negative case the budget must never produce: a person who installed
  // something is never left with zero bodies, however small the budget.
  const skills = [skill({ name: 'only', body: 'a'.repeat(20_000) }), skill({ id: 'z', name: 'second', body: 'b'.repeat(1_000) })]
  for (const budget of [1, 100, 0, -5]) {
    const plan = coordinatorSkillPlan(skills, budget)
    assert.equal(plan.inlined.length, 1, `budget ${budget} still inlines the first skill`)
    assert.equal(plan.inlined[0].name, 'only')
    assert.equal(plan.deferred.length, 1)
    const section = coordinatorSkillInstructions(skills, plan)
    assert.match(section, /"body":"a{20000}"/, `budget ${budget} keeps the first body whole`)
  }
})

test('no skills means no section at all', () => {
  assert.equal(coordinatorSkillInstructions([]), '')
  assert.equal(coordinatorSkillPlan([]).usedChars, 0)
})

test('the section stays under an upper bound at every install limit', () => {
  // The install rules (lib/plugins/store.ts, drizzle/...personal_plugins.sql):
  // at most 20 skills, at most 20,000 BYTES per body, 100,000 bytes in total.
  // Cost in tokens depends on the script, because estimateTokens charges one
  // token per non-ASCII character whatever its UTF-8 width: per 100,000 bytes
  // of storage, ASCII is ~25,000 tokens of prose and a 2-byte script is ~50,000.
  const cases: { label: string; char: string; bytesPerChar: number; ceiling: number }[] = [
    { label: 'ASCII', char: 'a', bytesPerChar: 1, ceiling: 27_000 },
    { label: '2-byte script (Greek/Cyrillic/Hebrew/Arabic)', char: '\u03b1', bytesPerChar: 2, ceiling: 52_000 },
    { label: 'CJK', char: '\u4e2d', bytesPerChar: 3, ceiling: 36_000 },
    { label: 'emoji', char: '\u{1f600}', bytesPerChar: 4, ceiling: 27_000 },
  ]
  for (const { label, char, bytesPerChar, ceiling } of cases) {
    // 20 rows is the count limit; per-body bytes = total / rows, capped at 20,000.
    const rows = 20
    const perSkillBytes = Math.min(20_000, Math.floor(100_000 / rows))
    const perSkillChars = Math.floor(perSkillBytes / bytesPerChar)
    const skills = many(rows, perSkillChars, char)
    const stored = skills.reduce((total, item) => total + Buffer.byteLength(item.body, 'utf8'), 0)
    assert.ok(stored <= 100_000, `${label}: ${stored} bytes is inside the install total`)

    const section = coordinatorSkillInstructions(skills, coordinatorSkillPlan(skills))
    const tokens = estimateTokens(section)
    assert.ok(tokens <= ceiling, `${label}: ${tokens} tokens exceeds the ${ceiling} ceiling`)

    // The budget holds: inlining stopped at the character budget.
    const plan = coordinatorSkillPlan(skills)
    assert.ok(plan.usedChars <= COORDINATOR_SKILL_BUDGET_CHARS, `${label}: usedChars ${plan.usedChars} is inside the budget`)
  }
})

test('the section cannot exceed the budget plus one whole body', () => {
  // The only row allowed past the budget is the first (a turn must keep some
  // guidance). Anything else that is inlined was measured against the budget.
  const skills = many(20, 5_000)
  const plan = coordinatorSkillPlan(skills)
  const beyondFirst = plan.inlined.slice(1).reduce((total, entry) => total + entry.bodyChars, 0)
  assert.ok(beyondFirst <= COORDINATOR_SKILL_BUDGET_CHARS)
  assert.ok(plan.usedChars <= COORDINATOR_SKILL_BUDGET_CHARS + 20_000)
})
