import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slackConfig, slackOwner } from './config'

// slackOwner decides who a Slack mention acts as: only a bound sender, in the
// configured app and workspace, on a plain human app_mention.

const config = slackConfig({
  SLACK_BOT_TOKEN: 'test-only-bot-token', SLACK_SIGNING_SECRET: 'test-only-signing-secret',
  SLACK_APP_ID: 'A123', SLACK_TEAM_ID: 'T123', SLACK_BOT_USER_ID: 'U123',
  SLACK_USER_BINDINGS: JSON.stringify({ U456: 'owner-a', U789: 'owner-b' }),
})!
const event = { type: 'app_mention', user: 'U456', text: '<@U123> list agents' }
const payload = { type: 'event_callback', api_app_id: 'A123', team_id: 'T123', event }
const withEvent = (patch: Record<string, unknown>) => ({ ...payload, event: { ...event, ...patch } })

test('owner match: each bound sender maps to its own Mikka user', () => {
  assert.equal(slackOwner(config, payload), 'owner-a')
  assert.equal(slackOwner(config, withEvent({ user: 'U789' })), 'owner-b')
  assert.equal(slackOwner(config, withEvent({ text: '' })), 'owner-a', 'empty text is still a mention')
})

test('non-owners are excluded: unbound, wrong case, or another workspace/app', () => {
  assert.equal(slackOwner(config, withEvent({ user: 'U999' })), null)
  assert.equal(slackOwner(config, withEvent({ user: 'u456' })), null)
  assert.equal(slackOwner(config, { ...payload, team_id: 'T999' }), null)
  assert.equal(slackOwner(config, { ...payload, api_app_id: 'A999' }), null)
  assert.equal(slackOwner(config, { ...payload, team_id: undefined }), null)
})

test('missing or empty owner fields are excluded', () => {
  assert.equal(slackOwner(config, withEvent({ user: undefined })), null)
  assert.equal(slackOwner(config, withEvent({ user: '' })), null)
  assert.equal(slackOwner(config, withEvent({ user: 456 })), null)
  assert.equal(slackOwner(config, withEvent({ text: undefined })), null)
  assert.equal(slackOwner(config, { ...payload, event: undefined }), null)
})

test('prototype keys never resolve to an owner', () => {
  for (const user of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(slackOwner(config, withEvent({ user })), null, user)
  }
})

test('only human app_mention callbacks count', () => {
  assert.equal(slackOwner(config, { ...payload, type: 'url_verification' }), null)
  assert.equal(slackOwner(config, withEvent({ type: 'message' })), null)
  assert.equal(slackOwner(config, withEvent({ bot_id: 'B1' })), null)
  assert.equal(slackOwner(config, withEvent({ subtype: 'bot_message' })), null)
  for (const value of [null, undefined, 42, 'x', [], {}]) assert.equal(slackOwner(config, value), null)
})

test('empty owner values in bindings disable the whole config', () => {
  assert.equal(slackConfig({ ...config, SLACK_USER_BINDINGS: '{"U456":""}' }), null)
})

test('no bindings: config loads but nobody is an owner', () => {
  const empty = slackConfig({ ...config, SLACK_USER_BINDINGS: '{}' })!
  assert.ok(empty)
  assert.equal(slackOwner(empty, payload), null)
})
