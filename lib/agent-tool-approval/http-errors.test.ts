import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { DeviceAuthorityRevoked, DeviceFenceUnavailable } from '../db/device-scope'

const runId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
let failure: Error | null = null
class ApprovalUnavailable extends Error { constructor(readonly revokeReason?: 'device_lost') { super('approvalUnavailable') } }
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
mock.module(new URL('../device-link.ts', import.meta.url).href, { namedExports: {
  authenticateDevice: async () => ({ userId: 'owner', tokenId: 'token', scopeDeviceId: deviceId }),
} })
mock.module(new URL('../deployment-switches.ts', import.meta.url).href, { namedExports: { deploymentSwitch: () => false } })
mock.module(new URL('./store.ts', import.meta.url).href, { namedExports: {
  ApprovalUnavailable,
  AgentToolApprovalStore: class { async checkState() { if (failure) throw failure; return { live: true, paused: false } } },
} })
const route = import('../../app/v1/runs/[runId]/tool-approval/route')
const check = async () => (await route).POST(new Request('https://mikka.test/v1/runs/'+runId+'/tool-approval', {
  method: 'POST', headers: { 'x-mikka-client-version': '0.0.375', 'content-type': 'application/json' },
  body: JSON.stringify({ operation: 'check', deviceId, policyRevision: 'a'.repeat(64) }),
}), { params: Promise.resolve({ runId }) })

test('an unavailable device fence reaches the retryable device-route response without granting liveness', async () => {
  for (const error of [new DeviceFenceUnavailable(new Error('private-fence-cause')), new Error('private-wrapper', { cause: new DeviceFenceUnavailable() })]) {
    failure = error
    const response = await check()
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('Retry-After'), '2')
    assert.deepEqual(await response.json(), { error: 'deviceAuthorityUnavailable' })
  }
  failure = null
  assert.deepEqual(await (await check()).json(), { live: true, paused: false })
})

test('typed device revocation still answers unauthorized immediately', async () => {
  failure = new DeviceAuthorityRevoked()
  const response = await check()
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Unauthorized' })
})

test('unavailable runs and changed policies remain immediate refusals', async () => {
  for (const error of [new ApprovalUnavailable(), new Error('agentPolicyChanged'), new Error('agentPolicyUnavailable'), new Error('unknown-private-error')]) {
    failure = error
    const response = await check()
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'approvalUnavailable' })
  }
})

test('only a typed host lease refusal returns a cause and it never grants liveness', async () => {
  failure = new ApprovalUnavailable('device_lost')
  const response = await check()
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {live:false,revokeReason:'device_lost'})
  failure = Object.assign(new Error('untrusted-error'), {revokeReason:'device_lost'})
  const untrusted = await check()
  assert.equal(untrusted.status, 409)
  assert.deepEqual(await untrusted.json(), {error:'approvalUnavailable'})
})

test('a transient database failure stays unavailable and logs only an allowlisted SQL state', async t => {
  const lines: string[] = []
  t.mock.method(console, 'warn', (line: string) => { lines.push(line) })
  t.mock.method(console, 'error', (line: string) => { lines.push(line) })
  failure = new Error('private-wrapper', { cause: Object.assign(new Error('private-query'), { code: '40P01' }) })
  const response = await check()
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'approvalUnavailable' })
  assert.equal(JSON.parse(lines[0]).databaseCode, '40P01')
  assert.doesNotMatch(lines.join(''), /private-wrapper|private-query|stack|cause/)
})
