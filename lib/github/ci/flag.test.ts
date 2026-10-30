import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { CI_RESUME_FLAG, ciResumeEnabled } from './flag'

test('CI resume is off unless MIKKA_CI_RESUME_ENABLED is exactly "1"', () => {
  assert.equal(CI_RESUME_FLAG, 'MIKKA_CI_RESUME_ENABLED')
  assert.equal(ciResumeEnabled({}), false)
  for (const value of ['', '0', 'true', 'yes', 'on', ' 1', '1 ', 'TRUE']) assert.equal(ciResumeEnabled({ MIKKA_CI_RESUME_ENABLED: value }), false, value)
  assert.equal(ciResumeEnabled({ MIKKA_CI_RESUME_ENABLED: '1' }), true)
})
