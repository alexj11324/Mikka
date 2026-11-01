import assert from 'node:assert/strict'
import test from 'node:test'
import { markdown, runSmoke } from './production-smoke.mjs'

const env = { SMOKE_OWNER_EMAIL: 'test+mikka-smoke-owner@example.com', SMOKE_OWNER_PASSWORD: 'SECRET_PASSWORD', SMOKE_BASE_URL: 'https://app.example.com', SMOKE_EXPECT_ON: 'credentialVault,cloudComputer' }
const botId = '11111111-1111-4111-8111-111111111111'
function fixture(overrides = {}) {
  const calls = []
  const responses = {
    '/api/auth/sign-in/email': () => Response.json({}, { headers: { 'set-cookie': 'session=SECRET_COOKIE; Path=/; Secure; HttpOnly' } }),
    '/api/auth/get-session': () => Response.json({ user: { email: env.SMOKE_OWNER_EMAIL } }),
    '/en': () => new Response('<html>account</html>', { headers: { 'content-type': 'text/html' } }),
    '/api/coordinator/runtime': () => Response.json({ runtime: { harness: 'ai_sdk' } }),
    '/api/credentials': () => Response.json({ logins: [] }),
    '/api/approved-writes': () => Response.json({ enabled: false }),
    '/api/bots': () => Response.json([{ id: botId, name: 'Smoke Bot' }]),
    [`/api/bots/${botId}/computer/runtimes`]: () => Response.json({ runtimes: [] }),
    ...overrides,
  }
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ path: url.pathname, options })
    const respond = responses[url.pathname.replace('/mikka', '')]
    assert.ok(respond, 'unexpected endpoint')
    return respond()
  } }
}

test('normal login carries session only to same-origin read probes; reports contain no credentials', async () => {
  const io = fixture()
  const report = await runSmoke({ env, fetchImpl: io.fetchImpl })
  assert.equal(report.status, 'pass')
  assert.equal(report.results.length, 4)
  assert.equal(io.calls.filter(call => call.options.method === 'POST').length, 1)
  assert.ok(io.calls.slice(1).every(call => call.options.headers.cookie === 'session=SECRET_COOKIE'))
  assert.ok(io.calls.every(call => call.options.redirect === 'error'))
  assert.ok(!JSON.stringify(report).includes('SECRET'))
  assert.ok(!markdown(report).includes(env.SMOKE_OWNER_EMAIL))
})

test('a disabled required capability or failed Coordinator read fails the smoke', async () => {
  const off = fixture({ [`/api/bots/${botId}/computer/runtimes`]: () => Response.json({ error: 'SECRET_PROVIDER' }, { status: 503 }) })
  assert.equal((await runSmoke({ env, fetchImpl: off.fetchImpl })).status, 'fail')
  const unavailable = fixture({ '/api/coordinator/runtime': () => Response.json({ error: 'unavailable' }, { status: 503 }) })
  assert.equal((await runSmoke({ env: { ...env, SMOKE_EXPECT_ON: '' }, fetchImpl: unavailable.fetchImpl })).status, 'fail')
})

test('missing cookies and mismatched account fail before application probes', async () => {
  const noCookie = fixture({ '/api/auth/sign-in/email': () => Response.json({ token: 'SECRET' }) })
  await assert.rejects(runSmoke({ env, fetchImpl: noCookie.fetchImpl }), /smoke_session_cookie_missing/)
  assert.equal(noCookie.calls.length, 1)
  const wrongAccount = fixture({ '/api/auth/get-session': () => Response.json({ user: { email: 'other@example.com' } }) })
  await assert.rejects(runSmoke({ env, fetchImpl: wrongAccount.fetchImpl }), /smoke_session_invalid/)
  assert.equal(wrongAccount.calls.length, 2)
})

test('configuration cannot send credentials to insecure targets or silently ignore misspelled required features', async () => {
  const io = fixture()
  for (const override of [
    { SMOKE_BASE_URL: 'http://remote.example.com' },
    { SMOKE_BASE_URL: 'https://user:SECRET@example.com' },
    { SMOKE_BASE_URL: 'https://app.example.com/unexpected' },
    { SMOKE_EXPECT_ON: 'cloudCompter' },
    { SMOKE_OWNER_EMAIL: 'ordinary@example.com' },
  ]) await assert.rejects(runSmoke({ env: { ...env, ...override }, fetchImpl: io.fetchImpl }), /smoke_/)
  assert.equal(io.calls.length, 0)
})

test('transport errors never expose cookies, URLs or provider error messages', async () => {
  await assert.rejects(runSmoke({ env, fetchImpl: async () => { throw new Error('SECRET_COOKIE https://private.example.com') } }), error => error.message === 'smoke_request_failed')
})
