import assert from 'node:assert/strict'
import test from 'node:test'
import { atTheirTime } from './thread-child-entries'

const entry = (id: string, at: number) => ({ id, at })

test('a child conversation sits where it started, between the entries around it', () => {
  const own = [entry('ask', 1), entry('done', 5), entry('fix', 9)]
  assert.deepEqual(atTheirTime(own, [entry('verify', 7), entry('review', 6)]).map(item => item.id), ['ask', 'done', 'review', 'verify', 'fix'])
})

test('one that started after the last entry goes at the end, and none leaves the conversation as it is', () => {
  assert.deepEqual(atTheirTime([entry('ask', 1)], [entry('review', 3)]).map(item => item.id), ['ask', 'review'])
  assert.deepEqual(atTheirTime([entry('b', 2), entry('a', 1)]).map(item => item.id), ['b', 'a'])
})
