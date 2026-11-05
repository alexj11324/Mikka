import assert from 'node:assert/strict'
import { test } from 'node:test'
import { persistentReadData, persistentReadKey } from './cache-policy'

test('only known read keys with plain scope arguments are durable', () => {
  for (const key of ['settings:issue-prefix', 'preferences', ['issue', 'task'], ['issue-activity-versions', 'task'], ['issues', 'owner', 'workspace'], ['team-directory', null]]) assert.equal(persistentReadKey(key), true)
  for (const key of ['account:sessions', ['settings:api-keys', 'workspace'], ['settings:subscriptions', 'workspace'], ['settings:secrets', 'workspace'], ['versions', 'task'], ['document-sync', 'task', 1], ['issues', { token: 'private' }]]) assert.equal(persistentReadKey(key), false)
})

test('ordinary task documents and history summaries retain their exact hash-covered shape', () => {
  const content = { type: 'doc', attrs: { mikka: { labels: [{ name: 'Cache', color: 'blue' }], assignee: null } }, content: [{ type: 'paragraph', attrs: { textAlign: null }, content: [{ type: 'text', text: 'Ordinary task body' }] }] }
  const issue = { id: 'task', content, readVersion: 'a'.repeat(32) }
  const history = { version: 'b'.repeat(32), positions: [{ id: 'v1', version: 'c'.repeat(32) }], items: [{ id: 'v1', content: { type: 'doc', attrs: content.attrs } }] }
  assert.deepEqual(persistentReadData(['issue', 'task'], issue), issue)
  assert.deepEqual(persistentReadData(['issue-activity-versions', 'task'], history), history)
  assert.equal(persistentReadData('settings:issue-prefix', 'MK'), 'MK')
})

test('a modified task body or metadata is not persisted under its original version proof', () => {
  for (const attrs of [{ apiKey: 'opaque-value' }, { mikka: { approval: { parameters: { password: 'opaque-value' } } } }, { futureProviderPayload: { value: 'opaque-value' } }]) {
    const content = { type: 'doc', attrs, content: [{ type: 'text', text: 'required body' }] }
    assert.equal(persistentReadData(['issue', 'task'], { content, readVersion: 'a'.repeat(32) }), undefined)
    assert.equal(persistentReadData(['issue-activity-versions', 'task'], { version: 'a'.repeat(32), positions: [{ id: 'v1', version: 'b'.repeat(32) }], items: [{ id: 'v1', content }] }), undefined)
  }
})

test('credential-looking text rejects the whole record rather than removing required text', () => {
  for (const text of ['sk-proj-abcdefghijklmnopqrstuvwxyz123456', 'Bearer abcdefghijklmnopqrstuvwxyz', 'https://example.invalid/file?token=opaque-value', 'https://name:password@example.invalid/file']) {
    assert.equal(persistentReadData(['issue', 'task'], { content: { type: 'doc', content: [{ type: 'text', text }] }, readVersion: 'a'.repeat(32) }), undefined)
  }
})

test('no credential, key, approval parameters or monotonic request clock reach disk', () => {
  for (const field of ['token', 'accessToken', 'api_key', 'keyId', 'publicKey', 'sessionKey', 'credentials', 'password', 'approval']) {
    assert.equal(persistentReadData('preferences', { theme: 'dark', [field]: { value: 'opaque-value' } }), undefined)
  }
  const data = { items: [], live: { deadline: { at: '2026-11-05T00:00:00Z', afterMs: 1000 } }, requestedAt: 12345 }
  assert.deepEqual(persistentReadData(['issues', 'owner', 'workspace'], data), { items: [], live: data.live })
})

test('chat stores only the proven tail and safe activity labels; first read replays its previews', () => {
  const data = {
    cursor: 500, continuation: { after: 490, cursor: 500, prefix: 'a'.repeat(32) }, version: 'b'.repeat(32),
    working: true, streamRunId: 'active-run', requestedAt: 1234,
    items: [
      { position: 300, text: 'outside latest 200 rows' },
      { position: 301, text: 'safe preview', activity: { thought: true, tools: [{ call: 'call-1', name: 'read_file', state: 'done', at: 0, input: 'sensitive parameters', output: 'sensitive result', quote: 'sensitive request', keyId: 'private-reference' }] } },
      { position: 500, text: 'latest reply' },
      { position: 501, pending: true, text: 'optimistic message' },
    ],
  }
  const value = persistentReadData(['coordinator-chat', 'bot'], data) as typeof data
  assert.equal(value.working, false)
  assert.equal(value.streamRunId, undefined)
  assert.equal(value.requestedAt, undefined)
  assert.deepEqual(value.items.map(item => item.position), [301, 500])
  assert.deepEqual(value.items[0].activity, { thought: true, tools: [{ call: 'call-1', name: 'read_file', state: 'done', at: 0 }] })
  assert.deepEqual(value.continuation, data.continuation)
  assert.equal(data.items[1].activity?.tools[0].input, 'sensitive parameters', 'sanitizing must not mutate the live read model')
})
