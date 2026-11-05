import assert from 'node:assert/strict'
import test from 'node:test'
import { dragProgress, drawerWidth, settlesOpen, surfaceRadius } from '../features/shell/model/drawer.ts'
import { dragSlot, moveTo, moveWorkspace, orderWorkspaces, parseWorkspaceOrder } from '../features/shell/model/workspace-order.ts'

test('the drawer is the screen less 52 points, between 280 and 360', () => {
  assert.equal(drawerWidth(393), 341)
  assert.equal(drawerWidth(430), 360)
  assert.equal(drawerWidth(320), 280)
})

test('the surface rounds to the screen corners, at least 34 points', () => {
  assert.equal(surfaceRadius({ top: 0, bottom: 0 }), 34)
  assert.equal(surfaceRadius({ top: 59, bottom: 34 }), 59)
})

test('a released drag settles open past halfway, a flick carrying it either way', () => {
  assert.equal(settlesOpen(0.6, 0), true)
  assert.equal(settlesOpen(0.4, 0), false)
  assert.equal(settlesOpen(0.2, 2), true, 'a quick flick open from a short way')
  assert.equal(settlesOpen(0.8, -2), false, 'a quick flick shut')
})

test('a drag moves the drawer by its own width, within closed and open', () => {
  assert.equal(dragProgress(0, 170, 340), 0.5)
  assert.equal(dragProgress(0, -40, 340), 0)
  assert.equal(dragProgress(1, -85, 340), 0.75)
  assert.equal(dragProgress(1, 40, 340), 1)
})

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

test('home: pins in their order, the Coordinator first among unplaced; sections; hidden chats leave the list', async () => {
  const { homeList } = await import('../features/home/model/home-list.ts')
  const chats = [
    chat('a', { pinned: true, pinOrder: 2 }), chat('c', { pinned: true, coordinator: true }), chat('z', { pinned: true, pinOrder: 1 }),
    chat('g', { kind: 'group', unread: 3 }), chat('w', { working: true }), chat('b', { listOrder: 2 }), chat('n', { at: '2026-11-05T12:00:00Z' }),
    chat('h', { hidden: true }), chat('b2', { listOrder: 1 }),
  ]
  const { pinned, items, hidden } = homeList(chats, { searching: false, collapsed: new Set() })
  assert.deepEqual(pinned.map(c => c.key), ['c', 'z', 'a'])
  assert.deepEqual(items.map(i => i.kind === 'section' ? `[${i.title} ${i.count}]` : i.chat.key), ['[正在工作 1]', 'w', '[Bot 3]', 'n', 'b2', 'b', '[群聊 1]', 'g'])
  assert.equal(hidden, 1)
  const closed = homeList(chats, { searching: false, collapsed: new Set(['groups']) })
  assert.deepEqual(closed.items.slice(-1), [{ kind: 'section', id: 'groups', title: '群聊', count: 1, collapsed: true, unread: 3 }])
  assert.equal(homeList(chats, { searching: true, collapsed: new Set() }).pinned.length, 0)
})

test('the avatar mark: waiting outranks unread, a hand-marked chat shows a dot', async () => {
  const { badgeOf } = await import('../features/home/model/home-list.ts')
  assert.deepEqual(badgeOf(chat('x', { waiting: 1, unread: 5 })), { kind: 'waiting' })
  assert.deepEqual(badgeOf(chat('x', { unread: 5 })), { kind: 'count', count: 5 })
  assert.deepEqual(badgeOf(chat('x', { markedUnread: true })), { kind: 'dot' })
  assert.equal(badgeOf(chat('x')), null)
})

test('a drop pins, moves a pin, or places a chat in its own section and unpins it', async () => {
  const { dropOrder, MAX_PINS } = await import('../features/home/model/home-list.ts')
  const chats = [chat('p1', { pinned: true, pinOrder: 1 }), chat('p2', { pinned: true, pinOrder: 2 }), chat('b1', { listOrder: 1 }), chat('b2', { listOrder: 2 }), chat('g1', { kind: 'group', listOrder: 3 })]
  assert.deepEqual(dropOrder(chats, 'b2', { area: 'pins', index: 1 }), { pinned: ['p1', 'b2', 'p2'], list: ['b1', 'g1'] })
  assert.deepEqual(dropOrder(chats, 'p2', { area: 'pins', index: 0 }), { pinned: ['p2', 'p1'], list: ['b1', 'b2', 'g1'] })
  assert.deepEqual(dropOrder(chats, 'p1', { area: 'list', before: 'b2' }), { pinned: ['p2'], list: ['b1', 'p1', 'b2', 'g1'] })
  assert.deepEqual(dropOrder(chats, 'b1', { area: 'list', before: 'g1' }), { pinned: ['p1', 'p2'], list: ['b2', 'b1', 'g1'] }, 'beside a later section: the end of its own')
  assert.deepEqual(dropOrder(chats, 'g1', { area: 'list', before: 'b1' }), { pinned: ['p1', 'p2'], list: ['b1', 'b2', 'g1'] }, 'beside an earlier section: the top of its own')
  const full = [...Array.from({ length: MAX_PINS }, (_, i) => chat(`p${i}`, { pinned: true, pinOrder: i })), chat('x')]
  assert.equal(dropOrder(full, 'x', { area: 'pins', index: 0 }), null, 'no room among the pins')
})

test('the row swipe: armed past 144 pt until back under 128; released, it pins, opens at 88 or closes', async () => {
  const { armedAt, settleSwipe } = await import('../features/home/model/pin-swipe.ts')
  assert.equal(armedAt(150, false), true)
  assert.equal(armedAt(140, false), false)
  assert.equal(armedAt(130, true), true, 'between the marks it stays as it was')
  assert.equal(armedAt(120, true), false)
  assert.equal(settleSwipe(-150, 0, true), 'pin')
  assert.equal(settleSwipe(-60, 0, false), 'open')
  assert.equal(settleSwipe(-30, 0, false), 'close')
  assert.equal(settleSwipe(-20, -400, false), 'open', 'a quick flick left opens it')
  assert.equal(settleSwipe(-80, 600, false), 'close', 'a flick back closes it')
})
