import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { oneTimeToken } from 'better-auth/plugins'
import { nextCookies } from 'better-auth/next-js'
import { openHandoff, sealHandoff } from '../lib/mobile-handoff'

const ambientCookies: string[] = []
mock.module('next/headers.js', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ set: (name: string) => { ambientCookies.push(name) } }) } })

// Real Better Auth with isolated in-memory storage; no accounts or provider calls leave this process.
const data: Record<string, any[]> = { user: [], session: [], account: [], verification: [] }
const auth = betterAuth({
  baseURL: 'https://handoff.test', secret: 'isolated-test-secret-123456789012345678901234',
  database: memoryAdapter(data), emailAndPassword: { enabled: true },
  plugins: [oneTimeToken({ expiresIn: 1, storeToken: 'hashed' }), nextCookies()],
})
mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { auth } })
mock.module(new URL('../lib/mcp/resource.ts', import.meta.url).href, { namedExports: { appOrigin: 'https://handoff.test' } })
const route = import('../app/api/mobile/open/route')

const cookieHeader = (headers: Headers) => headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
async function signUp(name: string) {
  const result = await auth.api.signUpEmail({ body: { name, email: `${name}@example.test`, password: 'synthetic-password-123' }, returnHeaders: true })
  return { id: result.response.user.id, cookie: cookieHeader(result.headers) }
}
async function issue(cookie: string) {
  return (await auth.api.generateOneTimeToken({ headers: new Headers({ cookie }) })).token
}
async function open(token: string, cookie?: string) {
  const { GET } = await route
  ambientCookies.length = 0
  return GET(new Request(`https://handoff.test/api/mobile/open?${new URLSearchParams({ token, to: '/?section=coordinator' })}`, { headers: cookie ? { cookie } : {} }))
}
async function session(cookie: string) {
  return auth.api.getSession({ headers: new Headers({ cookie }) })
}

test('handoff binds browser to issuing account, consumes token and rejects expiry', async () => {
  await assert.rejects(() => auth.api.generateOneTimeToken({ headers: new Headers() }))
  const alice = await signUp('alice')
  const bob = await signUp('bob')
  const token = await issue(alice.cookie)
  assert.ok(!JSON.stringify(data.verification).includes(token), 'stored token must be hashed')
  const response = await open(token)
  assert.equal(response.status, 200)
  assert.equal(ambientCookies.length, 0, 'nextCookies must not sign in before confirmation')
  assert.equal((await session(cookieHeader(response.headers))), null)
  const confirmed = await confirm(response)
  assert.equal(confirmed.status, 303)
  assert.equal(confirmed.headers.get('location'), 'https://handoff.test/?section=coordinator')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal((await session(cookieHeader(confirmed.headers)))?.user.id, alice.id)
  const invalid = await open('invalid', bob.cookie)
  assert.equal(invalid.headers.getSetCookie().length, 0)
  const replay = await open(token, bob.cookie)
  assert.equal(replay.headers.getSetCookie().length, 0)
  assert.equal((await session(bob.cookie))?.user.id, bob.id)
  const expired = await issue(alice.cookie)
  data.verification[0].expiresAt = new Date(Date.now() - 1000)
  const stale = await open(expired, bob.cookie)
  assert.equal(stale.headers.getSetCookie().length, 0)
  assert.equal((await session(bob.cookie))?.user.id, bob.id)
})

async function confirm(response: Response, origin = 'https://handoff.test', cookie?: string, csrf?: string) {
  const { POST } = await route
  const html = await response.clone().text()
  return POST(new Request('https://handoff.test/api/mobile/open', {
    method: 'POST', headers: { origin, cookie: cookie ?? cookieHeader(response.headers) },
    body: new URLSearchParams({ csrf: csrf ?? /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '' }),
  }))
}

test('induced GET does not switch accounts; confirmation requires same origin and browser cookie', async () => {
  const alice = await signUp('alice2')
  const bob = await signUp('bob2')
  const response = await open(await issue(alice.cookie), bob.cookie)
  assert.equal(response.status, 200)
  assert.equal(ambientCookies.length, 0, 'nextCookies must not sign in before confirmation')
  assert.equal((await session(bob.cookie))?.user.id, bob.id)
  assert.equal((await session(cookieHeader(response.headers))), null)
  assert.match(await response.clone().text(), /alice2@example.test/)
  assert.equal((await confirm(response, 'https://evil.test')).status, 403)
  assert.equal((await confirm(response, 'https://handoff.test', bob.cookie)).status, 403)
  assert.equal((await confirm(response, 'https://handoff.test', undefined, 'wrong')).status, 403)
  const confirmed = await confirm(response)
  assert.equal((await session(cookieHeader(confirmed.headers)))?.user.id, alice.id)
})

test('confirmation rejects expired, tampered state and a revoked underlying session', async () => {
  const alice = await signUp('alice3')
  const response = await open(await issue(alice.cookie))
  const secret = (await auth.$context).secret
  const cookie = cookieHeader(response.headers)
  const encoded = cookie.slice(cookie.indexOf('=') + 1)
  const state = openHandoff(encoded, secret)!
  const otherOrigin = sealHandoff({ ...state, origin: 'https://other-preview.test' }, secret)
  assert.equal((await confirm(response, 'https://handoff.test', `mikka-mobile-handoff=${otherOrigin}`)).status, 403)
  const expired = sealHandoff({ ...state, expires: Date.now() - 1 }, secret)
  assert.equal((await confirm(response, 'https://handoff.test', `mikka-mobile-handoff=${expired}`)).status, 403)
  assert.equal(openHandoff(encoded.slice(0, 30) + (encoded[30] === 'A' ? 'B' : 'A') + encoded.slice(31), secret), null)
  await auth.api.signOut({ headers: new Headers({ cookie: alice.cookie }) })
  assert.equal((await confirm(response)).status, 403)
})
