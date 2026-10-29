import test from 'node:test'
import assert from 'node:assert/strict'

import { withBasePath } from '@/lib/base-path'
import { desktopAuthCallbackPath, desktopAuthReturnPath, desktopAuthState } from './desktop-auth'

const state = 'a'.repeat(48)

test('the OAuth callback is a base-path-free API path', () => {
  const path = desktopAuthCallbackPath(state, '/')
  assert.equal(path, `/api/desktop/return?state=${state}&next=%2F`)
  assert.equal(desktopAuthReturnPath(state, '/'), withBasePath(path))
})

test('the desktop state must be URL-safe and bounded', () => {
  assert.equal(desktopAuthState(state), state)
  assert.equal(desktopAuthState('short'), null)
  assert.equal(desktopAuthState(`${'a'.repeat(16)}!`), null)
  assert.equal(desktopAuthState('a'.repeat(129)), null)
})
