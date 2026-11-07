import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiCache } from '../lib/api-cache.ts'
import { PresenceScopeCache } from '../lib/presence-scope.ts'

const home = '19df8afd-0f8c-4c6b-bc9c-20df0b046a72', team = 'e4ec7f73-0a59-4ad4-8b3c-41f8cd510c6d'
const start = 1_800_000_000_000, token = `home.${'a'.repeat(64)}`
const receipt = (expiresAt = start + 120_000, ownerId = 'owner', workspaceId = home) => ({ expiresAt, homeScope: { ownerId, workspaceId, expiresAt, token } })
function fixture() {
  let now = start
  const cache = new ApiCache(); cache.setIdentity('owner')
  const proofs = new PresenceScopeCache(cache, () => now)
  return { cache, proofs, now: (value: number) => { now = value } }
}

test('only a current matching home receipt is held, and a team ticket cannot replace it', () => {
  const { cache, proofs } = fixture()
  proofs.remember(home, receipt(), proofs.begin())
  assert.equal(proofs.token(), token)
  proofs.remember(team, { expiresAt: start + 120_000 }, proofs.begin())
  assert.equal(proofs.token(), token, 'a normal team ticket does not remove the existing personal home')
  cache.clear()
  assert.equal(proofs.token(), token, 'an already accepted home remains this owner\'s home after a selected workspace change')
  proofs.remember(home, receipt(start + 120_000, 'other-owner'), proofs.begin())
  assert.equal(proofs.token(), null)
})

test('late tickets are fenced by workspace context, account changes and explicit sign-out', () => {
  const { cache, proofs } = fixture()
  const oldContext = proofs.begin()
  cache.clear(); proofs.remember(home, receipt(), oldContext)
  assert.equal(proofs.token(), null)
  const accountA = proofs.begin()
  cache.setIdentity('other-owner'); cache.setIdentity('owner')
  proofs.remember(home, receipt(), accountA)
  assert.equal(proofs.token(), null, 'A to B to A cannot revive the first A response')
  const beforeSignout = proofs.begin()
  proofs.clear(); proofs.remember(home, receipt(), beforeSignout)
  assert.equal(proofs.token(), null, 'clearing also fences a late response before the identity view updates')
  proofs.remember(home, receipt(), proofs.begin())
  const beforeHeaders = cache.context(); cache.clear()
  assert.equal(proofs.token(beforeHeaders), null, 'a request awaiting session headers cannot acquire a new context\'s proof')
  cache.setIdentity('other-owner')
  assert.equal(proofs.token(), null)
})

test('expiry and rejected home renewals remove the proof without adding a timer or extending it', () => {
  const { proofs, now } = fixture()
  proofs.remember(home, receipt(start + 20), proofs.begin())
  now(start + 19); assert.equal(proofs.token(), token)
  now(start + 20); assert.equal(proofs.token(), null)
  now(start); proofs.remember(home, receipt(), proofs.begin())
  proofs.remember(home, null, proofs.begin()); assert.equal(proofs.token(), null)
  for (const value of [
    { ...receipt(), expiresAt: start + 119_999 },
    receipt(start + 305_001),
    receipt(start),
    receipt(start + 120_000, 'owner', team),
    { ...receipt(), homeScope: { ...receipt().homeScope, extra: true } },
    { ...receipt(), homeScope: { ...receipt().homeScope, token: 'malformed' } },
  ]) {
    proofs.remember(home, receipt(), proofs.begin())
    proofs.remember(home, value, proofs.begin())
    assert.equal(proofs.token(), null)
  }
})

test('the raw owner is verified within its server identity and a same-user server switch fences tickets', () => {
  const { cache, proofs } = fixture()
  cache.setIdentity('server-a:owner', 'owner')
  proofs.remember(home, receipt(), proofs.begin())
  assert.equal(proofs.token(), token, 'the server signs its user id without the mobile account namespace')
  const pendingA = proofs.begin()
  cache.setIdentity('server-b:owner', 'owner')
  assert.equal(proofs.token(), null, 'the same user id at another server cannot reuse this proof')
  proofs.remember(home, receipt(), pendingA)
  assert.equal(proofs.token(), null, 'a late ticket cannot cross servers')
  const tokenB = `other.${'b'.repeat(64)}`
  proofs.remember(home, { ...receipt(), homeScope: { ...receipt().homeScope, token: tokenB } }, proofs.begin())
  assert.equal(proofs.token(), tokenB)
  cache.setIdentity('server-a:owner', 'owner')
  assert.equal(proofs.token(), null)
  proofs.remember(home, receipt(), pendingA)
  assert.equal(proofs.token(), null, 'A to B to A cannot revive the earlier server context')
})
