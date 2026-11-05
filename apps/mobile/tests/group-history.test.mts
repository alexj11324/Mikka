import assert from 'node:assert/strict'
import test from 'node:test'
import { groupReactionPaths, mergeGroupMessages } from '../lib/group-history.ts'
import type { GroupMessage } from '../lib/types.ts'
const message = (position: string, body = position): GroupMessage => ({ id: `message-${position}`, position, body, authorType: 'user', authorId: 'fixture', createdAt: '2026-11-05T00:00:00Z' })
const range = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, i) => message(String(first + i)))

test('a 145-message conversation stays complete after history paging and a newer 100-message poll', () => {
  const first = mergeGroupMessages([], range(46, 145).reverse())
  const earlier = mergeGroupMessages(first, range(1, 45).reverse())
  const updated = mergeGroupMessages(earlier, range(47, 146).reverse())
  assert.equal(updated.length, 146)
  assert.deepEqual(updated.map(item => Number(item.position)), Array.from({ length: 146 }, (_, i) => i + 1))
  assert.equal(first.length, 100)
})
test('overlap uses the new message body and positions retain bigint precision', () => {
  const first = [message('9007199254740993', 'old'), message('9007199254740992')]
  const updated = mergeGroupMessages(first, [message('9007199254740993', 'updated'), message('9007199254740994')])
  assert.deepEqual(updated.map(item => item.position), ['9007199254740992', '9007199254740993', '9007199254740994'])
  assert.equal(updated[1].body, 'updated')
  assert.equal(first[0].body, 'old')
})

test('expanded history reads every reaction without exceeding the server limit', () => {
  const ids = range(1, 145).map(message => message.id)
  const paths = groupReactionPaths([...ids, ids[0]])
  const pages = paths.map(path => new URL(path, 'https://fixture.test').searchParams.get('ids')!.split(','))
  assert.deepEqual(pages.map(page => page.length), [100, 45])
  assert.deepEqual(pages.flat(), ids)
})
