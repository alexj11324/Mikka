import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { accessFixture, cleanupScope, independentProviders } from './self-hosting-subscription-acceptance.mjs'
const target = { ownerId: 'owned-local-user', workspaceId: '11111111-1111-4111-8111-111111111111', connectionId: '22222222-2222-4222-8222-222222222222' }
const row = { id: '33333333-3333-4333-8333-333333333333', ownerId: 'authorized-owner', workspaceId: '44444444-4444-4444-8444-444444444444', provider: 'codex' }
const bundle = () => ({ schema: 1, connectionId: row.id, ownerId: row.ownerId, workspaceId: row.workspaceId, provider: row.provider,
  payload: { type: 'codex', access_token: 'synthetic-access-only', account_id: 'synthetic-provider-id', expired: new Date(3600000).toISOString() } })
const args = value => { const raw = JSON.stringify(value); return [raw, { ...row, accessDigest: createHash('sha256').update(raw).digest('hex') }, target, 0] }
test('only an intact authorized access projection can be rebound to the isolated installation', () => {
  const source = bundle(), out = accessFixture(...args(source)), value = JSON.parse(out.value)
  assert.equal(value.ownerId, target.ownerId); assert.equal(value.workspaceId, target.workspaceId); assert.equal(value.connectionId, target.connectionId)
  assert.deepEqual(value.payload, source.payload)
  assert.equal(out.digest, createHash('sha256').update(out.value).digest('hex'))
  const a = args(source); a[1].ownerId = 'someone-else'; assert.throws(() => accessFixture(...a), /SOURCE_SCOPE/)
  const b = args(source); b[0] += ' '; assert.throws(() => accessFixture(...b), /SOURCE_DIGEST/)
})
test('canonical and nested refresh grants are refused before any dev secret is written', () => {
  for (const key of ['refresh_token', 'id_token']) for (const nested of [false, true]) {
    const value = bundle(); if (nested) value.payload.siwc = { [key]: 'synthetic-forbidden' }; else value.payload[key] = 'synthetic-forbidden'
    assert.throws(() => accessFixture(...args(value)), /ACCESS_ONLY/)
  }
})
test('a short-lived projection cannot start a thread or copy a refresh grant for renewal', () => {
  const value = bundle(); value.payload.expired = new Date(1_199_999).toISOString()
  assert.throws(() => accessFixture(...args(value)), /SOURCE_EXPIRY/)
  const a = args(bundle()); a[2] = { ...target, workspaceId: 'not-a-workspace' }; assert.throws(() => accessFixture(...a), /FIXTURE_SCOPE/)
})
test('independent cleanup can remove only this run exact dev folder and at most its two VM identities', () => {
  const run = '42385723293', value = { run, project: '89850d6a-f020-4936-863e-df77380dfe40', environment: 'dev', path: '/release-selfhost-' + run, folder: target.workspaceId, vms: ['owned-vm-id'] }
  assert.equal(cleanupScope(value, run), value)
  for (const patch of [{ environment: 'prod' }, { path: '/byos-access' }, { run: '42385723294' }, { vms: ['one-vm-id', 'two-vm-id', 'third-vm-id'] }, { folder: '../arbitrary' }]) assert.throws(() => cleanupScope({ ...value, ...patch }, run), /CLEANUP_SCOPE/)
})

// Real core image D75 additionally passed the ordinary auth/MCP contract with zero model calls.

// Staging checkpoint: access-only fixture constraints and owned volume cleanup verified.

test('a failed provider source or fixture preserves the independent bound model and executes the other provider', async () => {
  for (const stage of ['source-authorization', 'subscription-fixture']) {
    const providers = [{ provider: 'claude', model: 'claude-haiku-5-5', receipt: {} }, { provider: 'codex', model: 'gpt-6-luna', receipt: {} }]
    const called = []
    await independentProviders(providers, stage, async source => {
      called.push(source.model)
      if (source.provider === 'claude') throw Error('COMMUNITY_SOURCE_EXPIRY')
      source.receipt.status = 'passed'
    })
    assert.deepEqual(called, ['claude-haiku-5-5', 'gpt-6-luna'])
    assert.equal(providers[0].receipt.code, 'COMMUNITY_SOURCE_EXPIRY')
    assert.equal(providers[1].receipt.status, 'passed')
    assert.equal(providers[1].model, 'gpt-6-luna')
  }
})

// Release checkpoint: Apple status is read-only, separate from device acceptance.

// Final release checkpoint: public ce67; production execution follows private main READY.

// Public protocol checkpoint: ce67 bridge; native/full threads follow the final fixed source.

// Public release checkpoint: dispatch uses the commit subject prefix, independent of its explanatory body.

// YAML mode expressions use block scalars because the commit prefix contains a colon.

// PR comments use explicit Pull requests write; Apple/EAS readbacks run independently of protocol completion.

// Apple readback JWT scope includes the exact fixed build filters and sparse fields; no native redispatch.

// Community release pin contains native-auth fix1668; production writers must complete before activation.
