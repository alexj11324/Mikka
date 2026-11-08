import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudModelSupport, cloudTemplateModels, cloudTemplateOrigin, threadMachineTemplateKind } from './cloud-template-models'
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
test('all credential models need only the measured installed Agent', () => {
  assert.equal(cloudModelSupport(subscription, 'task', env), 'ready')
  assert.equal(cloudModelSupport({ ...subscription, model: 'unreported' }, 'task', env), 'ready')
  assert.equal(cloudModelSupport({ ...subscription, model: 'provider-model', source: { kind: 'api_key', keyId: 'fixture' } }, 'task', env), 'ready')
  const missing = { ...catalogue, templates: { ...catalogue.templates, desktop: { templateId: 'desktop1', models: [report('codex')] } } }
  assert.equal(cloudModelSupport(subscription, 'desktop', { ...env, MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify(missing) }), 'cloudModelNotReported')
  assert.equal(cloudModelSupport(subscription, 'task', { ...env, MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify(missing) }), 'ready')
})

const additive = { ...catalogue, templates: Object.fromEntries(Object.entries(catalogue.templates)
  .map(([kind, row]) => [kind, { ...row, baseTemplate: kind, preinstalled: true }])) }
const additiveEnv = { ...env, MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify(additive) }
test('only an exact additive catalogue identifies a preinstalled runtime', () => {
  assert.deepEqual(cloudTemplateOrigin('claude1', additiveEnv), { kind: 'claude', preinstalled: true })
  assert.deepEqual(cloudTemplateOrigin('desktop', {}), { kind: 'desktop', preinstalled: false })
  assert.equal(cloudTemplateOrigin('claude1', env), null, 'legacy model metadata is not release provenance')
  assert.equal(cloudTemplateOrigin('arbitrary-image', additiveEnv), null)
  assert.equal(cloudTemplateOrigin('claude1', { ...additiveEnv, MIKKA_CLOUD_WORKER_SHA: 'b'.repeat(40) }), null)
  const sourceCommit = 'c'.repeat(40)
  const withSource = { ...additiveEnv, MIKKA_CLOUD_WORKER_SOURCE_COMMIT: sourceCommit,
    MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify({ ...additive, sourceCommit }) }
  assert.deepEqual(cloudTemplateOrigin('claude1', withSource), { kind: 'claude', preinstalled: true })
  assert.equal(cloudTemplateOrigin('claude1', { ...withSource, MIKKA_CLOUD_WORKER_SOURCE_COMMIT: 'd'.repeat(40) }), null)
  const wrongBase = structuredClone(additive)
  wrongBase.templates.claude.baseTemplate = 'codex'
  assert.equal(cloudTemplateModels({ ...env, MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify(wrongBase) }), null)
  const partial = structuredClone(additive)
  delete (partial.templates.claude as { preinstalled?: boolean }).preinstalled
  assert.equal(cloudTemplateModels({ ...env, MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify(partial) }), null)
})
test('the previous release remains identifiable without accepting an unbound catalogue', () => {
  const rollbackEnv = { MIKKA_CLOUD_RUNTIME_PREVIOUS: JSON.stringify({ version: 1, configuration: additiveEnv }) }
  assert.deepEqual(cloudTemplateOrigin('codex1', rollbackEnv), { kind: 'codex', preinstalled: true })
  assert.equal(cloudTemplateOrigin('codex1', { MIKKA_CLOUD_RUNTIME_PREVIOUS: JSON.stringify({ version: 1,
    configuration: { ...additiveEnv, E2B_CODEX_TEMPLATE: 'different-image' } }) }), null)
})
test('retained task provenance survives release rotation and rejects mismatched official bases', () => {
  assert.equal(threadMachineTemplateKind({ snapshotId: 'retired-image', templateKind: 'claude' }, {}), 'claude')
  assert.equal(threadMachineTemplateKind({ snapshotId: 'retired-image' }, {}), null)
  assert.equal(threadMachineTemplateKind({ snapshotId: 'claude1' }, additiveEnv), 'claude')
  assert.equal(threadMachineTemplateKind({ snapshotId: 'claude', templateKind: 'codex' }, {}), null)
  assert.equal(threadMachineTemplateKind({ snapshotId: 'codex' }, {}), 'codex')
})
