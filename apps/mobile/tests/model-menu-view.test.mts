import assert from 'node:assert/strict'
import test from 'node:test'
import { groupTitle, modelMenuLabel, modelStatusLine, type ModelMenu } from '../lib/model-menu-view.ts'

const current: ModelMenu['current'] = { id: 'fixture', modelId: 'fixture-model', provider: 'claude', kind: 'subscription', chosen: true, available: false, availability: 'checking', credentialLabel: 'owner@example.test' }

test('an unknown allowance stays selected and reads checking, not unavailable', () => {
  const label = modelMenuLabel(current)
  assert.match(label, /待检查/)
  assert.doesNotMatch(label, /不可用/)
  assert.match(label, /owner@example.test/)
})
test('same-plan accounts and API keys have distinguishable headings', () => {
  const first = groupTitle({ kind: 'subscription', provider: 'claude', plan: 'Max', credentialLabel: 'first@example.test', options: [] })
  const second = groupTitle({ kind: 'subscription', provider: 'claude', plan: 'Max', credentialLabel: 'second@example.test', options: [] })
  assert.notEqual(first, second)
  assert.match(groupTitle({ kind: 'apiKey', credentialLabel: 'DeepSeek · ••••799e', options: [] }), /799e/)
})
test('a quota fallback names the selected key and its metered billing before sending', () => {
  const fallback: ModelMenu['current'] = { ...current, kind: 'apiKey', available: true, availability: 'available', credentialLabel: 'DeepSeek · ••••799e', fallback: 'quota', quota: { subscription: 'claude', plan: 'Max', resetsAt: null, fallback: { keyProvider: 'deepseek', keyName: 'DeepSeek', model: 'deepseek-chat' } } }
  assert.match(modelMenuLabel(fallback), /799e.*按量.*已切换/)
  assert.match(modelStatusLine(fallback) ?? '', /Claude Max.*额度用完.*API Key.*按 token 计费/)
})
test('a used-up subscription without a fallback never claims it switched to a paid key', () => {
  const exhausted: ModelMenu['current'] = { ...current, availability: 'exhausted', quota: { subscription: 'claude', plan: 'Max', resetsAt: null, fallback: null } }
  assert.match(modelStatusLine(exhausted) ?? '', /额度用完/)
  assert.doesNotMatch(modelStatusLine(exhausted) ?? '', /按 token 计费|改用/)
})
