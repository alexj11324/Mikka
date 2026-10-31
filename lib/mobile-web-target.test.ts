import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mobileWebTarget } from './mobile-web-target'

const BOT = '12345678-1234-1234-1234-123456789abc'

test('the app may open the Coordinator chat, a bot chat, a task or Settings', () => {
  assert.equal(mobileWebTarget('/?section=coordinator'), '/?section=coordinator')
  assert.equal(mobileWebTarget(`/?section=coordinator&bot=${BOT.toUpperCase()}`), `/?section=coordinator&bot=${BOT}`)
  assert.equal(mobileWebTarget(`/?issue=${BOT}`), `/?issue=${BOT}`)
  assert.equal(mobileWebTarget('/settings'), '/settings')
})

test('anything else is the home page', () => {
  for (const value of [null, '', 'https://evil.dev', '//evil.dev', '/api/auth/sign-out', '/settings?next=//evil.dev', '/settings/members', '/settings#x', '/?section=coordinator&bot=nope', `/?section=coordinator&bot=${BOT}&x=1`, '/?section=coordinator#x', '/\\evil.dev']) {
    assert.equal(mobileWebTarget(value), '/', String(value))
  }
})
