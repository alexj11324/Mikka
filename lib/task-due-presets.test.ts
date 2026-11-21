import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dueDatePresets, localDay } from './task-due-presets'

test('due date shortcuts are local days; the week ends on Sunday', () => {
  // Wednesday 2026-11-18, late evening local time.
  assert.deepEqual(dueDatePresets(new Date(2026, 10, 18, 23, 30)), { today: '2026-11-18', tomorrow: '2026-11-19', endOfWeek: '2026-11-22', inOneWeek: '2026-11-25' })
  // On a Sunday, End of this week is that Sunday.
  assert.equal(dueDatePresets(new Date(2026, 10, 22, 9)).endOfWeek, '2026-11-22')
  // Month and year roll over.
  assert.deepEqual(dueDatePresets(new Date(2026, 11, 31, 12)), { today: '2026-12-31', tomorrow: '2027-01-01', endOfWeek: '2027-01-03', inOneWeek: '2027-01-07' })
  assert.equal(localDay(new Date(2026, 0, 5)), '2026-01-05')
})
