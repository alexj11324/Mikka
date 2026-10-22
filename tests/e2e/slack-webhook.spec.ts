import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'

// These requests exercise the production build in isolated CI only. They must
// never invoke a real installed bot or send fixture signatures to cloud apps.
test.skip(!process.env.CI || Boolean(process.env.E2E_BASE_URL), 'Requires the CI-only Slack fixture configuration')

test('Slack callback verifies signed challenges and rejects unauthorized events before SDK/model calls', async ({ request }) => {
  const endpoint = '/mikka/api/webhooks/slack'
  const timestamp = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({ type: 'url_verification', challenge: 'ci-slack-challenge' })
  const signature = 'v0=' + createHmac('sha256', 'ci-only-slack-signing-secret').update(`v0:${timestamp}:${body}`).digest('hex')
  const headers = { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature }
  const valid = await request.post(endpoint, { headers, data: body })
  expect(valid.status()).toBe(200)
  expect(await valid.json()).toEqual({ challenge: 'ci-slack-challenge' })
  const tampered = await request.post(endpoint, { headers, data: body + ' ' })
  expect(tampered.status()).toBe(401)

  const unboundBody = JSON.stringify({ type: 'event_callback', api_app_id: 'A123', team_id: 'T123', event: { type: 'app_mention', user: 'U999', text: '<@U123> list agents' } })
  const unboundSignature = 'v0=' + createHmac('sha256', 'ci-only-slack-signing-secret').update(`v0:${timestamp}:${unboundBody}`).digest('hex')
  const unbound = await request.post(endpoint, { headers: { ...headers, 'x-slack-signature': unboundSignature }, data: unboundBody })
  expect(unbound.status()).toBe(204)
})
