import assert from 'node:assert/strict'
import test from 'node:test'
import * as protocol from '@mikka/protocol/device'
import * as gateway from './session-report'

test('the Worker mirrors the protocol\'s device session values and report shape', () => {
  for (const name of ['DEVICE_GATEWAY_PING_MS', 'DEVICE_GATEWAY_SILENCE_MS', 'DEVICE_SESSION_CLOSE_GRACE_MS', 'DEVICE_GATEWAY_UPDATE_REQUIRED_CODE'] as const) {
    assert.equal(gateway[name], protocol[name], name)
  }
  assert.notEqual(gateway.DEVICE_SOCKET_REPLACED_CODE, protocol.DEVICE_GATEWAY_UPDATE_REQUIRED_CODE)
  const report: gateway.DeviceSessionReport = { state: 'connected', at: new Date().toISOString(), socketId: gateway.newSocketId() }
  assert.deepEqual(protocol.deviceSessionReportSchema.parse(report), report)
})

test('2xx is acknowledged, 408/429/5xx are retried and other 4xx are dropped, with bounded backoff', async () => {
  assert.deepEqual([200, 204, 302, 400, 401, 404, 408, 429, 500, 503].map(gateway.deliveryOutcome),
    ['delivered', 'delivered', 'retry', 'dropped', 'dropped', 'dropped', 'retry', 'retry', 'retry', 'retry'])
  assert.deepEqual([1, 2, 3, 6, 7, 50].map(gateway.sessionReportBackoff), [1_000, 2_000, 4_000, 32_000, 60_000, 60_000])
  const calls: Request[] = []
  const outcome = await gateway.sendSessionReport('https://app.test/mikka/v1/internal/device-sessions/', 'push-secret', 'device-1',
    { state: 'disconnected', at: '2026-11-17T00:00:00.000Z', socketId: 'socket-0001' },
    async (input, init) => { calls.push(new Request(input, init)); return new Response(null, { status: 204 }) })
  assert.equal(outcome, 'delivered')
  assert.equal(calls[0]!.url, 'https://app.test/mikka/v1/internal/device-sessions/device-1')
  assert.equal(calls[0]!.headers.get('authorization'), 'Bearer push-secret')
  assert.deepEqual(await calls[0]!.json(), { state: 'disconnected', at: '2026-11-17T00:00:00.000Z', socketId: 'socket-0001' })
  assert.equal(await gateway.sendSessionReport('https://app.test/x', 's', 'd', { state: 'connected', at: '2026-11-17T00:00:00.000Z', socketId: 'socket-0001' },
    async () => { throw new Error('offline') }), 'retry')
})
