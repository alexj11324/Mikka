import assert from 'node:assert/strict'
import test from 'node:test'
import { markdown, runSmoke } from './production-smoke.mjs'
import { decode, encode } from '../../lib/desktop-rpc/wire.ts'

const env = { SMOKE_OWNER_EMAIL: 'test+mikka-smoke-owner@example.com', SMOKE_OWNER_PASSWORD: 'SECRET_PASSWORD', SMOKE_BASE_URL: 'https://app.example.com', SMOKE_EXPECT_ON: 'credentialVault,cloudComputer' }
const botId = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
const teamId = '33333333-3333-4333-8333-333333333333'
const personalId = '44444444-4444-4444-8444-444444444444'
function fixture(overrides = {}, poll = { items: [{ id: botId, name: 'Renamed Coordinator', coordinator: true }], live: { ownerId, workspaceId: teamId } }) {
  const calls = []
  const responses = {
    '/api/auth/sign-in/email': () => Response.json({}, { headers: { 'set-cookie': 'session=SECRET_COOKIE; Path=/; Secure; HttpOnly' } }),
    '/api/auth/get-session': () => Response.json({ user: { id: ownerId, email: env.SMOKE_OWNER_EMAIL } }),
    '/en': () => new Response('<html>account</html>', { headers: { 'content-type': 'text/html' } }),
    '/api/coordinator/runtime': () => Response.json({ runtime: { harness: 'ai_sdk' } }),
    '/api/credentials': () => Response.json({ logins: [] }),
    '/api/approved-writes': () => Response.json({ enabled: false }),
    '/api/workspace': (url, options) => {
      const selected = url.searchParams.get('workspace') === teamId || options.headers.cookie?.includes('mikka-workspace=' + teamId)
      return Response.json({ currentUserId: ownerId, role: 'member', workspace: { id: selected ? teamId : personalId, kind: selected ? 'team' : 'personal' },
        choices: [{ id: teamId, kind: 'team' }, { id: personalId, kind: 'personal' }], members: selected ? [
          { userId: ownerId, email: env.SMOKE_OWNER_EMAIL, role: 'member', status: 'active' },
          { userId: 'admin', email: 'alex@acme.aspectlylabs.com', role: 'admin', status: 'active' },
        ] : [] })
    },
    '/api/rpc': (_url, options) => {
      const body = JSON.parse(options.body), args = decode(body.args)
      if (body.action === 'workspace.switchWorkspace') {
        assert.deepEqual(args, [teamId])
        return Response.json({ version: 1, ok: true, result: encode({ ok: true, data: { workspaceId: teamId } }) },
          { headers: { 'set-cookie': 'mikka-workspace=' + teamId + '; Path=/mikka; Secure' } })
      }
      assert.equal(body.action, 'bots.pollBots'); assert.deepEqual(args, [])
      assert.ok(options.headers.cookie.includes('mikka-workspace=' + teamId))
      return Response.json({ version: 1, ok: true, result: encode(poll) })
    },
    '/api/bots': () => Response.json([{ id: botId, name: 'Renamed Coordinator', coordinator: true }]),
    [`/api/bots/${botId}/computer/runtimes`]: () => Response.json({ runtimes: [] }),
    ...overrides,
  }
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ path: url.pathname, options })
    const respond = responses[url.pathname.replace('/mikka', '')]
    assert.ok(respond, 'unexpected endpoint')
    return respond(url, options)
  } }
}

test('normal login carries session only to same-origin read probes; reports contain no credentials', async () => {
  const io = fixture()
  const report = await runSmoke({ env, fetchImpl: io.fetchImpl })
  assert.equal(report.status, 'pass')
  assert.equal(report.results.length, 4)
  const posts = io.calls.filter(call => call.options.method === 'POST')
  assert.equal(posts.length, 3)
  assert.deepEqual(posts.filter(call => call.path.endsWith('/api/rpc')).map(call => JSON.parse(call.options.body).action), ['workspace.switchWorkspace', 'bots.pollBots'])
  assert.ok(io.calls.slice(1).every(call => call.options.headers.cookie.startsWith('session=SECRET_COOKIE')))
  assert.ok(report.team.teamWorkspaceConfirmed)
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

test('the computer read requires the unique Coordinator and exact authorized owner/workspace', async () => {
  const coordinator = { id: botId, name: 'Coordinator', coordinator: true }
  for (const poll of [
    { items: [{ ...coordinator, name: 'Smoke Bot', coordinator: false }], live: { ownerId, workspaceId: teamId } },
    { items: [coordinator, coordinator], live: { ownerId, workspaceId: teamId } },
    { items: [coordinator], live: { ownerId: 'other-owner', workspaceId: teamId } },
    { items: [coordinator], live: { ownerId, workspaceId: personalId } },
  ]) {
    const io = fixture({}, poll)
    await assert.rejects(runSmoke({ env, fetchImpl: io.fetchImpl }), /smoke_coordinator_missing/)
    assert.equal(io.calls.some(call => call.path.endsWith('/computer/runtimes')), false)
  }
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
