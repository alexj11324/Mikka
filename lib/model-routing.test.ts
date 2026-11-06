import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { validatedAnswers, type DecisionAnswer } from './coordinator/decision'
import { candidateForTier, escalateModelRouting, levelForScore, routingTaskContent, MODEL_ROUTING_EFFORTS, modelRoutingDiagnostics, modelTier, nearestEffort, ROUTING_MIN_CONFIDENCE, routingDecisionQuestions, selectModelRouting, supportedModelEfforts, type ModelRoutingCandidate, type ModelRoutingSnapshot, type ModelRoutingSnapshotV1 } from './model-routing.ts'

const candidate = (id: string, model: string, harness: ModelRoutingCandidate['harness'], position: number): ModelRoutingCandidate => ({
  id, model, harness, tier: modelTier(model), position, efforts: supportedModelEfforts(model, harness),
})
const strongest = candidate('candidate:0', 'claude-opus-5-5', 'claude_code', 0)
const light = candidate('candidate:1', 'claude-haiku-5-5', 'claude_code', 1)
const standard = candidate('candidate:2', 'claude-sonnet-5-5', 'claude_code', 2)
const luna = candidate('candidate:3', 'gpt-6-luna', 'codex', 3)
const sol = candidate('candidate:4', 'gpt-6.1-sol', 'codex', 4)
const catalog = [strongest, light, standard, luna, sol]
type Answers = Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>
const answers = (tier: number, effort: number | null = 0, confidence: { tier?: number; effort?: number } = {}): Answers => new Map([
  ['tier', { type: 'score', name: 'tier', score: tier, confidence: confidence.tier ?? .9 }],
  ...(effort === null ? [] : [['effort', { type: 'score', name: 'effort', score: effort, confidence: confidence.effort ?? .9 }] as const]),
] as [string, Exclude<DecisionAnswer, { type: 'refusal' }>][])

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

test('Decision asks two independent ordered scores and never sends candidates', () => {
  const questions = routingDecisionQuestions()
  assert.deepEqual(questions.map(question => [question.name, question.type]), [['tier', 'score'], ['effort', 'score']])
  const [tier, effort] = questions
  if (tier.type !== 'score' || effort.type !== 'score') throw Error('score expected')
  assert.deepEqual(tier.levels.map(level => level.label), ['light', 'standard', 'strongest'])
  assert.deepEqual(effort.levels.map(level => level.label), [...MODEL_ROUTING_EFFORTS])
  assert.ok(!JSON.stringify(questions).includes('candidate'))
})

test('the transport validates score answers against the question levels', () => {
  const questions = routingDecisionQuestions()
  const body = (tier: unknown, extra: Record<string, unknown> = {}) => ({ answers: [{ type: 'score', name: 'tier', score: tier, confidence: .8, ...extra }] })
  assert.equal(validatedAnswers(body(1.4), questions)?.get('tier')?.type, 'score')
  assert.ok(validatedAnswers(body(1.1, { probabilities: [{ value: 0, label: 'light', probability: .1 }, { value: 1, label: 'standard', probability: .7 }, { value: 2, label: 'strongest', probability: .2 }] }), questions))
  for (const invalid of [body(-0.1), body(2.01), body(Number.NaN), body('1'), body(1, { confidence: 1.2 }), body(1, { probabilities: [{ value: 3, probability: .5 }] }), body(1, { probabilities: [{ value: 0.5, probability: .5 }] }),
    { answers: [{ type: 'choice', name: 'tier', choice: 'light' }] }]) assert.equal(validatedAnswers(invalid, questions), null)
})

test('the rounded tier picks the first listed model of that tier, regardless of the list head', () => {
  const pick = (score: number) => selectModelRouting(catalog, answers(score, null))!
  assert.deepEqual(pick(0.2), { id: light.id, snapshot: { version: 2, required: 'light', model: light.model, harness: light.harness, tier: 'light', reason: 'difficulty_fit' } })
  assert.equal(pick(0.49).id, light.id)
  assert.equal(pick(0.5).id, standard.id)
  assert.equal(pick(1.49).id, standard.id)
  assert.equal(pick(1.1).id, standard.id)
  assert.equal(pick(1.6).id, strongest.id)
  assert.equal(selectModelRouting([sol, luna, strongest], answers(2, null))?.id, strongest.id)
})

test('scores round to the nearest level within bounds', () => {
  assert.deepEqual([0, .49, .5, 1.49, 1.5, 2].map(score => levelForScore(score, 3)), [0, 0, 1, 1, 2, 2])
  assert.deepEqual([3.4, 3.5, 4].map(score => levelForScore(score, 5)), [3, 4, 4])
})

