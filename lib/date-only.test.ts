import assert from 'node:assert/strict'
import test from 'node:test'
import { createFormatter } from 'next-intl'
import { formatDateOnly } from './date-only'

const ZONES = ['America/Los_Angeles', 'Pacific/Honolulu', 'UTC', 'Asia/Shanghai', 'Pacific/Kiritimati']

test('a due date reads as the same day in every time zone, negative ones included', () => {
  const original = process.env.TZ
  try {
    for (const processZone of ZONES) {
      process.env.TZ = processZone
      for (const timeZone of ZONES) {
        assert.equal(formatDateOnly(createFormatter({ locale: 'zh-CN', timeZone }), '2026-10-30', { month: 'short', day: 'numeric' }), '10月30日', `${processZone} → ${timeZone}`)
        assert.equal(formatDateOnly(createFormatter({ locale: 'en', timeZone }), '2026-01-01', { month: 'short', day: 'numeric' }), 'Jan 1', `${processZone} → ${timeZone}`)
      }
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})
