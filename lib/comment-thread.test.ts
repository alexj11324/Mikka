import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadMessage, ThreadRecord } from '@/components/blocks/rich-text-editor-4/components/rich-text-comments'
import { attachmentsOf, commentTree, flattenComments, isTombstone, liveMessages, mayEditMessage } from './comment-thread'

const message = (id: string, at: string, over: Partial<ThreadMessage> = {}): ThreadMessage => ({ id, author: `a-${id}`, authorUserId: `u-${id}`, body: `body ${id}`, at, ...over })
const thread = (messages: ThreadMessage[]): ThreadRecord => ({ id: 't', author: 'a-1', createdAt: messages[0]?.at ?? '2026-01-01T00:00:00.000Z', resolved: false, messages })

test('a flat thread renders one root and one reply level', () => {
  const tree = commentTree(thread([message('1', '2026-01-01T00:00:00.000Z'), message('2', '2026-01-01T00:01:00.000Z', { replyTo: '1' })]))
  assert.equal(tree.length, 1)
  assert.equal(tree[0].message.id, '1')
  assert.equal(tree[0].depth, 0)
  assert.deepEqual(tree[0].replies.map(node => [node.message.id, node.depth]), [['2', 1]])
})

test('a reply to a reply nests again, so depth follows the conversation and not the position', () => {
  const tree = commentTree(thread([
    message('1', '2026-01-01T00:00:00.000Z'),
    message('2', '2026-01-01T00:01:00.000Z', { replyTo: '1' }),
    message('3', '2026-01-01T00:02:00.000Z', { replyTo: '2' }),
    message('4', '2026-01-01T00:03:00.000Z', { replyTo: '1' }),
  ]))
  assert.equal(tree.length, 1)
  assert.deepEqual(tree[0].replies.map(node => node.message.id), ['2', '4'])
  assert.deepEqual(tree[0].replies[0].replies.map(node => [node.message.id, node.depth]), [['3', 2]])
})

test('a reply naming a message outside the thread hangs from the root instead of disappearing', () => {
  const tree = commentTree(thread([message('1', '2026-01-01T00:00:00.000Z'), message('2', '2026-01-01T00:01:00.000Z', { replyTo: 'elsewhere' })]))
  assert.deepEqual(tree.map(node => node.message.id), ['1', '2'])
  assert.equal(tree[1].depth, 0)
})

test('a reply naming itself does not swallow the message', () => {
  const tree = commentTree(thread([message('1', '2026-01-01T00:00:00.000Z', { replyTo: '1' })]))
  assert.deepEqual(tree.map(node => [node.message.id, node.depth]), [['1', 0]])
})

test('a two-message cycle still renders both messages exactly once', () => {
  const tree = commentTree(thread([
    message('1', '2026-01-01T00:00:00.000Z', { replyTo: '2' }),
    message('2', '2026-01-01T00:01:00.000Z', { replyTo: '1' }),
  ]))
  const ids = flattenComments(tree).map(node => node.message.id).sort()
  assert.deepEqual(ids, ['1', '2'])
})

test('every message of a malformed thread appears exactly once in tree order', () => {
  const tree = commentTree(thread([
    message('1', '2026-01-01T00:00:00.000Z'),
    message('2', '2026-01-01T00:01:00.000Z', { replyTo: '1' }),
    message('3', '2026-01-01T00:02:00.000Z', { replyTo: '9' }),
    message('4', '2026-01-01T00:03:00.000Z', { replyTo: '3' }),
    message('5', '2026-01-01T00:04:00.000Z', { replyTo: '5' }),
  ]))
  const ids = flattenComments(tree).map(node => node.message.id)
  assert.deepEqual([...ids].sort(), ['1', '2', '3', '4', '5'])
  assert.equal(new Set(ids).size, ids.length)
})

test('siblings read oldest first regardless of the order they were stored in', () => {
  const tree = commentTree(thread([
    message('1', '2026-01-01T00:00:00.000Z'),
    message('late', '2026-01-01T00:09:00.000Z', { replyTo: '1' }),
    message('early', '2026-01-01T00:01:00.000Z', { replyTo: '1' }),
  ]))
  assert.deepEqual(tree[0].replies.map(node => node.message.id), ['early', 'late'])
})

test('a tombstone keeps its place so the replies below it keep their parent', () => {
  const deleted = message('2', '2026-01-01T00:01:00.000Z', { replyTo: '1', deletedAt: '2026-01-01T00:02:00.000Z', body: '', attachments: [] })
  const tree = commentTree(thread([message('1', '2026-01-01T00:00:00.000Z'), deleted, message('3', '2026-01-01T00:03:00.000Z', { replyTo: '2' })]))
  assert.equal(isTombstone(tree[0].replies[0].message), true)
  assert.deepEqual(tree[0].replies[0].replies.map(node => node.message.id), ['3'])
})

test('a tombstone is not counted as a live comment but still hangs its replies', () => {
  const deleted = message('2', '2026-01-01T00:01:00.000Z', { replyTo: '1', deletedAt: '2026-01-01T00:02:00.000Z', body: '' })
  const record = thread([message('1', '2026-01-01T00:00:00.000Z'), deleted])
  assert.deepEqual(liveMessages(record).map(m => m.id), ['1'])
  assert.deepEqual(commentTree(record)[0].replies.map(node => node.message.id), ['2'])
})

test('only the author is offered edit and delete, and never on a tombstone', () => {
  const own = message('1', '2026-01-01T00:00:00.000Z', { authorUserId: 'me' })
  assert.equal(mayEditMessage(own, 'me'), true)
  assert.equal(mayEditMessage(own, 'someone-else'), false)
  assert.equal(mayEditMessage(own, undefined), false)
  assert.equal(mayEditMessage({ ...own, deletedAt: '2026-01-01T00:05:00.000Z' }, 'me'), false)
})

test('a message from before authorship existed belongs to nobody, so no one is offered its controls', () => {
  const legacy = message('1', '2026-01-01T00:00:00.000Z', { authorUserId: undefined })
  assert.equal(mayEditMessage(legacy, 'anyone'), false)
})

test('attachments drop records without an id or a name, which the renderer cannot draw', () => {
  const withFiles = message('1', '2026-01-01T00:00:00.000Z', {
    attachments: [
      { id: 'f1', name: 'log.txt', mediaType: 'text/plain', size: 12 },
      { id: '', name: 'nameless.txt', mediaType: 'text/plain', size: 1 },
      { id: 'f3', name: '', mediaType: 'text/plain', size: 1 },
    ],
  })
  assert.deepEqual(attachmentsOf(withFiles).map(file => file.id), ['f1'])
  assert.deepEqual(attachmentsOf(message('2', '2026-01-01T00:00:00.000Z')), [])
})
