import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { issueTaskSecretAccess } from './task-access'
import { openEgressCapability } from './egress-capability'
import type { TaskSecretInjection } from './runtime'

const now = Date.now()
const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
const canary = `synthetic-only-${randomBytes(24).toString('hex')}`
const binding = { ownerId: 'owner-a', workspaceId: randomUUID(), repository: 'owner/repo', runId: randomUUID(), deviceId: randomUUID(), deviceTokenId: randomUUID(), attempt: 1 }
const http = { origin: 'https://api.example.com', header: 'authorization' as const, prefix: 'Bearer ', rules: [{ method: 'POST' as const, path: '/v1/items', match: 'exact' as const }] }
const secret = { id: randomUUID(), revision: 'a'.repeat(64), name: 'VENDOR_TOKEN', kind: 'secret' as const, value: canary, delivery: { mode: 'protected' as const, http } }
const injection = (): TaskSecretInjection => ({ env: { REGION: 'test' }, secretNames: [], protectedSecrets: [secret], unavailable: ['SIGNING_KEY'] })
const issue = (value: TaskSecretInjection) => issueTaskSecretAccess({ binding, injection: value, endpoint: `https://app.example.com/mikka/v1/task-secrets/${binding.runId}`, leaseExpiresAt: new Date(now + 90_000) }, now, env)

test('a claim seals its exact scope without exposing the canary in the assignment', () => {
  const prepared = injection()
  const access = issue(prepared)!
  assert.equal(access.grants.length, 1)
  assert.deepEqual(access.unavailable, ['SIGNING_KEY'])
  assert.equal(JSON.stringify(access).includes(canary), false)
  assert.deepEqual(prepared.env, { REGION: 'test' })
  assert.deepEqual(prepared.secretNames, [])
  const claims = openEgressCapability(access.grants[0].capability, binding, now, env)
  assert.equal(claims.secret, canary)
  assert.equal(claims.secretId, secret.id)
  assert.equal(claims.revision, secret.revision)
  assert.deepEqual(claims.http, http)
})

test('direct compatibility is explicit input to env and never inferred by the grant issuer', () => {
  const prepared: TaskSecretInjection = { env: { LEGACY_KEY: canary }, secretNames: ['LEGACY_KEY'], protectedSecrets: [], unavailable: [] }
  assert.equal(issue(prepared), undefined)
  assert.equal(prepared.env.LEGACY_KEY, canary)
  const unavailable = issue({ ...prepared, env: {}, secretNames: [], unavailable: ['LEGACY_KEY'] })!
  assert.deepEqual(unavailable.grants, [])
  assert.deepEqual(unavailable.unavailable, ['LEGACY_KEY'])
  assert.equal(JSON.stringify(unavailable).includes(canary), false)
})

test('an unsupported signing key, missing revision or malformed policy stays protected', () => {
  for (const invalid of [ { ...secret, value: '-----BEGIN KEY-----\nsynthetic\n-----END KEY-----' },
    { ...secret, revision: undefined }, { ...secret, id: undefined },
    { ...secret, delivery: { mode: 'protected' as const } } ]) {
    const access = issue({ env: {}, secretNames: [], protectedSecrets: [invalid], unavailable: [] })!
    assert.deepEqual(access.grants, [])
    assert.deepEqual(access.unavailable, ['VENDOR_TOKEN'])
    assert.equal(JSON.stringify(access).includes(canary), false)
  }
})

test('capability limits report additional secrets as unavailable without plaintext fallback', () => {
  const many = Array.from({ length: 33 }, (_, index) => ({ ...secret, name: `VENDOR_${index}` }))
  const access = issue({ env: {}, secretNames: [], protectedSecrets: many, unavailable: [] })!
  assert.equal(access.grants.length, 32)
  assert.deepEqual(access.unavailable, ['VENDOR_32'])
  assert.equal(JSON.stringify(access).includes(canary), false)
  const large = issue({ env: {}, secretNames: [], protectedSecrets: many.map(item => ({ ...item, value: 's'.repeat(32 * 1024) })), unavailable: [] })!
  assert.ok(JSON.stringify(large).length < 262_144)
  assert.equal(large.grants.length + large.unavailable.length, 33)
  assert.ok(large.unavailable.length > 1)
})
