import assert from 'node:assert/strict'
import { test } from 'node:test'
import { endsSelection, quotedMessage, selectedPart, selectionQuote, SELECTION_ACTIONS } from '../features/chat/model/chat-selection.ts'
import { nextQueueCheck, QUEUED_AFTER_MS, queuedItems, queuePreview } from '../features/chat/model/chat-queue.ts'
import { cardAnchor, cardHeight, rowWindow } from '../features/chat/model/chat-attachment-card.ts'
import { dismisses, fittedRect, frameSize, galleryRows, layerPose, loadedAspect, pageTurn, stackCard, throwsCard } from '../features/chat/model/chat-image-geometry.ts'
import { menuTasks } from '../features/chat/model/chat-header-menu.ts'
import type { ChatItem, Task } from '../lib/types.ts'

test('a selection capsule sends a Markdown quote of the selection, then its instruction', () => {
  assert.equal(quotedMessage('第一行\n第二行', '解释这段。'), '> 第一行\n> 第二行\n\n解释这段。')
  assert.equal(selectionQuote('  ', '整条消息'), '整条消息')
  assert.equal(selectionQuote('部分', '整条消息'), '部分')
  assert.equal(selectedPart('abcdef', 4, 1), 'bcd')
  assert.equal(selectedPart('abc', -3, 99), 'abc')
  assert.ok(SELECTION_ACTIONS.every(action => action.label && action.instruction))
})

test('only a quick tap outside the selected message ends the selection', () => {
  const rect = { x: 20, y: 100, width: 200, height: 80 }
  const down = { x: 300, y: 400, at: 0 }
  assert.equal(endsSelection(down, { x: 302, y: 401, at: 120 }, rect), true)
  // A scroll or a hold keeps it.
  assert.equal(endsSelection(down, { x: 300, y: 440, at: 120 }, rect), false)
  assert.equal(endsSelection(down, { x: 300, y: 400, at: 900 }, rect), false)
  // On the message, or on its handles just outside it.
  assert.equal(endsSelection({ x: 30, y: 110, at: 0 }, { x: 30, y: 110, at: 50 }, rect), false)
  assert.equal(endsSelection({ x: 230, y: 190, at: 0 }, { x: 230, y: 190, at: 50 }, rect), false)
})

const pending = (position: number, text: string, createdAt: number): ChatItem => ({ position, from: 'person', text, threads: [], artifacts: [], createdAt: new Date(createdAt).toISOString(), pending: true })

test('a pending message is queued while the bot works, once an idle bot would have taken it', () => {
  const now = 100_000
  const items = [pending(1, 'old', now - QUEUED_AFTER_MS - 1), pending(2, 'new', now - 1000)]
  assert.deepEqual(queuedItems(items, true, now).map(item => item.text), ['old'])
  assert.deepEqual(queuedItems(items, true, now, new Set(['new'])).map(item => item.text), ['old', 'new'])
  assert.deepEqual(queuedItems(items, false, now), [])
  assert.equal(nextQueueCheck(items, true, now), now - 1000 + QUEUED_AFTER_MS)
  assert.equal(nextQueueCheck(items, false, now), null)
})

test('a queued message previews its words without the quote, or its files', () => {
  assert.equal(queuePreview({ text: '> 引用\n\n回答  这个' }), '回答 这个')
  assert.equal(queuePreview({ text: '[mikka-file:0e8a1c52-6f1b-4c1f-9a51-3b0f8a3c2d10:a.pdf]' }), 'a.pdf')
  assert.equal(queuePreview({ text: '', images: 2 }), '照片')
})

test('the attachment card grows from the plus corner and its rows come in from the bottom', () => {
  assert.equal(cardHeight(3), 3 * 48 + 16)
  assert.deepEqual(rowWindow(0), [0.15, 0.65])
  assert.ok(rowWindow(2)[0] > rowWindow(1)[0])
  assert.deepEqual(cardAnchor({ x: 30, y: 700, height: 40 }, { x: 0, y: 600, height: 160 }), { left: 30, bottom: 20 })
})

test('pictures: one sits uncropped at its shape, several stack and fan out', () => {
  assert.deepEqual(frameSize(1, 400), { width: 240, height: 240 })
  assert.deepEqual(frameSize(0.1, 400), { width: 72, height: 240 })
  assert.deepEqual(frameSize(2, 400), { width: 280, height: 140 })
  assert.equal(stackCard(393).width, 196)
  assert.equal(stackCard(300).width, 180)
  assert.equal(layerPose(1, true).rotate, 6)
  assert.equal(layerPose(3, false).opacity, 0)
  assert.equal(throwsCard(50, 0, 196), true)
  assert.equal(throwsCard(20, 0, 196), false)
  assert.equal(throwsCard(5, 900, 196), true)
})

test('a loaded picture reports its shape from either platform', () => {
  assert.equal(loadedAspect({ nativeEvent: { source: { width: 800, height: 600 } } }), 800 / 600)
  assert.equal(loadedAspect({ nativeEvent: { target: { naturalWidth: 600, naturalHeight: 800 } } }), 600 / 800)
  assert.equal(loadedAspect({ nativeEvent: {} }), null)
  assert.equal(loadedAspect({}), null)
})

test('the viewer fits, pages, closes and grids', () => {
  const rect = fittedRect(1, { width: 393, height: 852 }, { top: 59, bottom: 34 }, false)
  assert.equal(rect.width, 393 - 32)
  assert.ok(Math.abs(rect.y + rect.height / 2 - 426) < 0.01)
  assert.equal(pageTurn(-300, 0, 417, 0, 3), 1)
  assert.equal(pageTurn(-10, -600, 417, 2, 3), 2)
  assert.equal(pageTurn(40, 0, 417, 1, 3), 1)
  assert.equal(dismisses(80, 300), true)
  assert.equal(dismisses(60, 0), false)
  assert.deepEqual(galleryRows(3), [[0], [1, 2]])
  assert.deepEqual(galleryRows(4), [[0, 1], [2, 3]])
})

test('the title menu lists the bot\'s open tasks, waiting ones first, a few of them', () => {
  const task = (id: string, status: string, bot = 'b1'): Task => ({ id, identifier: null, title: id, status, priority: 'normal', owner: null, updatedAt: '', bot: { id: bot, name: '' } })
  const tasks = [task('a', 'doing'), task('b', 'done'), task('c', 'review'), task('d', 'todo', 'other')]
  assert.deepEqual(menuTasks(tasks, 'b1').map(item => item.id), ['c', 'a'])
  assert.deepEqual(menuTasks([task('b', 'done')], 'b1').map(item => item.id), ['b'])
  assert.deepEqual(menuTasks(null, 'b1'), [])
  assert.deepEqual(menuTasks(tasks, null), [])
  const wasDispatched = { ...tasks[0], dispatchedBy: 'earlier-bot' }
  assert.deepEqual(menuTasks([wasDispatched], 'earlier-bot').map(item => item.id), [wasDispatched.id])
  assert.deepEqual(menuTasks([wasDispatched], 'other-bot'), [])
})
