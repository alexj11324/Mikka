// 设置 › 密钥与环境 + BYO E2B key against a real PostgreSQL. Uses a random per-run WORKSPACE_SECRETS_KEY only.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('workspace secrets, egress and E2B key', { skip: !dbUrl }, async t => {
  const previousKey = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { WorkspaceError } = await import('../lib/workspace-access')
  const store = await import('../lib/secrets/store')
  const e2b = await import('../lib/secrets/e2b')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => {
    if (previousKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = previousKey
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)
  const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
  const SECRET = 'sk_live_' + randomBytes(12).toString('hex')

  await t.test('secret value is never returned; DB holds ciphertext only', async () => {
    const created = await store.createWorkspaceSecret(admin, ws.id, { name: 'STRIPE_KEY', kind: 'secret', value: SECRET })
    assert.equal(created.value, null)
    const replaced = await store.replaceWorkspaceSecret(admin, ws.id, { id: created.id, value: SECRET + 'x' })
    assert.equal(replaced.value, null)
    const listed = await store.listWorkspaceSecrets(admin, ws.id)
    assert.ok(!JSON.stringify([created, replaced, listed]).includes(SECRET))
    assert.equal(listed.find(row => row.id === created.id)?.value, null)
    const { rows } = await pool.query('select * from workspace_secrets where id=$1', [created.id])
    assert.ok(!JSON.stringify(rows).includes(SECRET), 'no plaintext in the row')
    assert.equal(rows[0].keyVersion, 1)
    assert.ok(rows[0].ciphertext.length > 0 && rows[0].iv.length > 0)
  })

  await t.test('env values are readable; kind is fixed; scopes and names are unique per scope', async () => {
    const env = await store.createWorkspaceSecret(admin, ws.id, { name: 'NODE_ENV', kind: 'env', value: 'production' })
    assert.equal(env.value, 'production')
    assert.equal((await store.replaceWorkspaceSecret(admin, ws.id, { id: env.id, value: 'test' })).value, 'test')
    assert.equal((await store.listWorkspaceSecrets(admin, ws.id)).find(row => row.id === env.id)?.value, 'test')
    await assert.rejects(store.replaceWorkspaceSecret(admin, ws.id, { id: env.id, value: 'x', kind: 'secret' }))
    await rejects(store.createWorkspaceSecret(admin, ws.id, { name: 'NODE_ENV', kind: 'secret', value: 'v' }), 'secretNameTaken')
    const repo = await store.createWorkspaceSecret(admin, ws.id, { name: 'NODE_ENV', kind: 'env', value: 'repo', scope: { type: 'repository', repository: 'alexj11324/mikka' } })
    assert.deepEqual(repo.scope, { type: 'repository', repository: 'alexj11324/mikka' })
  })

  await t.test('admin only and workspace scoped', async () => {
    await rejects(store.listWorkspaceSecrets(member, ws.id), 'workspaceAccessDenied')
    await rejects(store.createWorkspaceSecret(member, ws.id, { name: 'X', kind: 'env', value: 'v' }), 'workspaceAccessDenied')
    await rejects(e2b.getE2BKeyStatus(member, ws.id), 'workspaceAccessDenied')
    const [mine] = await store.listWorkspaceSecrets(admin, ws.id)
    await rejects(store.replaceWorkspaceSecret(admin, other.id, { id: mine.id, value: 'v' }), 'secretNotFound')
    await rejects(store.deleteWorkspaceSecret(admin, other.id, { id: mine.id }), 'secretNotFound')
  })

  await t.test('audit hook runs inside the write transaction with the name as label; a throwing hook rolls back', async () => {
    const events: Array<{ action: string; label: string; inTx: boolean }> = []
    const hook: import('../lib/secrets/store').SecretAuditHook = async (tx, event) => {
      const { rows } = await tx.execute<{ n: number }>(`select count(*)::int n from workspace_secrets where "workspaceId"='${event.workspaceId}' and name='${event.target.label}'` as never)
      events.push({ action: event.action, label: event.target.label, inTx: (rows as unknown as Array<{ n: number }>).length > 0 })
    }
    const created = await store.createWorkspaceSecret(admin, ws.id, { name: 'AUDITED', kind: 'secret', value: SECRET }, hook)
    await store.replaceWorkspaceSecret(admin, ws.id, { id: created.id, value: SECRET + 'y' }, hook)
    await store.deleteWorkspaceSecret(admin, ws.id, { id: created.id }, hook)
    assert.deepEqual(events.map(e => [e.action, e.label]), [['secret.created', 'AUDITED'], ['secret.replaced', 'AUDITED'], ['secret.deleted', 'AUDITED']])
    assert.ok(!JSON.stringify(events).includes(SECRET))
    const boom: import('../lib/secrets/store').SecretAuditHook = async () => { throw new Error('audit failed') }
    await assert.rejects(store.createWorkspaceSecret(admin, ws.id, { name: 'ROLLED_BACK', kind: 'env', value: 'v' }, boom), /audit failed/)
    const { rows } = await pool.query(`select 1 from workspace_secrets where name='ROLLED_BACK'`)
    assert.equal(rows.length, 0, 'write rolled back with the audit')
    const env = await store.createWorkspaceSecret(admin, ws.id, { name: 'KEEP', kind: 'env', value: 'v1' })
    await assert.rejects(store.replaceWorkspaceSecret(admin, ws.id, { id: env.id, value: 'v2' }, boom))
    assert.equal((await store.listWorkspaceSecrets(admin, ws.id)).find(r => r.id === env.id)?.value, 'v1')
  })

  await t.test('missing WORKSPACE_SECRETS_KEY fails closed', async () => {
    const key = process.env.WORKSPACE_SECRETS_KEY
    delete process.env.WORKSPACE_SECRETS_KEY
    try {
      await rejects(store.createWorkspaceSecret(admin, ws.id, { name: 'NOPE', kind: 'secret', value: 'v' }), 'secretsUnavailable')
      await rejects(store.listWorkspaceSecrets(admin, ws.id), 'secretsUnavailable')
      let called = false
      await rejects(e2b.setE2BKey(admin, ws.id, { apiKey: 'e2b_nokeyconfigured' }, { verify: async () => { called = true; return { ok: true } } }), 'secretsUnavailable')
      assert.equal(called, false, 'E2B is not called when we cannot store the key')
    } finally { process.env.WORKSPACE_SECRETS_KEY = key }
    const { rows } = await pool.query(`select 1 from workspace_secrets where name='NOPE'`)
    assert.equal(rows.length, 0)
  })

  await t.test('egress: open by default, three modes only, domains validated per line', async () => {
    assert.deepEqual(await store.getNetworkPolicy(admin, ws.id), { mode: 'open', allowedDomains: [], updatedAt: null })
    const saved = await store.updateNetworkPolicy(admin, ws.id, { mode: 'allowlist', allowedDomains: ['github.com', '*.mikka.app', ''] })
    assert.deepEqual([saved.mode, saved.allowedDomains], ['allowlist', ['github.com', '*.mikka.app']])
    await assert.rejects(store.updateNetworkPolicy(admin, ws.id, { mode: 'allowlist', allowedDomains: ['ok.com', 'bad domain'] }), (error: unknown) => error instanceof store.EgressDomainError && error.lines.join() === '1')
    await assert.rejects(store.updateNetworkPolicy(admin, ws.id, { mode: 'deny', allowedDomains: [] }))
    for (const mode of ['deny', 'all', '', 'OPEN'])
      await assert.rejects(pool.query(`update workspace_network_policy set mode=$1 where "workspaceId"=$2`, [mode, ws.id]), (error: { code?: string }) => error.code === '23514', mode)
    assert.equal((await store.updateNetworkPolicy(admin, ws.id, { mode: 'none', allowedDomains: [] })).mode, 'none')
  })

  await t.test('E2B key: verified before save, write-only, audited as secret.* with label "E2B API Key"', async () => {
    e2b.resetVerifyAttempts()
    const KEY = 'e2b_' + randomBytes(16).toString('hex')
    await rejects(e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: false, code: 'invalid' }) }), 'e2bKeyInvalid')
    await rejects(e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: false, code: 'unavailable' }) }), 'e2bKeyUnverifiable')
    assert.equal((await e2b.getE2BKeyStatus(admin, ws.id)).configured, false, 'nothing saved on failure')
    const events: string[] = []
    const status = await e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: true }), audit: async (_tx, e) => { events.push(`${e.action}:${e.target.type}:${e.target.label}`) } })
    assert.equal(status.masked, `e2b_••••${KEY.slice(-4)}`)
    assert.ok(status.verifiedAt)
    assert.ok(!JSON.stringify(status).includes(KEY))
    const { rows } = await pool.query('select * from workspace_e2b_keys where "workspaceId"=$1', [ws.id])
    assert.ok(!JSON.stringify(rows).includes(KEY), 'ciphertext only')
    await e2b.setE2BKey(admin, ws.id, { apiKey: KEY + 'z' }, { verify: async () => ({ ok: true }), audit: async (_tx, e) => { events.push(`${e.action}:${e.target.type}:${e.target.label}`) } })
    await e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: true }) }) // 5th attempt in the window
    await rejects(e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: true }) }), 'e2bKeyRateLimited')
    assert.deepEqual((await e2b.removeE2BKey(admin, ws.id, async (_tx, e) => { events.push(`${e.action}:${e.target.type}:${e.target.label}`) })), { removed: true })
    assert.deepEqual(events, ['secret.created:e2b_key:E2B API Key', 'secret.replaced:e2b_key:E2B API Key', 'secret.deleted:e2b_key:E2B API Key'] /* 5th set used no hook */)
    assert.deepEqual(await e2b.removeE2BKey(admin, ws.id), { removed: false })
  })

  await t.test('BYO E2B getter: off = platform key (unchanged); on = workspace key or e2b_key_missing', async () => {
    e2b.resetVerifyAttempts()
    const PLATFORM = 'platform_' + randomBytes(8).toString('hex'), KEY = 'e2b_' + randomBytes(16).toString('hex')
    const base = { WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY, E2B_API_KEY: PLATFORM }
    assert.equal(await e2b.getWorkspaceE2BApiKey(other.id, base), PLATFORM)
    assert.equal(await e2b.getWorkspaceE2BApiKey(other.id, { ...base, MIKKA_BYO_E2B_KEY: '0' }), PLATFORM)
    await assert.rejects(e2b.getWorkspaceE2BApiKey(other.id, { MIKKA_BYO_E2B_KEY: '' }), /not configured/)
    const on = { ...base, MIKKA_BYO_E2B_KEY: '1' }
    await assert.rejects(e2b.getWorkspaceE2BApiKey(other.id, on), (error: unknown) => error instanceof e2b.E2BKeyError && error.code === 'e2b_key_missing')
    await e2b.setE2BKey(admin, other.id, { apiKey: KEY }, { verify: async () => ({ ok: true }) })
    assert.equal(await e2b.getWorkspaceE2BApiKey(other.id, on), KEY)
    assert.equal(await e2b.getWorkspaceE2BApiKey(other.id, base), PLATFORM, 'flag off ignores the stored key')
    await assert.rejects(e2b.getWorkspaceE2BApiKey(ws.id, on), (error: unknown) => error instanceof e2b.E2BKeyError && error.code === 'e2b_key_missing')
    await assert.rejects(e2b.getWorkspaceE2BApiKey(other.id, { MIKKA_BYO_E2B_KEY: '1' }), (error: unknown) => error instanceof e2b.E2BKeyError && error.code === 'e2b_unavailable')
    await e2b.recordE2BKeyError(other.id, 'invalid')
    assert.equal((await e2b.getE2BKeyStatus(admin, other.id)).lastErrorCode, 'invalid')
  })
})
