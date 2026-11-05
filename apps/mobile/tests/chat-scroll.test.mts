import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatScrollPosition } from '../lib/chat-scroll.ts'

test('incoming content follows a reader at the end, but leaves a history reader in place', () => {
  const scroll = new ChatScrollPosition()
  assert.equal(scroll.onResize(1800), 'end')
  assert.equal(scroll.onScroll(1200, 1800, 600), true)
  assert.equal(scroll.onResize(1900), 'end')
  assert.equal(scroll.onScroll(400, 1900, 600), false)
  assert.equal(scroll.onResize(2100), null)
  scroll.latest()
  assert.equal(scroll.onResize(2200), 'end')
})
test('prepending history preserves the same visible message, including footer layout changes', () => {
  const scroll = new ChatScrollPosition()
  scroll.onScroll(100, 2000, 600)
  scroll.preservePrepend()
  assert.equal(scroll.onResize(3456), 1556)
  assert.equal(scroll.onResize(3556), null)
})
test('a focused pending card stops following until an explicit return to latest', () => {
  const scroll = new ChatScrollPosition()
  scroll.pause()
  assert.equal(scroll.onResize(2000), null)
  scroll.latest()
  assert.equal(scroll.onResize(2100), 'end')
  scroll.reset()
  assert.equal(scroll.onResize(1000), 'end')
})
