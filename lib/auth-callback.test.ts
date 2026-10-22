import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authCallbackURL } from './auth-callback'

test('Google uses the localhost callback under the Mikka base path', () => {
  assert.equal(authCallbackURL('http://localhost:3000/', 'google', '/mikka'), 'http://localhost:3000/mikka/api/auth/callback/google')
})

test('uses the production base path and requires a configured base URL', () => {
  assert.equal(authCallbackURL('https://app.aspectlylabs.com', 'google', '/mikka'), 'https://app.aspectlylabs.com/mikka/api/auth/callback/google')
  assert.equal(authCallbackURL('https://app.aspectlylabs.com', 'github', '/mikka'), 'https://app.aspectlylabs.com/mikka/api/auth/callback/github')
  assert.equal(authCallbackURL(undefined, 'google'), undefined)
})
