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
    { domains: ['example.com', '*.mikka.app'], invalid: [5, 6, 7, 8, 9], count: 7 })
})

test('egress: 1-based lines, bare IPs rejected, count after dropping empties and duplicates', () => {
  assert.deepEqual(checkEgressDomains(['ok.com', 'bad one']).invalid, [2])
  for (const ip of ['1.2.3.4', '10.0.0.1', '::1', '2001:db8::1', '[2001:db8::1]', 'fe80::1%eth0', '127.0.0.1.'])
    assert.deepEqual(checkEgressDomains([ip]).invalid, [1], ip)
  assert.deepEqual(checkEgressDomains(['1password.com', 'a1.b2.io', 's3.amazonaws.com']).invalid, [])
  const lines = [...Array.from({ length: 200 }, (_, i) => `d${i}.com`), '', '  ', 'D0.com', 'd1.com.']
  assert.equal(checkEgressDomains(lines).count, 200)
  assert.equal(checkEgressDomains([...lines, 'd200.com']).count, 201)
  assert.doesNotThrow(() => updateEgressInput.parse({ mode: 'allowlist', allowedDomains: Array.from({ length: 201 }, (_, i) => `d${i}.com`) }), 'the 200 rule is egressTooManyDomains, not a zod error')
})

test('repository scope: no . / .. segments; stored lowercase', () => {
  const repo = (repository: string) => createSecretInput.parse({ name: 'A', kind: 'env', value: 'v', scope: { type: 'repository', repository } }).scope
  assert.deepEqual(repo('AlexJ11324/Mikka'), { type: 'repository', repository: 'alexj11324/mikka' })
  assert.deepEqual(repo('o/.github'), { type: 'repository', repository: 'o/.github' })
  for (const bad of ['./x', '../x', 'o/.', 'o/..', '../..', './.']) assert.throws(() => repo(bad), bad)
})
