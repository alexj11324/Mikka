import assert from 'node:assert/strict'
import test from 'node:test'
import { commandSchema, definitionSchema, webhookBatchListInput } from './contract'
import { parseRunSettings } from '../task-run-settings-schema'

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

test('the signed webhook batch list accepts the same status and bounded page size as history', () => {
  const scheduleId = '12340000-0000-4000-8000-000000000003'
  for (const status of ['collecting', 'queued', 'cancelled']) {
    assert.deepEqual(webhookBatchListInput.parse({ scheduleId, status, limit: 1 }), { scheduleId, status, limit: 1 })
  }
  assert.equal(webhookBatchListInput.safeParse({ scheduleId, status: 'pending' }).success, false)
  assert.equal(webhookBatchListInput.safeParse({ scheduleId, limit: 0 }).success, false)
  assert.equal(webhookBatchListInput.safeParse({ scheduleId, limit: 101 }).success, false)
})

test('run settings belong to a dispatched task; an existing thread and its ID come together', () => {
  const dispatch = { ...base, task: { kind: 'dispatch_task', botId: null, prompt: 'Fix CI' } } as const
  const thread = '0f8a4a62-8f3f-4c2f-a1f8-5d6b2a0c9e11'
  assert.equal(definitionSchema.safeParse({ ...base, environmentId: thread }).success, false, 'a reminder has no Environment')
  assert.equal(definitionSchema.safeParse({ ...base, description: 'Says hello' }).success, true, 'any automation has a description')
  assert.equal(definitionSchema.safeParse({ ...dispatch, environmentId: thread, model: { id: 'claude-haiku-5-5', effort: 'low' }, machineSize: 'standard-4-16', runs: { pin: true } }).success, true)
  assert.equal(definitionSchema.safeParse({ ...dispatch, machineSize: 'huge' }).success, false)
  assert.equal(definitionSchema.safeParse({ ...dispatch, model: { id: 'x', effort: 'extreme' } }).success, false)
  assert.equal(definitionSchema.safeParse({ ...dispatch, eachRun: 'existing_thread' }).success, false)
  assert.equal(definitionSchema.safeParse({ ...dispatch, singleThreadId: thread }).success, false)
  assert.equal(definitionSchema.safeParse({ ...dispatch, eachRun: 'existing_thread', singleThreadId: thread }).success, true)
})

test('a stored request keeps its valid run settings when one field does not fit, and names the dropped one', () => {
  const environmentId = '6b1f1a2e-0d7b-4c57-9b0e-0e6f1f0b9a11'
  assert.deepEqual(parseRunSettings({ environmentId, machineSize: 'huge', pin: true, extra: 1 }),
    { settings: { environmentId, pin: true }, dropped: ['machineSize', 'extra'] })
  assert.deepEqual(parseRunSettings({ model: { id: 'gpt-6-luna', effort: 'extreme' }, environmentId }), { settings: { environmentId }, dropped: ['model'] })
  assert.deepEqual(parseRunSettings(undefined), { settings: {}, dropped: [] })
  assert.deepEqual(parseRunSettings('pin'), { settings: {}, dropped: ['run'] })
})

test('run_as is a command of its own; an action the store has no branch for is refused', () => {
  const id = '0f8a4a62-8f3f-4c2f-a1f8-5d6b2a0c9e11'
  assert.equal(commandSchema.safeParse({ action: 'run_as', scheduleId: id, version: 1, userId: null }).success, true)
  assert.equal(commandSchema.safeParse({ action: 'run_as_someone', scheduleId: id, version: 1, userId: null }).success, false)
})
