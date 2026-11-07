import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { createCloudGitHubReceiver } from '../lib/github/cloud-webhook'
import { isE2eTarget } from './helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Cloud GitHub DB test requires matching isolated loopback _e2e URLs')

test('real PostgreSQL replicas dedupe cloud deliveries, recover failure, and preserve receipts', { skip: !valid }, async () => {
  const pool = new Pool({ connectionString: target, max: 5 }), id = randomUUID(), secret = 'fixture-server-secret', now = Date.now()
  let calls = 0, failure = true, release: (() => void) | undefined, entered: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const dispatch = async () => { calls++; if (failure) throw new Error('fixture_dispatch_failure'); entered!(); await gate; return new Response(null, { status: 202 }) }
  const a = createCloudGitHubReceiver({ database: pool, registration: async () => ({ serverSecret: secret }), readBody: request => request.text(), dispatch, now: () => now })
  const b = createCloudGitHubReceiver({ database: pool, registration: async () => ({ serverSecret: secret }), readBody: request => request.text(), dispatch, now: () => now })
  const request = (body = '{"fixture":true}', key = secret) => {
    const timestamp = Math.floor(now / 1000)
    return new Request('https://selfhost.example/mikka/api/cloud/webhooks/github', { method: 'POST', body, headers: { 'x-github-event': 'push', 'x-github-delivery': id, 'Mikka-Cloud-Signature': `t=${timestamp},v1=${createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex')}` } })
  }
  try {
    assert.equal((await a(request(undefined, 'wrong-server'))).status, 401); assert.equal(calls, 0)
    await assert.rejects(a(request()), /fixture_dispatch_failure/)
    failure = false
    const pending = a(request())
    await started
    assert.equal((await b(request())).status, 409)
    release!()
    assert.equal((await pending).status, 202)
    assert.equal(calls, 2)
    assert.equal((await b(request())).status, 204); assert.equal(calls, 2)
    assert.equal((await b(request('{"fixture":false}'))).status, 409)
    const row = (await pool.query('SELECT * FROM cloud_github_webhook_receipts WHERE delivery_id=$1', [id])).rows[0]
    assert.ok(row.completed_at); assert.equal(JSON.stringify(row).includes('fixture'), false)
  } finally { release?.(); await pool.query('DELETE FROM cloud_github_webhook_receipts WHERE delivery_id=$1', [id]); await pool.end() }
})
