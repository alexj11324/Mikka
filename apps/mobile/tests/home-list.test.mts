import { mobileMessages } from '../lib/messages.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { TOKENS } from '../lib/tokens.ts'
import { dragSlot, moveTo, moveWorkspace, orderWorkspaces, parseWorkspaceOrder } from '../features/workspace/model/workspace-order.ts'

test('workspaces keep the order the person gave them; new ones follow, gone ones drop', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(orderWorkspaces(list, ['c', 'gone', 'a']).map(w => w.id), ['c', 'a', 'b'])
  assert.deepEqual(orderWorkspaces(list, []).map(w => w.id), ['a', 'b', 'c'])
  assert.deepEqual(moveWorkspace(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
  assert.deepEqual(moveWorkspace(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c'])
  assert.deepEqual(parseWorkspaceOrder('["a",3,"b"]'), ['a', 'b'])
  assert.deepEqual(parseWorkspaceOrder('{oops'), [])
  assert.deepEqual(moveTo(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a'])
  assert.deepEqual(moveTo(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b'])
  assert.equal(dragSlot(0, 80, 52, 3), 2)
  assert.equal(dragSlot(1, -200, 52, 3), 0)
  assert.equal(dragSlot(1, 20, 52, 3), 1)
})

const chat = (key: string, extra: Partial<import('../features/home/model/home-list.ts').ListChat> = {}) => ({
  key, kind: 'bot' as const, at: '2026-11-05T10:00:00Z', pinned: false, hidden: false, pinOrder: null, listOrder: null,
  coordinator: false, working: false, unread: 0, markedUnread: false, waiting: 0, ...extra,
})

test('home: pins in their order, the Coordinator first among unplaced; the list newest first, a stored order ignored; sections; hidden chats leave the list', async () => {
  const { homeList } = await import('../features/home/model/home-list.ts')
  const chats = [
    chat('a', { pinned: true, pinOrder: 2 }), chat('c', { pinned: true, coordinator: true }), chat('z', { pinned: true, pinOrder: 1 }),
    chat('g', { kind: 'group', unread: 3 }), chat('w', { working: true }), chat('b', { listOrder: 2, at: '2026-11-05T11:00:00Z' }), chat('n', { at: '2026-11-05T12:00:00Z' }),
    chat('h', { hidden: true }), chat('b2', { listOrder: 1 }),
  ]
  const { pinned, items, hidden } = homeList(chats, { searching: false, collapsed: new Set() })
  assert.deepEqual(pinned.map(c => c.key), ['c', 'z', 'a'])
  assert.deepEqual(items.map(i => i.kind === 'section' ? `[${i.title} ${i.count}]` : i.chat.key), [`[${mobileMessages.MobileCore.working} 1]`, 'w', '[Bot 3]', 'n', 'b', 'b2', `[${mobileMessages.MobileCore.groupChats} 1]`, 'g'])
  assert.equal(hidden, 1)
  const closed = homeList(chats, { searching: false, collapsed: new Set(['groups']) })
  assert.deepEqual(closed.items.slice(-1), [{ kind: 'section', id: 'groups', title: mobileMessages.MobileCore.groupChats, count: 1, collapsed: true, unread: 3 }])
  assert.equal(homeList(chats, { searching: true, collapsed: new Set() }).pinned.length, 0)
})

// 2026-11-07: the page's large title is Bot, so bots that open the list have no second 「Bot」 header.
test('home: the bots that open the list carry no Bot header', async () => {
  const { homeList } = await import('../features/home/model/home-list.ts')
  const { items } = homeList([chat('b'), chat('g', { kind: 'group' })], { searching: false, collapsed: new Set() })
  assert.deepEqual(items.map(i => i.kind === 'section' ? `[${i.title}]` : i.chat.key), ['b', `[${mobileMessages.MobileCore.groupChats}]`, 'g'])
})

test('the avatar mark: waiting outranks unread, a hand-marked chat shows a dot', async () => {
  const { badgeOf } = await import('../features/home/model/home-list.ts')
  assert.deepEqual(badgeOf(chat('x', { waiting: 1, unread: 5 })), { kind: 'waiting' })
  assert.deepEqual(badgeOf(chat('x', { unread: 5 })), { kind: 'count', count: 5 })
  assert.deepEqual(badgeOf(chat('x', { markedUnread: true })), { kind: 'dot' })
  assert.equal(badgeOf(chat('x')), null)
})

test('the row swipe: armed past 144 pt until back under 128; released, it pins, opens at 88 or closes', async () => {
  const { armedAt, settleSwipe } = await import('../features/home/model/pin-swipe.ts')
  assert.equal(armedAt(235, false), true)
  assert.equal(armedAt(225, false), false)
  assert.equal(armedAt(215, true), true, 'between the marks it stays as it was')
  assert.equal(armedAt(205, true), false)
  assert.equal(settleSwipe(-235, 0, true), 'pin')
  assert.equal(settleSwipe(-80, 0, false), 'open')
  assert.equal(settleSwipe(-60, 0, false), 'close')
  assert.equal(settleSwipe(-20, -500, false), 'open', 'a quick flick left opens it')
  assert.equal(settleSwipe(-120, 600, false), 'close', 'a flick back closes it')
})
