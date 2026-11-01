// Reactions drawn before the server answers, and @mentions in a group message.
import assert from 'node:assert/strict'
import test from 'node:test'
import { myReaction, toggled, withMine } from '../lib/reactions.ts'
import { mentionsIn } from '../lib/group.ts'

test('withMine: the old reaction loses a count, the new one gains one', () => {
  const start = [{ emoji: '❤️', count: 2, mine: true }, { emoji: '👍', count: 1, mine: false }]
  assert.deepEqual(withMine(start, '👍'), [{ emoji: '❤️', count: 1, mine: false }, { emoji: '👍', count: 2, mine: true }])
  assert.deepEqual(withMine(start, null), [{ emoji: '❤️', count: 1, mine: false }, { emoji: '👍', count: 1, mine: false }])
  assert.deepEqual(withMine(undefined, '🎉'), [{ emoji: '🎉', count: 1, mine: true }])
  assert.deepEqual(withMine([{ emoji: '🎉', count: 1, mine: true }], null), [])
})

test('tapping a chip removes the person’s own, or makes it theirs', () => {
  const list = [{ emoji: '❤️', count: 1, mine: true }, { emoji: '👍', count: 3, mine: false }]
  assert.equal(myReaction(list), '❤️')
  assert.equal(toggled(list, '❤️'), null)
  assert.equal(toggled(list, '👍'), '👍')
})

test('mentionsIn: the bots named as @name, never people', () => {
  const members = [
    { id: 'b1', name: 'Reviewer', memberType: 'bot' as const },
    { id: 'b2', name: 'Writer', memberType: 'bot' as const },
    { id: 'u1', name: 'Alex', memberType: 'user' as const },
  ]
  assert.deepEqual(mentionsIn('@reviewer can you check? cc @Alex', members), [{ memberType: 'bot', memberId: 'b1' }])
  assert.deepEqual(mentionsIn('no one named', members), [])
})
