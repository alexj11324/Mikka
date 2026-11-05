import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hostedBrokerDevice, leaseDevice } from './subscription-native-device'
import { subscriptionNativeLease } from './subscription-native-lease'
import { subscriptionNativeHTTP } from './subscription-native-http'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { WorkerRefusal } from '../packages/daemon/src/subscription-worker-client'
import { DeviceAuthorityRevoked, DeviceFenceUnavailable } from './db/device-scope'
import { ModelAdmissionError } from './model-admission/contract'

const broker = [{ subscriptionBroker: true }]
const ids = { deviceId: '11111111-1111-4111-8111-111111111111', runId: '22222222-2222-4222-8222-222222222222' }

test('only a person\'s own enabled device with the capability takes a lease', () => {
  assert.equal(leaseDevice({ enabled: true, kind: 'local', harnesses: broker }), true)
  assert.equal(leaseDevice({ enabled: true, kind: 'cloud', harnesses: broker }), false)
  assert.equal(leaseDevice({ enabled: true, kind: 'local', harnesses: [{}] }), false)
  assert.equal(leaseDevice({ enabled: false, kind: 'local', harnesses: broker }), false)
  assert.equal(leaseDevice(null), false)
})

test('the hosted broker takes a cloud computer bound to its own token, or an allow-listed device', () => {
  const cloud = { enabled: true, kind: 'cloud', harnesses: broker }
  assert.equal(hostedBrokerDevice(cloud, ids.deviceId, ids.deviceId, ''), true, 'no id to list: the bound token is enough')
  assert.equal(hostedBrokerDevice(cloud, ids.deviceId, undefined, ''), false, 'an unbound token is not a cloud computer')
  assert.equal(hostedBrokerDevice(cloud, ids.deviceId, ids.runId, ''), false, 'a token bound to another machine')
  assert.equal(hostedBrokerDevice({ ...cloud, kind: 'local' }, ids.deviceId, ids.deviceId, ''), false, 'a person\'s own device uses the lease instead')
  assert.equal(hostedBrokerDevice({ ...cloud, harnesses: [{}] }, ids.deviceId, ids.deviceId, ''), false)
  assert.equal(hostedBrokerDevice({ ...cloud, enabled: false }, ids.deviceId, ids.deviceId, ''), false)
  assert.equal(hostedBrokerDevice({ ...cloud, kind: 'local' }, ids.deviceId, undefined, `x,${ids.deviceId}`), true, 'the allow-list still works')
  assert.equal(hostedBrokerDevice(null, ids.deviceId, ids.deviceId, ids.deviceId), false)
})

test('a failed self-test overrides an old broker flag for leases and hosted access', () => {
  for (const detail of ['env_not_clean', 'cli_missing', 'cli_version_mismatch', 'adapter_start_failed']) {
    const device = { enabled: true, kind: 'local', harnesses: [{ subscriptionBroker: true, subscriptionPreflight: detail }] }
    assert.equal(leaseDevice(device), false, detail)
    assert.equal(hostedBrokerDevice(device, ids.deviceId, undefined, ids.deviceId), false, detail)
    assert.equal(hostedBrokerDevice({ ...device, kind: 'cloud' }, ids.deviceId, ids.deviceId, ''), false, detail)
    // This device-wide gate permits a different healthy harness; nativeRun
    // separately checks the exact harness bound to the authenticated run.
    assert.equal(leaseDevice({ ...device, harnesses: [...device.harnesses, ...broker] }), true)
  }
})

const lease = { route: 'claude_code_cli', modelId: 'm', revision: 1, accountId: 'a', expiresAt: '2026-11-01T01:00:00.000Z', accessToken: 'fixture-access' }
const service = (fail = false) => () => ({
  nativeRun: async () => ({ ownerId: 'o', workspaceId: 'w', consumerId: 'c', bindingId: 'b', execution: 'native' as const, runId: ids.runId }),
  nativeLease: async () => { if (fail) throw new Error('fixture-refusal-detail'); return lease as never },
})
const post = () => new Request('http://local/lease', { method: 'POST' })

test('hosted context refusals retain a bounded server diagnosis without returning private details', async () => {
  const lines: string[] = []
  const failure = new SubscriptionRefusal('account_unavailable')
  failure.cause = { token: 'fixture-private-native-token' }
  const handler = subscriptionNativeHTTP({
    authorize: async () => 'o',
    service: () => ({ nativeRun: async () => ({ ownerId: 'o' }), nativeContext: async () => { throw failure } }) as never,
    log: (line: string) => { lines.push(line) },
  })
  const response = await handler(new Request('http://local/subscription', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'context' }) }), { params: Promise.resolve(ids) })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'subscription_unavailable' })
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), { event: 'subscription_native_refused', ...ids, operation: 'context', phase: 'context', code: 'account_unavailable', errorClass: 'SubscriptionRefusal' })
  assert.doesNotMatch(lines.join(''), /fixture-private-native-token|cause|stack/)
})

