import assert from 'node:assert/strict'
import test from 'node:test'
import { approveSecretDelivery, effectiveSecretDelivery, secretDeliveryInput, secretHttpPolicy, type SecretHttpPolicy } from './delivery'
import { createSecretInput, createUserSecretInput, importSecretsInput, importUserSecretsInput, replaceSecretInput, replaceUserSecretInput } from './format'

const http: SecretHttpPolicy = {
  origin: 'https://api.example.com', header: 'authorization', prefix: 'Bearer ',
  rules: [{ method: 'GET', path: '/v1/items', match: 'exact' }],
}
const id = '00000000-0000-4000-8000-000000000001'
const now = new Date('2026-11-08T12:00:00.000Z')

test('legacy, missing, malformed and unapproved direct metadata remain protected', () => {
  for (const input of [undefined, null, {}, { mode: 'direct' }, { mode: 'direct', exposeToAgent: true },
    { mode: 'direct', exposeToAgent: false, approvedBy: 'user', approvedAt: now.toISOString() },
    { mode: 'direct', exposeToAgent: true, approvedBy: '', approvedAt: now.toISOString() },
    { mode: 'direct', exposeToAgent: true, approvedBy: 'user', approvedAt: 'yesterday' },
    { mode: 'protected', http: { ...http, origin: 'http://api.example.com' } }, { mode: 'future' }]) {
    assert.deepEqual(effectiveSecretDelivery(input), { mode: 'protected' })
  }
  assert.deepEqual(approveSecretDelivery(undefined, 'user'), { mode: 'protected' })
})

test('direct mode requires explicit acknowledgement and server-authored approval on each requested transition', () => {
  for (const input of [{ mode: 'direct' }, { mode: 'direct', exposeToAgent: false },
    { mode: 'direct', exposeToAgent: true, approvedBy: 'forged' },
    { mode: 'direct', exposeToAgent: true, approvedAt: now.toISOString() }]) {
    assert.equal(secretDeliveryInput.safeParse(input).success, false)
  }
  const approved = approveSecretDelivery({ mode: 'direct', exposeToAgent: true }, 'signed-in-user', now)
  assert.deepEqual(approved, { mode: 'direct', exposeToAgent: true, approvedBy: 'signed-in-user', approvedAt: now.toISOString() })
  assert.deepEqual(approveSecretDelivery(undefined, 'another-user', new Date(), approved), approved, 'value or note changes keep the original approval')
  assert.deepEqual(approveSecretDelivery({ mode: 'protected' }, 'user', now, approved), { mode: 'protected' }, 'protecting again removes the previous exposure approval')
})

test('protected policy is constrained to HTTPS origin, safe header and bounded method/path rules', () => {
  assert.deepEqual(secretHttpPolicy.parse({ ...http, origin: 'https://API.example.com/' }), http)
  for (const origin of ['http://api.example.com', 'https://user:pass@api.example.com', 'https://api.example.com/path',
    'https://api.example.com?token=secret', 'https://api.example.com#secret', 'https://api.example.com./',
    ' https://api.example.com', 'https://api.example.com\\@evil.example']) {
    assert.equal(secretHttpPolicy.safeParse({ ...http, origin }).success, false, origin)
  }
  for (const path of ['', '//evil.example/path', '/v1/../admin', '/v1/./admin', '/v1/%2e%2e/admin',
    '/v1/%252fadmin', '/v1?key=secret', '/v1#frag', '/v1\\admin', '/v1\nadmin', '/v1 admin']) {
    assert.equal(secretHttpPolicy.safeParse({ ...http, rules: [{ method: 'GET', path, match: 'prefix' }] }).success, false, path)
  }
  for (const invalid of [{ header: 'cookie' }, { prefix: 'Bearer \r\nX-Other: value' }, { rules: [] },
    { rules: Array.from({ length: 33 }, () => http.rules[0]) },
    { rules: [{ method: 'CONNECT', path: '/', match: 'prefix' }] }, { extra: true }]) {
    assert.equal(secretHttpPolicy.safeParse({ ...http, ...invalid }).success, false)
  }
})

test('existing create/replace inputs accept value-free delivery edits; env and bulk cannot opt into plaintext delivery', () => {
  for (const schema of [createSecretInput, createUserSecretInput]) {
    assert.equal(schema.safeParse({ name: 'API_TOKEN', kind: 'secret', value: 'synthetic-canary', delivery: { mode: 'protected', http } }).success, true)
    assert.equal(schema.safeParse({ name: 'API_TOKEN', kind: 'secret', value: 'synthetic-canary', delivery: { mode: 'direct' } }).success, false)
    assert.equal(schema.safeParse({ name: 'REGION', kind: 'env', value: 'eu', delivery: { mode: 'direct', exposeToAgent: true } }).success, false)
    assert.equal(schema.safeParse({ name: 'REGION', kind: 'env', value: 'eu' }).success, true)
  }
  for (const schema of [replaceSecretInput, replaceUserSecretInput]) {
    assert.equal(schema.safeParse({ id, delivery: { mode: 'protected', http } }).success, true)
    assert.equal(schema.safeParse({ id }).success, false)
  }
  const bulk = { text: 'TOKEN=synthetic-canary', masked: true, onConflict: 'replace', delivery: { mode: 'direct', exposeToAgent: true } }
  assert.equal(importSecretsInput.safeParse({ ...bulk, scope: { type: 'workspace' } }).success, false)
  assert.equal(importUserSecretsInput.safeParse(bulk).success, false)
})
