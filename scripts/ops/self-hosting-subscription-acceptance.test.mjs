import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { accessFixture, cleanupScope, independentProviders, readProductionAccessLocation, readAuthorizedProjection, configureBoundSubscription, safeThreadFailure } from './self-hosting-subscription-acceptance.mjs'
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


test('access source uses the actual production configuration and its distinct access project without reading unrelated values', async () => {
  const publicProject = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
  const values = { MIKKA_BYOS_INFISICAL_PROJECT: '11111111-1111-4111-8111-111111111111', MIKKA_BYOS_ACCESS_INFISICAL_PROJECT: '22222222-2222-4222-8222-222222222222', MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'prod', MIKKA_BYOS_ACCESS_INFISICAL_PATH: '/actual-access' }
  const calls = [], rows = Object.keys(values).map((key, i) => ({ id: 'config'+i, key, type: 'sensitive', target: ['production'] }))
  rows.push({ id: 'never-read-private', key: 'PRIVATE_APPLICATION_SECRET', target: ['production'] })
  const sourceCalls = [], report = {}
  const location = await readProductionAccessLocation(async path => {
    calls.push(path)
    assert.equal(path, '/v10/projects/'+publicProject+'/env')
    return { envs: rows }
  }, async key => { sourceCalls.push(key); assert.ok(key in values); return values[key] }, report)
  assert.deepEqual(location, { project: values.MIKKA_BYOS_ACCESS_INFISICAL_PROJECT, environment: 'prod', path: '/actual-access' })
  assert.equal(calls.length, 1); assert.equal(sourceCalls.length, 4); assert.ok(sourceCalls.every(key => key in values))
  assert.ok(Object.values(report.sourceSelectorTypes).every(type => type === 'sensitive')); assert.equal(report.sourceLocationShape.projectIsUuid, true)
})

test('source projection reuses the normal custody identity for exactly one immutable access leaf and never exports its bearer', async () => {
  const calls = [], report = { sourceRequests: [] }, name = 'mikka-byos-33333333-3333-4333-8333-333333333333'
  const location = { project: '22222222-2222-4222-8222-222222222222', environment: 'prod', path: '/actual-access' }
  const value = 'synthetic-access-only'
  const raw = await readAuthorizedProjection({ location, name, clientId: 'existing-custody', clientSecret: 'synthetic-custody-secret', report,
    fetcher: async (url, init) => {
      const u = new URL(url); calls.push({ path: u.pathname, method: init.method })
      assert.equal(u.origin, 'https://app.infisical.com'); assert.equal(init.redirect, 'error')
      if (u.pathname === '/api/v1/auth/universal-auth/login') {
        assert.deepEqual(JSON.parse(init.body), { clientId: 'existing-custody', clientSecret: 'synthetic-custody-secret' })
        return Response.json({ accessToken: 'synthetic-derived-bearer', tokenType: 'Bearer' })
      }
      assert.equal(u.pathname, '/api/v4/secrets/'+name)
      assert.equal(u.searchParams.get('projectId'), location.project); assert.equal(u.searchParams.get('secretPath'), location.path)
      assert.equal(u.searchParams.get('version'), '1'); assert.equal(u.searchParams.get('expandSecretReferences'), 'false')
      assert.equal(init.headers.authorization, 'Bearer synthetic-derived-bearer')
      return Response.json({ secret: { secretKey: name, version: 1, secretValue: value } })
    } })
  assert.equal(raw, value); assert.equal(calls.length, 2)
  for (const secret of [value, 'synthetic-derived-bearer', 'synthetic-custody-secret']) assert.ok(!JSON.stringify(report).includes(secret))
  await assert.rejects(readAuthorizedProjection({ location, name: 'canonical-grant', report, fetcher: () => assert.fail('must not request') }), /SOURCE_PROJECTION_SCOPE/)
})


test('model selection materializes virtual defaults before removal and binds exactly the original small subscription', async () => {
  let customized = false, location = 'cloud', autoModelRouting = true, preferredHarness = 'claude_code'
  const selected = { harness: 'claude_code', model: 'claude-haiku-5-5', localConnection: target.connectionId }
  let entries = [
    { id: 'default:claude', harness: selected.harness, model: selected.model, source: { kind: 'subscription', connectionId: selected.localConnection } },
    { id: 'default:codex', harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: row.id } },
  ]
  const client = { rpc: async (action, args) => {
    if (action === 'model-order.getModelOrder') return structuredClone({ entries, location, autoModelRouting, preferredHarness })
    const [change] = args
    if (change.kind === 'location') { location = change.location; return }
    if (change.kind === 'preferred') { preferredHarness = change.harness; return }
    if (change.kind === 'autoRouting') { autoModelRouting = change.enabled; return }
    if (!customized) {
      const mapping = new Map(entries.map((e, i) => [e.id, 'stored-'+i])); entries = entries.map(e => ({ ...e, id: mapping.get(e.id) })); customized = true
      if (change.kind === 'remove') change.id = mapping.get(change.id) ?? change.id
    }
    if (change.kind === 'remove') { assert.ok(entries.some(e => e.id === change.id), 'virtual default id became stale'); entries = entries.filter(e => e.id !== change.id) }
    if (change.kind === 'add') for (const e of change.entries) if (!entries.some(old => old.harness === e.harness && old.model === e.model && old.source.connectionId === e.source.connectionId)) entries.push({ ...e, id: 'added' })
  } }
  await configureBoundSubscription(client, target.workspaceId, selected)
  assert.equal(entries.length, 1); assert.equal(entries[0].model, selected.model); assert.equal(entries[0].source.connectionId, selected.localConnection)
  assert.equal(location, 'local'); assert.equal(autoModelRouting, false); assert.equal(preferredHarness, selected.harness)
})


test('failed thread receipts retain only registered codes and stages, excluding provider text and prompts', () => {
 const secret = 'never-return-private-bearer'
 const out = safeThreadFailure({ thread: { status: 'failed', error: secret, failureDetails: { code: 'run_failed', detail: 'known', providerMessage: secret, causes: [{ name: 'WorkerRefusal', code: 'secret_not_found', message: secret }, { name: secret, code: secret }] } }, chunks: [{ chunk: { type: 'data-run-stage', data: { stage: 'repository', ok: false, stderr: secret } } }, { chunk: { type: 'text-delta', delta: secret } }] }, { run_failed: ['known'] })
 assert.equal(out.code, 'run_failed'); assert.equal(out.detail, 'known'); assert.equal(out.causes[0].code, 'secret_not_found')
 assert.deepEqual(out.stages, [{ stage: 'repository', ok: false }]); assert.ok(!JSON.stringify(out).includes(secret))
})

// Published artifact and actual served control-plane build identify this run; unserved Git HEAD is metadata only.
