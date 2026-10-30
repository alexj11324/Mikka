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
if (databaseURL && process.env.CREDENTIAL_TEST_RETAIN_RESOURCES !== '1') throw new Error('Credential database tests require explicit resource retention')
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Credential test database is required')
test('real PostgreSQL: owner/workspace binding, one-use forms/leases, revocation and opaque responses', { skip: !databaseURL }, async () => {
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex')
  const target = new URL(databaseURL!)
  const isolated = target.pathname === '/credential_test' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && target.hostname === '127.0.0.1' && target.pathname === '/mikka_e2e')
  if (!isolated) throw new Error('Use the isolated credential test database')
  const schema = `credential_${randomBytes(8).toString('hex')}`, admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid); CREATE TABLE bot_subagents(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"botId" uuid,status text); CREATE TABLE agent_runs(id uuid,"userId" text,"botId" uuid,"stopRequestedAt" timestamptz,status text,"leaseExpiresAt" timestamptz)`)
    await pool.query(await readFile(new URL('../../drizzle/20261029012027_account_credential_vault.sql', import.meta.url), 'utf8'))
    const a = { userId: 'owner-a', workspaceId: randomUUID(), botId: randomUUID(), subagentId: randomUUID() }
    const b = { userId: 'owner-b', workspaceId: a.workspaceId, botId: randomUUID(), subagentId: randomUUID() }
    await pool.query(`INSERT INTO "user"(id) VALUES('owner-a'),('owner-b')`)
    for (const caller of [a, b]) {
      await pool.query('INSERT INTO bots VALUES($1,$2,$3)', [caller.botId, caller.userId, caller.workspaceId])
      await pool.query(`INSERT INTO bot_subagents VALUES($1,$2,$3,$4,'needs_you')`, [caller.subagentId, caller.userId, caller.workspaceId, caller.botId])
    }
    const kms: Kms = { generate: async () => ({ plaintext: randomBytes(32), wrapped: 'synthetic-kms-context-tested-in-unit-suite' }), decrypt: async () => { throw new Error('Must not decrypt in rejected paths') } }
    const fixturePassword = randomBytes(24).toString('base64url')
    const store = new CredentialStore(pool, kms), origin = 'https://example.com'
    const browserTarget = { targetId: 'test-page', origin, endpoint: 'https://123.e2b.app/rpc?token=private', expiresAt: Date.now() + 120000 }
    const challenge = await store.challenge(a, origin)
    const input = { nonce: challenge.nonce, origin, username: 'test-account', password: fixturePassword }
    await assert.rejects(store.save({ ...a, userId: b.userId }, input), CredentialError)
    await assert.rejects(store.save({ ...a, workspaceId: randomUUID() }, input), CredentialError)
    const saved = await store.save(a, input)
    assert.deepEqual(saved, { status: 'saved', origin })
    await assert.rejects(store.save(a, input), CredentialError)
    assert.deepEqual(await store.lease(b, origin, browserTarget), { status: 'needs_login', origin })
    const metadata = await store.list(a)
    assert.equal(metadata.length, 1)
    assert(!JSON.stringify(metadata).includes('credentialId'))
    assert(!JSON.stringify(metadata).includes(input.password))
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
    // Synthetic retained session; no broker may restore it in this test.
    await pool.query(`INSERT INTO browser_sessions(credential_id,wrapped_dek,nonce,ciphertext,expires_at) SELECT credential_id,wrapped_dek,nonce,ciphertext,now()+interval '1 hour' FROM credential_secrets`)
    const leasesBeforeRevocation = (await pool.query('SELECT count(*)::int AS count FROM credential_fill_leases')).rows[0].count
    assert.deepEqual(await store.remove(b, origin, input.username), { status: 'revoked' })
    assert.equal((await store.list(a)).length, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM browser_sessions WHERE expires_at>now()')).rows[0].count, 1)
    assert.deepEqual(await store.remove(a, origin, input.username), { status: 'revoked' })
    assert.equal((await store.list(a)).length, 0)
    assert.deepEqual(await store.lease(a, origin, browserTarget), { status: 'needs_login', origin })
    assert.equal((await pool.query('SELECT * FROM credential_secrets')).rowCount, 1)
    assert.equal((await pool.query('SELECT * FROM browser_sessions')).rowCount, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM browser_sessions WHERE expires_at>now()')).rows[0].count, 0)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM credential_fill_leases')).rows[0].count, leasesBeforeRevocation)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM credential_fill_leases WHERE consumed_at IS NULL OR input_envelope IS NOT NULL')).rows[0].count, 0)
  } finally {
    await pool.end()
    await admin.end()
  }
})

test('real PostgreSQL: observed credential lease inserts once and stays guarded', { skip: !databaseURL }, async () => {
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('hex')
  const targetUrl = new URL(databaseURL!)
  const isolated = targetUrl.pathname === '/credential_test' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && targetUrl.hostname === '127.0.0.1' && targetUrl.pathname === '/mikka_e2e')
  if (!isolated) throw new Error('Use the isolated credential test database')
  const schema = `credential_${randomBytes(8).toString('hex')}`, admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY); CREATE TABLE bots(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid); CREATE TABLE bot_subagents(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"botId" uuid,status text,"targetId" text,epoch integer); CREATE TABLE agent_runs(id uuid,"userId" text,"botId" uuid,"stopRequestedAt" timestamptz,status text,"leaseExpiresAt" timestamptz); CREATE TABLE workspace_computer_policies("workspaceId" uuid PRIMARY KEY, permission text NOT NULL, version integer NOT NULL)`)
    await pool.query(await readFile(new URL('../../drizzle/20261029012027_account_credential_vault.sql', import.meta.url), 'utf8'))
    const actor = { userId: 'fixture-owner', workspaceId: randomUUID(), botId: randomUUID(), subagentId: randomUUID() }
    await pool.query('INSERT INTO "user"(id) VALUES($1)', [actor.userId])
    await pool.query('INSERT INTO bots VALUES($1,$2,$3)', [actor.botId, actor.userId, actor.workspaceId])
    await pool.query(`INSERT INTO bot_subagents VALUES($1,$2,$3,$4,'running','fixture-target',1)`, [actor.subagentId, actor.userId, actor.workspaceId, actor.botId])
    await pool.query(`INSERT INTO workspace_computer_policies VALUES($1,'allow',1)`, [actor.workspaceId])
    let key: Buffer | undefined, decrypts = 0, ended = false, inserted = 0
    const kms: Kms = {
      async generate() { key = randomBytes(32); return { plaintext: Buffer.from(key), wrapped: 'synthetic-key' } },
      async decrypt() { decrypts++; if (!key) throw new Error('missing fixture key'); return Buffer.from(key) },
    }
    const fixturePassword = randomBytes(24).toString('base64url')
    const store = new CredentialStore(pool, kms), origin = 'https://example.com'
    const challenge = await store.challenge(actor, origin)
    await store.save(actor, { nonce: challenge.nonce, origin, username: 'fixture-user', password: fixturePassword })
    const target = { targetId: 'fixture-target', origin, endpoint: 'https://fixture.e2b.app/', expiresAt: Date.now() + 60000, observedInput: { loaderId: 'fixture-loader', backendNodeId: 7, credentialRole: 'password' as const, epoch: 1, permissionVersion: 1 } }
    const cdp = { async attach() {}, async origin() {}, async call() { return { frameTree: { frame: { url: origin, loaderId: 'fixture-loader' } } } }, async insertAtObservedInput(_origin: string, _loader: string, _node: number, _role: string, value: string) { assert.equal(value, fixturePassword); inserted++ }, close() {} }
    const guard = { async begin() {
      const observer = await pool.connect()
      try {
        await observer.query('BEGIN')
        await assert.rejects(observer.query('SELECT id FROM bot_subagents WHERE id=$1 FOR UPDATE NOWAIT', [actor.subagentId]), (error: unknown) => (error as { code?: string }).code === '55P03')
      } finally { await observer.query('ROLLBACK'); observer.release() }
      return { cdpUrl: 'wss://fixture.e2b.app/', targetId: 'fixture-target', guardToken: 'fixture' }
    }, async end() { ended = true } }
    const lease = await store.lease(actor, origin, target, undefined, true)
    if (lease.status !== 'ready') throw new Error('fixture lease not issued')
    assert.deepEqual(await fillCredential(pool, lease.lease, { kms, guard, connect: (async () => cdp) as never }), { status: 'guarded', origin })
    assert.equal(inserted, 1); assert.equal(decrypts, 1); assert.equal(ended, false)
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM browser_sessions')).rows[0].count, 0)
    await assert.rejects(fillCredential(pool, lease.lease, { kms, guard, connect: (async () => cdp) as never }), CredentialError)
    // Pause after the lease is durably claimed on a real independent client.
    // A password update must fence this already-claimed old revision too.
    const beforeUpdate = await store.lease(actor, origin, target, undefined, true)
    if (beforeUpdate.status !== 'ready') throw new Error('fixture lease not issued')
    let signalClaimed!: () => void, resumeClaim!: () => void
    const claimed = new Promise<void>(resolve => { signalClaimed = resolve })
    const resume = new Promise<void>(resolve => { resumeClaim = resolve })
    const delayedPool = {
      async query(sql: string, values: unknown[]) {
        const result = await pool.query(sql, values)
        if (sql.startsWith('WITH candidate')) { signalClaimed(); await resume }
        return result
      },
      connect: () => pool.connect(),
    }
    const oldFill = fillCredential(delayedPool as never, beforeUpdate.lease, { kms, guard, connect: (async () => cdp) as never })
    const refused = assert.rejects(oldFill, CredentialError)
    await claimed
    try {
      const updateChallenge = await store.challenge(actor, origin)
      await store.save(actor, { nonce: updateChallenge.nonce, origin, username: 'fixture-user', password: randomBytes(24).toString('base64url') })
    } finally { resumeClaim() }
    await refused
    assert.equal(decrypts, 1); assert.equal(inserted, 1)
    const stale = await store.lease(actor, origin, target, undefined, true)
    if (stale.status !== 'ready') throw new Error('fixture lease not issued')
    await pool.query('UPDATE workspace_computer_policies SET version=2 WHERE "workspaceId"=$1', [actor.workspaceId])
    await assert.rejects(fillCredential(pool, stale.lease, { kms, guard, connect: (async () => cdp) as never }), CredentialError)
    assert.equal(decrypts, 1); assert.equal(inserted, 1)
    const revocable = await store.lease(actor, origin, { ...target, observedInput: { ...target.observedInput, permissionVersion: 2 } }, undefined, true)
    if (revocable.status !== 'ready') throw new Error('fixture lease not issued')
    assert.deepEqual(await store.remove(actor, origin, 'fixture-user'), { status: 'revoked' })
    await assert.rejects(fillCredential(pool, revocable.lease, { kms, guard, connect: (async () => cdp) as never }), CredentialError)
    assert.equal(decrypts, 1); assert.equal(inserted, 1)
  } finally {
    await pool.end()
    await admin.end()
  }
})
