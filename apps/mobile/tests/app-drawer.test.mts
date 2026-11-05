import assert from 'node:assert/strict'
import test from 'node:test'
import { dragProgress, drawerWidth, OPEN_SCALE, settlesOpen, surfaceDim, surfaceRadius, surfaceScale } from '../features/shell/model/drawer.ts'
import { TOKENS } from '../lib/tokens.ts'
import { moveWorkspace, orderWorkspaces, parseWorkspaceOrder } from '../features/shell/model/workspace-order.ts'

test('the drawer is the screen less 52 points, between 280 and 360', () => {
  assert.equal(drawerWidth(393), 341)
  assert.equal(drawerWidth(430), 360)
  assert.equal(drawerWidth(320), 280)
})

test('the surface rounds to the screen corners, at least 34 points', () => {
  assert.equal(surfaceRadius({ top: 0, bottom: 0 }), 34)
  assert.equal(surfaceRadius({ top: 59, bottom: 34 }), 59)
})

test('the open surface shrinks just enough to show its corners, under a veil lighter than a modal', () => {
  assert.equal(surfaceScale(0), 1)
  assert.equal(surfaceScale(1), OPEN_SCALE)
  assert.ok(OPEN_SCALE >= 0.94, 'still the app, not a small card')
  assert.equal(surfaceDim(0), 0)
  assert.equal(surfaceDim(1), 1)
  const alpha = (color: string) => Number(color.match(/[\d.]+(?=\))/)?.[0])
  assert.ok(alpha(TOKENS.drawerDim.light) < alpha(TOKENS.scrim.light))
  assert.ok(alpha(TOKENS.drawerDim.dark) < alpha(TOKENS.scrim.dark))
  assert.equal(TOKENS.drawer.ios, 'secondarySystemBackground')
  assert.equal(TOKENS.drawerRow.ios, 'tertiarySystemBackground')
  assert.notEqual(TOKENS.drawer.light, TOKENS.page.light)
  assert.notEqual(TOKENS.drawer.dark, TOKENS.page.dark)
  assert.notEqual(TOKENS.drawerRow.dark, TOKENS.drawer.dark)
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
})

test('home: pins on top with the Coordinator first, then 正在工作, Bot and 群聊; a search is one plain run', async () => {
  const { homeSections } = await import('../features/home/model/home-sections.ts')
  const bot = (id: string, extra: object = {}) => ({ kind: 'bot' as const, id, bot: { ...extra } })
  const rows = [bot('a', { pinned: true }), { kind: 'group' as const, id: 'g' }, bot('c', { pinned: true, coordinator: true }), bot('w', { working: true }), bot('b')]
  const { pinned, items } = homeSections(rows, false)
  assert.deepEqual(pinned.map(row => row.id), ['c', 'a'])
  assert.deepEqual(items.map(item => item.kind === 'section' ? `[${item.title} ${item.count}]` : item.row.id), ['[正在工作 1]', 'w', '[Bot 1]', 'b', '[群聊 1]', 'g'])
  const found = homeSections(rows, true)
  assert.equal(found.pinned.length, 0)
  assert.equal(found.items.length, rows.length)
})
