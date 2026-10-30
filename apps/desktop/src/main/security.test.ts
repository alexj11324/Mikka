import test from 'node:test'
import assert from 'node:assert/strict'

import { appExternalUrl, desktopAuthFinishUrl, desktopAuthState, externalUrl, isTrustedFrame, navigationDecision, originOf } from './security'

const APP = 'https://app.aspectlylabs.com/mikka'

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

test('navigation keeps only the app, opens every other HTTPS URL externally', () => {
  assert.equal(navigationDecision('https://app.aspectlylabs.com/mikka/issue/1', APP), 'allow')
  assert.equal(navigationDecision('https://github.com/login/oauth/authorize', APP), 'external')
  assert.equal(navigationDecision('https://accounts.google.com/o/oauth2/auth', APP), 'external')
  assert.equal(navigationDecision('https://docs.example/page', APP), 'external')
  assert.equal(navigationDecision('mailto:support@example.com', APP), 'external')
  // A lookalike host never loads in the app window; it goes to the system browser.
  assert.equal(navigationDecision('http://evil.example/mikka', APP), 'external')
  assert.equal(navigationDecision('file:///etc/passwd', APP), 'deny')
  assert.equal(navigationDecision('javascript:alert(1)', APP), 'deny')
})

test('external opens accept only HTTP(S) and mailto without credentials', () => {
  assert.equal(externalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(externalUrl('mailto:support@example.com'), 'mailto:support@example.com')
  assert.equal(externalUrl('http://example.com'), 'http://example.com/')
  assert.equal(externalUrl('file:///etc/passwd'), null)
  assert.equal(externalUrl('data:text/html,hi'), null)
  assert.equal(externalUrl('https://user:pass@example.com'), null)
  assert.equal(externalUrl(`https://example.com/${'a'.repeat(2_048)}`), null)
})

test('external app-origin opens stay on the app origin', () => {
  assert.equal(appExternalUrl('https://app.aspectlylabs.com/mikka/sign-in?desktop=1', APP), 'https://app.aspectlylabs.com/mikka/sign-in?desktop=1')
  assert.equal(appExternalUrl('http://localhost:3000/mikka/sign-in', 'http://localhost:3000/mikka'), 'http://localhost:3000/mikka/sign-in')
  assert.equal(appExternalUrl('https://app.aspectlylabs.com.evil.example/mikka/sign-in', APP), null)
  assert.equal(appExternalUrl('https://evil.example/mikka/sign-in', APP), null)
  assert.equal(appExternalUrl('file:///etc/passwd', APP), null)
  assert.equal(appExternalUrl('https://user:pass@app.aspectlylabs.com/mikka/sign-in', APP), null)
})

test('loopback auth callback becomes the in-app token exchange page', () => {
  const token = 'a'.repeat(32)
  const state = 'b'.repeat(32)
  const finish = desktopAuthFinishUrl(token, state, '/settings?section=integrations', APP)
  assert.ok(finish)
  const url = new URL(finish)
  assert.equal(url.origin, 'https://app.aspectlylabs.com')
  assert.equal(url.pathname, '/mikka/api/desktop/finish')
  const hash = new URLSearchParams(url.hash.slice(1))
  assert.equal(hash.get('code'), token)
  assert.equal(hash.get('token'), null)
  assert.equal(hash.get('state'), state)
  assert.equal(hash.get('next'), '/settings?section=integrations')
})

test('loopback auth callbacks reject invalid tokens and paths', () => {
  const token = 'a'.repeat(32)
  const state = 'b'.repeat(32)
  assert.equal(desktopAuthFinishUrl('short', state, '/', APP), null)
  assert.equal(desktopAuthFinishUrl(token, 'short', '/', APP), null)
  assert.equal(desktopAuthFinishUrl(token, state, '//evil.example', APP), null)
  assert.equal(desktopAuthFinishUrl(token, state, 'https://evil.example', APP), null)
  assert.equal(desktopAuthFinishUrl(token, state, '/ok#fragment', APP), null)
})

test('the loopback nonce is bounded', () => {
  assert.equal(desktopAuthState('abcdefghijklmnop'), 'abcdefghijklmnop')
  assert.equal(desktopAuthState('short'), null)
  assert.equal(desktopAuthState('a'.repeat(129)), null)
  assert.equal(desktopAuthState(null), null)
})

test('plain-HTTP links open in the system browser like HTTPS; other schemes stay denied', () => {
  assert.equal(externalUrl('http://example.com/docs'), 'http://example.com/docs')
  assert.equal(navigationDecision('http://example.com/docs', APP), 'external')
  assert.equal(externalUrl('http://user:pass@example.com'), null)
  assert.equal(externalUrl('file:///etc/passwd'), null)
  assert.equal(externalUrl('javascript:alert(1)'), null)
})
