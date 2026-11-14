import assert from 'node:assert/strict'
import test from 'node:test'
import { chatHistoryPath, chatUpdatePath, groupPagePath, mergeChatHistory, mergeChatRead, mergeGroupHistory, mergeGroupRead, olderThrough, personalReadback, type ChatRead, type GroupRead } from '../features/chat/model/chat-pages.ts'
import type { ChatItem, GroupMessage } from '../lib/types.ts'

const item = (position: number, extra: Partial<ChatItem> = {}): ChatItem => ({ id: `m${position}`, position, from: position % 2 ? 'person' : 'coordinator', text: `#${position}`, threads: [], artifacts: [], createdAt: '2026-11-05T00:00:00Z', ...extra })
const chat = (positions: number[], extra: Partial<ChatRead> = {}): ChatRead => ({ enabled: true, working: false, error: null, items: positions.map(p => item(p)), sources: {}, artifacts: {}, reactions: {}, ...extra })
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

test('a push reads only what came after the last read', () => {
  assert.equal(chatUpdatePath('/api/mobile/chat?bot=b', null), '/api/mobile/chat?bot=b')
  const read = chat(range(51, 100), { continuation: { after: 99, cursor: 100, prefix: 'a'.repeat(32) } })
  assert.equal(chatUpdatePath('/api/mobile/chat', read), `/api/mobile/chat?after=99&cursor=100&prefix=${'a'.repeat(32)}`)
  assert.equal(chatUpdatePath('/api/mobile/chat?bot=b', read), `/api/mobile/chat?bot=b&after=99&cursor=100&prefix=${'a'.repeat(32)}`)
})

test('an update keeps messages up to `after`, replaces the rest and drops waiting messages', () => {
  const previous = chat([...range(51, 100)], { continuation: { after: 99, cursor: 100, prefix: 'p' }, historyBefore: 51, reactions: { m60: [{ emoji: '👍', count: 1, mine: true }] } })
  previous.items.push(item(101, { pending: true, id: undefined }))
  const next = chat([99, 100, 101, 102], { after: 98, baseCursor: 100, continuation: { after: 101, cursor: 102, prefix: 'q' }, reactions: { m101: [] } })
  const merged = mergeChatRead(previous, next)
  assert.deepEqual(merged.items.map(i => i.position), range(51, 102))
  assert.equal(merged.items.some(i => i.pending), false)
  assert.equal(merged.historyBefore, 51, 'history still continues from the oldest page')
  assert.deepEqual(merged.continuation, { after: 101, cursor: 102, prefix: 'q' })
  assert.ok(merged.reactions?.m60 && merged.reactions.m101, 'reactions of kept and new messages')
  assert.equal('after' in merged, false)
})

test('an update that answers an older state is ignored', () => {
  const previous = chat(range(1, 10), { continuation: { after: 9, cursor: 12, prefix: 'p' } })
  const next = chat([10, 11], { after: 9, baseCursor: 10 })
  assert.equal(mergeChatRead(previous, next), previous)
})

test('a full read keeps loaded history it overlaps, and drops it when there is a gap', () => {
  const previous = chat(range(1, 100), { historyBefore: null })
  const overlapping = mergeChatRead(previous, chat(range(61, 110), { historyBefore: 61 }))
  assert.deepEqual(overlapping.items.map(i => i.position), range(1, 110))
  assert.equal(overlapping.historyBefore, null)
  const gap = mergeChatRead(previous, chat(range(151, 200), { historyBefore: 151 }))
  assert.deepEqual(gap.items.map(i => i.position), range(151, 200))
  assert.equal(gap.historyBefore, 151)
})

