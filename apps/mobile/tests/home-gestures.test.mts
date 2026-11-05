import assert from 'node:assert/strict'
import test from 'node:test'
import { avatarBadge, formatUnread, sumUnread } from '../features/home/model/chat-badge.ts'
import { chatMenu } from '../features/home/model/chat-menu.ts'
import { shownUnread } from '../features/home/model/chat-read.ts'
import { crossed, leadingTravel, pinOffset, pinOutcome, pinSwipeRest, PIN_COMMIT, PIN_REVEAL, trailingTravel } from '../features/home/model/chat-swipe.ts'
import {
  applyDrop, collapseSections, dropAt, edgeScroll, emptyOrder, listBands, orderedRows, parseChatOrder, pinColumn, pinGridHeight, pinIndex, slotContentY,
  type OrderRow,
} from '../features/home/model/chat-order.ts'
import { parseHomeList } from '../features/home/model/home-list.ts'

const bot = (id: string, extra: Partial<OrderRow> = {}): OrderRow => ({ id, kind: 'bot', pinned: false, working: false, ...extra })
const group = (id: string): OrderRow => ({ id, kind: 'group', pinned: false, working: false })

test('a leading swipe is toward the start edge, and the pin rests at 88 or runs at 144', () => {
  assert.equal(leadingTravel(-90, false), 90)
  assert.equal(leadingTravel(40, false), 0)
  assert.equal(trailingTravel(30, false), 30)
  assert.equal(leadingTravel(90, true), 90)
  assert.equal(pinSwipeRest(40, 0, false), 'closed')
  assert.equal(pinSwipeRest(PIN_REVEAL, 0, false), 'reveal')
  assert.equal(pinSwipeRest(PIN_COMMIT, 0, false), 'commit')
  assert.equal(pinSwipeRest(40, 900, false), 'commit', 'a flick carries a short swipe')
  assert.equal(pinSwipeRest(30, 0, true), 'reveal', 'an open row stays open')
  assert.equal(pinOffset('reveal'), PIN_REVEAL)
  assert.equal(pinOffset('commit'), 0)
  assert.equal(crossed(80, 90, PIN_REVEAL), true)
  assert.equal(crossed(90, 100, PIN_REVEAL), false)
})

test('Mikka has no pin cap, so a pin is never refused; a cap refuses one more', () => {
  assert.equal(pinOutcome(false, 12, null), 'pin')
  assert.equal(pinOutcome(true, 12, null), 'unpin')
  assert.equal(pinOutcome(false, 3, 3), 'limit')
  assert.equal(pinOutcome(true, 3, 3), 'unpin')
})

test('a waiting mark outranks an unread count on the avatar', () => {
  assert.deepEqual(avatarBadge({ waiting: 'question', unread: 4 }), { kind: 'waiting', mark: 'question' })
  assert.deepEqual(avatarBadge({ waiting: null, unread: 4 }), { kind: 'unread', count: 4 })
  assert.equal(avatarBadge({ waiting: null, unread: 0 }), null)
  assert.equal(formatUnread(100), '99+')
  assert.equal(sumUnread([1, 0, 2]), 3)
})

test('marking read hides the count until a newer line; marking unread shows at least one', () => {
  assert.equal(shownUnread(3, 't2', undefined), 3)
  assert.equal(shownUnread(3, 't2', { at: 't2', state: 'read' }), 0)
  assert.equal(shownUnread(3, 't3', { at: 't2', state: 'read' }), 3)
  assert.equal(shownUnread(0, 't2', { at: 't2', state: 'unread' }), 1)
})

test('the menu is the actions Mikka has: a group has no pin and no 资料', () => {
  assert.deepEqual(chatMenu({ kind: 'bot', pinned: false, unread: 2 }), ['read', 'pin', 'info', 'copy-id'])
  assert.deepEqual(chatMenu({ kind: 'bot', pinned: true, unread: 0 }), ['unread', 'unpin', 'info', 'copy-id'])
  assert.deepEqual(chatMenu({ kind: 'group', pinned: false, unread: 0 }), ['unread', 'copy-id'])
})

