import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { DecisionAnswer } from './coordinator/decision'
import { escalateModelRouting, MODEL_ROUTING_EFFORTS, modelTier, routingDecisionQuestions, selectModelRouting, supportedModelEfforts, type ModelRoutingCandidate, type ModelRoutingSnapshot } from './model-routing.ts'

const candidate = (id: string, model: string, harness: ModelRoutingCandidate['harness'], position: number): ModelRoutingCandidate => ({
  id, model, harness, tier: modelTier(model), position, efforts: supportedModelEfforts(model, harness),
})
const strongest = candidate('candidate:0', 'claude-opus-5-5', 'claude_code', 0)
const light = candidate('candidate:1', 'claude-haiku-5-5', 'claude_code', 1)
const standard = candidate('candidate:2', 'claude-sonnet-5-5', 'claude_code', 2)
const luna = candidate('candidate:3', 'gpt-6-luna', 'codex', 3)
const sol = candidate('candidate:4', 'gpt-6.1-sol', 'codex', 4)
const catalog = [strongest, light, standard, luna, sol]
type ChoiceAnswer = Extract<DecisionAnswer, { type: 'choice' }>
const answers = (model = light.id, difficulty = 'easy', effort = 'low', reason = 'difficulty_fit') => new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>(
  Object.entries({ difficulty, model, effort, reason }).map(([name, choice]) => [name, { type: 'choice', name, choice, confidence: .9 }]))
const withAnswer = (name: string, update: Partial<ChoiceAnswer>) => {
  const result = answers()
  result.set(name, { ...result.get(name), ...update } as ChoiceAnswer)
  return result
}

test('exact model tiers leave unknown versions and aliases at standard', () => {
  for (const model of ['claude-haiku-5-5', 'gpt-6-luna', 'deepseek-flash']) assert.equal(modelTier(model), 'light')
  for (const model of ['claude-opus-5-5', 'gpt-6.1-sol', 'gpt-6-astra']) assert.equal(modelTier(model), 'strongest')
  for (const model of ['claude-sonnet-5-5', 'unreported-opus', 'gpt-99-luna', 'constructor', '__proto__']) assert.equal(modelTier(model), 'standard')
})

test('offered efforts exist in the retained native capability reports and run protocol', () => {
  const claude = JSON.parse(readFileSync(new URL('../packages/daemon/test/fixtures/claude-code-2.1.309-initialize.json', import.meta.url), 'utf8'))
  for (const row of claude.response.response.models) {
    const offered = supportedModelEfforts(row.resolvedModel, 'claude_code')
    assert.ok(offered.length)
    for (const effort of offered) assert.ok(row.supportedEffortLevels.includes(effort))
  }
  const codex = JSON.parse(readFileSync(new URL('../packages/daemon/test/fixtures/codex-0.163.0-model-list.json', import.meta.url), 'utf8'))
  for (const row of codex.result.data) {
    const reported = row.supportedReasoningEfforts.map((item: { reasoningEffort: string }) => item.reasoningEffort)
    const offered = supportedModelEfforts(row.id, 'codex')
    assert.ok(offered.length)
    for (const effort of offered) assert.ok(reported.includes(effort) && MODEL_ROUTING_EFFORTS.includes(effort))
    assert.ok(!(offered as readonly string[]).includes('ultra'))
  }
  for (const [model, harness] of [['deepseek-flash', 'codex'], ['claude-haiku-5-5', 'codex'], ['gpt-6-luna', 'claude_code'], ['new-model', 'codex'], ['__proto__', 'claude_code']] as const) {
    assert.deepEqual(supportedModelEfforts(model, harness), [])
  }
})

test('Decision questions enumerate choices and never serialize a candidate credential', () => {
  const extra = { ...light, source: { connectionId: 'private-connection' }, ownerId: 'private-owner', deviceId: 'private-device' }
  const questions = routingDecisionQuestions([extra, sol])
  assert.deepEqual(questions.map(question => question.name), ['difficulty', 'model', 'effort', 'reason'])
  assert.ok(questions.every(question => question.type === 'choice'))
  const modelQuestion = questions[1]
  assert.equal(modelQuestion.type, 'choice')
  if (modelQuestion.type !== 'choice') throw Error('choice expected')
  assert.deepEqual(modelQuestion.choices.map(choice => choice.value), [light.id, sol.id, 'none'])
  assert.deepEqual(JSON.parse(modelQuestion.choices[0].description!), light)
  for (const hidden of ['private-connection', 'private-owner', 'private-device', 'connectionId', 'ownerId', 'deviceId']) assert.ok(!JSON.stringify(questions).includes(hidden))
  const efforts = questions[2]
  assert.equal(efforts.type, 'choice')
  if (efforts.type !== 'choice') throw Error('choice expected')
  assert.deepEqual(efforts.choices.map(choice => choice.value), ['default', 'low', 'medium', 'high', 'xhigh', 'max'])
})

