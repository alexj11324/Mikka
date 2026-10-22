import assert from 'node:assert/strict'
import { test } from 'node:test'
import { composioCallbackVerifierURL, isComposioCallbackVerifierConfigured } from './composio-config'

test('builds the callback verifier URL under the app base path', () => {
  assert.equal(
    composioCallbackVerifierURL('https://app.aspectlylabs.com', '/mikka'),
    'https://app.aspectlylabs.com/mikka/api/integrations/composio/callback',
  )
})

test('requires the configured Composio verifier URL to match exactly', () => {
  const previous = process.env.COMPOSIO_CALLBACK_VERIFIER_URL
  process.env.COMPOSIO_CALLBACK_VERIFIER_URL = 'https://app.aspectlylabs.com/mikka/api/integrations/composio/callback'
  try {
    assert.equal(isComposioCallbackVerifierConfigured('https://app.aspectlylabs.com', '/mikka'), true)
    assert.equal(isComposioCallbackVerifierConfigured('https://preview.example.com', '/mikka'), false)
  } finally {
    if (previous === undefined) delete process.env.COMPOSIO_CALLBACK_VERIFIER_URL
    else process.env.COMPOSIO_CALLBACK_VERIFIER_URL = previous
  }
})
