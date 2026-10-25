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
  assert.throws(() => nextTime({ ...def, timing: { kind: 'once', at: '2026-01-01T00:00:00Z' } }, new Date('2026-01-02T00:00:00Z'), true), /scheduleTimeMustBeFuture/)
  assert.equal(nextTime({ ...def, timing: { kind: 'interval', start: '2026-01-01T00:00:00Z', minutes: 1 } }, new Date('2026-01-01T00:03:30Z'))?.toISOString(), '2026-01-01T00:04:00.000Z')
  assert.equal(nextTime({...def,timezone:'Asia/Shanghai'},new Date('2026-01-01T00:00:00Z'))?.toISOString(),'2026-01-01T18:30:00.000Z')
})
