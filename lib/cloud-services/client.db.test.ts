import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { openSecret, sealSecret } from '@/lib/secrets/crypto'
import { CloudClientStore } from './store'

const url = process.env.E2E_DATABASE_URL
const disposable = !!url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname) && new URL(url).pathname.endsWith('_e2e')
if (process.env.REQUIRE_DB === '1' && !disposable) throw new Error('REQUIRE_DB=1 requires a loopback *_e2e database')

test('PG17: independent clients serialize rotating refresh and protect callback ownership and ciphertext', { skip: !disposable }, async t => {
  const schema = `cloud_client_${randomUUID().replaceAll('-', '')}`
  const bootstrap = new Pool({ connectionString: url })
  await bootstrap.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema},public`, max: 5 })
  t.after(async () => { await pool.end(); await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`); await bootstrap.end() })
  await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)')
  await pool.query(await readFile(new URL('../../drizzle/20261107000600_cloud_service_client.sql', import.meta.url), 'utf8'))
  await pool.query(await readFile(new URL('../../drizzle/20261107000800_cloud_push.sql', import.meta.url), 'utf8'))
  await pool.query('INSERT INTO "user" VALUES ($1),($2)', ['person', 'other'])
  const env = { BETTER_AUTH_URL: 'https://self.example', WORKSPACE_SECRETS_KEY: randomBytes(32).toString('base64') }
  const serverId = randomUUID(), secret = `mcs_${randomBytes(32).toString('base64url')}`, teamKey = `mkc_${randomBytes(32).toString('base64url')}`
  let exchangeCount = 0, refreshCount = 0, challenge = '', revoked = false
  const response = (mode: 'user' | 'server_key' = 'user') => ({ access_token: randomBytes(96).toString('base64url'), refresh_token: randomBytes(32).toString('base64url'), token_type: 'Bearer', expires_in: 3600,
    scope: mode === 'user' ? 'github' : 'github models', server_id: serverId, workspace_id: randomUUID(), subject: mode === 'user' ? 'user:cloud-user' : 'workspace:cloud-team', grant_type: mode })
  const fetcher: typeof fetch = async (target, init) => {
    const path = new URL(String(target)).pathname
    if (path.endsWith('/servers/register')) return Response.json({ serverId, serverSecret: secret, redirectUri: 'https://self.example/mikka/api/cloud/callback', tokenEndpoint: 'https://app.aspectlylabs.com/mikka/cloud/oauth/token', authorizationEndpoint: 'https://app.aspectlylabs.com/mikka/cloud/oauth/authorize' })
    if (path.endsWith('/oauth/token')) {
      const body = new URLSearchParams(String(init?.body))
      assert.equal(body.get('client_id'), serverId)
      if (body.get('grant_type') === 'authorization_code') { exchangeCount++; assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), challenge); return Response.json(response()) }
      if (body.get('grant_type') === 'client_credentials') { assert.equal(body.get('client_secret'), teamKey); return Response.json(response('server_key')) }
      refreshCount++; assert.equal(body.get('client_secret'), secret)
      return Response.json(response())
    }
    if (path.endsWith('/oauth/revoke')) { revoked = true; return Response.json({}) }
    throw new Error('Unexpected fixed cloud endpoint')
  }
  const first = new CloudClientStore(pool, env, fetcher), second = new CloudClientStore(pool, env, fetcher)
  await first.register('Test installation')
  const authorize = new URL((await first.beginBinding('person', 'session-one', ['github'])).url)
  challenge = authorize.searchParams.get('code_challenge')!
  const state = authorize.searchParams.get('state')!
  await assert.rejects(second.completeBinding('other', 'session-one', state, 'code'), { code: 'cloud_invalid_request' })
  await assert.rejects(second.completeBinding('person', 'session-two', state, 'code'), { code: 'cloud_invalid_request' })
  assert.equal(exchangeCount, 0)
  await first.completeBinding('person', 'session-one', state, 'code')
  await assert.rejects(second.completeBinding('person', 'session-one', state, 'code'), { code: 'cloud_invalid_request' })
  assert.equal(exchangeCount, 1)
  const bindingAad = `cloud_service_client\0binding\0${serverId}:user:person`
  const stored = (await pool.query("SELECT secret FROM cloud_service_bindings WHERE owner='user:person'")).rows[0].secret
  const payload = JSON.parse(openSecret(stored, bindingAad, env))
  assert.ok(!JSON.stringify(stored).includes(payload.token.refreshToken))
  assert.throws(() => openSecret(stored, bindingAad.replace('person', 'other'), env))
  payload.token.expiresAt = Date.now() - 1000
  await pool.query("UPDATE cloud_service_bindings SET secret=$1 WHERE owner='user:person'", [sealSecret(JSON.stringify(payload), bindingAad, env)])
  const tokens = await Promise.all([first.access('person', 'github'), second.access('person', 'github')])
  assert.equal(refreshCount, 1)
  assert.equal(tokens[0].token.accessToken, tokens[1].token.accessToken)
  await first.connectTeamKey(teamKey)
  assert.equal(await first.capability('person', 'models'), null, 'readiness preserves the missing personal scope')
  assert.deepEqual(await first.capability('other', 'models'), { serviceUrl: 'https://app.aspectlylabs.com/mikka/cloud' })
  assert.equal(refreshCount, 1, 'readiness never refreshes tokens or calls the service')
  await assert.rejects(first.access('person', 'models'), { code: 'cloud_scope_missing' }, 'a missing personal scope never silently changes billing to the team')
  await pool.query("UPDATE cloud_service_bindings SET revoked=true WHERE owner='user:person'")
  assert.equal(await first.capability('person', 'models'), null, 'a revoked personal binding never reveals the team choice')
  await assert.rejects(first.access('person', 'github'), { code: 'cloud_server_revoked' })
  await first.disconnect('person')
  assert.equal(revoked, true)
  assert.equal((await first.access('person', 'github')).token.grantType, 'server_key')
  assert.deepEqual(await first.capability('person', 'models'), { serviceUrl: 'https://app.aspectlylabs.com/mikka/cloud' })
  assert.equal(await second.connected(), true)
})