test('the judge reads what must change, not process, acceptance or reporting sections', () => {
  const content = ['Intro line.', '## 现象', 'The list is unsorted.', '## 要做', '1. Sort by time.', '### 细节', 'Use createdAt.',
    '## 验收', 'Run pnpm test:local-loop.', '### 截图', 'Attach screenshots.', '## 汇报', 'Message the coordinator.', '## Rules', 'Never push to main.',
    '## 不在范围', 'Mobile.'].join('\n')
  assert.equal(routingTaskContent(content), ['Intro line.', '## 现象', 'The list is unsorted.', '## 要做', '1. Sort by time.', '### 细节', 'Use createdAt.',
    '## 不在范围', 'Mobile.'].join('\n'))
  assert.equal(routingTaskContent('No headings at all.'), 'No headings at all.')
  assert.equal(routingTaskContent(''), '')
})

test('a missing tier goes up, never down, and only falls lower when nothing higher can run', () => {
  assert.equal(candidateForTier([strongest, light], 'standard')?.id, strongest.id)
  assert.equal(candidateForTier([standard, light], 'strongest')?.id, standard.id)
  assert.equal(candidateForTier([light, luna], 'strongest')?.id, light.id)
  assert.equal(candidateForTier([], 'light'), undefined)
  const result = selectModelRouting([light, strongest], answers(1, null))!
  assert.deepEqual([result.id, result.snapshot.required, result.snapshot.tier], [strongest.id, 'standard', 'strongest'])
})

test('effort maps to the nearest level the selected model supports', () => {
  assert.equal(nearestEffort(MODEL_ROUTING_EFFORTS, 2.2), 'high')
  assert.equal(nearestEffort(MODEL_ROUTING_EFFORTS, 3.5), 'max')
  assert.equal(nearestEffort(['low', 'medium', 'high', 'xhigh'], 4), 'xhigh')
  assert.equal(nearestEffort(['low', 'high'], 1), 'high')
  assert.equal(nearestEffort([], 2), undefined)
  assert.equal(selectModelRouting(catalog, answers(2, 2.4))?.snapshot.effort, 'high')
  assert.equal(selectModelRouting(catalog, answers(2, 2.5))?.snapshot.effort, 'xhigh')
  assert.equal(selectModelRouting(catalog, answers(0, 0.3))?.snapshot.effort, 'low')
  const unknown = candidate('candidate:5', 'new-provider-model', 'codex', 5)
  const result = selectModelRouting([unknown], answers(1, 4))!
  assert.deepEqual([result.id, result.snapshot.reason], [unknown.id, 'difficulty_fit'])
  assert.ok(!Object.hasOwn(result.snapshot, 'effort'))
})

test('only an uncertain, missing or malformed tier keeps list order', () => {
  const below = ROUTING_MIN_CONFIDENCE - .001
  const low = selectModelRouting(catalog, answers(0, 0, { tier: below }))!
  assert.deepEqual(low, { id: strongest.id, snapshot: { version: 2, required: 'unknown', model: strongest.model, harness: strongest.harness, tier: 'strongest', reason: 'low_confidence' } })
  assert.equal(selectModelRouting(catalog, answers(0, 0, { tier: ROUTING_MIN_CONFIDENCE }))?.id, light.id)
  const tierless = answers(0); tierless.delete('tier')
  assert.equal(selectModelRouting(catalog, tierless)?.snapshot.reason, 'no_selection')
  for (const bad of [Number.NaN, -1, 2.5]) assert.equal(selectModelRouting(catalog, answers(bad))?.snapshot.reason, 'invalid_answer')
  for (const confidence of [Number.NaN, 1.01, -.1]) assert.equal(selectModelRouting(catalog, answers(0, 0, { tier: confidence }))?.snapshot.reason, 'invalid_answer')
  const choice: Answers = new Map([['tier', { type: 'choice', name: 'tier', choice: 'light' }]])
  assert.equal(selectModelRouting(catalog, choice)?.snapshot.reason, 'invalid_answer')
  assert.equal(selectModelRouting(catalog, null)?.snapshot.reason, 'decision_unavailable')
  assert.equal(selectModelRouting(catalog, null, { fallbackReason: 'list_order' })?.snapshot.reason, 'list_order')
  assert.equal(selectModelRouting([], answers(0)), null)
})

test('confidence combinations: effort never abandons the tier judgement', () => {
  const below = ROUTING_MIN_CONFIDENCE / 2, high = .9
  for (const tier of [below, high]) for (const effort of [below, high]) for (const effortScore of [2, Number.NaN, null]) {
    const answer = answers(2, effortScore, { tier, effort })
    const result = selectModelRouting(catalog, answer)!
    const label = JSON.stringify({ tier, effort, effortScore })
    if (tier === below) assert.deepEqual([result.id, result.snapshot.reason, result.snapshot.required], [strongest.id, 'low_confidence', 'unknown'], label)
    else assert.deepEqual([result.id, result.snapshot.reason, result.snapshot.required, result.snapshot.effort],
      [strongest.id, 'difficulty_fit', 'strongest', effort === high && effortScore === 2 ? 'high' : undefined], label)
  }
})

