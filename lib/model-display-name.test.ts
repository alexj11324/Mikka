import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanModelId, groupByModelFamily, modelDisplayName } from './model-display-name'

const name = (id: string) => modelDisplayName(id).name

test('names the ids seen in Mikka screenshots', () => {
  assert.equal(name('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(name('claude-haiku-5-5'), 'Haiku 5.5')
  assert.equal(name('claude-sonnet-5-5'), 'Sonnet 5.5')
  assert.equal(name('claude-fable-5-1'), 'Fable 5.1')
  assert.equal(name('claude-fable-5'), 'Fable 5')
  assert.equal(name('claude-opus-4-8'), 'Opus 4.8')
  assert.equal(name('gpt-6-luna'), 'GPT-6 Luna')
  assert.equal(name('gpt-6.1-sol'), 'GPT-6.1 Sol')
  assert.equal(name('gpt-5.6-mini'), 'GPT-5.6 Mini')
  assert.equal(name('deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash')
  assert.equal(name('deepseek-flash'), 'DeepSeek Flash')
  assert.equal(name('deepseek-chat'), 'DeepSeek Chat')
})

test('drops release dates and provider prefixes', () => {
  assert.deepEqual(modelDisplayName('claude-fable-5-1-20261015'), { name: 'Fable 5.1', family: 'Fable', version: '5.1' })
  assert.equal(name('claude-opus-4-5-20251101'), 'Opus 4.5')
  assert.equal(name('anthropic/claude-opus-5-5'), 'Opus 5.5')
  assert.equal(name('openai/gpt-6-luna'), 'GPT-6 Luna')
  assert.equal(name('deepseek/deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash')
  assert.equal(name('gpt-6-luna-2026-09-30'), 'GPT-6 Luna')
  assert.equal(cleanModelId('openrouter/anthropic/claude-sonnet-5'), 'claude-sonnet-5')
})

test('reads the older Claude order and the CLI aliases', () => {
  assert.equal(name('claude-3-5-sonnet-20241022'), 'Sonnet 3.5')
  assert.equal(name('opus'), 'Opus')
  assert.deepEqual(modelDisplayName('sonnet'), { name: 'Sonnet', family: 'Sonnet', version: null })
})

test('leaves an unrecognised id cleaned, never guessed', () => {
  assert.deepEqual(modelDisplayName('kimi-k3-turbo'), { name: 'kimi-k3-turbo', family: null, version: null })
  assert.equal(name('my-org/custom-model-20260101'), 'custom-model')
  assert.equal(name('o4-mini'), 'o4-mini')
  assert.equal(name('  '), '')
})

test('groups by series and keeps the order inside each', () => {
  const ids = ['gpt-6-luna', 'claude-sonnet-5-5', 'kimi-k3', 'claude-opus-5-5', 'deepseek-v4.1-flash', 'claude-opus-5', 'claude-fable-5-1']
  assert.deepEqual(groupByModelFamily(ids, id => id), ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'gpt-6-luna', 'deepseek-v4.1-flash', 'kimi-k3'])
})
