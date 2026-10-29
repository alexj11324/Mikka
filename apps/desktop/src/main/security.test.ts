import test from 'node:test'
import assert from 'node:assert/strict'

import { externalUrl, isTrustedFrame, navigationDecision, originOf } from './security'

const APP = 'https://app.aspectlylabs.com/mikka'
const AUTH = ['https://github.com', 'https://accounts.google.com']

test('only the exact app origin is trusted', () => {
  assert.equal(isTrustedFrame('https://app.aspectlylabs.com/mikka/en', APP), true)
  assert.equal(isTrustedFrame('https://app.aspectlylabs.com.evil.example/mikka', APP), false)
  assert.equal(isTrustedFrame('https://app.aspectlylabs.com@evil.example/mikka', APP), false)
  assert.equal(isTrustedFrame('https://evil.example/mikka', APP), false)
  assert.equal(isTrustedFrame(undefined, APP), false)
  assert.equal(isTrustedFrame('not a url', APP), false)
})

test('credentials and non-URLs have no origin', () => {
  assert.equal(originOf('https://user:pass@app.example/'), null)
  assert.equal(originOf('javascript:alert(1)'), 'null')
  assert.equal(originOf('not a url'), null)
})

test('navigation keeps the app and sign-in providers, opens HTTPS elsewhere', () => {
  assert.equal(navigationDecision('https://app.aspectlylabs.com/mikka/issue/1', APP, AUTH), 'allow')
  assert.equal(navigationDecision('https://github.com/login/oauth/authorize', APP, AUTH), 'allow')
  assert.equal(navigationDecision('https://accounts.google.com/o/oauth2/auth', APP, AUTH), 'allow')
  assert.equal(navigationDecision('https://docs.example/page', APP, AUTH), 'external')
  assert.equal(navigationDecision('mailto:support@example.com', APP, AUTH), 'external')
  assert.equal(navigationDecision('http://evil.example/mikka', APP, AUTH), 'deny')
  assert.equal(navigationDecision('file:///etc/passwd', APP, AUTH), 'deny')
  assert.equal(navigationDecision('javascript:alert(1)', APP, AUTH), 'deny')
})

test('external opens accept only HTTPS and mailto without credentials', () => {
  assert.equal(externalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(externalUrl('mailto:support@example.com'), 'mailto:support@example.com')
  assert.equal(externalUrl('http://example.com'), null)
  assert.equal(externalUrl('file:///etc/passwd'), null)
  assert.equal(externalUrl('data:text/html,hi'), null)
  assert.equal(externalUrl('https://user:pass@example.com'), null)
  assert.equal(externalUrl(`https://example.com/${'a'.repeat(2_048)}`), null)
})
