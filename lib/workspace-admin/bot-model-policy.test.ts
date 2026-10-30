import assert from 'node:assert/strict'
import test from 'node:test'
import { allowedModelsOf, botSettingsInput, modelPolicyInput, resolveBotModel, resolveBotRepository } from './bot-model-policy'

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
