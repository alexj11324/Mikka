import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { commandSchema, digest } from './contract'
import { score, SCORER, SCORER_DIGEST } from './scorer'
import { BASELINE, BENCHMARK_DIGEST, compareDocuments, createSkillCandidate, SKILL_PATH } from './regression'

test('feedback is a signal; silence and self-reported success never become independent truth', () => {
  assert.equal(score('positive', { verify: { status: 'passed' } }).outcome, 'unknown')
  assert.equal(score('unknown', null).outcome, 'unknown')
  assert.equal(score('negative', null).reason, 'untrusted_negative_feedback')
  assert.equal(score('unknown', { verify: { status: 'failed' } }).outcome, 'failure')
  assert.equal(score('unknown', { verify: 'failed' }).outcome, 'unknown')
  assert.equal(digest(SCORER), SCORER_DIGEST)
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }))
})

test('candidate only touches the allowlisted inactive Skill; benchmark and baseline stay fixed', async () => {
  assert.equal(await readFile(new URL('../../' + SKILL_PATH, import.meta.url), 'utf8'), BASELINE)
  const candidate = createSkillCandidate()
  assert.equal(candidate.path, SKILL_PATH)
  assert.equal(candidate.result.benchmarkDigest, BENCHMARK_DIGEST)
  assert.equal(candidate.result.noRegression, null)
  assert.equal(candidate.result.improved, null)
  assert.equal(candidate.result.status, 'pending')
  assert.equal(candidate.result.independentVerification, false)
  assert.equal(candidate.result.productionEligible, false)
  assert.equal(compareDocuments(BASELINE, 'exact command').noRegression, null)
  assert.equal(compareDocuments(BASELINE, BASELINE).improved, null)
  assert.equal(createSkillCandidate().diff, candidate.diff)
})

test('strict input forbids changing identity, target, scorer, budget, approval or benchmark', () => {
  const input = { action: 'propose', runId: '28d8a157-3a38-4a39-b4c8-4946950d5151' }
  for (const field of ['userId', 'workspaceId', 'path', 'content', 'scorer', 'threshold', 'cases', 'budget', 'approval'])
    assert.equal(commandSchema.safeParse({ ...input, [field]: 'injected' }).success, false)
})
