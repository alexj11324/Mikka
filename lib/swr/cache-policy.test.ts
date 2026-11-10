import assert from 'node:assert/strict'
import { test } from 'node:test'
import { persistentReadData, persistentReadKey } from './cache-policy'
import { mergeChat } from '../coordinator/chat-poll'

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
})

test('issue prefix persists its actual read model with public team identifiers', () => {
  for (const teamKeys of [[], ['MIK', 'TEAM']]) {
    const data = { prefix: 'ALEX', saved: null, suggested: 'ALEX', teamKeys }
    assert.deepEqual(persistentReadData('settings:issue-prefix', data), data)
  }
  const unresolved = { prefix: null, saved: null, suggested: null, teamKeys: [] }
  assert.deepEqual(persistentReadData('settings:issue-prefix', unresolved), unresolved)
})

test('public team identifiers are allowed only in the exact issue prefix root field', () => {
  const data = { prefix: 'ALEX', saved: null, suggested: 'ALEX', teamKeys: ['MIK'] }
  assert.equal(persistentReadData('preferences', data), undefined)
  assert.equal(persistentReadData('settings:issue-prefix', { ...data, nested: { teamKeys: ['MIK'] } }), undefined)
  for (const teamKeys of [null, 'MIK', [1], ['MIK', 1], [['MIK']], [{ name: 'MIK' }]]) {
    assert.equal(persistentReadData('settings:issue-prefix', { ...data, teamKeys }), undefined)
  }
  for (const field of ['TeamKeys', 'teamKeysExtra', 'keyId', 'apiKey', 'token', 'credentials']) {
    assert.equal(persistentReadData('settings:issue-prefix', { ...data, [field]: 'opaque-value' }), undefined)
  }
})

