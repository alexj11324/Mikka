import assert from 'node:assert/strict'
import test from 'node:test'
import { compactAge } from './compact-age'

const words = (key: string, values?: { n: number }) => key === 'now' ? 'now' : `${values?.n}${key}`

test('an age reads as Capy\'s sidebar writes it: now, seconds, minutes, hours, days, weeks, years', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()
  assert.equal(compactAge(ago(2_000), now, words), 'now')
  assert.equal(compactAge(ago(45_000), now, words), '45s')
  assert.equal(compactAge(ago(12 * 60_000), now, words), '12m')
  assert.equal(compactAge(ago(3 * 3_600_000), now, words), '3h')
  assert.equal(compactAge(ago(2 * 86_400_000), now, words), '2d')
  assert.equal(compactAge(ago(15 * 86_400_000), now, words), '2w')
  assert.equal(compactAge(ago(400 * 86_400_000), now, words), '1y')
  assert.equal(compactAge(null, now, words), '')
  assert.equal(compactAge('not a date', now, words), '')
})
