import assert from 'node:assert/strict'
import test from 'node:test'
import { oauthAccountNotLinkedProvider, ssoRefusalHasOwnNotice } from './auth-error'

test('recognizes an unlinked provider in single or repeated query values', () => {
  assert.equal(oauthAccountNotLinkedProvider('account_not_linked', 'google'), 'google')
  assert.equal(oauthAccountNotLinkedProvider(['account_not_linked', 'account_not_linked'], ['github', 'github']), 'github')
  assert.equal(oauthAccountNotLinkedProvider('access_denied', 'google'), null)
  assert.equal(oauthAccountNotLinkedProvider('account_not_linked', 'unknown'), null)
})

test('a company SSO refusal suppresses the generic notice only with a server-issued code', () => {
  assert.equal(ssoRefusalHasOwnNotice('failed', 'ENTERPRISE_DIRECTORY_INACTIVE'), true)
  assert.equal(ssoRefusalHasOwnNotice(['failed'], ['ENTERPRISE_SSO_REQUIRED']), true)
  // A bare sso=failed from a crafted link must not silence an unrelated OAuth error.
  assert.equal(ssoRefusalHasOwnNotice('failed', undefined), false)
  assert.equal(ssoRefusalHasOwnNotice('failed', 'access_denied'), false)
  assert.equal(ssoRefusalHasOwnNotice('failed', 'enterprise_directory_inactive'), false)
  assert.equal(ssoRefusalHasOwnNotice('failed', ['ENTERPRISE_SSO_REQUIRED', 'access_denied']), false)
  assert.equal(ssoRefusalHasOwnNotice(undefined, 'ENTERPRISE_DIRECTORY_INACTIVE'), false)
  assert.equal(ssoRefusalHasOwnNotice('ok', 'ENTERPRISE_DIRECTORY_INACTIVE'), false)
})
