import assert from 'node:assert/strict'
import test from 'node:test'
import { groupTitle, modelMenuLabel, modelStatusLine, type ModelMenu } from '../lib/model-menu-view.ts'

const current: ModelMenu['current'] = { id: 'fixture', modelId: 'fixture-model', provider: 'claude', kind: 'subscription', chosen: true, available: false, availability: 'checking', credentialLabel: 'owner@example.test' }

test('the collapsed chip names only the model while its allowance is checking', () => {
  assert.equal(modelMenuLabel(current), 'fixture-model')
})
test('same-plan accounts and API keys have distinguishable headings', () => {
  const first = groupTitle({ kind: 'subscription', provider: 'claude', plan: 'Max', credentialLabel: 'first@example.test', options: [] })
  const second = groupTitle({ kind: 'subscription', provider: 'claude', plan: 'Max', credentialLabel: 'second@example.test', options: [] })
  assert.notEqual(first, second)
  assert.match(groupTitle({ kind: 'apiKey', credentialLabel: 'DeepSeek · ••••799e', options: [] }), /799e/)
})
test('a quota fallback names the selected key and its metered billing before sending', () => {
  const fallback: ModelMenu['current'] = { ...current, kind: 'apiKey', available: true, availability: 'available', credentialLabel: 'DeepSeek · ••••799e', fallback: 'quota', quota: { subscription: 'claude', plan: 'Max', resetsAt: null, fallback: { keyProvider: 'deepseek', keyName: 'DeepSeek', model: 'deepseek-chat' } } }
  assert.equal(modelMenuLabel(fallback), 'fixture-model')
  assert.match(modelStatusLine(fallback) ?? '', /Claude Max.*额度用完.*799e.*API Key.*按 token 计费/)
})
test('a preference fallback keeps its credential and metered billing in the notice', () => {
  const fallback: ModelMenu['current'] = { ...current, kind: 'apiKey', available: true, availability: 'available', credentialLabel: 'DeepSeek · ••••799e', fallback: 'preference' }
  assert.equal(modelMenuLabel(fallback), 'fixture-model')
  assert.match(modelStatusLine(fallback) ?? '', /下一条使用 fixture-model.*799e.*按量.*已切换/)
})
test('a used-up subscription without a fallback never claims it switched to a paid key', () => {
  const exhausted: ModelMenu['current'] = { ...current, availability: 'exhausted', quota: { subscription: 'claude', plan: 'Max', resetsAt: null, fallback: null } }
  assert.match(modelStatusLine(exhausted) ?? '', /额度用完/)
  assert.doesNotMatch(modelStatusLine(exhausted) ?? '', /按 token 计费|改用/)
})
