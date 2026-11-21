import assert from 'node:assert/strict'
import test from 'node:test'
import { fingerprint } from '../credentials/fingerprint'
import { reasoningText } from './reasoning-mask'

test('history reasoning masks known credential patterns and omits saved secrets', t => {
  const original = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = 'synthetic-reasoning-mask-key-00000000000000'
  t.after(() => { if (original === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = original })
  assert.equal(reasoningText('owner', '  Thinking  ', []), 'Thinking')
  assert.equal(reasoningText('owner', '   ', []), undefined)
  const secret = 'SYNTHETIC-SAVED-CREDENTIAL'
  assert.equal(reasoningText('owner', `Do not display ${secret}`, [fingerprint('owner', secret)]), undefined)
})