test('the Coordinator stays the first pin, including when a saved order names another pin first', () => {
  const rows = [bot('a', { pinned: true }), bot('c', { pinned: true, coordinator: true }), bot('b'), group('g')]
  assert.deepEqual(orderedRows(rows, null).map(row => row.id), ['c', 'a', 'b', 'g'])
  const saved = { pins: ['a', 'c'], sections: { working: [], bots: ['b'], groups: ['g'] } }
  assert.deepEqual(orderedRows(rows, saved).map(row => row.id), ['c', 'a', 'b', 'g'])
  const dropped = applyDrop(rows, 'a', { zone: 'pins', index: 0 })
  assert.deepEqual(dropped?.order.pins, ['c', 'a'])
})

test('a drop on the pins pins a bot, a drop back in its section unpins it, and a group cannot be pinned', () => {
  const rows = [bot('a'), bot('w', { working: true }), group('g')]
  const pinned = applyDrop(rows, 'a', { zone: 'pins', index: 0 })
  assert.equal(pinned?.pin, true)
  assert.deepEqual(pinned?.order.pins, ['a'])
  const back = applyDrop([bot('a', { pinned: true }), bot('w', { working: true }), group('g')], 'a', { zone: 'section', id: 'bots', index: 0 })
  assert.equal(back?.pin, false)
  assert.deepEqual(back?.order.sections.bots, ['a'])
  assert.equal(applyDrop(rows, 'g', { zone: 'pins', index: 0 }), null)
  assert.equal(applyDrop(rows, 'w', { zone: 'section', id: 'bots', index: 0 }), null, 'working is not a section the person assigns')
  assert.equal(applyDrop(rows, 'a', { zone: 'section', id: 'groups', index: 0 }), null)
})

test('a folded section keeps its unread count and hides its rows', () => {
  const items = [
    { kind: 'section' as const, id: 'bots', title: 'Bot', count: 2 },
    { kind: 'row' as const, row: { id: 'a', unread: 2 } },
    { kind: 'row' as const, row: { id: 'b', unread: 0 } },
  ]
  const folded = collapseSections(items, new Set(['bots']), row => row.unread)
  assert.equal(folded.length, 1)
  assert.equal(folded[0].kind === 'section' && folded[0].unread, 2)
  assert.equal(folded[0].kind === 'section' && folded[0].collapsed, true)
})

test('the finger lands in the pin grid or a section, and near the edge the list scrolls', () => {
  const bands = listBands(20, 5, [{ id: 'bots', rows: 2, collapsed: false }, { id: 'groups', rows: 1, collapsed: true }])
  assert.equal(pinGridHeight(5) > 0, true)
  assert.deepEqual(dropAt(bands, 20 + 12, 'bot'), { zone: 'pins', index: 0 })
  assert.equal(dropAt(bands, 20 + 12, 'group'), null)
  const bots = bands.find(band => band.zone === 'section' && band.id === 'bots')!
  assert.deepEqual(dropAt(bands, bots.top + 36 + 10, 'bot'), { zone: 'section', id: 'bots', index: 0 })
  assert.equal(pinIndex(0, pinColumn(90, 120), 5), 3)
  assert.equal(slotContentY(bands, { zone: 'section', id: 'groups', index: 0 }), bands.find(band => band.zone === 'section' && band.id === 'groups')!.top)
  assert.equal(edgeScroll(10, 0, 400), -1)
  assert.equal(edgeScroll(200, 0, 400), 0)
  assert.equal(edgeScroll(390, 0, 400), 1)
  assert.deepEqual(parseChatOrder('{"pins":["a"],"sections":{"bots":["b"]}}'), { pins: ['a'], sections: { working: [], bots: ['b'], groups: [] } })
  assert.equal(parseChatOrder('nope'), null)
  assert.deepEqual(emptyOrder().sections.groups, [])
})

test('a saved home list drops an unreadable arrangement and keeps read marks', () => {
  assert.deepEqual(parseHomeList(null), { order: null, collapsed: [], read: {} })
  const saved = parseHomeList(JSON.stringify({ order: { pins: ['a'], sections: { bots: ['b'] } }, collapsed: ['groups'], read: { a: { at: 't', state: 'unread' }, b: { at: 1, state: 'read' } } }))
  assert.deepEqual(saved.order?.pins, ['a'])
  assert.deepEqual(saved.collapsed, ['groups'])
  assert.deepEqual(saved.read.a, { at: 't', state: 'unread' })
  assert.equal(saved.read.b, undefined)
  assert.deepEqual(parseHomeList('{'), { order: null, collapsed: [], read: {} })
})
