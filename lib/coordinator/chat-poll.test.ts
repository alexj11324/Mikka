import assert from 'node:assert/strict'
import test from 'node:test'
import { knownVersion, mergeChat, metadataEntities, METADATA_KEYS_MAX, refreshChatMetadata, type UnchangedChat } from './chat-poll'
import type { ChatToolMetadataRow } from './chat-tool-metadata'
import type { ChatView } from './store'

type Chat = { version?: string; streamRunId?: string; items: { position: number; text: string; pending?: true }[]; working: boolean; error: string | null; cursor?: number; botId: string; enabled: boolean; after?: number; baseCursor?: number }
const chat: Chat = { version: 'v1', streamRunId: 'wrun_old', items: [{ position: 1, text: 'hello' }], working: true, error: null, cursor: 4, botId: 'b', enabled: true }
const unchanged = (state: Partial<UnchangedChat> = {}): UnchangedChat => ({ unchanged: true, version: 'v1', cursor: 4, working: false, error: null, botId: 'b', enabled: true, ...state })

test('a read names the shown version until card metadata is marked stale; time alone never makes a read full', () => {
  assert.equal(knownVersion(undefined, false), undefined, 'the first read is full')
  assert.equal(knownVersion({}, false), undefined, 'a chat without a version is read in full')
  assert.equal(knownVersion(chat, false), 'v1', 'however long since the last full read')
  assert.equal(knownVersion(chat, true), undefined, 'refresh metadata while still sending the history continuation')
})

test('each artifact card listens on its own key, bounded and in a stable order', () => {
  assert.deepEqual(metadataEntities(undefined), [])
  const artifacts = Object.fromEntries(Array.from({ length: METADATA_KEYS_MAX + 5 }, (_, i) => [`a${String(i).padStart(3, '0')}`, {}]).reverse())
  const entities = metadataEntities({ artifacts })
  assert.equal(entities.length, METADATA_KEYS_MAX)
  assert.deepEqual(entities[0], { kind: 'artifact', id: 'a000' })
  assert.ok(entities.every(entity => entity.kind === 'artifact'))
})

test('an unchanged poll keeps the conversation and takes the live state', () => {
  assert.deepEqual(mergeChat(chat, unchanged()), { version: 'v1', items: chat.items, working: false, error: null, cursor: 4, botId: 'b', enabled: true },
    'the turn ended: no stream to follow')
  assert.equal(mergeChat(chat, unchanged({ streamRunId: 'wrun_new' }))?.streamRunId, 'wrun_new')
  assert.equal(mergeChat(chat, unchanged({ error: 'wake_failed' }))?.error, 'wake_failed')
  const full = { ...chat, version: 'v2', items: [...chat.items, { position: 5, text: 'reply' }] }
  assert.equal(mergeChat(chat, full), full, 'a changed chat replaces the shown one')
  const newer = { ...chat, version: 'v3' }
  assert.equal(mergeChat(newer, unchanged()), newer, 'a cache that moved on during the poll is kept')
})

test('a delta replaces the replayed tail and pending messages, without duplicating stored rows', () => {
  const previous: Chat = { ...chat, items: [...chat.items, { position: 4, text: 'tool running' }, { position: 5, text: 'pending', pending: true }] }
  const next: Chat = { ...chat, version: 'v2', cursor: 6, after: 3, baseCursor: 4, items: [{ position: 4, text: 'tool done and reply' }, { position: 6, text: 'stored' }] }
  assert.deepEqual(mergeChat(previous, next)?.items, [chat.items[0], ...next.items])
  assert.equal(mergeChat({ ...previous, cursor: 7 }, next)?.cursor, 7, 'an old response cannot overwrite newer cache data')
})

test('an unchanged transcript replaces reauthorized metadata, removing deleted and revoked cards', () => {
  const previous = { ...chat, sources: { private: { title: 'No longer shared' } }, artifacts: { deleted: { title: 'Removed' } } }
  const next = mergeChat(previous, unchanged({ metadata: { sources: {}, artifacts: {} } }))
  assert.ok(next)
  assert.equal(next.items, previous.items, 'unchanged message bodies are retained')
  assert.deepEqual(next.sources, {})
  assert.deepEqual(next.artifacts, {})
})

