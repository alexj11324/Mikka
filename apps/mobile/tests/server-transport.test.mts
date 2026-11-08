import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { boundAuthFetch } from '../lib/server-transport.ts'

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
