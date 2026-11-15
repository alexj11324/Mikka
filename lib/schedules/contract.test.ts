import assert from 'node:assert/strict'
import test from 'node:test'
import { definitionSchema } from './contract'

const base = {
  title: 'Cron contract',
  timezone: 'UTC',
  timing: { kind: 'cron', expression: '*/5 * * * *' },
  task: { kind: 'reminder', text: 'hello' },
  misfire: 'catch_up_once',
  maxLatenessMinutes: 5,
} as const

test('cron definitions require a bounded five-field-shaped expression', () => {
  assert.equal(definitionSchema.parse(base).timing.kind, 'cron')
  assert.throws(() => definitionSchema.parse({ ...base, timing: { kind: 'cron', expression: '* * * *' } }))
  assert.throws(() => definitionSchema.parse({ ...base, timing: { kind: 'cron', expression: 'x'.repeat(101) } }))
})

test('maxConcurrent is optional and bounded from one to five', () => {
  assert.equal('maxConcurrent' in definitionSchema.parse(base), false, 'old definitions without the key still parse')
  for (const maxConcurrent of [1, 5]) assert.equal(definitionSchema.parse({ ...base, maxConcurrent }).maxConcurrent, maxConcurrent)
  for (const maxConcurrent of [0, 6, 1.5]) assert.throws(() => definitionSchema.parse({ ...base, maxConcurrent }))
})

test('unknown definition keys are rejected', () => {
  assert.throws(() => definitionSchema.parse({ ...base, visibility: 'workspace' }))
})

test('dispatch_task names a Bot or the Coordinator and keeps the task form’s own limits', () => {
  const task = { kind: 'dispatch_task', botId: null, prompt: 'Check the open PRs and fix failing CI' } as const
  assert.equal(definitionSchema.parse({ ...base, task }).task.kind, 'dispatch_task')
  const full = { ...task, botId: '12340000-0000-4000-8000-000000000001', title: 'Nightly CI', destination: { kind: 'cloud' }, profileId: 'default' }
  assert.deepEqual(definitionSchema.parse({ ...base, task: full }).task, full)
  assert.throws(() => definitionSchema.parse({ ...base, task: { ...task, botId: 'not-a-bot' } }))
  assert.throws(() => definitionSchema.parse({ ...base, task: { ...task, prompt: ' ' } }))
  assert.throws(() => definitionSchema.parse({ ...base, task: { ...task, title: 'x'.repeat(61) } }), 'the New task title limit')
  assert.throws(() => definitionSchema.parse({ ...base, task: { ...task, allowedActions: ['web_search'] } }), 'no read scope or other kind’s keys')
})

test('manual timing has no schedule of its own and run_now needs a request identity', async () => {
  assert.equal(definitionSchema.parse({ ...base, timing: { kind: 'manual' } }).timing.kind, 'manual')
  assert.throws(() => definitionSchema.parse({ ...base, timing: { kind: 'manual', at: '2030-01-01T00:00:00Z' } }))
  const { commandSchema } = await import('./contract')
  const scheduleId = '12340000-0000-4000-8000-000000000002'
  assert.equal(commandSchema.safeParse({ action: 'run_now', scheduleId, version: 1, requestId: '12340000-0000-4000-8000-000000000003' }).success, true)
  assert.equal(commandSchema.safeParse({ action: 'run_now', scheduleId, version: 1 }).success, false)
})
