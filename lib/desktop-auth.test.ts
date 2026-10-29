import test from 'node:test'
import assert from 'node:assert/strict'

import { withBasePath } from '@/lib/base-path'
import { desktopAuthCallbackPath, desktopAuthReturnPath, desktopAuthState, desktopLoopbackCallback } from './desktop-auth'

const state = 'a'.repeat(48)

test('the OAuth callback is a base-path-free API path', () => {
  const path = desktopAuthCallbackPath(state, '/')
  assert.equal(path, `/api/desktop/return?state=${state}&next=%2F`)
  assert.equal(desktopAuthReturnPath(state, '/'), withBasePath(path))
})

test('the loopback callback is carried through the return path', () => {
  const callback = 'http://127.0.0.1:49152/auth/callback'
  const path = desktopAuthCallbackPath(state, '/?settings=account', callback)
  const url = new URL(path, 'https://app.example')
  assert.equal(url.pathname, '/api/desktop/return')
  assert.equal(url.searchParams.get('callback'), callback)
})

test('only an unadorned loopback callback is accepted', () => {
  assert.equal(desktopLoopbackCallback('http://127.0.0.1:49152/auth/callback'), 'http://127.0.0.1:49152/auth/callback')
  for (const value of [
    'https://127.0.0.1:49152/auth/callback',
    'http://localhost:49152/auth/callback',
    'http://127.0.0.1/auth/callback',
    'http://127.0.0.1:49152/other',
    'http://127.0.0.1:49152/auth/callback?x=1',
    'http://user:pass@127.0.0.1:49152/auth/callback',
    'not a url',
  ]) assert.equal(desktopLoopbackCallback(value), null, value)
})

test('the desktop state must be URL-safe and bounded', () => {
  assert.equal(desktopAuthState(state), state)
  assert.equal(desktopAuthState('short'), null)
  assert.equal(desktopAuthState(`${'a'.repeat(16)}!`), null)
  assert.equal(desktopAuthState('a'.repeat(129)), null)
})
