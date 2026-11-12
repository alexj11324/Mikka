import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mobileWebTarget } from './mobile-web-target'

const BOT = '12345678-1234-1234-1234-123456789abc'

test('the app may open the Coordinator chat, a bot chat, a task or Settings', () => {
  assert.equal(mobileWebTarget('/?section=coordinator'), '/?section=coordinator')
  assert.equal(mobileWebTarget(`/?section=coordinator&bot=${BOT.toUpperCase()}`), `/?section=coordinator&bot=${BOT}`)
  assert.equal(mobileWebTarget(`/?section=coordinator&workspace=${BOT.toUpperCase()}`), `/?section=coordinator&workspace=${BOT}`)
  assert.equal(mobileWebTarget(`/?section=coordinator&bot=${BOT}&workspace=${BOT}`), `/?section=coordinator&bot=${BOT}&workspace=${BOT}`)
  assert.equal(mobileWebTarget(`/?issue=${BOT}`), `/?issue=${BOT}`)
  assert.equal(mobileWebTarget('/settings'), '/settings')
  assert.equal(mobileWebTarget('/settings?section=computers'), '/settings?section=computers')
  assert.equal(mobileWebTarget('/settings?section=models'), '/settings?section=models')
  assert.equal(mobileWebTarget('/settings?section=billing'), '/settings?section=billing')
  assert.equal(mobileWebTarget(`/settings?section=billing&workspace=${BOT.toUpperCase()}`), `/settings?section=billing&workspace=${BOT}`)
  assert.equal(mobileWebTarget(`/settings?section=models&workspace=${BOT}`), `/settings?section=models&workspace=${BOT}`)
  assert.equal(mobileWebTarget('/?section=plugins'), '/?section=plugins')
  assert.equal(mobileWebTarget('/?section=plugins&app=gmail'), '/?section=plugins&app=gmail')
  assert.equal(mobileWebTarget(`/api/artifacts/${BOT.toUpperCase()}/versions/3/frame`), `/api/artifacts/${BOT}/versions/3/frame`)
})

test('settings recovery only accepts one validated workspace and an allowed section', () => {
  for (const value of ['/settings?section=billing&workspace=evil', `/settings?section=members&workspace=${BOT}`, `/settings?section=models&workspace=${BOT}&next=//evil.dev`, `/settings?section=models&workspace=${BOT}&workspace=${BOT}`, '/settings?section=models&workspace=', '/settings?section=models&section=billing']) assert.equal(mobileWebTarget(value), '/', value)
})

test('Members accepts only the exact Workspace destination from mobile Settings', () => {
  assert.equal(mobileWebTarget(`/settings/members?workspace=${BOT.toUpperCase()}`), `/settings/members?workspace=${BOT}`)
  for (const target of [`/settings/members/?workspace=${BOT}`, `/settings/members?workspace=${BOT}#x`,
    `/settings/members?workspace=${BOT}&workspace=${BOT}`, `/settings/members?section=members&workspace=${BOT}`,
    '/settings/members?workspace=invalid', '/settings/members?workspace=']) assert.equal(mobileWebTarget(target), '/')
})

test('scoped chats reject malformed, extra and repeated authority parameters', () => {
  for (const value of ['/?section=coordinator&workspace=private', `/?section=coordinator&workspace=${BOT}&workspace=${BOT}`, `/?section=coordinator&bot=${BOT}&workspace=${BOT}&owner=other`, `/?section=coordinator&bot=${BOT}&bot=${BOT}`, `/?section=coordinator&workspace=${BOT}#fragment`]) assert.equal(mobileWebTarget(value), '/', value)
})

test('anything else is the home page', () => {
  for (const value of [null, '', 'https://evil.dev', '//evil.dev', '/api/auth/sign-out', '/settings?next=//evil.dev', '/settings?section=members', '/settings?section=models&x=1', '/settings?section=computers#x', '/?section=plugins&app=Gmail', '/?section=plugins&app=../x', '/?section=plugins&app=gmail&x=1', '/?section=plugins#x', '/settings/members', '/settings#x', '/?section=coordinator&bot=nope', `/?section=coordinator&bot=${BOT}&x=1`, '/?section=coordinator#x', '/\\evil.dev', `/api/artifacts/${BOT}/versions/3/download`, `/api/artifacts/${BOT}/versions/0/frame`, `/api/artifacts/${BOT}/versions/3/frame?x=1`, '/api/artifacts/nope/versions/1/frame']) {
    assert.equal(mobileWebTarget(value), '/', String(value))
  }
})
