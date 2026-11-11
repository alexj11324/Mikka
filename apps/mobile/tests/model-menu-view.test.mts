import { mobileMessages } from '../lib/messages.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { groupTag, groupTitle, HOSTED_CHOICE, modelDisplayName, modelMenuLabel, modelSourceLabel, modelStatusLine, type ModelMenu } from '../lib/model-menu-view.ts'

const current: ModelMenu['current'] = { id: 'fixture', modelId: 'fixture-model', provider: 'claude', kind: 'subscription', chosen: true, available: false, availability: 'checking', credentialLabel: 'owner@example.test' }

test('the collapsed chip names only the model while its allowance is checking, and nothing sits above the composer', () => {
  assert.equal(modelMenuLabel(current), 'Fixture Model')
  assert.equal(modelStatusLine(current), null)
  assert.equal(modelStatusLine({ ...current, available: true, availability: 'available' }), null)
})
test('model ids read as people write them', () => {
  for (const [id, name] of [['gpt-6-luna', 'GPT-6 Luna'], ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5'], ['deepseek-flash', 'DeepSeek Flash'],
    ['kimi-k2', 'Kimi K2'], ['gpt-4o', 'GPT-4o'], ['gpt-5.1-codex', 'GPT-5.1 Codex'], ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'], ['o3', 'o3'], ['Some Model', 'Some Model']]) {
    assert.equal(modelDisplayName(id), name)
  }
})
test('a model that cannot run says so and offers 换模型', () => {
  assert.deepEqual(modelStatusLine({ ...current, availability: undefined }), { line: '这个模型现在用不了', change: true })
})
test('same-plan accounts and API keys have distinguishable headings', () => {
  const first = groupTitle({ kind: 'subscription', provider: 'claude', plan: 'Max', credentialLabel: 'first@example.test', options: [] })
  const second = groupTitle({ kind: 'subscription', provider: 'claude', plan: 'Max', credentialLabel: 'second@example.test', options: [] })
  assert.notEqual(first, second)
  assert.match(groupTitle({ kind: 'apiKey', credentialLabel: 'DeepSeek · ••••799e', options: [] }), /799e/)
})
test('a quota fallback names the selected key and its metered billing before sending', () => {
  const fallback: ModelMenu['current'] = { ...current, kind: 'apiKey', available: true, availability: 'available', credentialLabel: 'DeepSeek · ••••799e', fallback: 'quota', quota: { subscription: 'claude', plan: 'Max', resetsAt: null, fallback: { keyProvider: 'deepseek', keyName: 'DeepSeek', model: 'deepseek-chat' } } }
  assert.equal(modelMenuLabel(fallback), 'Fixture Model')
  assert.match(modelStatusLine(fallback)?.line ?? '', /Claude Max.*额度用完.*799e.*API Key.*按 token 计费/)
  assert.equal(modelStatusLine(fallback)?.change, false)
})
test('a preference fallback keeps its credential and metered billing in the notice', () => {
  const fallback: ModelMenu['current'] = { ...current, kind: 'apiKey', available: true, availability: 'available', credentialLabel: 'DeepSeek · ••••799e', fallback: 'preference' }
  assert.equal(modelMenuLabel(fallback), 'Fixture Model')
  assert.match(modelStatusLine(fallback)?.line ?? '', /下一条改用 Fixture Model.*799e.*按量/)
})
test('a used-up subscription without a fallback never claims it switched to a paid key', () => {
  const exhausted: ModelMenu['current'] = { ...current, availability: 'exhausted', quota: { subscription: 'claude', plan: 'Max', resetsAt: null, fallback: null } }
  assert.match(modelStatusLine(exhausted)?.line ?? '', /额度用完/)
  assert.doesNotMatch(modelStatusLine(exhausted)?.line ?? '', /按 token 计费|改用/)
  assert.equal(modelStatusLine(exhausted)?.change, true)
})

test('cloud hosted choices identify Mikka Cloud credits while self-hosted and older servers retain their own billing labels', () => {
  const hosted: ModelMenu['current'] = { id: HOSTED_CHOICE, modelId: '', provider: 'mikka', kind: 'hosted', available: true, chosen: true, hostedSource: 'cloud' }
  assert.equal(groupTag({ kind: 'hosted', hostedSource: 'cloud', options: [hosted] }), mobileMessages.Coordinator.modelPicker.cloudCredits)
  assert.equal(groupTag({ kind: 'hosted', hostedSource: 'self-hosted', options: [] }), mobileMessages.Coordinator.modelPicker.ownProvider)
  assert.equal(groupTag({ kind: 'hosted', options: [] }), '点数')
  assert.equal(modelMenuLabel(hosted), mobileMessages.Coordinator.modelPicker.hosted, 'the composer chip stays compact')
  assert.equal(modelSourceLabel(hosted), `${mobileMessages.Coordinator.modelPicker.hosted} · ${mobileMessages.Coordinator.modelPicker.cloudCredits}`)
})
