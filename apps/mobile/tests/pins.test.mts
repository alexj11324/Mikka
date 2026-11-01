// 对话's pinned row: the star is the pin, the same for every bot, the Coordinator included.
import assert from 'node:assert/strict'
import test from 'node:test'
import { botPath, splitPinned } from '../lib/pins.ts'

const bot = (id: string, pinned: boolean, coordinator = false) => ({ kind: 'bot' as const, bot: { id, pinned, coordinator } })
const group = { kind: 'group' as const }

test('pinned bots go on top with the Coordinator first; the rest stay in the list', () => {
  const { pinned, rest } = splitPinned([bot('a', true), bot('c', true, true), bot('b', false), group])
  assert.deepEqual(pinned.map(row => row.bot!.id), ['c', 'a'])
  assert.deepEqual(rest, [bot('b', false), group])
})

test('an unpinned Coordinator is an ordinary row in the list', () => {
  const { pinned, rest } = splitPinned([bot('c', false, true), bot('a', true)])
  assert.deepEqual(pinned.map(row => row.bot!.id), ['a'])
  assert.deepEqual(rest.map(row => row.bot!.id), ['c'])
})

test("the Coordinator's row opens the workspace's Coordinator chat", () => {
  assert.equal(botPath({ id: 'c', coordinator: true }), '/bots/coordinator')
  assert.equal(botPath({ id: 'a' }), '/bots/a')
})
