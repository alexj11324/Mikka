import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { CLEANUP_ENDPOINT, runCredentialCleanup } from './credential-cleanup'

test('default-off performs no request and never invents credentials', async () => {
  assert.deepEqual(await runCredentialCleanup({}, async () => { throw new Error('must not run') }), { enabled: false })
  await assert.rejects(runCredentialCleanup({ CREDENTIAL_CLEANUP_ENABLED: '1' }), /not_configured/)
})

test('real HTTP transport authenticates, reports bounded progress, preserves failures and refuses redirects', async () => {
  let status = 200, count = 0, redirected = 0
  const server = createServer((req, res) => {
    if (req.url === '/other') { redirected++; res.end('should not receive auth'); return }
    assert.equal(req.headers.authorization, 'Bearer synthetic-test-only')
    count++
    res.writeHead(status, status === 302 ? { location: '/other' } : { 'content-type': 'application/json' })
    res.end(status === 200 ? JSON.stringify({ checked: 2 }) : 'private provider exception must not escape')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const transport: typeof fetch = (url, init) => {
    assert.equal(url, CLEANUP_ENDPOINT)
    assert.equal(init?.redirect, 'error')
    assert.ok(init?.signal)
    return fetch(`http://127.0.0.1:${port}/cleanup`, init)
  }
  const env = { CREDENTIAL_CLEANUP_ENABLED: '1', CRON_SECRET: 'synthetic-test-only' }
  try {
    assert.deepEqual(await runCredentialCleanup(env, transport), { enabled: true, checked: 2 })
    for (status of [401, 503, 302]) await assert.rejects(runCredentialCleanup(env, transport), { message: 'credential_cleanup_failed' })
    assert.equal(redirected, 0)
    status = 200
    assert.equal((await runCredentialCleanup(env, transport)).checked, 2)
    assert.equal(count, 5)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('malformed results and network ambiguity never report successful cleanup', async () => {
  const env = { CREDENTIAL_CLEANUP_ENABLED: '1', CRON_SECRET: 'synthetic-test-only' }
  for (const body of [{}, { checked: -1 }, { checked: 101 }, { checked: 1.5 }, { checked: '2' }]) {
    await assert.rejects(runCredentialCleanup(env, async () => Response.json(body)), { message: 'credential_cleanup_failed' })
  }
  await assert.rejects(runCredentialCleanup(env, async () => { throw new Error('secret upstream details') }), { message: 'credential_cleanup_failed' })
})

test('scheduled minute dispatch is opt-in and daily Linear path is not redirected', async () => {
  const { default: worker } = await import('./index')
  const pending: Promise<unknown>[] = []
  let requests = 0
  const previous = globalThis.fetch
  globalThis.fetch = async url => { assert.equal(url, CLEANUP_ENDPOINT); requests++; return Response.json({ checked: 0 }) }
  try {
    const ctx = { waitUntil(promise: Promise<unknown>) { pending.push(promise) } }
    worker.scheduled({ cron: '* * * * *' }, {}, ctx)
    worker.scheduled({ cron: '0 4 * * *' }, { CREDENTIAL_CLEANUP_ENABLED: '1' }, ctx)
    assert.equal(requests, 0)
    worker.scheduled({ cron: '* * * * *' }, { CREDENTIAL_CLEANUP_ENABLED: '1', CRON_SECRET: 'synthetic-test-only' }, ctx)
    await Promise.all(pending)
    assert.equal(requests, 1)
  } finally { globalThis.fetch = previous }
})