test('an older page overlaps the first item by one and goes in front', () => {
  const shown = chat(range(51, 100), { historyBefore: 51 })
  const through = olderThrough(shown)
  assert.equal(through, 51)
  assert.equal(chatHistoryPath('/api/mobile/chat?bot=b', through!), '/api/mobile/chat?bot=b&through=51')
  const page = { items: range(2, 51).map(p => item(p)), sources: {}, artifacts: {}, reactions: {}, historyBefore: 2 }
  const merged = mergeChatHistory(shown, page, through!)
  assert.deepEqual(merged.items.map(i => i.position), range(2, 100))
  assert.equal(merged.historyBefore, 2)
  assert.equal(olderThrough({ ...merged, historyBefore: null }), null)
})

const message = (position: number): GroupMessage => ({ id: `g${position}`, conversationId: 'c', position: String(position), authorType: 'user', authorId: 'u', body: `#${position}`, mentions: [], replyToId: null, createdAt: '2026-11-05T00:00:00Z' })
const page = (positions: number[], extra: Partial<GroupRead> = {}): GroupRead => ({ messages: positions.map(message), nextBefore: null, agentStatus: null, routingError: null, ...extra })
const desc = (from: number, to: number) => range(from, to).reverse()

test('a manual read revision survives an empty named chat and advances without another message', () => {
  const empty = mergeGroupRead(null, page([], { readRevision: 0 }))
  assert.equal(empty.readRevision, 0)
  const first = mergeGroupRead(empty, page([1], { appended: true, readRevision: 1 }))
  const revised = mergeGroupRead(first, page([], { unchanged: true, readRevision: 2 }))
  assert.equal(revised.messages[0]?.id, 'g1')
  assert.equal(revised.readRevision, 2)
  assert.equal(mergeGroupRead(null, page([])).readRevision, undefined)
})

test('a group push reads only after its newest message; history reads before', () => {
  assert.equal(groupPagePath('c', null), '/api/conversations/c/messages?limit=50')
  assert.equal(groupPagePath('c', page(desc(1, 50))), '/api/conversations/c/messages?limit=50&after=50')
  assert.equal(groupPagePath('c', page(desc(1, 50)), '1'), '/api/conversations/c/messages?limit=50&before=1')
})

test('a group read: unchanged keeps the messages, appended goes in front, a full page keeps history it reaches', () => {
  const previous = page(desc(1, 100), { nextBefore: null })
  const unchanged = mergeGroupRead(previous, page([], { unchanged: true, agentStatus: { agentId: null, botId: 'b', status: 'thinking' } }))
  assert.equal(unchanged.messages.length, 100)
  assert.equal(unchanged.agentStatus?.status, 'thinking')
  const appended = mergeGroupRead(previous, page([102, 101], { appended: true }))
  assert.deepEqual(appended.messages.slice(0, 3).map(m => Number(m.position)), [102, 101, 100])
  assert.equal(appended.messages.length, 102)
  const full = mergeGroupRead(previous, page(desc(61, 110), { nextBefore: '61' }))
  assert.equal(full.messages.length, 110)
  assert.equal(full.nextBefore, null)
  const far = mergeGroupRead(previous, page(desc(201, 250), { nextBefore: '201' }))
  assert.equal(far.messages.length, 50)
  assert.equal(far.nextBefore, '201')
  const older = mergeGroupHistory(page(desc(51, 100), { nextBefore: '51' }), page(desc(1, 51), { nextBefore: null }))
  assert.equal(older.messages.length, 100)
  assert.equal(older.nextBefore, null)
})


test('a fresh legacy snapshot takes over acknowledged sends without guessing from message text', () => {
  const twice = chat([], { items: [item(1, {text:'OK'}), item(3, {text:'OK'})] })
  assert.deepEqual(personalReadback(twice, ['confirmed-before-this-GET']).acknowledgedBeforeRead, ['confirmed-before-this-GET'])
  assert.deepEqual(personalReadback(twice, []).acknowledgedBeforeRead, [])
  assert.equal(personalReadback({ ...twice, submissionIds:true }, ['receipt']).acknowledgedBeforeRead, undefined)
  assert.equal(personalReadback(chat([], {items:[item(1,{ submissionId:'older-modern-receipt' })]}), ['receipt']).submissionIds, true)
})
