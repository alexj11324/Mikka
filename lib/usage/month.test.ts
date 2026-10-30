import assert from 'node:assert/strict'
import test from 'node:test'
import { currentMonth, monthBounds, monthDays, recentMonths } from './month'

test('usage months are UTC calendar months', () => {
  assert.deepEqual(monthBounds('2026-12'), { start: new Date('2026-12-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z') })
  assert.throws(() => monthBounds('2026-13'))
  assert.equal(monthDays('2026-02').length, 28)
  assert.equal(currentMonth(new Date('2026-10-30T23:59:00Z')), '2026-10')
  assert.deepEqual(recentMonths(3, new Date('2026-01-15T00:00:00Z')), ['2026-01', '2025-12', '2025-11'])
})
