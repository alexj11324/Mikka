import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { deviceAuthorization } from 'better-auth/plugins'
import { daemonAuthorizationOptions, exchangeDaemonSession } from './daemon-authorization'

const origin = 'https://preview.mikka.example'
const basePath = '/mikka'
const grant = 'urn:ietf:params:oauth:grant-type:device_code'
const deviceToken = `orv_${'d'.repeat(43)}`

function fixture() {
  const memory: Record<string, Array<Record<string, any>>> = { user: [], session: [], account: [], verification: [], deviceCode: [] }
  const issued: Array<{ userId: string; tokenHash: string }> = []
  const auth = betterAuth({
    baseURL: origin, basePath: `${basePath}/api/auth`,
    secret: 'isolated-device-auth-fixture-secret-at-least-32-chars',
    database: memoryAdapter(memory), emailAndPassword: { enabled: true },
    plugins: [deviceAuthorization(daemonAuthorizationOptions(basePath))],
    logger: { disabled: true },
    hooks: { after: createAuthMiddleware(async ctx => {
      const replacement = await exchangeDaemonSession({
        path: ctx.path, clientId: ctx.body?.client_id, returned: ctx.context.returned, newSession: ctx.context.newSession,
      }, {
        revokeSession: token => ctx.context.internalAdapter.deleteSession(token),
        issueToken: async userId => {
          issued.push({ userId, tokenHash: createHash('sha256').update(deviceToken).digest('hex') })
          return deviceToken
        },
      })
      if (replacement) { ctx.context.newSession = null; return ctx.json(replacement) }
    }) },
  })
  const post = (path: string, body: unknown, cookie = '') => auth.handler(new Request(`${origin}${basePath}/api/auth${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body),
  }))
  async function signIn(name: string) {
    const response = await post('/sign-up/email', { name, email: `${name}@fixture.invalid`, password: 'fixture-only-password-123' })
    assert.equal(response.status, 200)
    return response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
  }
  async function code() {
    const response = await post('/device/code', { client_id: 'mikka-daemon' })
    assert.equal(response.status, 200)
    return response.json() as Promise<{ device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string }>
  }
  const review = (userCode: string, cookie: string) => auth.handler(new Request(`${origin}${basePath}/api/auth/device?user_code=${userCode}`, { headers: { cookie } }))
  const poll = (device_code: string, client_id = 'mikka-daemon') => post('/device/token', { device_code, client_id, grant_type: grant })
  return { auth, memory, issued, post, signIn, code, poll, review }
}

test('device grant allows only the daemon and keeps the preview base path', async () => {
  const f = fixture()
  const rejected = await f.post('/device/code', { client_id: 'untrusted-client' })
  assert.equal(rejected.status, 400)
  assert.equal(f.memory.deviceCode.length, 0)
  const code = await f.code()
  assert.equal(code.verification_uri, `${origin}${basePath}/device`)
  assert.equal(new URL(code.verification_uri_complete).searchParams.get('user_code'), code.user_code)
  assert.equal((await f.poll(code.device_code, 'other-client')).status, 400)
  assert.equal(f.issued.length, 0)
})

test('approved device flow exchanges once, revokes its temporary session and preserves the browser session', async () => {
  const f = fixture()
  const cookie = await f.signIn('owner')
  const sessionCount = f.memory.session.length
  const code = await f.code()
  const pending = await f.poll(code.device_code)
  assert.equal((await pending.json()).error, 'authorization_pending')
  assert.equal((await f.review(code.user_code, cookie)).status, 200)
  const approval = await f.post('/device/approve', { userCode: code.user_code }, cookie)
  assert.equal(approval.status, 200)
  f.memory.deviceCode[0].lastPolledAt = new Date(0)
  const response = await f.poll(code.device_code)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { access_token: deviceToken, token_type: 'Bearer', scope: 'device' })
  assert.match(response.headers.get('cache-control') ?? '', /no-store/)
  assert.equal(f.issued.length, 1)
  assert.equal(f.issued[0].userId, f.memory.user[0].id)
  assert.equal(f.memory.session.length, sessionCount)
  assert.ok(f.memory.session.every(session => session.token !== deviceToken))
  const replay = await f.poll(code.device_code)
  assert.notEqual(replay.status, 200)
  assert.equal(f.issued.length, 1)
})

test('denied, expired and claimed-by-another-account grants never mint device credentials', async () => {
  const f = fixture()
  const owner = await f.signIn('owner')
  const other = await f.signIn('other')
  const denied = await f.code()
  assert.equal((await f.review(denied.user_code, owner)).status, 200)
  assert.equal((await f.post('/device/deny', { userCode: denied.user_code }, owner)).status, 200)
  assert.equal((await (await f.poll(denied.device_code)).json()).error, 'access_denied')
  const expired = await f.code()
  f.memory.deviceCode.find(row => row.deviceCode === expired.device_code)!.expiresAt = new Date(0)
  assert.equal((await (await f.poll(expired.device_code)).json()).error, 'expired_token')
  const bound = await f.code()
  const review = await f.auth.handler(new Request(`${origin}${basePath}/api/auth/device?user_code=${bound.user_code}`, { headers: { cookie: owner } }))
  assert.equal(review.status, 200)
  assert.equal((await f.post('/device/approve', { userCode: bound.user_code }, other)).status, 403)
  assert.equal(f.issued.length, 0)
})

test('a failed mint cannot leave a valid temporary session, and unrelated auth responses are unchanged', async () => {
  const revoked: string[] = []
  const input = { path: '/device/token', clientId: 'mikka-daemon', returned: { access_token: 'temporary-session' }, newSession: { user: { id: 'owner' }, session: { token: 'temporary-session' } } }
  const dependencies = { revokeSession: async (token: string) => { revoked.push(token) }, issueToken: async () => { throw new Error('fixture mint failed') } }
  await assert.rejects(exchangeDaemonSession(input, dependencies), /fixture mint failed/)
  assert.deepEqual(revoked, ['temporary-session'])
  assert.equal(await exchangeDaemonSession({ ...input, path: '/sign-in/email' }, dependencies), null)
  assert.equal(await exchangeDaemonSession({ ...input, newSession: null }, dependencies), null)
  assert.equal(await exchangeDaemonSession({ ...input, returned: { error: 'authorization_pending' } }, dependencies), null)
})
