import assert from 'node:assert/strict'
import test from 'node:test'

import { actionOutcome, calendarEventSummary } from './pending-action-view'

test('reads an event’s title and times, also when nested under response_data', () => {
  const event = { summary: 'Review', start: { dateTime: '2026-10-27T10:00:00-07:00' }, end: { date: '2026-10-28' } }
  assert.deepEqual(calendarEventSummary(event), { summary: 'Review', start: '2026-10-27T10:00:00-07:00', end: '2026-10-28' })
  assert.deepEqual(calendarEventSummary({ response_data: event }), calendarEventSummary(event))
  assert.equal(calendarEventSummary({}), null)
})

test('keeps only ids and the link from a result', () => {
  assert.deepEqual(actionOutcome({ response_data: { id: 'e1', htmlLink: 'https://calendar.google.com/e1', attendees: [] } }), { id: 'e1', htmlLink: 'https://calendar.google.com/e1' })
  assert.deepEqual(actionOutcome({ id: 'm1', threadId: 't1', labelIds: ['SENT'] }), { id: 'm1', threadId: 't1' })
})
