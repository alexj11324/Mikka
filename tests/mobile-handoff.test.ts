import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { oneTimeToken } from 'better-auth/plugins'

// Real Better Auth with isolated in-memory storage; no accounts or provider calls leave this process.
const data: Record<string, any[]> = { user: [], session: [], account: [], verification: [] }
const auth = betterAuth({
  baseURL: 'https://handoff.test', secret: 'isolated-test-secret-123456789012345678901234',
  database: memoryAdapter(data), emailAndPassword: { enabled: true },
  plugins: [oneTimeToken({ expiresIn: 1, storeToken: 'hashed' })],
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
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), 'https://handoff.test/?section=coordinator')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal((await session(cookieHeader(response.headers)))?.user.id, alice.id)
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

test('current GET contract: a valid induced link replaces an existing browser session (login CSRF)', async () => {
  const alice = await signUp('alice2')
  const bob = await signUp('bob2')
  const response = await open(await issue(alice.cookie), bob.cookie)
  assert.equal((await session(cookieHeader(response.headers)))?.user.id, alice.id)
  assert.notEqual(alice.id, bob.id)
})
