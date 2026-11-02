import assert from 'node:assert/strict'
import test from 'node:test'
import { botModelChoice, groupBotModels, modelProvider, selectedBotModel } from './execution-settings-view'

test('the provider mark follows the model id, then the account or harness', () => {
  assert.equal(modelProvider('claude-opus-4-5'), 'claude')
  assert.equal(modelProvider('sonnet'), 'claude')
  assert.equal(modelProvider('gpt-5'), 'openai')
  assert.equal(modelProvider('o3'), 'openai')
  assert.equal(modelProvider('dynamic-model', 'codex'), 'openai')
  assert.equal(modelProvider('dynamic-model', 'claude'), 'claude')
  assert.equal(modelProvider('dynamic-model', 'claude_code'), 'claude')
  assert.equal(modelProvider('composer-1', 'cursor'), 'unknown')
})

test('bot models group by account and list a copied binding once', () => {
  const rows = [
    { bindingId: 'b1', consumerId: 'bot-a', modelId: 'm1', route: 'claude_cpa', connectionId: 'c1', provider: 'claude' },
    { bindingId: 'b2', consumerId: 'bot-b', modelId: 'm1', route: 'claude_cpa', connectionId: 'c1', provider: 'claude' },
    { bindingId: 'b3', consumerId: 'bot-a', modelId: 'm2', route: 'codex_cpa', connectionId: 'c2', provider: 'codex' },
  ]
  const accounts = groupBotModels(rows)
  assert.deepEqual(accounts.map(account => [account.connectionId, account.models.map(model => model.bindingId)]), [['c1', ['b1']], ['c2', ['b3']]])
  assert.equal(selectedBotModel(rows, 'b2')?.key, accounts[0].models[0].key)
  assert.equal(selectedBotModel(rows, null), null)
  assert.equal(selectedBotModel(rows, 'gone'), null)
})

test('a Bot with no saved model shows the Claude account first, then ChatGPT', () => {
  const rows = [
    { bindingId: 'b3', consumerId: 'bot-a', modelId: 'm2', route: 'codex_cpa', connectionId: 'c2', provider: 'codex' },
    { bindingId: 'b1', consumerId: 'bot-a', modelId: 'm1', route: 'claude_cpa', connectionId: 'c1', provider: 'claude' },
  ]
  assert.equal(botModelChoice(rows, null)?.modelId, 'm1')
  assert.equal(botModelChoice(rows, 'b3')?.modelId, 'm2')
  assert.equal(botModelChoice(rows.slice(0, 1), null)?.modelId, 'm2')
  assert.equal(botModelChoice([], null), null)
})
