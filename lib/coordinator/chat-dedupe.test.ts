import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstThreadCards, staleEventPositions, visibleDivider } from './chat-dedupe'

const reply = (position: number, threads: string[] = []) => ({ position, from: 'coordinator', threads })
const event = (position: number, runId: string, kind = 'runWaiting') => ({ position, from: 'event', line: { runId, kind } })

test('a thread has one card: under the first reply that names it', () => {
  const first = firstThreadCards([reply(1, ['r1']), reply(3, ['r1', 'r2']), reply(5, ['r2'])])
  assert.deepEqual([...first], [['r1', 1], ['r2', 3]])
})

test('a thread\'s repeated event line shows only the latest; other threads and kinds stay', () => {
  const rows = [event(2, 'r1'), reply(3), event(4, 'r1'), event(5, 'r2'), event(6, 'r1', 'runFinished'), event(7, 'r1')]
  assert.deepEqual([...staleEventPositions(rows)].sort(), [2, 4])
})

test('the unread divider moves to the next row shown when its row is hidden, and stays otherwise', () => {
  const rows = [event(2, 'r1'), reply(3), event(4, 'r1'), reply(5)]
  const hidden = staleEventPositions(rows)
  assert.equal(visibleDivider(2, rows, hidden), 3)
  assert.equal(visibleDivider(3, rows, hidden), 3)
  assert.equal(visibleDivider(null, rows, hidden), null)
  assert.equal(visibleDivider(4, [...rows.slice(0, 3), event(6, 'r1')], staleEventPositions([...rows.slice(0, 3), event(6, 'r1')])), 6)
})
