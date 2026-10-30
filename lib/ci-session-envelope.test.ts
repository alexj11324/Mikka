import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { openCiSession, sealCiSession, type CiSessionScope } from './ci-session-envelope'

test('session ciphertext is bound to every scope field and rejects tampering', () => {
  const scope: CiSessionScope = { ownerId: 'owner', workspaceId: 'workspace', consumerId: 'agent', bindingId: 'binding', accountId: 'account', route: 'codex_cli', revision: 4, modelId: 'model', runId: 'run', sessionId: 'session' }
  const secret = 'synthetic-test-key-with-at-least-32-bytes'
  const plain = Buffer.from('synthetic session contents')
  const sealed = sealCiSession(scope, plain, secret)
  assert.equal(sealed.includes(plain), false)
  assert.deepEqual(openCiSession(scope, sealed, secret), plain)
  for (const field of Object.keys(scope) as (keyof CiSessionScope)[]) {
    const altered = { ...scope, [field]: field === 'revision' ? 5 : 'different' }
    assert.throws(() => openCiSession(altered, sealed, secret))
  }
  const corrupted = Buffer.from(sealed); corrupted[corrupted.length - 1] ^= 1
  assert.throws(() => openCiSession(scope, corrupted, secret))
  assert.throws(() => openCiSession(scope, sealed, 'another-synthetic-key-with-32-bytes'))
  assert.throws(() => sealCiSession(scope, Buffer.alloc(0), secret))
  assert.throws(() => sealCiSession(scope, Buffer.alloc(8 * 1024 * 1024 + 1), secret))
})