test('issue prefix team identifiers still reject credential text and URLs', () => {
  for (const value of ['ghp_abcdefghijklmnopqrstuvwxyz', 'Bearer abcdefghijklmnopqrstuvwxyz', 'https://example.invalid/file?token=opaque-value', 'https://name:password@example.invalid/file']) {
    const data = { prefix: 'ALEX', saved: null, suggested: 'ALEX', teamKeys: ['MIK', value] }
    assert.equal(persistentReadData('settings:issue-prefix', data), undefined)
  }
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

test('stripped visible tool metadata retains the body continuation and requests a one-time repair', () => {
  const continuation = { after: 490, cursor: 500, prefix: 'a'.repeat(32) }
  for (const field of ['target', 'displayName', 'errorCode', 'errorDetail']) {
    const data = { cursor: 500, continuation, version: 'b'.repeat(32), items: [
      { position: 301, text: 'prefix', activity: { tools: [{ call: 'call-1', name: 'github_call', state: 'done', [field]: 'private-value' }] } },
      { position: 500, text: 'tail' },
    ] }
    const projected = persistentReadData(['coordinator-chat', 'bot'], data) as typeof data & { restoreToolMetadata?: true }
    assert.deepEqual(projected.continuation, continuation, `${field} does not invalidate the body proof`)
    assert.equal(projected.restoreToolMetadata, true)
    assert.ok(!JSON.stringify(projected).includes('private-value'))
    assert.equal(data.continuation, continuation, 'the live in-memory cursor is unchanged')
  }
})

test('a response-only metadata overlay cannot bypass the nested disk allowlist', () => {
  const data = { cursor: 2, continuation: { after: 1, cursor: 2, prefix: 'a'.repeat(32) }, items: [{ position: 1, text: 'safe' }],
    toolMetadata: { baseCursor: 2, prefix: 'a'.repeat(32), rows: [{ position: 1, parts: [{ target: 'private-target', operationName: 'private-operation' }] }] } }
  const projected = persistentReadData('coordinator-chat', data) as Record<string, unknown>
  assert.equal('toolMetadata' in projected, false)
  assert.equal(projected.restoreToolMetadata, true)
  assert.deepEqual(projected.continuation, data.continuation)
  assert.equal(JSON.stringify(projected).includes('private-'), false)
})

test('a complete chat keeps the server history boundary, including absent and null', () => {
  for (const boundary of [{}, { historyBefore: null }, { historyBefore: 0 }, { historyBefore: 77 }]) {
    const data = { ...boundary, cursor: 102, continuation: { after: 101, cursor: 102, prefix: 'a'.repeat(32) }, items: [
      { position: 101, text: 'First retained message' }, { position: 102, text: 'Latest message' },
    ] }
    const before = structuredClone(data)
    const projected = persistentReadData('coordinator-chat', data) as Record<string, unknown>
    assert.deepEqual(projected, { ...data, working: false })
    assert.equal(Object.hasOwn(projected, 'historyBefore'), Object.hasOwn(boundary, 'historyBefore'))
    assert.deepEqual(JSON.parse(JSON.stringify(projected)), { ...data, working: false }, 'disk round-trip preserves the server boundary')
    assert.deepEqual(data, before, 'projection leaves the live model unchanged')
  }
})

test('empty chat pages retain their server boundary without inventing an older page', () => {
  for (const boundary of [{}, { historyBefore: null }, { historyBefore: 12 }]) {
    for (const items of [[], [{ position: 0, pending: true }, { position: -1 }, { position: '1' }, null], [{ position: 299 }]]) {
      const data = { ...boundary, cursor: 500, items }
      const projected = persistentReadData(['coordinator-chat', 'bot'], data) as Record<string, unknown>
      assert.deepEqual(projected, { ...boundary, cursor: 500, items: [], working: false })
      assert.equal(Object.hasOwn(projected, 'historyBefore'), Object.hasOwn(boundary, 'historyBefore'))
    }
  }
})

test('dropping pending or invalid entries does not create chat history', () => {
  const kept = [{ position: 1, text: 'First message' }, { position: 2, text: 'Last message' }]
  for (const boundary of [{}, { historyBefore: null }]) {
    const data = { ...boundary, cursor: 2, items: [
      null, undefined, 'invalid', 0, { position: -1 }, { position: 0.5 }, { position: '0' },
      { position: Number.NaN }, { position: Number.POSITIVE_INFINITY }, { position: 0, pending: true }, ...kept,
    ] }
    assert.deepEqual(persistentReadData('coordinator-chat', data), { ...boundary, cursor: 2, items: kept, working: false })
  }
})

test('only discarded older stored messages advance the retained chat boundary', () => {
  const continuation = { after: 490, cursor: 500, prefix: 'a'.repeat(32) }
  for (const boundary of [{}, { historyBefore: null }, { historyBefore: 250 }]) {
    const data = { ...boundary, cursor: 500, continuation, items: [
      { position: 300 }, { position: 301 }, { position: 500 }, { position: 501, pending: true },
    ] }
    assert.deepEqual(persistentReadData('coordinator-chat', data), {
      ...data, items: [{ position: 301 }, { position: 500 }], historyBefore: 301, working: false,
    })
  }
  // A recovered older shape may omit cursor. The independent 200-item cap
  // still keeps its original order and supplies the remaining history edge.
  const items = Array.from({ length: 250 }, (_, index) => ({ position: index + 1 }))
  assert.deepEqual(persistentReadData('coordinator-chat', { items }), {
    items: items.slice(50), historyBefore: 51, working: false,
  })
})

test('unusual item order does not turn a kept or discarded newer item into older history', () => {
  const unordered = { cursor: 5, items: [{ position: 5 }, { position: 2 }] }
  assert.deepEqual(persistentReadData('coordinator-chat', unordered), { ...unordered, working: false })
  const items = [{ position: 500 }, { position: 5 }, { position: 2 }, ...Array.from({ length: 198 }, (_, index) => ({ position: index + 6 }))]
  assert.deepEqual(persistentReadData('coordinator-chat', { items, historyBefore: null }), {
    items: items.slice(1), historyBefore: null, working: false,
  })
})

test('a restored complete chat stays complete after the real tail merge', () => {
  const full = { version: 'b'.repeat(32), cursor: 2, continuation: { after: 1, cursor: 2, prefix: 'a'.repeat(32) }, sources: {}, artifacts: {}, items: [
    { position: 1, text: 'What should we review today?' },
    { position: 2, text: 'Review the desktop workspace, including conversations, tasks, artifacts and settings.' },
  ] }
  const restored = JSON.parse(JSON.stringify(persistentReadData(['coordinator-chat', 'bot'], full))) as typeof full & { historyBefore?: number; after?: number; baseCursor?: number }
  const next = { ...full, after: 1, baseCursor: 2, items: [full.items[1]] }
  const merged = mergeChat(restored, next)
  assert.ok(merged)
  assert.deepEqual(merged.items, full.items)
  assert.deepEqual(merged.continuation, full.continuation)
  assert.equal(merged.cursor, 2)
  assert.equal(merged.historyBefore, undefined, 'a successful tail read must not inherit a false Earlier messages boundary')
  const projectedAgain = persistentReadData(['coordinator-chat', 'bot'], merged) as Record<string, unknown>
  assert.equal(Object.hasOwn(projectedAgain, 'historyBefore'), false)
})
