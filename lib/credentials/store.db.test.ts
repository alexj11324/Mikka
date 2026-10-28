import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { CredentialStore, hashNonce } from './store'
import { CredentialError } from './contracts'
import { fillCredential } from './broker'
import type { Kms } from './kms'

const databaseURL = process.env.CREDENTIAL_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Credential test database is required')
test('real PostgreSQL: owner/workspace binding, one-use forms/leases, revocation and opaque responses', { skip: !databaseURL }, async () => {
  process.env.BETTER_AUTH_SECRET = 'isolated-credential-test-fingerprint-key'
  const target = new URL(databaseURL!)
  const isolated = target.pathname === '/credential_test' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && target.hostname === '127.0.0.1' && target.pathname === '/mikka_e2e')
  if (!isolated) throw new Error('Use the isolated credential test database')
  const schema = `credential_${randomBytes(8).toString('hex')}`, admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid); CREATE TABLE bot_subagents(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"botId" uuid,status text); CREATE TABLE agent_runs(id uuid,"userId" text,"botId" uuid,"stopRequestedAt" timestamptz,status text,"leaseExpiresAt" timestamptz)`)
    await pool.query(await readFile(new URL('../../drizzle/20261028174823_account_credential_vault.sql', import.meta.url), 'utf8'))
    const a = { userId: 'owner-a', workspaceId: randomUUID(), botId: randomUUID(), subagentId: randomUUID() }
    const b = { userId: 'owner-b', workspaceId: a.workspaceId, botId: randomUUID(), subagentId: randomUUID() }
    await pool.query(`INSERT INTO "user"(id) VALUES('owner-a'),('owner-b')`)
    for (const caller of [a, b]) {
      await pool.query('INSERT INTO bots VALUES($1,$2,$3)', [caller.botId, caller.userId, caller.workspaceId])
      await pool.query(`INSERT INTO bot_subagents VALUES($1,$2,$3,$4,'needs_you')`, [caller.subagentId, caller.userId, caller.workspaceId, caller.botId])
    }
    const kms: Kms = { generate: async () => ({ plaintext: randomBytes(32), wrapped: 'synthetic-kms-context-tested-in-unit-suite' }), decrypt: async () => { throw new Error('Must not decrypt in rejected paths') } }
    const store = new CredentialStore(pool, kms), origin = 'https://example.com'
    const browserTarget = { targetId: 'test-page', origin, endpoint: 'https://123.e2b.app/rpc?token=private', expiresAt: Date.now() + 120000 }
    const challenge = await store.challenge(a, origin)
    const input = { nonce: challenge.nonce, origin, username: 'test-account', password: 'test-password' }
    await assert.rejects(store.save({ ...a, userId: b.userId }, input), CredentialError)
    await assert.rejects(store.save({ ...a, workspaceId: randomUUID() }, input), CredentialError)
    const saved = await store.save(a, input)
    assert.deepEqual(saved, { status: 'saved', origin })
    await assert.rejects(store.save(a, input), CredentialError)
    assert.deepEqual(await store.lease(b, origin, browserTarget), { status: 'needs_login', origin })
    const metadata = await store.list(a)
    assert.equal(metadata.length, 1)
    assert(!JSON.stringify(metadata).includes('credentialId'))
    assert(!JSON.stringify(metadata).includes('test-password'))
    const otherBot = { ...a, botId: randomUUID(), subagentId: randomUUID() }
    await pool.query('INSERT INTO bots VALUES($1,$2,$3)', [otherBot.botId, a.userId, a.workspaceId])
    await pool.query(`INSERT INTO bot_subagents VALUES($1,$2,$3,$4,'running')`, [otherBot.subagentId, a.userId, a.workspaceId, otherBot.botId])
    const lease = await store.lease(otherBot, origin, browserTarget)
    assert.equal(lease.status, 'ready')
    if (lease.status !== 'ready') throw new Error()
    const guard = { begin: async () => { throw new CredentialError() }, end: async () => {} }
    await assert.rejects(fillCredential(pool, lease.lease, { kms, guard }), CredentialError)
    await assert.rejects(fillCredential(pool, lease.lease, { kms, guard }), CredentialError)
    const retry = await store.lease(otherBot, origin, browserTarget, undefined, true)
    if (retry.status !== 'ready') throw new Error()
    const retryTarget = (await pool.query('SELECT target FROM credential_fill_leases WHERE nonce_hash=$1', [hashNonce(retry.lease)])).rows[0].target
    assert.equal(retryTarget.credentialMode, 'password')
    await assert.rejects(fillCredential(pool, retry.lease, { kms, guard }), CredentialError)
    const codeChallenge = await store.challenge(a, origin)
    const codeLease = await store.otpLease(a, { nonce: codeChallenge.nonce, origin, code: '123456' }, browserTarget)
    await assert.rejects(fillCredential(pool, codeLease, { kms, guard }), CredentialError)
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM credential_fill_leases WHERE input_kind='otp' AND input_envelope IS NOT NULL`)).rows[0].count, 0)
    await assert.rejects(fillCredential(pool, codeLease, { kms, guard }), CredentialError)
    const expired = await store.lease(a, origin, browserTarget)
    await pool.query('UPDATE credential_fill_leases SET expires_at=now()-interval \'1 second\'')
    if (expired.status !== 'ready') throw new Error()
    await assert.rejects(fillCredential(pool, expired.lease, { kms, guard }), CredentialError)
    await store.remove(b, origin, input.username)
    assert.equal((await store.list(a)).length, 1)
    await store.remove(a, origin, input.username)
    assert.equal((await store.list(a)).length, 0)
    assert.deepEqual(await store.lease(a, origin, browserTarget), { status: 'needs_login', origin })
    assert.equal((await pool.query('SELECT * FROM credential_secrets')).rowCount, 0)
    assert.equal((await pool.query('SELECT * FROM browser_sessions')).rowCount, 0)
    assert.equal((await pool.query('SELECT * FROM credential_fill_leases')).rowCount, 0)
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