test('a transient context authorization failure is retryable and a later request rechecks authority', async () => {
  const lines: string[] = []
  let attempts = 0
  let nativeRuns = 0
  const context = { route: 'claude_code_cli', modelId: 'm', revision: 1, accountId: 'a', expiresAt: '2026-11-01T01:00:00.000Z' }
  const handler = subscriptionNativeHTTP({
    authorize: async () => {
      if (++attempts === 1) throw new Error('fixture-private-infrastructure-detail')
      return 'o'
    },
    service: () => ({
      nativeRun: async () => { nativeRuns++; return { ownerId: 'o' } },
      nativeContext: async () => context,
    }) as never,
    log: line => { lines.push(line) },
  })
  const request = () => new Request('http://local/subscription', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'context' }) })
  const failed = await handler(request(), { params: Promise.resolve(ids) })
  assert.equal(failed.status, 503)
  assert.equal(failed.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await failed.json(), { error: 'subscription_unavailable' })
  assert.equal(nativeRuns, 0, 'an unavailable authority must not grant access')
  assert.deepEqual(JSON.parse(lines[0]), { event: 'subscription_native_refused', ...ids, operation: null, phase: 'authorize', code: 'subscription_unavailable', errorClass: 'unknown' })
  assert.doesNotMatch(lines.join(''), /fixture-private-infrastructure-detail|stack/)
  const recovered = await handler(request(), { params: Promise.resolve(ids) })
  assert.equal(recovered.status, 200)
  assert.deepEqual(await recovered.json(), context)
  assert.equal(attempts, 2)
  assert.equal(nativeRuns, 1, 'retry reauthorizes and resolves the current run binding')
})

test('a hosted context worker refusal remains an authoritative conflict', async () => {
  const handler = subscriptionNativeHTTP({
    authorize: async () => 'o',
    service: () => ({ nativeRun: async () => ({ ownerId: 'o' }), nativeContext: async () => { throw new WorkerRefusal('provider_operation_failed') } }) as never,
    log: () => {},
  })
  const response = await handler(new Request('http://local/subscription', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'context' }) }), { params: Promise.resolve(ids) })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'subscription_unavailable' })
})

for (const code of ['modelPolicyRevoked', 'modelRouteDenied'] as const) {
  test(`hosted context preserves an authoritative ${code} refusal`, async () => {
    const lines: string[] = []
    const failure = new ModelAdmissionError(code)
    failure.cause = { policy: 'fixture-private-model-policy' }
    const handler = subscriptionNativeHTTP({
      authorize: async () => 'o',
      service: () => ({ nativeRun: async () => ({ ownerId: 'o' }), nativeContext: async () => { throw failure } }) as never,
      log: line => { lines.push(line) },
    })
    const request = new Request('http://local/subscription', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'context' }) })
    const response = await handler(request, { params: Promise.resolve(ids) })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'subscription_unavailable' })
    assert.deepEqual(JSON.parse(lines[0]), { event: 'subscription_native_refused', ...ids, operation: 'context', phase: 'context', code: 'model_policy_refused', errorClass: 'ModelAdmissionError' })
    assert.doesNotMatch(lines.join(''), /fixture-private-model-policy|cause|stack/)
  })
}

for (const phase of ['authorize', 'context'] as const) {
  for (const failure of [new DeviceAuthorityRevoked(), new DeviceFenceUnavailable(new Error('fixture-private-fence-detail'))]) {
    test(`hosted ${phase} preserves ${failure.constructor.name} for the device route fence`, async () => {
      let contexts = 0
      const handler = subscriptionNativeHTTP({
        authorize: async () => { if (phase === 'authorize') throw failure; return 'o' },
        service: () => ({
          nativeRun: async () => ({ ownerId: 'o' }),
          nativeContext: async () => { contexts++; throw failure },
        }) as never,
        log: () => {},
      })
      const request = new Request('http://local/subscription', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'context' }) })
      // The outer withDeviceRoute maps these exact typed errors to 401 and
      // retryable 503. This handler must not replace either with its own status.
      await assert.rejects(handler(request, { params: Promise.resolve(ids) }), error => error === failure)
      assert.equal(contexts, phase === 'authorize' ? 0 : 1)
    })
  }
}

test('the lease is returned uncached to an authorized device', async () => {
  const handler = subscriptionNativeLease({ authorize: async () => 'o', service: service() })
  const response = await handler(post(), { params: Promise.resolve(ids) })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(await response.json(), lease)
})

test('an unauthorized device, a bad id or a refusal gets no token and no detail', async () => {
  const unauthorized = subscriptionNativeLease({ authorize: async () => null, service: service() })
  assert.equal((await unauthorized(post(), { params: Promise.resolve(ids) })).status, 401)
  const authorized = subscriptionNativeLease({ authorize: async () => 'o', service: service(true) })
  assert.equal((await authorized(post(), { params: Promise.resolve({ ...ids, runId: 'x' }) })).status, 404)
  const refused = await authorized(post(), { params: Promise.resolve(ids) })
  assert.equal(refused.status, 409)
  const body = await refused.text()
  assert.doesNotMatch(body, /fixture-access|fixture-refusal-detail/)
})
