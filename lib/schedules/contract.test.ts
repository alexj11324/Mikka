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
