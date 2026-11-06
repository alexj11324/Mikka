import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desktopWebTarget } from './desktop-web-target'
import { mobileWebTarget } from './mobile-web-target'

test('account and integration handoffs retain only the explicit page and locale', () => {
  const workspace = '11111111-1111-4111-8111-111111111111'
  for (const path of [
    '/?settings=account', '/?settings=integrations', '/?settings=integrations&app=linear',
    '/?section=plugins', '/?section=plugins&app=gmail', '/en?section=plugins&app=linear',
    '/en?settings=account', '/settings?section=account', '/en/settings?section=connections&app=gmail',
    `/settings?section=integrations&workspace=${workspace}`,
  ]) {
    assert.equal(desktopWebTarget(path), path)
    assert.equal(mobileWebTarget(path), path)
  }
  assert.equal(desktopWebTarget('/en/?settings=account'), '/en?settings=account')
})

test('handoff cannot target credentials, other origins or unvalidated query parameters', () => {
  for (const path of [
    null, '', '/', '/en', 'https://evil.test/?settings=account', '//evil.test', '/\\evil.test',
    '/api/auth/get-session', '/api/auth/sign-out', '/api/mobile/open?token=forged',
    '/?settings=account&next=//evil.test', '/?settings=account&settings=integrations',
    '/?settings=account&app=gmail', '/?settings=integrations&app=../gmail',
    '/?section=plugins&app=gmail&intent=forged', '/?section=plugins&app=Gmail',
    '/settings?section=account&app=gmail', '/settings?section=members',
    '/settings?section=integrations&workspace=other', '/en/settings?section=account#private',
    '/settings?section=integrations&workspace=', '/settings%2f..%2fapi/auth/get-session',
  ]) assert.equal(desktopWebTarget(path), null, String(path))
})