test('diagnostics carry scores, confidence and the outcome, never candidate IDs', () => {
  const answer = answers(1.2, 2.1, { effort: .1 })
  const diagnostics = modelRoutingDiagnostics(answer, selectModelRouting(catalog, answer))
  assert.deepEqual(diagnostics, { tier: { score: 1.2, confidence: .9 }, effort: { score: 2.1, confidence: .1, applied: false },
    required: 'standard', selectedTier: 'standard', reason: 'difficulty_fit' })
  const bad = answers(9, Number.NaN)
  assert.deepEqual(modelRoutingDiagnostics(bad, selectModelRouting(catalog, bad)), { tier: 'invalid', effort: 'invalid', required: 'unknown', selectedTier: 'strongest', reason: 'invalid_answer' })
  assert.deepEqual(modelRoutingDiagnostics(null, selectModelRouting(catalog, null)), { required: 'unknown', selectedTier: 'strongest', reason: 'decision_unavailable' })
  assert.ok(!JSON.stringify(diagnostics).includes('candidate:'))
})

test('toggle off ignores the Decision and follows the person\'s list position without mutation', () => {
  const shuffled = [luna, light, strongest, standard]
  const before = JSON.stringify(shuffled)
  const result = selectModelRouting(shuffled, answers(0), { enabled: false })!
  assert.deepEqual(result, { id: strongest.id, snapshot: { version: 2, required: 'unknown', model: strongest.model, harness: strongest.harness, tier: 'strongest', reason: 'list_order' } })
  assert.equal(JSON.stringify(shuffled), before)
})

const lightSnapshot: ModelRoutingSnapshot = { version: 2, required: 'light', model: light.model, harness: light.harness, tier: light.tier, effort: 'low', reason: 'difficulty_fit' }
test('a light failure goes to the nearest higher available tier, before an earlier strongest entry', () => {
  const result = escalateModelRouting(catalog, lightSnapshot)!
  assert.deepEqual(result, { id: standard.id, snapshot: { version: 2, required: 'light', model: standard.model, harness: standard.harness, tier: 'standard', effort: 'low', reason: 'escalated', previousModel: light.model } })
  assert.deepEqual(lightSnapshot, { version: 2, required: 'light', model: light.model, harness: light.harness, tier: 'light', effort: 'low', reason: 'difficulty_fit' })
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

test('a version-1 snapshot from before the tier judgement still escalates, with an unknown required tier', () => {
  const legacy: ModelRoutingSnapshotV1 = { version: 1, difficulty: 'easy', model: light.model, harness: light.harness, tier: 'light', effort: 'low', reason: 'difficulty_fit' }
  assert.deepEqual(escalateModelRouting(catalog, legacy)?.snapshot, { version: 2, required: 'unknown', model: standard.model, harness: standard.harness, tier: 'standard', effort: 'low', reason: 'escalated', previousModel: light.model })
})

test('the labeled routing set is well formed and each label is reachable through the host mapping', async () => {
  const { labeledExamples, summarize } = await import('../scripts/model-routing-calibration.ts')
  const examples = labeledExamples()
  assert.ok(examples.length >= 12)
  for (const tier of ['light', 'standard', 'strongest'] as const) assert.ok(examples.some(example => example.tier === tier), tier)
  for (const example of examples) {
    assert.ok(MODEL_ROUTING_EFFORTS.indexOf(example.effort[0]) <= MODEL_ROUTING_EFFORTS.indexOf(example.effort[1]), String(example.issue))
    const score = ['light', 'standard', 'strongest'].indexOf(example.tier)
    assert.equal(selectModelRouting(catalog, answers(score, null))?.snapshot.tier, example.tier)
  }
  const [all, , floor] = summarize([
    { issue: 1, expected: 'light', effortRange: ['low', 'medium'], tier: { score: .2, confidence: .9 }, effort: { score: 1, confidence: .9 } },
    { issue: 2, expected: 'strongest', effortRange: ['high', 'max'], tier: { score: .9, confidence: .25 } },
    { issue: 3, expected: 'standard', effortRange: ['medium', 'high'], unavailable: true },
  ])
  assert.deepEqual([all.routed, all.tierExact, floor.threshold, floor.routed, floor.tierAccuracy, floor.effortInRange], [2, 1, .3, 1, 1, 1])
})