test('joined transcripts reauthorize held and new decorations separately, without mutating their shared result', async () => {
  const source = { kind: 'issue' as const, id: 'new', title: 'Shared task', number: null, identifier: null, status: 'todo', priority: 'normal' }
  const shared = Object.freeze({ ...chat, sources: Object.freeze({ new: source }), artifacts: Object.freeze({}) })
  const requests: { sourceIds: string[]; artifactIds: string[] }[] = []
  const held = { sourceIds: ['old', 'new'], artifactIds: ['removed'] }
  const first = await refreshChatMetadata(shared, held, async ids => { requests.push(ids); return { sources: { new: source }, artifacts: {} } })
  // Same body object, but the second request starts after source access was revoked.
  const revoked = await refreshChatMetadata(shared, held, async ids => { requests.push(ids); return { sources: {}, artifacts: {} } })
  assert.deepEqual(requests, Array(2).fill({ sourceIds: ['new', 'old'], artifactIds: ['removed'] }))
  assert.notEqual(first, shared); assert.notEqual(revoked, shared)
  assert.deepEqual(first.sources, { new: source }); assert.deepEqual(revoked.sources, {})
  assert.deepEqual(shared.sources, { new: source }, 'a sibling authorization result cannot rewrite the shared body')
  const quiet = await refreshChatMetadata(unchanged(), held, async () => ({ sources: {}, artifacts: {} }))
  assert.deepEqual(quiet.metadata, { sources: {}, artifacts: {} }, 'unchanged responses still clear revoked historical cards')
})

function metadataFixture() {
  const item = (position: number, call: string): ChatView['items'][number] => ({ position, from: 'coordinator', text: `Cached body ${position}`, tools: ['github_call'], threads: [], artifacts: [], createdAt: '2026-11-05T00:00:00Z',
    activity: { thought: false, tools: [{ call, name: 'github_call', state: 'done', at: 10 }] } })
  const previous: ChatView = { items: [item(301, 'same-call'), item(320, 'same-call'), item(500, 'last-call')], cursor: 500,
    continuation: { after: 499, cursor: 500, prefix: 'a'.repeat(32) }, working: false, error: null, sources: {}, artifacts: {}, restoreToolMetadata: true }
  const rows = [301, 320].flatMap<ChatToolMetadataRow>(position => [
    { position, parts: [{ ordinal: 2, type: 'tool-call', toolCallId: 'same-call', toolName: 'github_call', operationName: 'get_issue', target: `Target ${position}` }] },
    { position: position + 1, parts: [{ ordinal: 1, type: 'tool-result', toolCallId: 'same-call', status: 'done' }] },
  ])
  const next = { ...previous, restoreToolMetadata: undefined, after: 499, baseCursor: 500, items: [previous.items[2]],
    toolMetadata: { baseCursor: 500, prefix: 'a'.repeat(32), rows } }
  return { previous, next }
}

test('metadata restoration scopes duplicate call ids to each reply and consumes all response-only data', () => {
  const { previous, next } = metadataFixture()
  const merged = mergeChat(previous, next)
  assert.ok(merged)
  assert.deepEqual(merged.items.map(item => item.text), previous.items.map(item => item.text))
  assert.deepEqual(merged.items.slice(0, 2).map(item => item.activity?.tools[0].target), ['Target 301', 'Target 320'])
  assert.ok(merged.items.slice(0, 2).every(item => item.activity?.tools[0].displayName === 'GitHub · Get issue'))
  assert.equal(previous.items[0].activity?.tools[0].target, undefined, 'applying an overlay never mutates the held snapshot')
  assert.equal('toolMetadata' in merged, false)
  assert.equal('restoreToolMetadata' in merged, false)
})

test('missing, reordered or ambiguous metadata requires a full reset instead of validating a partial prefix', () => {
  const mutate = [
    (rows: ChatToolMetadataRow[]) => rows.splice(0, 1),
    (rows: ChatToolMetadataRow[]) => rows.splice(1, 1),
    (rows: ChatToolMetadataRow[]) => rows.reverse(),
    (rows: ChatToolMetadataRow[]) => { rows[0].parts.push({ ...rows[0].parts[0], ordinal: 1 }) },
    (rows: ChatToolMetadataRow[]) => { rows[0].parts[0].toolCallId = 'unexpected-call' },
  ]
  for (const change of mutate) {
    const { previous, next } = metadataFixture()
    change(next.toolMetadata.rows)
    assert.equal(mergeChat(previous, next), undefined)
    assert.equal(previous.restoreToolMetadata, true)
  }
  const { previous, next } = metadataFixture()
  previous.items[0].activity!.tools.push({ ...previous.items[0].activity!.tools[0] })
  next.toolMetadata.rows[0].parts.push({ ...next.toolMetadata.rows[0].parts[0], ordinal: 3 })
  assert.equal(mergeChat(previous, next), undefined, 'a duplicate within one reply is ambiguous')
})

test('an overlay is bound to its exact prefix and a full reset clears the repair hint', () => {
  const { previous, next } = metadataFixture()
  next.toolMetadata.prefix = 'b'.repeat(32)
  assert.equal(mergeChat(previous, next), undefined)
  next.toolMetadata.prefix = previous.continuation!.prefix
  next.toolMetadata.baseCursor--
  assert.equal(mergeChat(previous, next), undefined)
  assert.equal(mergeChat(previous, { ...next, toolMetadata: undefined }), undefined)
  const full = { ...previous, restoreToolMetadata: undefined }
  const merged = mergeChat(previous, full)
  assert.ok(merged)
  assert.equal(merged.items, full.items)
  assert.equal(merged.restoreToolMetadata, undefined)
})
