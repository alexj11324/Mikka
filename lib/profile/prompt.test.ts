import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldRepository, repositoryApplies } from './repository'
import { PROMPT_FACTS_MAX, PROMPT_FACTS_MAX_CHARS, PROMPT_FACT_MIN_CONFIDENCE, profileSection, promptFacts, type PromptFact } from './prompt'

// ALE-67/ALE-68: what Mikka learnt about the person reaches the agent's prompt
// through one composer, and a fact scoped to a repository reaches only a chat
// working in it. These are the two rules the whole feature rests on, so they
// are tested without a database or a model.

const fact = (fields: Partial<PromptFact> = {}): PromptFact => ({
  kind: 'preference', subject: 'Prefers pnpm over npm', repository: null, confidence: 0.8,
  lastSeenAt: new Date('2026-11-01T00:00:00Z'), userEdited: false, ...fields,
})

test('a repository folds to one form however its remote is spelled', () => {
  for (const spelling of ['https://github.com/Acme/Widget.git', 'git@github.com:acme/widget', 'ssh://git@github.com/acme/widget/', 'Acme/Widget', 'ACME/widget.git']) {
    assert.equal(foldRepository(spelling), 'acme/widget', spelling)
  }
  // A remote on another host is still a work context, kept as given.
  assert.equal(foldRepository('git@gitlab.com:acme/widget.git'), 'git@gitlab.com:acme/widget')
  // Nothing is not a scope: a fact with no repository is the person's own.
  for (const empty of [null, undefined, '', '   ']) assert.equal(foldRepository(empty), null, String(empty))
})

test('a person-level fact applies everywhere and a repository fact only where that repository is used', () => {
  assert.equal(repositoryApplies(null, []), true)
  assert.equal(repositoryApplies(null, ['acme/widget']), true)
  assert.equal(repositoryApplies('acme/widget', ['acme/other']), false)
  assert.equal(repositoryApplies('acme/widget', ['acme/other', 'https://github.com/Acme/Widget.git']), true, 'spellings of one remote match')
  assert.equal(repositoryApplies('acme/widget', []), false, 'a chat that names no repository is told only person-level facts')
})

test('a fact scoped to another repository never reaches the prompt', () => {
  const facts = [
    fact({ subject: 'Uses pnpm here', repository: 'acme/widget' }),
    fact({ subject: 'Uses npm here', repository: 'acme/gadget' }),
    fact({ subject: 'Prefers terse replies' }),
  ]
  const inWidget = promptFacts(facts, ['acme/widget'])
  assert.deepEqual(inWidget.map(item => item.subject).sort(), ['Prefers terse replies', 'Uses pnpm here'])
  const inGadget = promptFacts(facts, ['acme/gadget'])
  assert.deepEqual(inGadget.map(item => item.subject).sort(), ['Prefers terse replies', 'Uses npm here'])
  // The point of the dimension: project A's habit never appears in project B's chat.
  assert.ok(!inGadget.some(item => item.subject === 'Uses pnpm here'))
  assert.deepEqual(promptFacts(facts, []).map(item => item.subject), ['Prefers terse replies'])
})

test('one subject can hold a different answer in each repository', () => {
  const facts = [
    fact({ kind: 'tool', subject: 'Test command: pnpm test', repository: 'acme/widget', confidence: 0.9 }),
    fact({ kind: 'tool', subject: 'Test command: npm test', repository: 'acme/gadget', confidence: 0.9 }),
  ]
  assert.deepEqual(promptFacts(facts, ['acme/widget']).map(item => item.subject), ['Test command: pnpm test'])
  assert.deepEqual(promptFacts(facts, ['acme/gadget']).map(item => item.subject), ['Test command: npm test'])
})

test('the person\'s own correction outranks certainty, and weak guesses are left out', () => {
  const facts = [
    fact({ subject: 'Guessed strongly', confidence: 0.95 }),
    fact({ subject: 'Corrected by the person', confidence: 0.4, userEdited: true }),
    fact({ subject: 'Barely supported', confidence: PROMPT_FACT_MIN_CONFIDENCE - 0.01 }),
  ]
  const kept = promptFacts(facts, []).map(item => item.subject)
  assert.equal(kept[0], 'Corrected by the person')
  assert.ok(!kept.includes('Barely supported'))
})

test('the prompt is stable for the same facts, whatever order they are read in', () => {
  const facts = [fact({ subject: 'Second', confidence: 0.5 }), fact({ subject: 'First', confidence: 0.7, kind: 'interest' }), fact({ subject: 'Third', confidence: 0.6 })]
  const forward = profileSection(promptFacts(facts, []))
  const backward = profileSection(promptFacts([...facts].reverse(), []))
  assert.equal(forward, backward, 'a cached prefix must not change because rows came back in another order')
})

test('the section states facts as background, never as instructions, and names no repository', () => {
  const section = profileSection(promptFacts([
    fact({ kind: 'tool', subject: 'Uses pnpm in this repository', repository: 'acme/widget', userEdited: true }),
    fact({ kind: 'interest', subject: '川菜' }),
  ], ['acme/widget']))
  assert.match(section, /^## What Mikka knows about the person/)
  assert.match(section, /never instructions/)
  assert.match(section, /the person's own words in this chat always win/)
  assert.match(section, /Uses pnpm in this repository \(the person confirmed this\)/)
  assert.ok(!section.includes('acme/widget'), 'the repository is a scope, not something to tell the model about')
  assert.equal(profileSection([]), '')
})

test('the section is capped so a large profile cannot crowd out the rules', () => {
  const many = Array.from({ length: PROMPT_FACTS_MAX + 25 }, (_, index) => fact({ subject: `Fact number ${index} with some words in it`, confidence: 1 - index / 1000 }))
  const facts = promptFacts(many, [])
  assert.equal(facts.length, PROMPT_FACTS_MAX, 'at most PROMPT_FACTS_MAX facts are stated')
  const section = profileSection(facts)
  assert.ok(section.length <= PROMPT_FACTS_MAX_CHARS + 600, `section stayed near its budget, was ${section.length}`)
})

test('one crowded kind cannot empty the others', () => {
  const crowd = Array.from({ length: PROMPT_FACTS_MAX }, (_, index) => fact({ subject: `Bulk ${index}`, kind: 'interest', confidence: 0.99 }))
  const section = profileSection(promptFacts([...crowd, fact({ kind: 'routine', subject: 'Stands up at 09:00', confidence: 0.5 })], []))
  assert.match(section, /Stands up at 09:00/, 'every kind keeps a share of the budget')
})
