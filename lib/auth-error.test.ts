import assert from 'node:assert/strict'
import test from 'node:test'
import { oauthAccountNotLinkedProvider } from './auth-error'

test('recognizes an unlinked provider in single or repeated query values', () => {
  assert.equal(oauthAccountNotLinkedProvider('account_not_linked', 'google'), 'google')
  assert.equal(oauthAccountNotLinkedProvider(['account_not_linked', 'account_not_linked'], ['github', 'github']), 'github')
  assert.equal(oauthAccountNotLinkedProvider('access_denied', 'google'), null)
  assert.equal(oauthAccountNotLinkedProvider('account_not_linked', 'unknown'), null)
})
