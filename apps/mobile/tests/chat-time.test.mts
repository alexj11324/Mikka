import { mobileLocale } from '../lib/messages.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { separatorLabel, startsGroup } from '../lib/chat-time.ts'

// Local times, so the test reads the same in any time zone.
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min).toISOString()
const now = new Date(2026, 10, 8, 14, 0) // Sunday 8 November 2026, 14:00

test('the separator reads today, 昨天, the weekday within a week, then the date', () => {
  assert.equal(separatorLabel(at(2026, 11, 8, 9, 21), now), '09:21')
  assert.equal(separatorLabel(at(2026, 11, 7, 21, 4), now), mobileLocale === 'zh-CN' ? '昨天 21:04' : 'Yesterday 21:04')
  assert.equal(separatorLabel(at(2026, 11, 6, 14, 11), now), mobileLocale === 'zh-CN' ? '星期五 14:11' : 'Friday 14:11')
  assert.equal(separatorLabel(at(2026, 11, 2, 8, 5), now), mobileLocale === 'zh-CN' ? '星期一 08:05' : 'Monday 08:05')
  assert.equal(separatorLabel(at(2026, 11, 1, 14, 11), now), mobileLocale === 'zh-CN' ? '11月1日 14:11' : 'Nov 1 14:11')
  assert.equal(separatorLabel(at(2025, 12, 31, 23, 59), now), mobileLocale === 'zh-CN' ? '2025年12月31日 23:59' : 'Dec 31, 2025 23:59')
})

test('replies close together share a separator; a 15-minute gap or a new day starts another', () => {
  assert.equal(startsGroup(at(2026, 11, 8, 9, 0), null), true)
  assert.equal(startsGroup(at(2026, 11, 8, 9, 14), at(2026, 11, 8, 9, 0)), false)
  assert.equal(startsGroup(at(2026, 11, 8, 9, 15), at(2026, 11, 8, 9, 0)), true)
  assert.equal(startsGroup(at(2026, 11, 8, 0, 2), at(2026, 11, 7, 23, 58)), true)
  assert.equal(startsGroup('not a time', at(2026, 11, 8, 9, 0)), false)
})