test('easy work selects light with low effort, regardless of the strongest list head', () => {
  assert.deepEqual(selectModelRouting(catalog, answers()), {
    id: light.id,
    snapshot: { version: 1, difficulty: 'easy', model: light.model, harness: light.harness, tier: 'light', effort: 'low', reason: 'difficulty_fit' },
  })
  assert.equal(selectModelRouting(catalog, answers(luna.id))?.snapshot.model, 'gpt-6-luna')
})

test('hard work selects strongest and preserves its chosen reasoning effort', () => {
  const result = selectModelRouting(catalog, answers(sol.id, 'hard', 'high'))!
  assert.deepEqual([result.id, result.snapshot.difficulty, result.snapshot.tier, result.snapshot.effort], [sol.id, 'hard', 'strongest', 'high'])
  const medium = selectModelRouting(catalog, answers(standard.id, 'medium', 'medium'))!
  assert.deepEqual([medium.snapshot.tier, medium.snapshot.effort], ['standard', 'medium'])
})

test('the exact opaque candidate distinguishes the same model from two credentials', () => {
  const other = { ...light, id: 'candidate:5', position: 5 }
  const result = selectModelRouting([...catalog, other], answers(other.id))!
  assert.equal(result.id, other.id)
  assert.equal(result.snapshot.model, light.model)
  for (const unenumerated of ['claude-haiku-5-5', 'Haiku', 'candidate:99']) {
    const fallback = selectModelRouting([...catalog, other], answers(unenumerated))!
    assert.equal(fallback.id, strongest.id)
    assert.equal(fallback.snapshot.reason, 'invalid_answer')
  }
})

test('default effort sends no override, including for an unknown model', () => {
  const unknown = candidate('candidate:5', 'new-provider-model', 'codex', 5)
  const result = selectModelRouting([...catalog, unknown], answers(unknown.id, 'medium', 'default'))!
  assert.equal(result.snapshot.tier, 'standard')
  assert.equal(result.snapshot.difficulty, 'medium')
  assert.ok(!Object.hasOwn(result.snapshot, 'effort'))
  const effortQuestion = routingDecisionQuestions([unknown])[2]
  assert.equal(effortQuestion.type, 'choice')
  if (effortQuestion.type === 'choice') assert.deepEqual(effortQuestion.choices.map(choice => choice.value), ['default'])
})

test('tier and effort metadata never construct selectable models outside the host catalogue', () => {
  const empty = routingDecisionQuestions([]).find(question => question.name === 'model')!
  assert.equal(empty.type, 'choice')
  if (empty.type === 'choice') assert.deepEqual(empty.choices.map(choice => choice.value), ['none'])
  assert.equal(selectModelRouting([], answers()), null)
  const reported = candidate('candidate:0', 'only-reported-model', 'codex', 0)
  const question = routingDecisionQuestions([reported]).find(question => question.name === 'model')!
  assert.equal(question.type, 'choice')
  if (question.type === 'choice') {
    assert.deepEqual(question.choices.map(choice => choice.value), [reported.id, 'none'])
    assert.deepEqual(JSON.parse(question.choices[0].description!), reported)
  }
  assert.equal(reported.tier, 'standard')
  assert.deepEqual(reported.efforts, [])
  for (const unreported of [light.model, strongest.model, 'candidate:1']) {
    const result = selectModelRouting([reported], answers(unreported))!
    assert.equal(result.snapshot.model, reported.model)
    assert.equal(result.snapshot.reason, 'invalid_answer')
  }
  assert.equal(escalateModelRouting([reported], { version: 1, difficulty: 'medium', model: reported.model,
    harness: reported.harness, tier: reported.tier, reason: 'difficulty_fit' }), null)
})

test('effort must be supported by the selected model, not merely another candidate', () => {
  const restricted = { ...light, efforts: ['low'] as const }
  const unknown = candidate('candidate:5', 'new-provider-model', 'codex', 5)
  for (const answer of [answers(light.id, 'easy', 'max'), answers(light.id, 'easy', 'ultra'), answers(unknown.id, 'easy', 'low')]) {
    const result = selectModelRouting([strongest, restricted, unknown], answer)!
    assert.equal(result.id, strongest.id)
    assert.equal(result.snapshot.reason, 'invalid_answer')
    assert.equal(result.snapshot.difficulty, 'unknown')
    assert.ok(!Object.hasOwn(result.snapshot, 'effort'))
  }
})

