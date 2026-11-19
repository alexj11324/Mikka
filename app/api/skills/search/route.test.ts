import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let oidcUnavailable = true
let upstreamStatus = 200
let expectedAuthorization = 'Bearer test-vercel-oidc-token'
let fetchCount = 0

mock.module('@vercel/oidc', { namedExports: { getVercelOidcToken: async () => {
  if (oidcUnavailable) throw new Error('unconfigured')
  return 'test-vercel-oidc-token'
} } })
mock.module('@/lib/api-auth', { namedExports: { auth: { api: { getSession: async () => ({ user: { id: 'fixture-user' } }) } } } })
mock.module('@/lib/request-log', { namedExports: { noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler } })
const { GET } = await import('./route')

test('skills catalog requires deployment OIDC and preserves authenticated access', async t => {
  fetchCount = 0
  t.mock.method(globalThis, 'fetch', async (input: URL, options: RequestInit) => {
    assert.equal(input.origin, 'https://skills.sh')
    fetchCount += 1
    assert.equal(new Headers(options.headers).get('authorization'), expectedAuthorization)
    assert.equal(options.redirect, 'error')
    return upstreamStatus === 200 ? Response.json({ data: [] }) : new Response('private provider error', { status: upstreamStatus })
  })
  const request = new Request('https://self-hosted.example.test/mikka/api/skills/search?q=typescript')

  const missingIdentity = await GET(request)
  assert.equal(missingIdentity.status, 503)
  assert.deepEqual(await missingIdentity.json(), { error: 'skills_search_identity_unavailable' })
  assert.equal(fetchCount, 0, 'must not make an unauthenticated upstream request')

  oidcUnavailable = false
  const available = await GET(request)
  assert.deepEqual(await available.json(), { data: [], hasMore: false })
  assert.equal(fetchCount, 1)

  upstreamStatus = 401
  const rejectedIdentity = await GET(request)
  assert.equal(rejectedIdentity.status, 503)
  assert.deepEqual(await rejectedIdentity.json(), { error: 'skills_search_identity_rejected' })
  assert.equal(fetchCount, 2)
})
