import assert from 'node:assert/strict'
import test from 'node:test'
import { knownVersion, mergeChat, metadataEntities, METADATA_KEYS_MAX, type UnchangedChat } from './chat-poll'

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
  assert.equal(mergeChat(chat, unchanged({ streamRunId: 'wrun_new' })).streamRunId, 'wrun_new')
  assert.equal(mergeChat(chat, unchanged({ error: 'wake_failed' })).error, 'wake_failed')
  const full = { ...chat, version: 'v2', items: [...chat.items, { position: 5, text: 'reply' }] }
  assert.equal(mergeChat(chat, full), full, 'a changed chat replaces the shown one')
  const newer = { ...chat, version: 'v3' }
  assert.equal(mergeChat(newer, unchanged()), newer, 'a cache that moved on during the poll is kept')
})

test('a delta replaces the replayed tail and pending messages, without duplicating stored rows', () => {
  const previous: Chat = { ...chat, items: [...chat.items, { position: 4, text: 'tool running' }, { position: 5, text: 'pending', pending: true }] }
  const next: Chat = { ...chat, version: 'v2', cursor: 6, after: 3, baseCursor: 4, items: [{ position: 4, text: 'tool done and reply' }, { position: 6, text: 'stored' }] }
  assert.deepEqual(mergeChat(previous, next).items, [chat.items[0], ...next.items])
  assert.equal(mergeChat({ ...previous, cursor: 7 }, next).cursor, 7, 'an old response cannot overwrite newer cache data')
})
