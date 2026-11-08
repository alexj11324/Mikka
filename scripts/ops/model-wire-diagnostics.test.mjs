import test from 'node:test'
import assert from 'node:assert/strict'
import { installModelWireDiagnostics } from './model-wire-diagnostics.mjs'
const url = 'https://app.aspectlylabs.com/mikka/cloud/v1/models/chat/completions'
test('observe only wire structure while preserving exact request and response identities', async () => {
  const records = [], response = Promise.resolve(new Response('fixture')), calls = []
  const target = { fetch: (...args) => { calls.push(args); return response } }, original = target.fetch
  const restore = installModelWireDiagnostics(target, value => records.push(value))
  const secret = 'FIXTURE_BODY_AND_HEADER_MUST_NOT_LEAK'
  const init = { headers: { authorization: secret }, body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: secret }],
    tools: [{ type: 'function', function: { name: 'read_fixture', description: secret, parameters: { type: 'object', properties: {} } } }], stream: true, max_tokens: 4096 }) }
  assert.equal(target.fetch(url, init), response); assert.equal(calls[0][0], url); assert.equal(calls[0][1], init)
  assert.equal(records[0].toolCount, 1); assert.equal(records[0].messageCount, 1); assert.equal(records[0].maxTokens, 4096)
  assert.ok(!JSON.stringify(records).includes(secret)); assert.ok(!JSON.stringify(records).includes('read_fixture'))
  restore(); assert.equal(target.fetch, original)
})
test('OAuth secrets and foreign requests are never inspected', () => {
  const records = [], target = { fetch: () => 'original-result' }
  installModelWireDiagnostics(target, value => records.push(value))
  for (const path of ['https://app.aspectlylabs.com/mikka/cloud/oauth/token', 'https://foreign.example/mikka/cloud/v1/models/chat/completions']) {
    assert.equal(target.fetch(path, { body: 'credential' }), 'original-result')
  }
  assert.deepEqual(records, [])
})
test('a failing diagnostic writer cannot suppress the original request', () => {
  const target = { fetch: () => 'original-result' }
  installModelWireDiagnostics(target, () => { throw new Error('synthetic observer failure') })
  assert.equal(target.fetch(url, { body: '{}' }), 'original-result')
})
