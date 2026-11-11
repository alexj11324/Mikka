import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextTime, resolveLocal, timezone } from './time'
import type { Definition } from './contract'
const def: Definition = { title: 'test', timezone: 'America/New_York', timing: { kind: 'daily', time: '02:30', fold: 'earlier', gap: 'skip' }, task: { kind: 'reminder', text: 'hello' }, misfire: 'catch_up_once', maxLatenessMinutes: 5 }
test('DST spring gap skips the absent local date', () => {
  assert.equal(nextTime(def, new Date('2026-03-08T05:00:00Z'))?.toISOString(), '2026-03-09T06:30:00.000Z')
})
test('DST fold selects explicit earlier/later or rejects; Lord Howe half-hour fold', () => {
  const local = Date.UTC(2026,10,1,1,30)
  assert.equal(new Date(resolveLocal(local, def.timezone, 'earlier')!).toISOString(), '2026-11-01T05:30:00.000Z')
  assert.equal(new Date(resolveLocal(local, def.timezone, 'later')!).toISOString(), '2026-11-01T06:30:00.000Z')
  assert.throws(() => resolveLocal(local, def.timezone, 'reject'), /ambiguousLocalTime/)
  const half = Date.UTC(2026,3,5,1,45)
  assert.equal(resolveLocal(half,'Australia/Lord_Howe','later')! - resolveLocal(half,'Australia/Lord_Howe','earlier')!, 1800000)
})
test('past once/interval starts and invalid zones reject, interval skips backlog', () => {
  assert.throws(() => timezone('Mars/Base'), /invalidIanaTimezone/)
  assert.throws(() => timezone('+08:00'), /invalidIanaTimezone/)
  for (const abbreviation of ['PST', 'EST', 'CST']) assert.throws(() => timezone(abbreviation), /invalidIanaTimezone/)
  assert.equal(timezone('UTC'), 'UTC')
  assert.throws(() => nextTime({ ...def, timing: { kind: 'once', at: '2026-01-01T00:00:00Z' } }, new Date('2026-01-02T00:00:00Z'), true), /scheduleTimeMustBeFuture/)
  assert.equal(nextTime({ ...def, timing: { kind: 'interval', start: '2026-01-01T00:00:00Z', minutes: 1 } }, new Date('2026-01-01T00:03:30Z'))?.toISOString(), '2026-01-01T00:04:00.000Z')
  assert.equal(nextTime({...def,timezone:'Asia/Shanghai'},new Date('2026-01-01T00:00:00Z'))?.toISOString(),'2026-01-01T18:30:00.000Z')
})
test('five-field cron supports steps, ranges, names, month names and strict next time', () => {
  const cron = (expression: string, at: string, zone = 'UTC') => nextTime({ ...def, timezone: zone, timing: { kind: 'cron', expression } }, new Date(at))?.toISOString()
  assert.equal(cron('*/5 * * * *', '2026-01-01T00:02:00Z'), '2026-01-01T00:05:00.000Z')
  assert.equal(cron('*/5 * * * *', '2026-01-01T00:05:00Z'), '2026-01-01T00:10:00.000Z', 'next time is strictly after after')
  assert.equal(cron('0 9 * * MON-FRI', '2026-01-02T00:00:00Z', 'America/New_York'), '2026-01-02T14:00:00.000Z')
  assert.equal(cron('0 0 * JUL *', '2026-01-01T00:00:00Z'), '2026-07-01T00:00:00.000Z')
  assert.equal(cron('0 0 * * WED', '2026-01-01T00:00:00Z'), '2026-01-07T00:00:00.000Z')
  assert.equal(cron('10-20/5 * * * *', '2026-01-01T00:11:00Z'), '2026-01-01T00:15:00.000Z')
})
test('cron follows the parser timezone across DST and rejects unsupported syntax', () => {
  const cron = (expression: string, at: string, zone = 'America/New_York') => nextTime({ ...def, timezone: zone, timing: { kind: 'cron', expression } }, new Date(at))?.toISOString()
  assert.equal(cron('0 2 * * *', '2026-03-08T05:00:00Z'), '2026-03-08T07:00:00.000Z')
  assert.equal(cron('30 2 * * *', '2026-11-01T05:00:00Z'), '2026-11-01T07:30:00.000Z')
  for (const expression of ['0 0 0 * * *', '@daily', '0 0 L * *', '0 0 * * 1L', '0 0 ? * *', '0 0 * * 1#2', '0 0 1W * *']) {
    assert.throws(() => cron(expression, '2026-01-01T00:00:00Z'), /invalidCron/, expression)
  }
})
test('cron has a 370-day lookahead; leap day works when it is within the window', () => {
  const cron = (expression: string, at: string) => nextTime({ ...def, timezone: 'UTC', timing: { kind: 'cron', expression } }, new Date(at))?.toISOString()
  assert.equal(cron('0 0 29 2 *', '2027-03-01T00:00:00Z'), '2028-02-29T00:00:00.000Z')
  assert.throws(() => cron('0 0 29 2 *', '2026-03-01T00:00:00Z'), /noNextExecution/)
  assert.throws(() => cron('0 0 31 4 *', '2026-01-01T00:00:00Z'), /invalidCron/)
})
