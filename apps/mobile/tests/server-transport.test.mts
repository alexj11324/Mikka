import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { createServer } from 'node:http'
import { boundAuthFetch } from '../lib/server-transport.ts'

mock.module('expo-constants', { defaultExport: { expoConfig: { version: '1.0.0' } } })
mock.module('expo-application', { namedExports: { nativeApplicationVersion: '1.0.0' } })
const { mobileFetchFor } = await import('../lib/tracing.ts')
const { onMobileUpdateRequired } = await import('../lib/startup.ts')

test('bound auth transport sends its cookie only to its own base and rejects redirects', async t => {
  let received: string | undefined
  const server = createServer((request, response) => {
    if (request.url?.endsWith('/redirect')) { response.writeHead(302, { location: '/elsewhere' }).end(); return }
    if (request.url === '/elsewhere') { assert.fail('a credentialed redirect must never be followed') }
    received = request.headers.cookie
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close(); server.closeAllConnections() })
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}/mikka`
  const request = boundAuthFetch(base, fetch)
  const cookie = 'better-auth.session_token=fixture-private-cookie'
  assert.equal((await request(`${base}/api/auth/get-session`, { headers: { cookie } })).status, 200)
  assert.equal(received, cookie)
  await assert.rejects(request(`${base}/api/auth/redirect`, { headers: { cookie } }))
  for (const path of [`http://localhost:${port}/mikka/api/auth/get-session`, `http://127.0.0.1:${port}/api/auth/get-session`, `${base}/api/mobile/settings`]) assert.throws(() => request(path, { headers: { cookie } }), /mobile_auth_target_invalid/)
})

test('the mobile fetch adapter sends its reader version only to its API and preserves a 426 for its caller', async t => {
  const base = 'https://mobile.example.test/mikka'
  const cause = { code: 'api_version_below_floor', version: 1, minimum: 2 }
  const upgrade = { error: 'update_required', minVersion: '2', minApiVersion: 2, message: 'Update Mikka before continuing.', cause }
  const notices: string[] = []
  const unsubscribe = onMobileUpdateRequired(server => notices.push(server))
  t.after(unsubscribe)
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const own = String(input).startsWith(`${base}/api/`)
    assert.equal(headers.get('x-mikka-api-version'), own ? '1' : null)
    assert.equal(headers.get('x-mikka-client'), own ? 'mobile' : null)
    return Response.json(upgrade, { status: 426 })
  })
  const request = mobileFetchFor(base)
  assert.deepEqual(await (await request(`${base}/api/auth/get-session`)).json(), upgrade)
  await request('https://other.example.test/mikka/api/auth/get-session')
  await request('https://mobile.example.test/elsewhere/api/auth/get-session')
  assert.deepEqual(notices, [base])
})
