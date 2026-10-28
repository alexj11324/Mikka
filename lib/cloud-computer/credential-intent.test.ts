import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialIntentSchema, credentialStep } from './credential-intent'

test('credential intent contains only an observed target', () => {
  assert.deepEqual(credentialIntentSchema.parse({ targetSelector: '[data-mikka-ref="12"]' }), { targetSelector: '[data-mikka-ref="12"]' })
  for (const intent of [
    { targetSelector: 'input[type=password]' },
    { targetSelector: '[data-mikka-ref="1"];alert(1)' },
    { targetSelector: '[data-mikka-ref="1"]', secret: 'synthetic' },
    { targetSelector: '[data-mikka-ref="1"]', action: 'evaluate' },
  ]) assert.equal(credentialIntentSchema.safeParse(intent).success, false)
})

test('session application and submission require a later observation', () => {
  assert.equal(credentialStep('session_applied'), 'running')
  assert.equal(credentialStep('submitted'), 'running')
  assert.equal(credentialStep('needs_login'), 'waiting')
})
