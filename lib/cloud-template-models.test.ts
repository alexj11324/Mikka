import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudModelSupport, cloudTemplateModels } from './cloud-template-models'
const report = (harness: 'claude_code' | 'codex') => ({ harness, installed: true, version: null, models: ['fixture-slot'], modelSlots: [{ slot: 'fixture-slot', model: 'fixture-resolved', name: 'Fixture' }] })
const catalogue = { version: 1, workerSha: 'a'.repeat(40), templates: {
  desktop: { templateId: 'desktop1', models: [report('claude_code'), report('codex')] },
  claude: { templateId: 'claude1', models: [report('claude_code')] }, codex: { templateId: 'codex1', models: [report('codex')] },
} }
const env = { MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify(catalogue), MIKKA_CLOUD_WORKER_SHA: catalogue.workerSha, E2B_BYO_COMPUTER_TEMPLATE: 'desktop1', E2B_CLAUDE_TEMPLATE: 'claude1', E2B_CODEX_TEMPLATE: 'codex1' }
const subscription = { harness: 'claude_code' as const, model: 'fixture-resolved', source: { kind: 'subscription' as const, connectionId: 'fixture' } }
test('only a catalogue bound to all exact template IDs and worker hash is usable', () => {
  assert.ok(cloudTemplateModels(env))
  for (const key of ['MIKKA_CLOUD_TEMPLATE_MODELS','MIKKA_CLOUD_WORKER_SHA','E2B_CLAUDE_TEMPLATE','E2B_CODEX_TEMPLATE','E2B_BYO_COMPUTER_TEMPLATE']) {
    assert.equal(cloudTemplateModels({ ...env, [key]: 'changed' }), null, key)
    assert.equal(cloudModelSupport(subscription, 'task', { ...env, [key]: 'changed' }), 'cloudModelsUnknown')
  }
})
test('subscription matching uses CLI slots and resolved IDs; API keys need only the measured harness', () => {
  assert.equal(cloudModelSupport(subscription, 'task', env), 'ready')
  assert.equal(cloudModelSupport({ ...subscription, model: 'unreported' }, 'task', env), 'cloudModelNotReported')
  assert.equal(cloudModelSupport({ ...subscription, model: 'provider-model', source: { kind: 'api_key', keyId: 'fixture' } }, 'task', env), 'ready')
  const missing = { ...catalogue, templates: { ...catalogue.templates, desktop: { templateId: 'desktop1', models: [report('codex')] } } }
  assert.equal(cloudModelSupport(subscription, 'desktop', { ...env, MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify(missing) }), 'cloudModelNotReported')
  assert.equal(cloudModelSupport(subscription, 'task', { ...env, MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify(missing) }), 'ready')
})
