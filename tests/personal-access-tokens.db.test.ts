// 设置 › 个人访问令牌 against a real PostgreSQL: hash-only storage, one-time plaintext, list, revoke, scoping.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('personal access tokens', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { WorkspaceError } = await import('../lib/workspace-access')
  const store = await import('../lib/tokens/store')
  const { DEFAULT_API_SCOPES, hashPersonalAccessToken, PAT_ACTIVE_LIMIT } = await import('../lib/tokens/format')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)

  const owner = await seedUser(pool, 'owner'), member = await seedUser(pool, 'member'), outsider = await seedUser(pool, 'outsider'), gone = await seedUser(pool, 'gone')
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }, { userId: gone, role: 'member', status: 'suspended' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])

  await t.test('create stores only the hash and returns the plaintext once', async () => {
    const created = await store.createPersonalAccessToken(owner, ws.id, { name: ' Deploy ' })
    assert.match(created.token, /^mkp_[A-Za-z0-9_-]{43}$/)
    assert.deepEqual([created.name, created.hint, created.expiresAt, created.lastUsedAt, created.expired], ['Deploy', created.token.slice(-4), null, null, false])
    const { rows } = await pool.query('select * from personal_access_tokens where id=$1', [created.id])
    assert.equal(rows[0].tokenHash, hashPersonalAccessToken(created.token))
    assert.ok(!JSON.stringify(rows).includes(created.token), 'plaintext never stored')
    const listed = await store.listPersonalAccessTokens(owner, ws.id)
    assert.ok(!JSON.stringify(listed).includes(created.token), 'list never returns plaintext')
    assert.ok(!JSON.stringify(listed).includes(rows[0].tokenHash), 'list never returns the hash')
  })

  await t.test('scopes: new tokens default to public; legacy is only the explicit test helper', async () => {
    const legacy = await store.createLegacyPersonalAccessToken(owner, ws.id, { name: 'Legacy shape' })
    assert.equal(legacy.legacy, true)
    assert.deepEqual(legacy.scopes, [])
    assert.deepEqual((await store.verifyPersonalAccessToken(legacy.token))?.scopes, ['legacy:full'])
    const publicToken = await store.createPersonalAccessToken(owner, ws.id, { name: 'Public shape' })
    assert.equal(publicToken.legacy, false)
    assert.deepEqual(publicToken.scopes, [...DEFAULT_API_SCOPES])
    assert.deepEqual((await store.verifyPersonalAccessToken(publicToken.token))?.scopes, [...DEFAULT_API_SCOPES])
    // A caller can never request the internal legacy scope through the public input.
    await assert.rejects(store.createPersonalAccessToken(owner, ws.id, { name: 'No legacy', scopes: ['legacy:full'] }))
    await assert.rejects(store.createLegacyPersonalAccessToken(owner, ws.id, { name: 'No override', scopes: DEFAULT_API_SCOPES }))
  })

  await t.test('migration: new rows default to public scopes and mixed audiences are rejected', async () => {
    const inserted = await pool.query(
      'insert into personal_access_tokens (id,"userId","workspaceId",name,"tokenHash",hint) values ($1,$2,$3,$4,$5,$6) returning scopes',
      [crypto.randomUUID(), owner, ws.id, 'Default scope', hashPersonalAccessToken(crypto.randomUUID()), 'AAAA'],
    )
    assert.deepEqual(inserted.rows[0].scopes, [...DEFAULT_API_SCOPES])
    await assert.rejects(
      pool.query(
        `insert into personal_access_tokens (id,"userId","workspaceId",name,"tokenHash",hint,scopes) values ($1,$2,$3,'Mixed scope',$4,'AAAA',ARRAY['legacy:full','tasks:read']::text[])`,
        [crypto.randomUUID(), owner, ws.id, hashPersonalAccessToken(crypto.randomUUID())],
      ),
      (error: unknown) => (error as { code?: string }).code === '23514',
    )
  })

  await t.test('migration: the real file backfills pre-M4 rows and defaults new rows to public', async () => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('create schema pat_migration')
      await client.query('set local search_path to pat_migration')
      // The pre-M4 shape: scopes/rotatedAt do not exist yet.
      await client.query(`create table personal_access_tokens (
        id uuid primary key,
        "userId" text not null,
        "workspaceId" uuid not null,
        name text not null,
        "tokenHash" text not null,
        hint text not null,
        "createdAt" timestamptz not null default now(),
        "expiresAt" timestamptz,
        "lastUsedAt" timestamptz,
        "revokedAt" timestamptz
      )`)
      await client.query(
        'insert into personal_access_tokens (id,"userId","workspaceId",name,"tokenHash",hint) values ($1,$2,$3,$4,$5,$6)',
        [crypto.randomUUID(), owner, ws.id, 'pre-M4', hashPersonalAccessToken(crypto.randomUUID()), 'abcd'],
      )
      await client.query(await readFile(new URL('../drizzle/20261111080200_api_tokens.sql', import.meta.url), 'utf8'))
      assert.deepEqual((await client.query('select scopes from personal_access_tokens')).rows[0].scopes, ['legacy:full'])
      const inserted = await client.query(
        'insert into personal_access_tokens (id,"userId","workspaceId",name,"tokenHash",hint) values ($1,$2,$3,$4,$5,$6) returning scopes',
        [crypto.randomUUID(), owner, ws.id, 'post-M4', hashPersonalAccessToken(crypto.randomUUID()), 'abcd'],
      )
      assert.deepEqual(inserted.rows[0].scopes, [...DEFAULT_API_SCOPES])
      await assert.rejects(
        client.query(
          `insert into personal_access_tokens (id,"userId","workspaceId",name,"tokenHash",hint,scopes) values ($1,$2,$3,'Mixed scope',$4,'AAAA',ARRAY['legacy:full','tasks:read']::text[])`,
          [crypto.randomUUID(), owner, ws.id, hashPersonalAccessToken(crypto.randomUUID())],
        ),
        (error: unknown) => (error as { code?: string }).code === '23514',
      )
    } finally {
      await client.query('rollback')
      client.release()
    }
  })

  await t.test('create and revoke write audit rows in the same transaction (name only, never the token)', async () => {
    const auditWs = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    const created = await store.createPersonalAccessToken(owner, auditWs.id, { name: 'CLI · MacBook' }, new Date(), { actorName: 'Owner', ip: '203.0.113.4' })
    await store.revokePersonalAccessToken(owner, auditWs.id, { id: created.id }, new Date(), { actorName: 'Owner' })
    const { rows } = await pool.query('select action, category, "actorName", "targetId", "targetLabel", metadata, host(ip) as ip from workspace_audit_events where "workspaceId"=$1 order by "createdAt", id', [auditWs.id])
    assert.deepEqual(rows.map(row => [row.action, row.category, row.actorName, row.targetId, row.targetLabel]), [['token.created', 'security', 'Owner', created.id, 'CLI · MacBook'], ['token.revoked', 'security', 'Owner', created.id, 'CLI · MacBook']])
    assert.equal(rows[0].ip, '203.0.113.4')
    assert.ok(!JSON.stringify(rows).includes(created.token), 'the plaintext never reaches the audit log')
    // A bad audit event rolls the token back with it.
    await assert.rejects(store.createPersonalAccessToken(owner, auditWs.id, { name: 'Broken' }, new Date(), { actorName: '' }))
    assert.equal((await store.listPersonalAccessTokens(owner, auditWs.id)).some(token => token.name === 'Broken'), false)
  })

  await t.test('optional expiry: future accepted, past/too far rejected, expired flagged and unusable', async () => {
    const now = new Date()
    const later = await store.createPersonalAccessToken(owner, ws.id, { name: 'Week', expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString() })
    assert.ok(later.expiresAt)
    await rejects(store.createPersonalAccessToken(owner, ws.id, { name: 'Past', expiresAt: new Date(now.getTime() - 1000).toISOString() }), 'validationGeneric')
    await rejects(store.createPersonalAccessToken(owner, ws.id, { name: 'Far', expiresAt: new Date(now.getTime() + 400 * 86_400_000).toISOString() }), 'validationGeneric')
    const soon = await store.createPersonalAccessToken(owner, ws.id, { name: 'Soon', expiresAt: new Date(now.getTime() + 60_000).toISOString() })
    const afterExpiry = new Date(now.getTime() + 120_000)
    assert.equal((await store.listPersonalAccessTokens(owner, ws.id, afterExpiry)).find(row => row.id === soon.id)?.expired, true)
    assert.equal(await store.verifyPersonalAccessToken(soon.token, afterExpiry), null)
    assert.equal((await store.verifyPersonalAccessToken(soon.token))?.tokenId, soon.id)
  })

  await t.test('list: own tokens in this workspace only, newest first, revoked hidden', async () => {
    const mine = await store.createPersonalAccessToken(member, ws.id, { name: 'Member token' })
    const elsewhere = await store.createPersonalAccessToken(owner, other.id, { name: 'Other workspace' })
    const ownerList = await store.listPersonalAccessTokens(owner, ws.id)
    assert.ok(!ownerList.some(row => row.id === mine.id || row.id === elsewhere.id))
    assert.deepEqual(ownerList.map(row => row.createdAt), ownerList.map(row => row.createdAt).sort().reverse())
    await store.revokePersonalAccessToken(member, ws.id, { id: mine.id })
    assert.deepEqual(await store.listPersonalAccessTokens(member, ws.id), [])
  })

  await t.test('revoke: only own unrevoked token; revoked token stops verifying', async () => {
    const created = await store.createPersonalAccessToken(owner, ws.id, { name: 'Revoke me' })
    assert.equal((await store.verifyPersonalAccessToken(created.token))?.userId, owner)
    await rejects(store.revokePersonalAccessToken(member, ws.id, { id: created.id }), 'tokenNotFound')
    await rejects(store.revokePersonalAccessToken(owner, other.id, { id: created.id }), 'tokenNotFound')
    assert.deepEqual(await store.revokePersonalAccessToken(owner, ws.id, { id: created.id }), { id: created.id })
    await rejects(store.revokePersonalAccessToken(owner, ws.id, { id: created.id }), 'tokenNotFound')
    assert.equal(await store.verifyPersonalAccessToken(created.token), null)
    const { rows } = await pool.query('select "revokedAt" from personal_access_tokens where id=$1', [created.id])
    assert.ok(rows[0].revokedAt, 'revoked rows are kept')
  })

  await t.test('rotate in place: same id/scopes/expiry, old secret stops, audit written', async () => {
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const created = await store.createPersonalAccessToken(owner, ws.id, { name: 'Rotate me', scopes: DEFAULT_API_SCOPES, expiresAt })
    const rotated = await store.rotatePersonalAccessToken(owner, ws.id, { id: created.id }, new Date(), { actorName: 'Owner' })
    assert.equal(rotated.id, created.id)
    assert.deepEqual(rotated.scopes, [...DEFAULT_API_SCOPES])
    assert.equal(rotated.legacy, false)
    assert.equal(rotated.expiresAt, created.expiresAt)
    assert.ok(rotated.rotatedAt)
    assert.notEqual(rotated.token, created.token)
    assert.equal(await store.verifyPersonalAccessToken(created.token), null, 'the old secret stops immediately')
    assert.equal((await store.verifyPersonalAccessToken(rotated.token))?.tokenId, created.id)
    const { rows } = await pool.query(`select action, "targetId", "targetLabel", metadata from workspace_audit_events where "workspaceId"=$1 and action='token.rotated'`, [ws.id])
    assert.equal(rows.length, 1)
    assert.deepEqual([rows[0].action, rows[0].targetId, rows[0].targetLabel, rows[0].metadata], ['token.rotated', created.id, 'Rotate me', {}])
    assert.ok(!JSON.stringify(rows).includes(rotated.token))
    await rejects(store.rotatePersonalAccessToken(owner, ws.id, { id: '00000000-0000-4000-8000-000000000000' }), 'tokenNotFound')
    const revokedToken = await store.createPersonalAccessToken(owner, ws.id, { name: 'Rotate revoked' })
    await store.revokePersonalAccessToken(owner, ws.id, { id: revokedToken.id })
    await rejects(store.rotatePersonalAccessToken(owner, ws.id, { id: revokedToken.id }), 'tokenNotFound')
    const expiredToken = await store.createPersonalAccessToken(owner, ws.id, { name: 'Rotate expired' })
    await pool.query(`UPDATE personal_access_tokens SET "createdAt"=now()-interval '2 hours', "expiresAt"=now()-interval '1 minute' WHERE id=$1`, [expiredToken.id])
    await rejects(store.rotatePersonalAccessToken(owner, ws.id, { id: expiredToken.id }), 'tokenNotFound')
    await rejects(store.rotatePersonalAccessToken(member, ws.id, { id: created.id }), 'tokenNotFound')
    const legacyToken = await store.createLegacyPersonalAccessToken(owner, ws.id, { name: 'Rotate legacy' })
    const rotatedLegacy = await store.rotatePersonalAccessToken(owner, ws.id, { id: legacyToken.id })
    assert.equal(rotatedLegacy.legacy, true)
    assert.deepEqual(rotatedLegacy.scopes, [])
    assert.deepEqual((await store.verifyPersonalAccessToken(rotatedLegacy.token))?.scopes, ['legacy:full'])
  })

  await t.test('verify: unknown or malformed tokens fail; lastUsedAt updates', async () => {
    assert.equal(await store.verifyPersonalAccessToken('mkp_' + 'A'.repeat(43)), null)
    assert.equal(await store.verifyPersonalAccessToken('not-a-token'), null)
    const created = await store.createPersonalAccessToken(owner, ws.id, { name: 'Used' })
    await store.verifyPersonalAccessToken(created.token)
    assert.ok((await store.listPersonalAccessTokens(owner, ws.id)).find(row => row.id === created.id)?.lastUsedAt)
  })

  await t.test('scoping and limit: outsiders/suspended refused, 50 active tokens max', async () => {
    await rejects(store.createPersonalAccessToken(outsider, ws.id, { name: 'x' }), 'workspaceAccessDenied')
    await rejects(store.listPersonalAccessTokens(gone, ws.id), 'workspaceAccessDenied')
    await assert.rejects(store.createPersonalAccessToken(owner, ws.id, { name: '' }))
    const fresh = await seedUser(pool, 'fresh')
    await pool.query(`insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$2 || '@example.invalid','member','active')`, [ws.id, fresh])
    for (let i = 0; i < PAT_ACTIVE_LIMIT; i++) await store.createPersonalAccessToken(fresh, ws.id, { name: `t${i}` })
    await rejects(store.createPersonalAccessToken(fresh, ws.id, { name: 'one more' }), 'tokenLimitReached')
    const [first] = await store.listPersonalAccessTokens(fresh, ws.id)
    await store.revokePersonalAccessToken(fresh, ws.id, { id: first.id })
    assert.ok((await store.createPersonalAccessToken(fresh, ws.id, { name: 'after revoke' })).token)
  })

  const member_ = async (label: string) => {
    const id = await seedUser(pool, label)
    await pool.query(`insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$2 || '@example.invalid','member','active')`, [ws.id, id])
    return id
  }
  const outcome = async (promise: Promise<unknown>) => { try { await promise; return 'ok' } catch (error) { return error instanceof WorkspaceError ? error.code : 'error' } }

  await t.test('QA: expiry is capped at exactly 366 days', async () => {
    const user = await member_('cap'), now = new Date('2026-10-30T00:00:00Z'), day = 86_400_000
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString()
    assert.equal(await outcome(store.createPersonalAccessToken(user, ws.id, { name: 'd366', expiresAt: at(366 * day) }, now)), 'ok')
    assert.equal(await outcome(store.createPersonalAccessToken(user, ws.id, { name: 'd366+1ms', expiresAt: at(366 * day + 1) }, now)), 'validationGeneric')
    assert.equal(await outcome(store.createPersonalAccessToken(user, ws.id, { name: 'd367', expiresAt: at(367 * day) }, now)), 'validationGeneric')
    assert.equal(await outcome(store.createPersonalAccessToken(user, ws.id, { name: 'now', expiresAt: at(0) }, now)), 'validationGeneric')
    assert.equal(await outcome(store.createPersonalAccessToken(user, ws.id, { name: 'never', expiresAt: null }, now)), 'ok')
  })

  await t.test('QA: a token stops working exactly at expiresAt', async () => {
    const now = new Date(), expiresAt = new Date(now.getTime() + 60_000)
    const created = await store.createPersonalAccessToken(owner, ws.id, { name: 'Boundary', expiresAt: expiresAt.toISOString() }, now)
    assert.ok(await store.verifyPersonalAccessToken(created.token, new Date(expiresAt.getTime() - 1)))
    assert.equal(await store.verifyPersonalAccessToken(created.token, expiresAt), null)
    assert.equal(await store.verifyPersonalAccessToken(created.token, new Date(expiresAt.getTime() + 1)), null)
  })

  await t.test('QA: expired tokens do not count toward the limit', async () => {
    const user = await member_('expired'), past = new Date(Date.now() - 3 * 86_400_000)
    for (let i = 0; i < PAT_ACTIVE_LIMIT; i++) await store.createPersonalAccessToken(user, ws.id, { name: `e${i}`, expiresAt: new Date(past.getTime() + 86_400_000).toISOString() }, past)
    assert.equal(await outcome(store.createPersonalAccessToken(user, ws.id, { name: 'new' })), 'ok')
    // Still capped by live tokens: 49 more fill it, the next is refused.
    for (let i = 0; i < PAT_ACTIVE_LIMIT - 1; i++) await store.createPersonalAccessToken(user, ws.id, { name: `l${i}` })
    assert.equal(await outcome(store.createPersonalAccessToken(user, ws.id, { name: 'over' })), 'tokenLimitReached')
  })

  await t.test('DB failures become a generic TokenStoreError: no tokenHash, params or SQL in the error or logs', async () => {
    await pool.query(`create or replace function pg_temp_pat_boom() returns trigger language plpgsql as $$ begin raise exception 'boom' using errcode = 'P0001'; end $$`)
    await pool.query('create trigger qa_pat_boom before insert or update on personal_access_tokens for each row execute function pg_temp_pat_boom()')
    const existing = await pool.query('select "tokenHash" from personal_access_tokens limit 1')
    const knownHashes = existing.rows.map(r => r.tokenHash as string)
    const lines: string[] = [], original = console.error
    console.error = (...args: unknown[]) => { lines.push(args.map(a => a instanceof Error ? `${a.stack} ${JSON.stringify(a)}` : String(a)).join(' ')) }
    try {
      for (const work of [
        () => store.createPersonalAccessToken(owner, other.id, { name: 'Boom' }),
        () => store.verifyPersonalAccessToken('mkp_' + 'A'.repeat(43)),
      ]) {
        let caught: unknown
        try { await work() } catch (error) { caught = error; console.error(error) }
        if (caught === undefined) continue // verify of an unknown token updates no row, so the trigger never fires
        assert.ok(caught instanceof store.TokenStoreError, String(caught))
        assert.equal((caught as { cause?: unknown }).cause, undefined)
      }
      const blob = lines.join('\n')
      assert.ok(lines.length >= 1)
      assert.ok(!/params:|insert into|update "|[0-9a-f]{64}|[A-Za-z0-9_-]{43}/.test(blob), blob.slice(0, 300))
      for (const hash of knownHashes) assert.ok(!blob.includes(hash))
    } finally {
      console.error = original
      await pool.query('drop trigger if exists qa_pat_boom on personal_access_tokens'); await pool.query('drop function if exists pg_temp_pat_boom()')
    }
  })
})
