import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cronShape, definitionFrom, draftFrom, emptyDraft, foldNeeded, instant, wallTime } from './automation-draft'

const now = new Date('2026-10-20T12:00:00Z')
const filled = (patch = {}) => ({ ...emptyDraft('America/New_York', now), title: 'Morning triage', prompt: 'Triage new issues', ...patch })

test('a new draft needs a name and a request before it saves', () => {
  assert.deepEqual(definitionFrom(emptyDraft('UTC', now), now), { missing: 'title' })
  assert.deepEqual(definitionFrom({ ...emptyDraft('UTC', now), title: 'x' }, now), { missing: 'prompt' })
})

test('a daily time that repeats when daylight saving ends waits for the person to choose', () => {
  const draft = filled({ dailyTime: '01:30' })
  assert.equal(foldNeeded(draft, now), true)
  assert.deepEqual(definitionFrom(draft, now), { missing: 'fold' })
  const later = definitionFrom({ ...draft, fold: 'later' }, now)
  assert.ok('definition' in later)
  assert.deepEqual(later.definition.timing, { kind: 'daily', time: '01:30', fold: 'later', gap: 'skip' })
  assert.equal(foldNeeded(filled({ dailyTime: '09:00' }), now), false)
  assert.equal(foldNeeded({ ...draft, timezone: 'Asia/Shanghai' }, now), false)
})

test('schedule off saves a manual automation; the task carries Bot, machine and profile', () => {
  const result = definitionFrom(filled({ scheduleOn: false, botId: '7c1b8f0e-1d2a-4c55-9a0e-3b9f1f1d2a11', machine: 'cloud', profileId: 'p1', taskTitle: ' Daily ' }), now)
  assert.ok('definition' in result)
  assert.deepEqual(result.definition.timing, { kind: 'manual' })
  assert.deepEqual(result.definition.task, { kind: 'dispatch_task', botId: '7c1b8f0e-1d2a-4c55-9a0e-3b9f1f1d2a11', prompt: 'Triage new issues', title: 'Daily', destination: { kind: 'cloud' }, profileId: 'p1' })
})

test('once and interval read wall time in the automation zone and round-trip', () => {
  const once = definitionFrom(filled({ scheduleKind: 'once', onceAt: '2026-12-01T09:00' }), now)
  assert.ok('definition' in once)
  assert.deepEqual(once.definition.timing, { kind: 'once', at: '2026-12-01T14:00:00.000Z' })
  assert.equal(draftFrom(once.definition, now).onceAt, '2026-12-01T09:00')
  const every = definitionFrom(filled({ scheduleKind: 'interval', intervalStart: '2026-12-01T09:00', intervalValue: 2, intervalUnit: 'hours' }), now)
  assert.ok('definition' in every)
  assert.equal(every.definition.timing.kind === 'interval' && every.definition.timing.minutes, 120)
  const back = draftFrom(every.definition, now)
  assert.equal(back.intervalValue, 2)
  assert.equal(back.intervalUnit, 'hours')
  assert.deepEqual(definitionFrom(filled({ scheduleKind: 'interval', intervalValue: 0 }), now), { missing: 'interval' })
})

test('a skipped wall time is refused; a repeated one takes the earlier instant', () => {
  assert.equal(instant('2026-03-08T02:30', 'America/New_York'), null)
  assert.equal(instant('2026-11-01T01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z')
  assert.equal(wallTime('2026-11-01T06:30:00Z', 'America/New_York'), '2026-11-01T01:30')
  assert.deepEqual(definitionFrom(filled({ scheduleKind: 'once', onceAt: '2026-03-08T02:30' }), now), { missing: 'time' })
})

test('a chat-made automation keeps its own task when edited here', () => {
  const definition = { title: 'Remind', timezone: 'UTC', timing: { kind: 'daily', time: '09:00', fold: 'earlier', gap: 'skip' }, task: { kind: 'reminder', text: 'stand up' }, misfire: 'skip', maxLatenessMinutes: 30 } as const
  const draft = draftFrom(definition, now)
  assert.deepEqual(draft.otherTask, definition.task)
  const result = definitionFrom({ ...draft, prompt: '' }, now)
  assert.ok('definition' in result)
  assert.deepEqual(result.definition.task, definition.task)
})

test('cronShape names every day, weekdays, one weekday and one day of the month; anything else is null', () => {
  assert.deepEqual(cronShape('0 9 * * *'), { kind: 'daily', hour: 9, minute: 0 })
  assert.deepEqual(cronShape('30 8 * * 1-5'), { kind: 'weekdays', hour: 8, minute: 30 })
  assert.deepEqual(cronShape('0 9 * * 7'), { kind: 'weekly', hour: 9, minute: 0, day: 0 })
  assert.equal(cronShape('*/5 * * * *'), null)
  assert.deepEqual(cronShape('0 18 28 * *'), { kind: 'monthly', hour: 18, minute: 0, day: 28 })
  assert.equal(cronShape('0 9 1 * 1'), null)
  assert.equal(cronShape('0 9 32 * *'), null)
  assert.equal(cronShape('0 25 * * *'), null)
})
