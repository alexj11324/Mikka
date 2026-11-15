import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'

// The schedule store is the database's (lib/schedules/dispatch.db.test.ts); here it records what the route hands it.
const fire = mock.fn(async (_payload: Record<string, unknown>): Promise<number> => 1)
mock.module(new URL('../schedules/runtime.ts', import.meta.url).href, { namedExports: { fireSlackAutomations: fire } })
let handle: typeof import('./automation-route')['handleSlackAutomations']
before(async () => { ({ handleSlackAutomations: handle } = await import('./automation-route')) })
beforeEach(() => fire.mock.resetCalls())
const env = { SLACK_SIGNING_SECRET: 'unit-only-signing-secret', SLACK_APP_ID: 'A1' } as NodeJS.ProcessEnv
const request = (payload: unknown, secret = env.SLACK_SIGNING_SECRET!) => {
  const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000))
  return new Request('http://localhost/api/webhooks/slack/automations', { method: 'POST', body, headers: {
    'x-slack-request-timestamp': timestamp, 'x-slack-signature': 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex') } })
}
const event = { type: 'event_callback', api_app_id: 'A1', team_id: 'T1', event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U1', ts: '1.1' } }

test('a forwarded event signed by Slack for this app reaches the automations', async () => {
  const response = await handle(request(event), env)
  assert.deepEqual([response.status, await response.json()], [200, { queued: 1 }])
  assert.deepEqual(fire.mock.calls[0]!.arguments[0], event)
})

test('a bad signature is 401, another app’s event queues nothing, and no configuration is 503', async () => {
  assert.equal((await handle(request(event, 'another-secret'), env)).status, 401)
  const other = await handle(request({ ...event, api_app_id: 'A2' }), env)
  assert.deepEqual([other.status, await other.json()], [200, { queued: 0 }])
  assert.equal((await handle(request(event), {} as NodeJS.ProcessEnv)).status, 503)
  assert.equal(fire.mock.callCount(), 0)
})

test('a store failure is 503', async () => {
  fire.mock.mockImplementationOnce(async () => { throw new Error('database unavailable') })
  assert.equal((await handle(request(event), env)).status, 503)
})
