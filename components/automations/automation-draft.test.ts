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

test('GitHub trigger rows round-trip; each needs a repository; lists split on either comma', () => {
  const github = [{ event: 'pull_request_opened' as const, repositories: ['v2/github.com/acme/web'], branches: 'main，release', labels: ' bug , bug', runWhen: ' The PR touches billing. ' }]
  const result = definitionFrom(filled({ scheduleOn: false, github }), now)
  assert.ok('definition' in result)
  assert.deepEqual(result.definition.events, [{ source: 'github', event: 'pull_request_opened', repositories: ['v2/github.com/acme/web'], branches: ['main', 'release'], labels: ['bug'], runWhen: 'The PR touches billing.' }])
  assert.deepEqual(draftFrom(result.definition, now).github, [{ event: 'pull_request_opened', repositories: ['v2/github.com/acme/web'], branches: 'main, release', labels: 'bug', runWhen: 'The PR touches billing.' }])
  assert.deepEqual(definitionFrom(filled({ github: [{ ...github[0]!, repositories: [] }] }), now), { missing: 'repository' })
  const plain = definitionFrom(filled({ scheduleKind: 'daily', dailyTime: '09:00' }), now)
  assert.ok('definition' in plain && !('events' in plain.definition), 'no rows, no events key')
})

test('每天最多运行: 0 is no limit and leaves the key out; a number round-trips', () => {
  const none = definitionFrom(filled({ scheduleOn: false }), now)
  assert.ok('definition' in none && !('maxRunsPerDay' in none.definition))
  const capped = definitionFrom(filled({ scheduleOn: false, perDay: 10 }), now)
  assert.ok('definition' in capped)
  assert.equal(capped.definition.maxRunsPerDay, 10)
  assert.equal(draftFrom(capped.definition, now).perDay, 10)
})

test('每次运行: 追加到同一个任务 round-trips; 新建任务 leaves the key out', () => {
  const single = definitionFrom(filled({ scheduleOn: false, eachRun: 'same_task' }), now)
  assert.ok('definition' in single)
  assert.equal(single.definition.eachRun, 'same_task')
  assert.equal(draftFrom(single.definition, now).eachRun, 'same_task')
  const fresh = definitionFrom(filled({ scheduleOn: false }), now)
  assert.ok('definition' in fresh && !('eachRun' in fresh.definition))
})

test('Webhook: off leaves the key out; 0 and a batch window round-trip', () => {
  const off = definitionFrom(filled({ scheduleOn: false }), now)
  assert.ok('definition' in off && !('webhook' in off.definition))
  for (const minutes of [0, 15]) {
    const on = definitionFrom(filled({ scheduleOn: false, webhook: minutes }), now)
    assert.ok('definition' in on)
    assert.deepEqual(on.definition.webhook, { batchMinutes: minutes })
    assert.equal(draftFrom(on.definition, now).webhook, minutes)
  }
})

test('运行后发到 Slack: off leaves the key out; a channel round-trips with the locale it was saved in', () => {
  const off = definitionFrom(filled({ scheduleOn: false }), now)
  assert.ok('definition' in off && !('notify' in off.definition))
  const on = definitionFrom(filled({ scheduleOn: false, notify: { channel: 'C0RUNS', locale: 'en' } }), now)
  assert.ok('definition' in on)
  assert.deepEqual(on.definition.notify, { slack: { channel: 'C0RUNS', locale: 'en' } })
  assert.deepEqual(draftFrom(on.definition, now).notify, { channel: 'C0RUNS', locale: 'en' })
})
