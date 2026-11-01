import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mobileWebTarget } from './mobile-web-target'

const BOT = '12345678-1234-1234-1234-123456789abc'

test('the app may open the Coordinator chat, a bot chat, a task or Settings', () => {
  assert.equal(mobileWebTarget('/?section=coordinator'), '/?section=coordinator')
  assert.equal(mobileWebTarget(`/?section=coordinator&bot=${BOT.toUpperCase()}`), `/?section=coordinator&bot=${BOT}`)
  assert.equal(mobileWebTarget(`/?issue=${BOT}`), `/?issue=${BOT}`)
  assert.equal(mobileWebTarget('/settings'), '/settings')
  assert.equal(mobileWebTarget('/settings?section=computers'), '/settings?section=computers')
  assert.equal(mobileWebTarget('/settings?section=models'), '/settings?section=models')
  assert.equal(mobileWebTarget('/?section=plugins'), '/?section=plugins')
  assert.equal(mobileWebTarget('/?section=plugins&app=gmail'), '/?section=plugins&app=gmail')
  assert.equal(mobileWebTarget(`/api/artifacts/${BOT.toUpperCase()}/versions/3/frame`), `/api/artifacts/${BOT}/versions/3/frame`)
})

test('anything else is the home page', () => {
  for (const value of [null, '', 'https://evil.dev', '//evil.dev', '/api/auth/sign-out', '/settings?next=//evil.dev', '/settings?section=members', '/settings?section=models&x=1', '/settings?section=computers#x', '/?section=plugins&app=Gmail', '/?section=plugins&app=../x', '/?section=plugins&app=gmail&x=1', '/?section=plugins#x', '/settings/members', '/settings#x', '/?section=coordinator&bot=nope', `/?section=coordinator&bot=${BOT}&x=1`, '/?section=coordinator#x', '/\\evil.dev', `/api/artifacts/${BOT}/versions/3/download`, `/api/artifacts/${BOT}/versions/0/frame`, `/api/artifacts/${BOT}/versions/3/frame?x=1`, '/api/artifacts/nope/versions/1/frame']) {
    assert.equal(mobileWebTarget(value), '/', String(value))
  }
})
