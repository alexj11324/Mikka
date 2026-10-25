import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'
import { signJWT } from 'better-auth/crypto'
import { createAuthEmail, AUTH_EMAIL_FROM, type AuthMailContext } from './auth-email'

const databaseURL = process.env.AUTH_EMAIL_TEST_DATABASE_URL
if (!databaseURL) throw new Error('Run node scripts/test-auth-email.mjs; never inherit an application database')
const target = new URL(databaseURL)
if (target.hostname !== '127.0.0.1' || !target.pathname.endsWith('_e2e')) throw new Error('Isolated loopback authentication database required')
const pool = new Pool({ connectionString: databaseURL, max: 8 })
const origin = 'https://auth.example.test'
const secret = 'synthetic-auth-email-secret-with-enough-entropy'
const root = `${origin}/mikka/api/auth`
let fixtureNumber = 0
before(async () => { await (await getMigrations({ database: pool, emailAndPassword: { enabled: true } })).runMigrations() })
after(async () => { await pool.end() })

function fixture(autoSend = false, deferred = false) {
  const fixtureIP = `198.51.100.${++fixtureNumber}`
  const mail: { to: string[]; from: string; text: string }[] = []
  const reports: unknown[] = []
  let fail = false
  let key: string | undefined = 'synthetic-resend-key'
  let failUpdate = false
  let duringVerify: (() => Promise<void>) | undefined
  const pending: (() => Promise<void>)[] = []
  const email = createAuthEmail({ origin, apiKey: () => key,
    context: async (): Promise<AuthMailContext> => auth.$context,
    report: event => reports.push(event),
    ...(deferred ? { background: (task: () => Promise<void>) => { pending.push(task) } } : {}),
    fetch: async (input, init) => {
      assert.equal(input, 'https://api.resend.com/emails')
      assert.equal(init?.redirect, 'error')
      mail.push(JSON.parse(String(init?.body)))
      return fail ? new Response('provider-body-with-secret-should-not-escape', { status: 503 }) : Response.json({ id: 'synthetic-message-id' })
    },
  })
  const auth = betterAuth({ baseURL: origin, basePath: '/mikka/api/auth', secret, database: pool,
    emailAndPassword: email.emailAndPassword, emailVerification: { ...email.emailVerification, sendOnSignUp: autoSend },
    rateLimit: email.rateLimit, trustedOrigins: [origin], logger: { disabled: true },
    databaseHooks: { user: { update: { before: async () => { if (failUpdate) throw new Error('synthetic update failure') } } } },
    hooks: {
      before: createAuthMiddleware(async ctx => {
        const result = await email.before(ctx)
        if (ctx.path === '/verify-email' && duringVerify) await duringVerify()
        return result
      }),
      after: createAuthMiddleware(async ctx => {
        if (ctx.path === '/verify-email' || ctx.path?.startsWith('/reset-password')) {
          ctx.setHeader('referrer-policy', 'no-referrer')
          ctx.setHeader('cache-control', 'no-store')
        }
        const result = await email.publicRequestResult(ctx.path, ctx.context.returned, ctx.request)
        if (result) return Response.json(result, { status: 202, headers: { 'cache-control': 'no-store' } })
      }),
    },
  })
  const post = (path: string, body: unknown, ip = fixtureIP) => auth.handler(new Request(`${root}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': ip }, body: JSON.stringify(body),
  }))
  const get = (url: URL) => auth.handler(new Request(url, { headers: { 'x-forwarded-for': fixtureIP } }))
  return { auth, email, mail, reports, post, get, updateFailure: (value: boolean) => { failUpdate = value }, race: (operation: () => Promise<void>) => { duringVerify = operation }, flush: () => Promise.all(pending.splice(0).map(task => task())), failure: () => { fail = true }, noKey: () => { key = undefined } }
}
let seq = 0
async function user(f: ReturnType<typeof fixture>) {
  const email = `fixture-${++seq}@example.test`
  return f.auth.api.signUpEmail({ body: { name: 'Synthetic', email, password: 'synthetic-password-initial' } })
}
function link(f: ReturnType<typeof fixture>) { return new URL(f.mail.at(-1)!.text.split('\n').find(line => line.startsWith('https://'))!) }

test('automatic signup sends the fixed verified sender without breaking normal signup session', async () => {
  const f = fixture(true)
  const created = await user(f)
  assert.ok(created.token)
  assert.equal(f.mail.length, 1)
  assert.equal(f.mail[0].from, AUTH_EMAIL_FROM)
  assert.equal(link(f).origin, origin)
  assert.equal(link(f).searchParams.get('callbackURL'), `${origin}/mikka/sign-in`)
  assert.equal(f.mail[0].text.includes('15 minutes'), true)
  const claims = JSON.parse(Buffer.from(link(f).searchParams.get('token')!.split('.')[1], 'base64url').toString())
  assert.equal(claims.exp - claims.iat, 900)
})

test('real Better Auth verification consumes once atomically; wrong callback cannot burn the link', async () => {
  const f = fixture(); const created = await user(f)
  const sent = await f.post('/send-verification-email', { email: created.user.email })
  assert.equal(sent.status, 202)
  const url = link(f)
  const foreign = new URL(url); foreign.searchParams.set('callbackURL', 'https://evil.example/')
  assert.equal((await f.get(foreign)).status, 400)
  for (const value of ['/', '', `${origin}/`, 'mikka/sign-in']) {
    const wrong = new URL(url); wrong.searchParams.set('callbackURL', value)
    assert.equal((await f.get(wrong)).status, 400)
  }
  const results = await Promise.all(Array.from({ length: 4 }, () => f.get(url)))
  assert.equal(results.filter(r => r.status === 302).length, 1)
  assert.equal(results.filter(r => r.status === 400).length, 3)
  assert.equal(results.find(r => r.status === 302)!.headers.get('referrer-policy'), 'no-referrer')
  assert.equal((await f.get(url)).status, 400)
  const row = await pool.query('select "emailVerified" from "user" where id=$1', [created.user.id])
  assert.equal(row.rows[0].emailVerified, true)
})

test('missing nonce, tampering, expired signatures and direct API callback tricks fail closed', async () => {
  const f = fixture(); const created = await user(f)
  await f.post('/send-verification-email', { email: created.user.email }, '192.0.2.2')
  const url = link(f)
  const missing = new URL(url); missing.searchParams.delete('nonce')
  assert.equal((await f.get(missing)).status, 400)
  const altered = new URL(url); altered.searchParams.set('token', 'invalid')
  assert.equal((await f.get(altered)).status, 400)
  const expired = await signJWT({ email: created.user.email }, secret, -1)
  const old = new URL(url); old.searchParams.set('token', expired)
  assert.equal((await f.get(old)).status, 400)
  await assert.rejects(f.auth.api.sendVerificationEmail({ body: { email: created.user.email, callbackURL: '//evil.example/' } }))
  assert.equal((await f.get(url)).status, 302)
})

test('a link issued for a deleted account cannot verify a different new owner with the same email', async () => {
  const f = fixture(); const created = await user(f)
  await f.post('/send-verification-email', { email: created.user.email }, '192.0.2.3')
  const url = link(f)
  await pool.query('delete from "user" where id=$1', [created.user.id])
  await f.auth.api.signUpEmail({ body: { name: 'New synthetic owner', email: created.user.email, password: 'synthetic-new-owner-password' } })
  assert.equal((await f.get(url)).status, 400)
  const row = await pool.query('select "emailVerified" from "user" where email=$1', [created.user.email])
  assert.equal(row.rows[0].emailVerified, false)
})

test('recipient throttling applies across independent auth instances and automatic/manual send paths', async () => {
  const f = fixture(true); const created = await user(f)
  const other = fixture()
  assert.equal((await other.post('/send-verification-email', { email: created.user.email }, '192.0.2.4')).status, 202)
  assert.equal(other.mail.length, 0)
  assert.deepEqual(other.reports, [{ kind: 'verification', outcome: 'throttled' }])
})

test('deletion/recreation between issuance consumption and library lookup cannot substitute another owner', async () => {
  const f = fixture(); const created = await user(f)
  await f.post('/send-verification-email', { email: created.user.email }, '192.0.2.30')
  const url = link(f)
  f.race(async () => {
    await pool.query('delete from "user" where id=$1', [created.user.id])
    await f.auth.api.signUpEmail({ body: { name: 'Racing synthetic owner', email: created.user.email, password: 'synthetic-racing-owner-password' } })
  })
  assert.equal((await f.get(url)).status, 400)
  const row = await pool.query('select "emailVerified" from "user" where email=$1', [created.user.email])
  assert.equal(row.rows[0].emailVerified, false)
})

test('unknown recipient and rejected delivery have identical public responses; failures remain explicit server-side', async () => {
  const f = fixture(); const created = await user(f); f.failure()
  const known = await f.post('/send-verification-email', { email: created.user.email }, '192.0.2.5')
  const unknown = await f.post('/send-verification-email', { email: 'unknown-fixture@example.test' }, '192.0.2.6')
  assert.equal(known.status, 202); assert.equal(unknown.status, 202)
  assert.deepEqual(await known.json(), await unknown.json())
  assert.deepEqual(f.reports, [{ kind: 'verification', outcome: 'failed' }])
  const resetKnown = await f.post('/request-password-reset', { email: created.user.email }, '192.0.2.7')
  const resetUnknown = await f.post('/request-password-reset', { email: 'unknown-fixture@example.test' }, '192.0.2.8')
  assert.equal(resetKnown.status, 202); assert.equal(resetUnknown.status, 202)
  assert.deepEqual(await resetKnown.json(), await resetUnknown.json())
})

test('password reset remains single-use and revokes existing sessions through real Better Auth', async () => {
  const f = fixture(); const created = await user(f)
  const reset = await f.post('/request-password-reset', { email: created.user.email }, '192.0.2.9')
  assert.equal(reset.status, 202)
  const url = link(f); const token = url.pathname.split('/').at(-1)!
  assert.equal(url.searchParams.get('callbackURL'), `${origin}/mikka/reset-password`)
  const wrong = new URL(url); wrong.searchParams.set('callbackURL', '/')
  assert.equal((await f.get(wrong)).status, 400)
  const results = await Promise.all(Array.from({ length: 3 }, () => f.post('/reset-password', { token, newPassword: 'synthetic-password-replacement' }, '192.0.2.10')))
  assert.equal(results.filter(r => r.status === 200).length, 1)
  assert.equal(results.filter(r => r.status === 400).length, 2)
  const sessions = await pool.query('select count(*)::int as count from session where "userId"=$1', [created.user.id])
  assert.equal(sessions.rows[0].count, 0)
  assert.equal((await f.post('/sign-in/email', { email: created.user.email, password: 'synthetic-password-initial' }, '192.0.2.11')).status, 401)
  assert.equal((await f.post('/sign-in/email', { email: created.user.email, password: 'synthetic-password-replacement' }, '192.0.2.12')).status, 200)
})

test('missing server key fails uniformly; foreign origins and reset destinations stay rejected', async () => {
  const f = fixture(); f.noKey()
  for (const path of ['/send-verification-email', '/request-password-reset']) {
    assert.equal((await f.post(path, { email: 'unknown@example.test' }, '192.0.2.13')).status, 503)
  }
  const configured = fixture()
  assert.equal((await configured.post('/request-password-reset', { email: 'unknown@example.test', redirectTo: 'https://evil.example/' }, '192.0.2.14')).status, 403)
  const response = await configured.auth.handler(new Request(`${root}/request-password-reset`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ email: 'unknown@example.test' }) }))
  assert.equal(response.status, 403)
  assert.equal(configured.mail.length, 0)
})

test('background delivery does not expose provider latency or failure as account existence', async () => {
  const f = fixture(false, true); const created = await user(f); f.failure()
  const known = await f.post('/send-verification-email', { email: created.user.email }, '192.0.2.21')
  const unknown = await f.post('/send-verification-email', { email: 'unknown-deferred@example.test' }, '192.0.2.22')
  assert.equal(known.status, 202); assert.equal(unknown.status, 202)
  assert.deepEqual(await known.json(), await unknown.json())
  assert.equal(f.mail.length, 0)
  await f.flush()
  assert.equal(f.mail.length, 1)
  assert.deepEqual(f.reports, [{ kind: 'verification', outcome: 'failed' }])
})

test('expired reset token does not change a password or revoke a session', async () => {
  const f = fixture(); const created = await user(f)
  await f.post('/request-password-reset', { email: created.user.email }, '192.0.2.23')
  const token = link(f).pathname.split('/').at(-1)!
  await pool.query('update verification set "expiresAt"=now()-interval \'1 second\' where identifier=$1', [`reset-password:${token}`])
  assert.equal((await f.post('/reset-password', { token, newPassword: 'synthetic-expired-replacement' }, '192.0.2.24')).status, 400)
  const sessions = await pool.query('select count(*)::int as count from session where "userId"=$1', [created.user.id])
  assert.equal(sessions.rows[0].count, 1)
  assert.equal((await f.post('/sign-in/email', { email: created.user.email, password: 'synthetic-password-initial' }, '192.0.2.25')).status, 200)
})

test('HTTP request rate limits are enabled independently of production mode', async () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) assert.equal((await f.post('/request-password-reset', { email: 'absent-rate@example.test' }, '192.0.2.26')).status, 202)
  assert.equal((await f.post('/request-password-reset', { email: 'absent-rate@example.test' }, '192.0.2.26')).status, 429)
})


test('instance A issues and instance B validates; successful verification rejects replay', async () => {
  const a = fixture(); const created = await user(a); const b = fixture()
  await a.post('/send-verification-email', { email: created.user.email })
  const url = link(a)
  assert.equal((await b.get(url)).status, 302)
  assert.equal((await a.get(url)).status, 400)
})

test('user update failure rolls back nonce consumption and another instance can retry', async () => {
  const a = fixture(); const created = await user(a)
  await a.post('/send-verification-email', { email: created.user.email })
  const url = link(a); a.updateFailure(true)
  assert.equal((await a.get(url)).status, 500)
  assert.equal((await pool.query('select "emailVerified" from "user" where id=$1', [created.user.id])).rows[0].emailVerified, false)
  const b = fixture()
  assert.equal((await b.get(url)).status, 302)
  assert.equal((await a.get(url)).status, 400)
})


test('HEAD inspection cannot consume a verification link; normal GET consumes exactly once', async () => {
  const f = fixture(); const created = await user(f)
  await f.post('/send-verification-email', { email: created.user.email })
  const url = link(f)
  const head = await f.auth.handler(new Request(url, { method: 'HEAD' }))
  assert.notEqual(head.status, 302)
  assert.equal((await f.get(url)).status, 302)
  assert.equal((await f.get(url)).status, 400)
})
