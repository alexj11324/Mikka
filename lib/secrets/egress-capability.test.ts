import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { CodedError } from '@mikka/protocol/coded-error'
import { sealSecret } from './crypto'
import { EGRESS_CAPABILITY_TTL_MS, issueEgressCapability, openEgressCapability, type EgressCapabilityBinding } from './egress-capability'

const now = Date.parse('2026-11-08T12:00:00.000Z')
const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
const binding: EgressCapabilityBinding = {
  ownerId: 'owner-a', workspaceId: 'workspace-a', repository: 'owner/repository',
  runId: 'run-a', deviceId: 'device-a', deviceTokenId: 'credential-a', attempt: 2,
}
const input: Parameters<typeof issueEgressCapability>[0] = {
  ...binding, name: 'EXAMPLE_API_KEY', secretId: 'secret-row-a', secret: 'synthetic-canary-do-not-deliver-to-agent', revision: 'a'.repeat(64),
  http: { origin: 'https://api.example.com', header: 'authorization' as const, prefix: 'Bearer ', rules: [{ method: 'GET' as const, path: '/v1/widgets', match: 'prefix' as const }] },
  leaseExpiresAt: now + 300_000,
}
const issue = (overrides: Partial<typeof input> = {}) => issueEgressCapability({ ...input, ...overrides }, now, env)
const reason = (detail: string) => (error: unknown) => error instanceof CodedError && error.code === 'task_secret_unavailable' && error.detail === detail

test('sealed grants keep the value opaque, preserve scope/revision, and use fresh nonces', () => {
  const first = issue(), second = issue()
  assert.notEqual(first.capability, second.capability)
  assert.equal(first.name, input.name)
  assert.equal(first.origin, input.http.origin)
  assert.equal(first.expiresAt, new Date(now + EGRESS_CAPABILITY_TTL_MS).toISOString())
  for (const value of [first.capability, Buffer.from(first.capability.split('.')[1], 'base64url').toString('latin1')])
    assert.ok(!value.includes(input.secret))
  const opened = openEgressCapability(first.capability, binding, now, env)
  assert.equal(opened.secret, input.secret)
  assert.equal(opened.revision, input.revision)
  assert.equal(opened.secretId, input.secretId)
  for (const field of Object.keys(binding) as Array<keyof EgressCapabilityBinding>) assert.equal(opened[field], binding[field])
})

test('owner, workspace, repository, run, device, credential and attempt all remain bound', () => {
  const grant = issue()
  for (const field of Object.keys(binding) as Array<keyof EgressCapabilityBinding>) {
    const expected = { ...binding, [field]: field === 'attempt' ? 3 : `different-${field}` }
    assert.throws(() => openEgressCapability(grant.capability, expected, now, env), reason('binding_mismatch'), field)
  }
  assert.throws(() => openEgressCapability(grant.capability, { workspaceId: null }, now, env), reason('binding_mismatch'))
  const personal = issueEgressCapability({ ...input, workspaceId: null, repository: null }, now, env)
  assert.equal(openEgressCapability(personal.capability, { workspaceId: null, repository: null }, now, env).workspaceId, null)
})

test('expiry is the smaller of 90 seconds and the current lease, with no grace or self-renewal', () => {
  const grant = issue({ leaseExpiresAt: now + 12_345 })
  assert.equal(openEgressCapability(grant.capability, binding, now + 12_344, env).expiresAt, now + 12_345)
  assert.throws(() => openEgressCapability(grant.capability, binding, now + 12_345, env), reason('expired_capability'))
  assert.throws(() => openEgressCapability(grant.capability, binding, now - 1, env), reason('expired_capability'))
  for (const leaseExpiresAt of [now, now - 1, NaN, Infinity]) assert.throws(() => issue({ leaseExpiresAt }), reason('expired_capability'))
  assert.throws(() => issueEgressCapability({ ...input, leaseExpiresAt: 'bad' }, now, env), reason('expired_capability'))
  assert.equal(issueEgressCapability({ ...input, leaseExpiresAt: new Date(now + 2_000) }, now, env).expiresAt, new Date(now + 2_000).toISOString())
  assert.equal(issueEgressCapability({ ...input, leaseExpiresAt: new Date(now + 3_000).toISOString() }, now, env).expiresAt, new Date(now + 3_000).toISOString())
})

test('tampering, alternate framing, the wrong encryption key and unrelated ciphertext all fail closed', () => {
  const { capability } = issue()
  const bytes = Buffer.from(capability.split('.')[1], 'base64url')
  bytes[14] ^= 1
  for (const bad of ['', 'not-a-token', capability.replace('v1', 'v2'), `${capability}=`, `${capability}.suffix`, capability.slice(0, -8),
    `mikka-egress-v1.${bytes.toString('base64url')}`, `mikka-egress-v1.${'A'.repeat(65_536)}`])
    assert.throws(() => openEgressCapability(bad, binding, now, env), reason('invalid_capability'))
  assert.throws(() => openEgressCapability(capability, binding, now, { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }), reason('invalid_capability'))
  const row = sealSecret(JSON.stringify({ ...input, version: 1, issuedAt: now, expiresAt: now + 90_000 }), 'workspace_secret', env)
  const body = Buffer.concat([Buffer.from(row.iv, 'base64'), Buffer.from(row.ciphertext, 'base64')])
  assert.throws(() => openEgressCapability(`mikka-egress-v1.${body.toString('base64url')}`, binding, now, env), reason('invalid_capability'))
})

test('missing encryption configuration cannot issue or open a grant', () => {
  assert.throws(() => issueEgressCapability(input, now, {}), reason('configuration'))
  assert.throws(() => openEgressCapability(issue().capability, binding, now, {}), reason('configuration'))
})

test('issuance accepts only bounded HTTP-header secrets and explicit canonical policies', () => {
  for (const secret of ['', 'canary\r\nX-Other: value', 'binary\u0000key', '非ASCII', 'x'.repeat(32 * 1024 + 1)])
    assert.throws(() => issue({ secret }), reason('invalid_capability'))
  for (const origin of ['http://api.example.com', 'https://user:password@api.example.com', 'https://api.example.com/private', 'https://api.example.com?next=evil'])
    assert.throws(() => issue({ http: { ...input.http, origin } }), reason('invalid_capability'))
  assert.throws(() => issue({ http: { ...input.http, origin: `https://${'a'.repeat(512)}.example.com` } }), reason('invalid_capability'))
  assert.equal(openEgressCapability(issue({ http: { ...input.http, origin: 'https://api.example.com/' } }).capability, binding, now, env).http.origin, 'https://api.example.com')
  assert.throws(() => issue({ http: { ...input.http, prefix: 'Bearer\r\n' } }), reason('invalid_capability'))
  assert.throws(() => issue({ http: { ...input.http, rules: [{ method: 'GET', path: '/v1/%2e%2e', match: 'prefix' }] } }), reason('invalid_capability'))
  assert.throws(() => issue({ http: { ...input.http, rules: Array.from({ length: 32 }, () => ({ method: 'GET' as const, path: '/' + 'x'.repeat(2_000), match: 'exact' as const })) } }), reason('limit_exceeded'))
})
