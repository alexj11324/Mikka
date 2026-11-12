import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createBrokerServer } from './server.mjs'

test('compiled broker over HTTP serves liveness, enforces caller identity and hides preview probes', async t => {
  const server = createBrokerServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(done => server.close(done)))
  const origin = 'http://127.0.0.1:' + server.address().port
  const get = await fetch(origin + '/health.json')
  assert.deepEqual(await get.json(), { ok: true })
  assert.match(get.headers.get('cache-control'), /no-store/)
  const head = await fetch(origin + '/health.json', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  for (const [method, path, expected] of [
    ['GET', '/api/fill', 404], ['POST', '/api/fill', 403], ['POST', '/api/oidc', 404],
    ['POST', '/api/fill?origin=elsewhere', 404], ['GET', '/other', 404],
  ]) {
    const response = await fetch(origin + path, { method })
    assert.equal(response.status, expected, method + ' ' + path)
    assert.match(response.headers.get('cache-control'), /no-store/)
  }
  const malformed = await fetch(origin + '/api/fill', { method: 'POST', headers: { authorization: 'Bearer invalid' } })
  assert.equal(malformed.status, 403)
  assert.equal((await malformed.json()).error, 'credential_denied')
})
