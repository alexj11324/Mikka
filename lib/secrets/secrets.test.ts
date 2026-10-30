// Unit tests: crypto (fail closed, AAD binding) and input rules. Uses a random per-run key only.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { openSecret, sealSecret, secretAad, secretsKey, SecretsKeyMissingError } from './crypto'
import { checkEgressDomains, createSecretInput, updateEgressInput } from './format'

const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
const row = { workspaceId: '00000000-0000-4000-8000-000000000001', kind: 'secret', scopeType: 'workspace', scopeRef: '', name: 'API_TOKEN' }

test('missing or malformed key fails closed', () => {
  for (const bad of [undefined, '', 'short', 'z'.repeat(64), randomBytes(16).toString('hex')])
    assert.throws(() => secretsKey({ WORKSPACE_SECRETS_KEY: bad }), SecretsKeyMissingError)
  assert.throws(() => sealSecret('v', 'aad', {}), SecretsKeyMissingError)
  const sealed = sealSecret('v', 'aad', env)
  assert.throws(() => openSecret(sealed, 'aad', {}), SecretsKeyMissingError)
  assert.equal(secretsKey({ WORKSPACE_SECRETS_KEY: randomBytes(32).toString('base64') }).length, 32)
})

test('round trip; ciphertext hides the value and is bound to its row', () => {
  const value = 'sk_live_supersecretvalue'
  const sealed = sealSecret(value, secretAad(row), env)
  assert.ok(!sealed.ciphertext.includes(value) && !Buffer.from(sealed.ciphertext, 'base64').toString('latin1').includes(value))
  assert.equal(openSecret(sealed, secretAad(row), env), value)
  assert.notEqual(sealSecret(value, secretAad(row), env).iv, sealed.iv)
  assert.throws(() => openSecret(sealed, secretAad({ ...row, name: 'OTHER' }), env))
  assert.throws(() => openSecret(sealed, secretAad(row), { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }))
})

test('names, scopes and egress input', () => {
  assert.deepEqual(createSecretInput.parse({ name: 'NODE_ENV', kind: 'env', value: 'production' }).scope, { type: 'workspace' })
  for (const name of ['1ABC', 'A-B', 'A B', '', 'x'.repeat(129)]) assert.throws(() => createSecretInput.parse({ name, kind: 'secret', value: 'v' }), name)
  assert.throws(() => createSecretInput.parse({ name: 'A', kind: 'secret', value: '' }))
  assert.throws(() => createSecretInput.parse({ name: 'A', kind: 'secret', value: 'x'.repeat(32 * 1024 + 1) }))
  assert.throws(() => createSecretInput.parse({ name: 'A', kind: 'secret', value: 'v', scope: { type: 'repository', repository: 'not a repo' } }))
  assert.throws(() => updateEgressInput.parse({ mode: 'deny', allowedDomains: [] }))
  assert.deepEqual(checkEgressDomains(['example.com', ' *.Mikka.app ', '', 'example.com', '*.com', 'a*.b.com', 'http://x.com', '-a.com', 'x..com']),
    { domains: ['example.com', '*.mikka.app'], invalid: [4, 5, 6, 7, 8] })
})
