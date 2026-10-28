import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { BENCHMARK, BASELINE, compareDocuments, createSkillCandidate } from './regression'
import { createImprovementEvaluator, type ImprovementEvaluationDependencies, type TrustedSkillComparison } from './evaluation'
import { syntheticComparison, syntheticDecision } from './testing/evaluation-fixture'

const proposal = () => ({ id: randomUUID(), issueId: randomUUID(), candidate: createSkillCandidate() })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

test('keyword stuffing and the fixed guideline do not manufacture an improvement', async () => {
  const stuffed = 'Unrelated text: ' + BENCHMARK.cases.map(item => item.requires).join('; ')
  for (const content of [stuffed, BASELINE, createSkillCandidate().content]) {
    const result = compareDocuments(BASELINE, content)
    assert.equal(result.improved, null); assert.equal(result.noRegression, null)
    assert.equal(result.outcome, 'unknown'); assert.equal(result.status, 'pending')
  }
  const result = await createImprovementEvaluator()('synthetic-owner', proposal())
  assert.equal(result.status, 'pending'); assert.equal(result.execution, null)
})

test('unavailable collector/model and refusal never fall back to a keyword or human decision', async () => {
  let calls = 0
  const invokeDecision: ImprovementEvaluationDependencies['invokeDecision'] = async () => { calls++; return null }
  const cases: ImprovementEvaluationDependencies[] = [
    { invokeDecision },
    { loadComparison: async () => syntheticComparison() },
    { loadComparison: async () => null, invokeDecision },
    { loadComparison: async () => { throw Error('offline') }, invokeDecision },
    { loadComparison: async () => syntheticComparison(), invokeDecision },
    { loadComparison: async () => syntheticComparison(), invokeDecision: async () => { throw Error('timeout') } },
    { loadComparison: async () => syntheticComparison(), invokeDecision: async (...args) => ({ ...(await syntheticDecision()(...args))!, answers: new Map() }) },
    { loadComparison: async () => syntheticComparison(), invokeDecision: syntheticDecision('unknown') },
  ]
  for (const deps of cases) {
    const result = await createImprovementEvaluator(deps)('synthetic-owner', proposal())
    assert.equal(result.status, 'pending'); assert.equal(result.outcome, 'unknown'); assert.equal(result.improved, null)
  }
  assert.equal(calls, 1)
})

test('structured effect is a model choice bound to fixed outputs; confidence creates no extra approval', async () => {
  for (const [choice, improved, noRegression] of [['improved', true, true], ['not_improved', false, true], ['regressed', false, false]] as const) {
    for (const confidence of [undefined, 0]) {
      const result = await createImprovementEvaluator({ loadComparison: async () => syntheticComparison(), invokeDecision: syntheticDecision(choice, confidence) })('synthetic-owner', proposal())
      assert.equal(result.status, 'assessed'); assert.equal(result.improved, improved); assert.equal(result.noRegression, noRegression)
      assert.equal(result.outcome, choice); assert.equal(result.productionEligible, false); assert.equal(result.independentVerification, false)
      assert.ok(result.evidenceDigest); assert.equal(result.execution?.providerGenerationId, 'synthetic-generation')
    }
  }
})

test('all available pixel bytes are submitted with their bound run/case context; they do not attest understanding', async () => {
  const comparison = syntheticComparison()
  // Synthetic format-valid PNG header, not a genuine screenshot or visual acceptance.
  const bytes = Buffer.from('\x89PNG\r\n\x1a\nsynthetic', 'latin1')
  const dataUrl = 'data:image/png;base64,' + bytes.toString('base64')
  comparison.requiresVisual = true
  for (const side of [comparison.baseline, comparison.candidate]) side.images.push({ dataUrl, sha256: hash(bytes), capturedAt: side.finishedAt })
  let submitted = false
  const invokeDecision: ImprovementEvaluationDependencies['invokeDecision'] = async (...args) => {
    const input = args[1]; assert.ok(typeof input !== 'string')
    assert.equal(input.images?.length, 2); assert.ok(input.images?.every(image => image.dataUrl === dataUrl))
    assert.ok(input.text.includes(comparison.baseline.runId)); assert.ok(input.text.includes(comparison.candidate.sessionId))
    submitted = true
    return syntheticDecision('unknown')(...args)
  }
  const result = await createImprovementEvaluator({ loadComparison: async () => comparison, invokeDecision })('synthetic-owner', proposal())
  assert.equal(submitted, true); assert.equal(result.outcome, 'unknown'); assert.equal(result.improved, null)
  assert.equal(result.execution?.vision, 'image-input-submitted'); assert.equal(result.independentVerification, false)
})

test('collector provenance, immutable artifact bytes/version, fixed cases and visual requirements fail closed', async () => {
  const changes: ((e: TrustedSkillComparison) => void)[] = [
    e => { e.candidate.documentDigest = '0'.repeat(64) },
    e => { e.candidate.artifact.sha256 = '0'.repeat(64) },
    e => { e.candidate.artifact.versionId = e.baseline.artifact.versionId },
    e => { e.candidate.runId = e.baseline.runId },
    e => { e.candidate.sessionId = e.baseline.sessionId },
    e => { e.candidate.cases[0].output += 'altered bytes' },
    e => { e.candidate.cases[0] = e.candidate.cases[1] },
    e => { e.baseline.cases.pop() },
    e => { e.candidate.environment = 'other' },
    e => { e.requiresVisual = true },
    e => { e.candidate.finishedAt = new Date(Date.now() + 60000).toISOString() },
    e => { e.candidate.images.push({ dataUrl: 'https://untrusted.invalid/label.png', sha256: '0'.repeat(64), capturedAt: e.candidate.finishedAt }) },
  ]
  for (const change of changes) {
    const evidence = syntheticComparison(); change(evidence)
    let called = false
    const result = await createImprovementEvaluator({ loadComparison: async () => evidence, invokeDecision: async () => { called = true; return null } })('synthetic-owner', proposal())
    assert.equal(called, false); assert.equal(result.status, 'pending'); assert.equal(result.improved, null)
  }
})

test('forged/mismatched execution or malformed answer cannot become an effect judgment', async () => {
  for (const field of ['requestDigest', 'modelId', 'imageDigests', 'vision', 'providerGenerationId', 'executionId', 'completedAt', 'answer']) {
    const invokeDecision: ImprovementEvaluationDependencies['invokeDecision'] = async (...args) => {
      const result = (await syntheticDecision()(...args))!
      if (field === 'answer') result.answers.set('skill_effect', { type: 'choice', name: 'skill_effect', choice: 'approve_and_publish' })
      else Object.assign(result.execution, { [field]: field === 'imageDigests' ? ['forged'] : field === 'providerGenerationId' ? '' : 'forged' })
      return result
    }
    const result = await createImprovementEvaluator({ loadComparison: async () => syntheticComparison(), invokeDecision })('synthetic-owner', proposal())
    assert.equal(result.status, 'pending'); assert.equal(result.improved, null)
  }
})

test('altered candidate hashes or allowlisted path fail before calling collector/model', async () => {
  for (const patch of [{ path: '../permissions.ts' }, { candidateDigest: '0'.repeat(64) }, { baseline: 'changed scorer' }]) {
    const p = proposal(); Object.assign(p.candidate, patch)
    await assert.rejects(createImprovementEvaluator()('synthetic-owner', p), /sourceMismatch/)
  }
})
