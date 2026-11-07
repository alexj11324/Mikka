import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

mock.module('@vercel/oidc', { namedExports: { getVercelOidcToken: async () => { throw new Error('unconfigured') } } })
mock.module('@/lib/api-auth', { namedExports: { auth: { api: { getSession: async () => ({ user: { id: 'fixture-user' } }) } } } })
mock.module('@/lib/request-log', { namedExports: { noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler } })
const { GET } = await import('./route')

test('skills catalog uses the public API without a deployment identity and returns stable failure codes', async t => {
  let status = 200
  t.mock.method(globalThis, 'fetch', async (input: URL, options: RequestInit) => {
    assert.equal(input.origin, 'https://skills.sh')
    assert.equal(new Headers(options.headers).has('authorization'), false)
    assert.equal(options.redirect, 'error')
    return status === 200 ? Response.json({ data: [] }) : new Response('private provider error', { status })
  })
  const request = new Request('https://self-hosted.example.test/mikka/api/skills/search?q=typescript')
  assert.deepEqual(await (await GET(request)).json(), { data: [], hasMore: false })
  status = 401
  const unavailable = await GET(request)
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { error: 'skills_search_unavailable' })
})