for (const name of ['difficulty', 'model', 'effort', 'reason']) test(`confidence checks cover ${name}, including malformed numbers`, () => {
  assert.equal(selectModelRouting(catalog, withAnswer(name, { confidence: .549 }))?.snapshot.reason, 'low_confidence')
  assert.equal(selectModelRouting(catalog, withAnswer(name, { confidence: .55 }))?.id, light.id)
  assert.equal(selectModelRouting(catalog, withAnswer(name, { confidence: undefined }))?.id, light.id)
  for (const confidence of [Number.NaN, Infinity, -Infinity, -.1, 1.01]) {
    const result = selectModelRouting(catalog, withAnswer(name, { confidence }))!
    assert.equal(result.id, strongest.id)
    assert.equal(result.snapshot.reason, 'invalid_answer')
    assert.equal(result.snapshot.difficulty, 'unknown')
  }
})

test('none, refusals, missing answers and unrecognized values retain list order', () => {
  assert.equal(selectModelRouting(catalog, answers('none', 'easy', 'default', 'no_selection'))?.snapshot.reason, 'no_selection')
  assert.equal(selectModelRouting(catalog, answers(light.id, 'easy', 'low', 'no_selection'))?.snapshot.reason, 'no_selection')
  const missing = answers(); missing.delete('effort')
  const wrongType = answers(); wrongType.set('model', { name: 'model', type: 'predicate', probability: .99 })
  for (const answer of [missing, wrongType, answers(light.id, 'impossible'), answers(light.id, 'easy', 'low', 'I think this fits'), withAnswer('model', { name: 'another-question' })]) {
    const result = selectModelRouting(catalog, answer)!
    assert.equal(result.id, strongest.id)
    assert.equal(result.snapshot.reason, 'invalid_answer')
  }
  assert.equal(selectModelRouting(catalog, null)?.snapshot.reason, 'decision_unavailable')
  assert.equal(selectModelRouting(catalog, null, { fallbackReason: 'list_order' })?.snapshot.reason, 'list_order')
  assert.equal(selectModelRouting([], answers()), null)
})

test('toggle off ignores the Decision and follows the person\'s list position without mutation', () => {
  const shuffled = [luna, light, strongest, standard]
  const before = JSON.stringify(shuffled)
  const result = selectModelRouting(shuffled, answers(luna.id), { enabled: false })!
  assert.deepEqual(result, { id: strongest.id, snapshot: { version: 1, difficulty: 'unknown', model: strongest.model, harness: strongest.harness, tier: 'strongest', reason: 'list_order' } })
  assert.equal(JSON.stringify(shuffled), before)
})

const lightSnapshot: ModelRoutingSnapshot = { version: 1, difficulty: 'easy', model: light.model, harness: light.harness, tier: light.tier, effort: 'low', reason: 'difficulty_fit' }
test('a light failure goes to the nearest higher available tier, before an earlier strongest entry', () => {
  const result = escalateModelRouting(catalog, lightSnapshot)!
  assert.deepEqual(result, { id: standard.id, snapshot: { version: 1, difficulty: 'easy', model: standard.model, harness: standard.harness, tier: 'standard', effort: 'low', reason: 'escalated', previousModel: light.model } })
  assert.deepEqual(lightSnapshot, { version: 1, difficulty: 'easy', model: light.model, harness: light.harness, tier: 'light', effort: 'low', reason: 'difficulty_fit' })
})

test('escalation preserves list order inside a tier and never returns a lower or failed tier', () => {
  const next = { ...standard, id: 'candidate:6', position: 6 }
  assert.equal(escalateModelRouting([next, strongest, standard], lightSnapshot)?.id, standard.id)
  const strongestOnly = escalateModelRouting([sol, strongest, light], lightSnapshot)!
  assert.equal(strongestOnly.id, strongest.id)
  assert.equal(strongestOnly.snapshot.tier, 'strongest')
  assert.equal(escalateModelRouting(catalog, strongestOnly.snapshot), null)
  assert.equal(escalateModelRouting([light, luna], lightSnapshot), null)
  assert.equal(escalateModelRouting([], lightSnapshot), null)
})

test('escalation keeps an accepted effort only when the new model supports it', () => {
  const result = escalateModelRouting([{ ...standard, efforts: [] }], lightSnapshot)!
  assert.ok(!Object.hasOwn(result.snapshot, 'effort'))
  assert.equal(result.snapshot.reason, 'escalated')
  assert.equal(result.snapshot.previousModel, light.model)
})
