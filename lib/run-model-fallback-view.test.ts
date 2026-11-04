import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelFallbackRecordSchema, projectModelFallback, threadComposerHarness, type ModelFallbackRecord } from './run-model-fallback-view'

const sourceId = '10000000-0000-4000-8000-000000000001'
const retryId = '10000000-0000-4000-8000-000000000002'
const from = { harness: 'codex', model: 'fixture-first', source: 'api_key' } as const
const to = { harness: 'claude_code', model: 'fixture-next', source: 'subscription' } as const
const failure = { kind: 'balance', retryable: false, status: 402 }
const record: ModelFallbackRecord = {
  state: 'switched', fallback: 'balance', from, to, retryRunId: retryId,
  attempted: [encodeURIComponent('codex\u0000fixture-first\u000010000000-0000-4000-8000-000000000003')], nextDefinitionDigest: 'a'.repeat(64),
}

test('only a committed continuation within the same authorized chain is shown as switched', () => {
  const chain = new Set([sourceId, retryId])
  assert.equal(projectModelFallback(sourceId, { ...record, state: 'pending' }, failure, chain), null)
  assert.equal(modelFallbackRecordSchema.safeParse({ ...record, state: 'stopped' }).success, true)
  assert.equal(projectModelFallback(sourceId, { ...record, state: 'stopped' }, failure, chain), null, 'cancelled or obsolete recovery does not become a missing-model card')
  assert.equal(projectModelFallback(sourceId, record, failure, new Set([sourceId])), null)
  assert.equal(projectModelFallback(sourceId, record, failure, new Set([retryId])), null)
  assert.equal(projectModelFallback(sourceId, { ...record, to: undefined }, failure, chain), null)
  assert.deepEqual(projectModelFallback(sourceId, record, failure, chain), { runId: sourceId, state: 'switched', continuationRunId: retryId, from, to, failure: 'balance' })
})

test('the composer follows only a confirmed switch to its current live run', () => {
  const switched = projectModelFallback(sourceId, record, failure, new Set([sourceId, retryId]))!
  assert.equal(threadComposerHarness(from.harness, retryId, [switched]), to.harness,
    'the cross-harness continuation is the agent addressed by the composer')
  assert.equal(threadComposerHarness(from.harness, sourceId, [switched]), from.harness,
    'a source run is not relabelled as its continuation')
  const laterPickedId = '10000000-0000-4000-8000-000000000004'
  assert.equal(threadComposerHarness(from.harness, laterPickedId, [switched]), from.harness,
    'a later manually selected run does not inherit an ended switch label')
  assert.equal(threadComposerHarness(from.harness, retryId, []), from.harness,
    'a pending or unconfirmed receipt cannot change the label')
})

test('multiple switch notices cannot replace the current run with an unrelated historical target', () => {
  const laterId = '10000000-0000-4000-8000-000000000005'
  const chain = new Set([sourceId, retryId, laterId])
  const first = projectModelFallback(sourceId, record, failure, chain)!
  const second = projectModelFallback(retryId, { ...record, from: to, to: from, retryRunId: laterId }, failure, chain)!
  assert.equal(threadComposerHarness(from.harness, retryId, [first, second]), to.harness)
  assert.equal(threadComposerHarness(to.harness, laterId, [second, first]), from.harness,
    'the matching child id, not receipt array order, selects the displayed harness')
})

test('blocked and explicitly picked models keep the safe per-model reasons and setup actions', () => {
  const reasons = [{ choice: from, reason: 'balance' }, { choice: to, reason: 'paused' }]
  const card = { title: 'Fixture title', description: 'Fixture description', options: [{ value: 'models', label: 'Fixture setup', action: 'modelSettings' as const }] }
  for (const state of ['blocked', 'picked'] as const) {
    assert.deepEqual(projectModelFallback(sourceId, { state, fallback: 'unavailable', from, reasons, card }, { kind: 'auth', retryable: false }, new Set([sourceId])),
      { runId: sourceId, state, from, failure: 'auth', reasons, card })
  }
})

test('host receipt parsing rejects raw fields and malformed digests without exposing private receipt fields', () => {
  assert.equal(modelFallbackRecordSchema.safeParse(record).success, true, 'encoded entry keys preserve their separators without literal NUL in JSONB')
  assert.equal(modelFallbackRecordSchema.safeParse({ ...record, nextDefinitionDigest: 'not-a-digest' }).success, false)
  assert.equal(projectModelFallback(sourceId, { ...record, providerError: 'Bearer fixture-secret' }, failure, new Set([sourceId, retryId])), null)
  const view = projectModelFallback(sourceId, record, failure, new Set([sourceId, retryId]))!
  assert.equal('attempted' in view, false)
  assert.equal('nextDefinitionDigest' in view, false)
  assert.equal('retryRunId' in view, false)
})
