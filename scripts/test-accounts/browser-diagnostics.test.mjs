import assert from 'node:assert/strict'
import test from 'node:test'
import { browserConsoleDiagnostic, browserResponseDiagnostic, browserRouteClass, browserTestErrorDiagnostic } from './browser-diagnostics.mjs'

const origin = 'http://localhost:3100'

test('browser diagnostics retain HTTP and reviewed network categories without raw text', () => {
  assert.deepEqual(browserConsoleDiagnostic('Failed to load resource: the server responded with a status of 404 (Not Found)', `${origin}/mikka/api/auth/get-session`, origin), { category: 'resource-http', status: 404, route: 'auth-session' })
  assert.deepEqual(browserConsoleDiagnostic('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT', 'https://example.test/favicon.ico', origin), { category: 'resource-network', code: 'ERR_BLOCKED_BY_CLIENT', route: 'other-origin' })
  assert.deepEqual(browserConsoleDiagnostic('Minified React error #418; visit a diagnostic URL', `${origin}/mikka/_next/static/chunks/hash.js`, origin), { category: 'react-minified', code: 418, route: 'next-chunk' })
  assert.deepEqual(browserResponseDiagnostic(503, `${origin}/mikka/api/coordinator/messages`, origin), { category: 'http-response', status: 503, route: 'coordinator-messages' })
})

test('query strings, credentials, dynamic paths and unknown diagnostics never reach reports', () => {
  const secret = 'synthetic-secret-do-not-print'
  const inputs = [
    `${origin}/mikka/api/auth/get-session?token=${secret}#${secret}`,
    `${origin}/mikka/api/conversations/${secret}/read`,
    `${origin}/mikka/${secret}`,
    `http://${secret}:${secret}@localhost:3100/mikka`,
    `https://${secret}.example.test/${secret}`,
    `data:text/plain,${secret}`,
  ]
  for (const location of inputs) {
    const result = JSON.stringify([
      browserConsoleDiagnostic(`Internal error: ${secret}`, location, origin),
      browserResponseDiagnostic(401, location, origin),
    ])
    assert.equal(result.includes(secret), false)
    assert.equal(result.includes('token='), false)
    assert.equal(result.includes('http:'), false)
  }
  assert.equal(browserRouteClass(inputs[0], origin), 'auth-session')
  assert.equal(browserRouteClass(inputs[1], origin), 'conversation-read')
  assert.deepEqual(browserConsoleDiagnostic(`Failed to load resource: net::ERR_${secret}`, '', origin), { category: 'console-error', route: 'unknown-location' })
})

test('body errors keep their failure category and reviewed source position before teardown', () => {
  const error = { message: 'Error: expect(received).toBe(expected)\nExpected: secret-value', stack: 'Error: private detail\n at setup (/home/runner/work/Mikka/Mikka/tests/mvp/core-loop.spec.ts:143:27)' }
  assert.deepEqual(browserTestErrorDiagnostic(error), { category: 'assertion', location: { file: 'tests/mvp/core-loop.spec.ts', line: 143, column: 27 } })
  assert.deepEqual(browserTestErrorDiagnostic({ ...error, message: 'Test timeout of 180000ms exceeded.' }), { category: 'timeout', location: { file: 'tests/mvp/core-loop.spec.ts', line: 143, column: 27 } })
  assert.deepEqual(browserTestErrorDiagnostic({ message: 'private error', stack: 'at /private/secret-value.ts:1:1' }), { category: 'test-error', location: null })
  assert.deepEqual(browserTestErrorDiagnostic({ message: 'private error', stack: 'at tests/mvp/secret-value.ts:1:1' }), { category: 'test-error', location: null })
  assert.deepEqual(browserTestErrorDiagnostic(null), { category: 'test-error', location: null })
})
