import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { homeScopeProof, readHomeScopeProof } from './home-scope-proof'
import { liveChannelId } from './scope'
import { deviceGatewayTicketValid } from '../device-gateway-ticket'
import { readDevicePresenceGrant } from '../device-presence-grant'

const now = 1_800_000_000_000, secret = 'local-home-scope-proof-test'
const scope = { ownerId: 'owner', workspaceId: '19df8afd-0f8c-4c6b-bc9c-20df0b046a72' }

test('the home routing proof binds the exact owner and home until the existing ticket expiry', () => {
  const proof = homeScopeProof(scope, now + 120_000, secret, now)!
  assert.deepEqual(readHomeScopeProof(proof.token, 'owner', secret, now), { ...scope, expiresAt: proof.expiresAt })
  assert.equal(readHomeScopeProof(proof.token, 'other-owner', secret, now), null)
  assert.equal(readHomeScopeProof(proof.token, 'owner', 'wrong-secret', now), null)
  assert.equal(readHomeScopeProof(proof.token, 'owner', secret, proof.expiresAt - 1)?.expiresAt, proof.expiresAt)
  assert.equal(readHomeScopeProof(proof.token, 'owner', secret, proof.expiresAt), null)
  const [encoded, signature] = proof.token.split('.')
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encoded, 'base64url').toString()), workspaceId: 'e4ec7f73-0a59-4ad4-8b3c-41f8cd510c6d' })).toString('base64url')
  assert.equal(readHomeScopeProof(`${changed}.${signature}`, 'owner', secret, now), null)
})

test('home routing metadata cannot be reused as socket or device presence authority', () => {
  const proof = homeScopeProof(scope, now + 120_000, secret, now)!, channel = liveChannelId(scope)
  assert.equal(readDevicePresenceGrant(proof.token, channel, secret, now), null)
  assert.equal(deviceGatewayTicketValid(`live:${channel}`, proof.token, secret, now), false)
  const encoded = proof.token.split('.')[0]
  const wrongDomain = createHmac('sha256', secret).update(`mikka-presence-v1.${encoded}`).digest('hex')
  assert.equal(readHomeScopeProof(`${encoded}.${wrongDomain}`, 'owner', secret, now), null)
})

test('bounded closed metadata rejects malformed, expired and overlong proofs', () => {
  assert.equal(homeScopeProof(scope, now, secret, now), null)
  assert.equal(homeScopeProof(scope, now + 300_001, secret, now), null)
  assert.equal(homeScopeProof(scope, NaN, secret, now), null)
  assert.equal(homeScopeProof(scope, now + 1, '', now), null)
  assert.equal(homeScopeProof({ ...scope, ownerId: 'x'.repeat(201) }, now + 1, secret, now), null)
  assert.equal(homeScopeProof({ ...scope, workspaceId: 'not-a-workspace' }, now + 1, secret, now), null)
  const encoded = Buffer.from(JSON.stringify({ v: 1, ...scope, expiresAt: now + 1, device: 'caller-device' })).toString('base64url')
  const signature = createHmac('sha256', secret).update(`mikka-presence-home-v1.${encoded}`).digest('hex')
  assert.equal(readHomeScopeProof(`${encoded}.${signature}`, 'owner', secret, now), null)
  for (const value of ['', 'invalid', `${'x'.repeat(1024)}.${'a'.repeat(64)}`, '%%%.' + 'a'.repeat(64)]) assert.equal(readHomeScopeProof(value, 'owner', secret, now), null)
})
