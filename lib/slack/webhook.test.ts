import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { slackConfig, slackOwner } from './config'
import { validSlackSignature } from './webhook'

const timestamp = '1792700000'
const secret = 'test-only-signing-secret'
const body = JSON.stringify({ type: 'url_verification', challenge: 'challenge' })
const signature = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')
const now = Number(timestamp) * 1000

test('accepts a signed challenge, rejects changed bytes, wrong secret and malformed signatures', () => {
  assert.equal(validSlackSignature(body, timestamp, signature, secret, now), true)
  assert.equal(validSlackSignature(body + ' ', timestamp, signature, secret, now), false)
  assert.equal(validSlackSignature(body, timestamp, signature, 'other', now), false)
  for (const value of [null, '', 'v0=short', 'v0=' + 'z'.repeat(64)]) {
    assert.equal(validSlackSignature(body, timestamp, value, secret, now), false)
  }
})

test('rejects replayed and future requests outside the Slack five-minute window', () => {
  assert.equal(validSlackSignature(body, timestamp, signature, secret, now + 301_000), false)
  assert.equal(validSlackSignature(body, timestamp, signature, secret, now - 301_000), false)
  assert.equal(validSlackSignature(body, null, signature, secret, now), false)
  assert.equal(validSlackSignature(body, 'NaN', signature, secret, now), false)
})

const config = slackConfig({
  SLACK_BOT_TOKEN: 'test-only-bot-token', SLACK_SIGNING_SECRET: secret,
  SLACK_APP_ID: 'A123', SLACK_TEAM_ID: 'T123', SLACK_BOT_USER_ID: 'U123',
  SLACK_USER_BINDINGS: JSON.stringify({ U456: 'mikka-owner' }),
})!
const payload = {
  type: 'event_callback', api_app_id: 'A123', team_id: 'T123',
  event: { type: 'app_mention', user: 'U456', text: 'list agents' },
}

test('only explicitly bound senders in the configured app/workspace can invoke tools', () => {
  assert.equal(slackOwner(config, payload), 'mikka-owner')
  assert.equal(slackOwner(config, { ...payload, team_id: 'T999' }), null)
  assert.equal(slackOwner(config, { ...payload, api_app_id: 'A999' }), null)
  for (const event of [
    { ...payload.event, user: 'U999' },
    { ...payload.event, type: 'message' },
    { ...payload.event, bot_id: 'B123' },
    { ...payload.event, subtype: 'message_changed' },
  ]) assert.equal(slackOwner(config, { ...payload, event }), null)
  for (const value of [null, {}, 'invalid']) assert.equal(slackOwner(config, value), null)
})

test('incomplete or malformed identity configuration disables the bot', () => {
  assert.equal(slackConfig({}), null)
  for (const bindings of ['not-json', 'null', '{"U456":42}', '{"someone":"owner"}']) {
    assert.equal(slackConfig({ ...config, SLACK_USER_BINDINGS: bindings }), null)
  }
})
