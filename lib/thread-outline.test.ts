import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ThreadItem } from './issue-run-conversation'
import { threadOutline } from './thread-outline'

const person = (id: string, text: string, extra: Partial<Extract<ThreadItem, { kind: 'person' }>> = {}): ThreadItem =>
  ({ kind: 'person', id, text, author: 'Alex', mine: false, at: 1_700_000_000_000, ...extra })
const agent = (id: string, text: string): ThreadItem => ({ kind: 'agent', id, text, at: 1_700_000_000_000 })
const steps: ThreadItem = { kind: 'steps', id: 'steps:1', count: 2, steps: [], at: 1_700_000_000_000 }

test('the index holds what a person said and nothing else', () => {
  const items: ThreadItem[] = [person('m1', 'First question'), agent('text:1', 'An answer'), steps, person('m2', 'Follow-up')]
  const outline = threadOutline(items)
  assert.deepEqual(outline.map(entry => entry.id), ['m1', 'm2'])
})

test('it keeps the conversation order, never resorting', () => {
  // threadItems already sorts by time; the index must not impose a second order
  // that could disagree with the list the reader is looking at.
  const items: ThreadItem[] = [person('m1', 'a'), person('m2', 'b'), person('m3', 'c')]
  assert.deepEqual(threadOutline(items).map(entry => entry.id), ['m1', 'm2', 'm3'])
})

test('an empty message is left out rather than becoming an unlabelled jump', () => {
  const items: ThreadItem[] = [person('m1', 'real'), person('m2', '   '), person('m3', 'also real')]
  assert.deepEqual(threadOutline(items).map(entry => entry.id), ['m1', 'm3'])
})

test('the entry carries the anchor id and what the panel needs to show', () => {
  const [entry] = threadOutline([person('m1', 'Ship it', { author: 'Bob', mine: true, at: 42 })])
  assert.deepEqual(entry, { id: 'm1', author: 'Bob', text: 'Ship it', at: 42, mine: true })
})

test('the text is not truncated here: the panel decides how much to show', () => {
  const long = 'x'.repeat(5_000)
  assert.equal(threadOutline([person('m1', long)])[0]!.text.length, 5_000)
})

test('a thread with only the agent has no jump index', () => {
  assert.deepEqual(threadOutline([agent('text:1', 'working'), steps]), [])
  assert.deepEqual(threadOutline([]), [])
})

test('a message with no author still gets an entry', () => {
  // The author is presentation; losing it must not lose the anchor.
  assert.deepEqual(threadOutline([person('m1', 'hi', { author: '' })]).map(entry => entry.id), ['m1'])
})
