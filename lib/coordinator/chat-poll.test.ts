import assert from 'node:assert/strict'
import test from 'node:test'
import { FULL_READ_EVERY_MS, knownVersion, mergeChat, type UnchangedChat } from './chat-poll'

type Chat = { version?: string; streamRunId?: string; items: { position: number; text: string; pending?: true }[]; working: boolean; error: string | null; cursor?: number; botId: string; enabled: boolean; after?: number; baseCursor?: number }
const chat: Chat = { version: 'v1', streamRunId: 'wrun_old', items: [{ position: 1, text: 'hello' }], working: true, error: null, cursor: 4, botId: 'b', enabled: true }
const unchanged = (state: Partial<UnchangedChat> = {}): UnchangedChat => ({ unchanged: true, version: 'v1', cursor: 4, working: false, error: null, botId: 'b', enabled: true, ...state })

test('a poll names the shown version until card metadata needs refreshing', () => {
  assert.equal(knownVersion(undefined, 0, 1), undefined, 'the first read is full')
  assert.equal(knownVersion({}, 0, 1), undefined, 'a chat without a version is read in full')
  assert.equal(knownVersion(chat, 1_000, 1_000 + FULL_READ_EVERY_MS - 1), 'v1')
  assert.equal(knownVersion(chat, 1_000, 1_000 + FULL_READ_EVERY_MS), undefined, 'refresh metadata while still sending the history continuation')
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
