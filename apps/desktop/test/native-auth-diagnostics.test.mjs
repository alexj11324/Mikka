import assert from 'node:assert/strict'
import test from 'node:test'
import { authDiagnosticRoute, nativeDiagnosticFailure } from './native-auth-diagnostics.mjs'

test('authentication diagnostics use a closed route vocabulary', () => {
  for (const [path, expected] of [
    ['/mikka/api/desktop/begin', 'desktop-begin'], ['/mikka/api/desktop/return', 'desktop-return'],
    ['/mikka/api/desktop/exchange', 'desktop-exchange'], ['/mikka/api/auth/get-session', 'auth-session'],
    ['/mikka/api/auth/sign-out', 'auth-sign-out'], ['/auth/callback', 'loopback'],
    ['/mikka/en', 'root'], ['/mikka/en/sign-in', 'sign-in'],
    ['/mikka/en/a/short-secret', 'public-share'], ['/mikka/api/artifacts/shared/short-secret/frame', 'public-share-api'],
    ['/mikka/assets/short-secret.js', 'asset'], ['/private/short-secret', 'other'],
  ]) assert.equal(authDiagnosticRoute(`https://secret-host.example${path}?token=short-secret#secret`), expected)
})

test('malformed and encoded credential paths cannot escape as output', () => {
  for (const value of ['secret', 'mikka://app/mikka/api/desktop/exchange/short-secret',
    'https://example.test/mikka/api/desktop/%65xchange', 'https://example.test/short-secret',
    'https://example.test/mikka/en/a/short-secret/extra']) assert.equal(authDiagnosticRoute(value), 'other')
})

test('failure diagnostics keep only closed error categories and bounded causes', () => {
  const secret = 'a-short-secret'
  const error = new AggregateError([new Error(`https://example.test/${secret}?code=${secret}`)], secret, { cause: new Error(secret) })
  assert.deepEqual(nativeDiagnosticFailure(error), { kind: 'AggregateError', code: 'other', cause: { kind: 'Error', code: 'other' }, errors: [{ kind: 'Error', code: 'other' }] })
  assert.equal(JSON.stringify(nativeDiagnosticFailure(error)).includes(secret), false)
  assert.equal(nativeDiagnosticFailure(new Error('NATIVE_SESSION_WAIT_TIMEOUT: private details')).code, 'NATIVE_SESSION_WAIT_TIMEOUT')
})
