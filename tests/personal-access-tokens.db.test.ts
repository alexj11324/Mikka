// 设置 › 个人访问令牌 against a real PostgreSQL: hash-only storage, one-time plaintext, list, revoke, scoping.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('personal access tokens', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { WorkspaceError } = await import('../lib/workspace-access')
  const store = await import('../lib/tokens/store')
  const { hashPersonalAccessToken, PAT_ACTIVE_LIMIT } = await import('../lib/tokens/format')
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
