import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { ScheduleError } from './contract'

// The schedule store is the database's (lib/schedules/dispatch.db.test.ts); here it records what the route hands it.
const receive = mock.fn(async (_key: string, _body: string, _requestKey?: string): Promise<unknown> => ({ status: 'queued', dueAt: '2026-11-15T18:00:00.000Z' }))
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: { receiveAutomationWebhook: receive } })
let handle: typeof import('./webhook-route')['handleAutomationWebhook']
before(async () => { ({ handleAutomationWebhook: handle } = await import('./webhook-route')) })
beforeEach(() => receive.mock.resetCalls())
const key = `mwh_${'a'.repeat(43)}`
const call = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
  handle(new Request(`http://localhost/api/webhooks/automations/${path}`, { method: 'POST', body, headers }), path)

test('a request with a well-formed key reaches the automation with its body and request ID', async () => {
  const response = await call(key, '{"alert":"disk"}\r\n', { 'idempotency-key': 'req-1' })
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { status: 'queued', dueAt: '2026-11-15T18:00:00.000Z' })
  assert.deepEqual(receive.mock.calls[0]!.arguments, [key, '{"alert":"disk"}\n', 'req-1'])
})

test('a malformed key, a body over 64 KB and a body that is not text are refused before the store', async () => {
  assert.equal((await call('mwh_short', 'x')).status, 404)
  assert.equal((await call(key, 'x'.repeat(64 * 1024 + 1))).status, 413)
  assert.equal((await call(key, new Uint8Array([0xff, 0xfe, 0x00]))).status, 415)
  assert.equal(receive.mock.callCount(), 0)
})

test('an unknown URL is 404 and a paused automation 409, by the store’s code', async () => {
  receive.mock.mockImplementationOnce(async () => { throw new ScheduleError('scheduleNotFound', 404) })
  const unknown = await call(key, 'x')
  assert.deepEqual([unknown.status, await unknown.json()], [404, { error: 'scheduleNotFound' }])
  receive.mock.mockImplementationOnce(async () => { throw new ScheduleError('scheduleNotActive', 409) })
  assert.equal((await call(key, 'x')).status, 409)
})
