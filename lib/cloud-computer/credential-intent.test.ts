import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialIntentSchema, credentialStep } from './credential-intent'

test('credential intent contains only an observed target and a bounded purpose', () => {
  assert.deepEqual(credentialIntentSchema.parse({ action: 'fill_login', targetSelector: '[data-mikka-ref="12"]' }), { action: 'fill_login', targetSelector: '[data-mikka-ref="12"]' })
  for (const intent of [
    { action: 'fill_login', targetSelector: 'input[type=password]' },
    { action: 'submit_login', targetSelector: '[data-mikka-ref="1"];alert(1)' },
    { action: 'fill_login', targetSelector: '[data-mikka-ref="1"]', secret: 'synthetic' },
    { action: 'evaluate', targetSelector: '[data-mikka-ref="1"]' },
  ]) assert.equal(credentialIntentSchema.safeParse(intent).success, false)
})

test('session application and submission require a later observation', () => {
  assert.equal(credentialStep('session_applied'), 'running')
  assert.equal(credentialStep('submitted'), 'running')
  assert.equal(credentialStep('needs_login'), 'waiting')
})
