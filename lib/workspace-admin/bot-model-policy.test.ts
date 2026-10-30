import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedModelsOf, bindingProvider, botModelRefusalText, parseBotModelRefusal, botSettingsInput, chooseBotModelSource, modelPolicyInput, resolveBotModel, resolveBotRepository, selectableModels } from './bot-model-policy'

test('allowlist: null allows every family; stored lists come back in menu order without unknown values', () => {
  assert.deepEqual(allowedModelsOf(null), ['mikka', 'codex', 'claude'])
  assert.deepEqual(allowedModelsOf(['claude', 'mikka']), ['mikka', 'claude'])
  assert.deepEqual(allowedModelsOf(['gpt-x', 'codex']), ['codex'])
})

test('a bot keeps its allowed model; a disallowed one falls back to the starting model, then the first allowed', () => {
  assert.deepEqual(resolveBotModel({ model: 'codex', allowedModels: ['mikka', 'codex'], startingModel: 'mikka' }), { model: 'codex', unavailable: false })
  assert.deepEqual(resolveBotModel({ model: 'claude', allowedModels: ['mikka', 'codex'], startingModel: 'codex' }), { model: 'codex', unavailable: true })
  assert.deepEqual(resolveBotModel({ model: 'claude', allowedModels: ['codex'], startingModel: null }), { model: 'codex', unavailable: true })
  // A starting model that is itself no longer allowed is skipped.
  assert.deepEqual(resolveBotModel({ model: 'claude', allowedModels: ['codex'], startingModel: 'mikka' }), { model: 'codex', unavailable: true })
  // Nothing chosen yet is not "unavailable".
  assert.deepEqual(resolveBotModel({ model: null, allowedModels: ['mikka', 'claude'], startingModel: 'claude' }), { model: 'claude', unavailable: false })
})

test('a repository counts only while it is installed', () => {
  assert.deepEqual(resolveBotRepository('acme/app', ['acme/app']), { repository: 'acme/app', unavailable: false })
  assert.deepEqual(resolveBotRepository('acme/gone', ['acme/app']), { repository: null, unavailable: true })
  assert.deepEqual(resolveBotRepository(null, []), { repository: null, unavailable: false })
})

test('policy input: at least one known family, no duplicates; bot input: uuid and known model', () => {
  assert.ok(modelPolicyInput.safeParse({ allowedModels: ['mikka'], startingModel: null }).success)
  assert.ok(!modelPolicyInput.safeParse({ allowedModels: [], startingModel: null }).success)
  assert.ok(!modelPolicyInput.safeParse({ allowedModels: ['mikka', 'mikka'], startingModel: null }).success)
  assert.ok(!modelPolicyInput.safeParse({ allowedModels: ['gpt-x'], startingModel: null }).success)
  assert.ok(!modelPolicyInput.safeParse({ allowedModels: ['mikka'], startingModel: null, defaultRepository: 'a/b' }).success, 'no admin default repository')
  const botId = '00000000-0000-4000-8000-000000000001'
  assert.ok(botSettingsInput.safeParse({ botId, model: 'codex', repository: null }).success)
  assert.ok(!botSettingsInput.safeParse({ botId: 'nope', model: 'codex' }).success)
  assert.ok(!botSettingsInput.safeParse({ botId, model: 'gpt-x' }).success)
})

test('a run uses the owner\'s model: hosted Mikka, that provider\'s binding, or a refusal; never another provider', () => {
  const base = { allowedModels: ['mikka', 'codex', 'claude'] as const, startingModel: null, definitionBinding: null, latestBindings: {}, subscriptionsRunnable: true }
  const all = [...base.allowedModels]
  assert.deepEqual(chooseBotModelSource({ ...base, allowedModels: all, storedModel: 'mikka' }), { family: 'mikka', source: undefined })
  assert.deepEqual(chooseBotModelSource({ ...base, allowedModels: all, storedModel: 'codex', latestBindings: { codex: 'b1', claude: 'b2' } }), { family: 'codex', source: { type: 'subscription', bindingId: 'b1' } })
  assert.deepEqual(chooseBotModelSource({ ...base, allowedModels: all, storedModel: 'codex', latestBindings: { claude: 'b2' } }), { family: 'codex', refused: 'binding_required' })
  assert.deepEqual(chooseBotModelSource({ ...base, allowedModels: all, storedModel: 'claude', subscriptionsRunnable: false }), { family: 'claude', refused: 'backend_unavailable' })
  // The definition's binding wins for its own provider; a choice of another provider ignores it.
  const definitionBinding = { id: 'd1', provider: 'claude' as const }
  assert.deepEqual(chooseBotModelSource({ ...base, allowedModels: all, storedModel: 'claude', definitionBinding, latestBindings: { claude: 'b2' } }), { family: 'claude', source: { type: 'subscription', bindingId: 'd1' } })
  assert.deepEqual(chooseBotModelSource({ ...base, allowedModels: all, storedModel: 'mikka', definitionBinding }), { family: 'mikka', source: undefined })
  // Never chosen: the definition's provider stands in for the choice.
  assert.deepEqual(chooseBotModelSource({ ...base, allowedModels: all, storedModel: null, definitionBinding }), { family: 'claude', source: { type: 'subscription', bindingId: 'd1' } })
  // Disallowed: falls back to the starting model.
  assert.deepEqual(chooseBotModelSource({ ...base, allowedModels: ['mikka', 'codex'], startingModel: 'codex', storedModel: 'claude', definitionBinding, latestBindings: { codex: 'b1' } }), { family: 'codex', source: { type: 'subscription', bindingId: 'b1' } })
})

test('routes map to providers; the menu offers only what can run here', () => {
  assert.deepEqual(['codex_cpa', 'openai_siwc', 'claude_cpa'].map(bindingProvider), ['codex', 'codex', 'claude'])
  assert.deepEqual(selectableModels(['mikka', 'codex', 'claude'], false), ['mikka'])
  assert.deepEqual(selectableModels(['codex', 'claude'], true), ['codex', 'claude'])
})

test('a refused turn round-trips through the stored error; other errors are not refusals', () => {
  assert.deepEqual(parseBotModelRefusal(botModelRefusalText('binding_required', 'codex')), { reason: 'binding_required', family: 'codex' })
  assert.deepEqual(parseBotModelRefusal(botModelRefusalText('backend_unavailable', null)), { reason: 'backend_unavailable', family: null })
  for (const other of [null, '', 'binding_required', 'botModel:other:codex', 'replyEmpty: the model returned no text']) assert.equal(parseBotModelRefusal(other), null, String(other))
})
