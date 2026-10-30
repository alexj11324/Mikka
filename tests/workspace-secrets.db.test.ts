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

  await t.test('members only (outsiders denied) and workspace scoped', async () => {
    const outsider = await seedUser(pool, 'outsider')
    await rejects(store.listWorkspaceSecrets(outsider, ws.id), 'workspaceAccessDenied')
    await rejects(store.createWorkspaceSecret(outsider, ws.id, { name: 'X', kind: 'env', value: 'v', scope: { type: 'repository', repository: 'o/r' }, environment: 'preview' }), 'workspaceAccessDenied')
    await rejects(e2b.getE2BKeyStatus(outsider, ws.id), 'workspaceAccessDenied')
    await rejects(store.getNetworkPolicy(outsider, ws.id), 'workspaceAccessDenied')
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
    await assert.rejects(store.updateNetworkPolicy(admin, ws.id, { mode: 'allowlist', allowedDomains: ['ok.com', 'bad domain'] }), (error: unknown) => error instanceof store.EgressDomainError && error.lines.join() === '2')
    await assert.rejects(store.updateNetworkPolicy(admin, ws.id, { mode: 'deny', allowedDomains: [] }))
    for (const mode of ['deny', 'all', '', 'OPEN'])
      await assert.rejects(pool.query(`update workspace_network_policy set mode=$1 where "workspaceId"=$2`, [mode, ws.id]), (error: { code?: string }) => error.code === '23514', mode)
    assert.equal((await store.updateNetworkPolicy(admin, ws.id, { mode: 'none', allowedDomains: [] })).mode, 'none')
  })

  await t.test('E2B key: verified before save, write-only, audited as secret.* with label "E2B API Key"', async () => {
    await pool.query('delete from workspace_e2b_verify_attempts')
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

  await t.test('E2B verify limit is in Postgres: 10 parallel attempts admit exactly 5; window slides; per workspace', async () => {
    await pool.query('delete from workspace_e2b_verify_attempts')
    const now = new Date()
    const results = await Promise.all(Array.from({ length: 10 }, () => e2b.takeVerifyAttempt(ws.id, now)))
    assert.equal(results.filter(Boolean).length, 5)
    assert.equal((await pool.query('select count(*)::int n from workspace_e2b_verify_attempts where "workspaceId"=$1', [ws.id])).rows[0].n, 5)
    assert.equal(await e2b.takeVerifyAttempt(other.id, now), true, 'other workspace unaffected')
    assert.equal(await e2b.takeVerifyAttempt(ws.id, new Date(now.getTime() + e2b.VERIFY_WINDOW_MS - 1)), false)
    assert.equal(await e2b.takeVerifyAttempt(ws.id, new Date(now.getTime() + e2b.VERIFY_WINDOW_MS)), true, 'old attempts expire')
    // through setE2BKey: failed checks count, the 6th is refused before E2B is called
    await pool.query('delete from workspace_e2b_verify_attempts')
    let calls = 0
    const settled = await Promise.allSettled(Array.from({ length: 10 }, () => e2b.setE2BKey(admin, ws.id, { apiKey: 'e2b_' + randomBytes(16).toString('hex') }, { verify: async () => { calls++; return { ok: false, code: 'invalid' } } })))
    assert.equal(calls, 5)
    assert.equal(settled.filter(r => r.status === 'rejected' && (r.reason as { code?: string }).code === 'e2bKeyRateLimited').length, 5)
    await pool.query('delete from workspace_e2b_verify_attempts')
  })

  await t.test('saving a value shorter than 8 chars returns shortValueNotMasked', async () => {
    const short = await store.createWorkspaceSecret(admin, other.id, { name: 'SHORT_ONE', kind: 'secret', value: 'abc1234' })
    assert.equal(short.warning, 'shortValueNotMasked')
    assert.equal((await store.replaceWorkspaceSecret(admin, other.id, { id: short.id, value: '12345678' })).warning, null)
    assert.equal((await store.replaceWorkspaceSecret(admin, other.id, { id: short.id, value: 'x' })).warning, 'shortValueNotMasked')
    assert.equal((await store.createWorkspaceSecret(admin, other.id, { name: 'LONG_ENV', kind: 'env', value: 'long-enough' })).warning, null)
    await store.deleteWorkspaceSecret(admin, other.id, { id: short.id })
  })

  await t.test('E2B key delete: admin only; afterwards dispatch sees no key', async () => {
    await pool.query('delete from workspace_e2b_verify_attempts')
    const KEY = 'e2b_' + randomBytes(16).toString('hex')
    const on = { WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY, E2B_API_KEY: 'platform', MIKKA_BYO_E2B_KEY: '1' }
    await e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: true }) })
    assert.equal(await e2b.getWorkspaceE2BApiKey(ws.id, on), KEY)
    await rejects(e2b.removeE2BKey(member, ws.id), 'secretPermissionDenied')
    assert.equal(await e2b.getWorkspaceE2BApiKey(ws.id, on), KEY, 'non-admin delete changed nothing')
    assert.deepEqual(await e2b.removeE2BKey(admin, ws.id), { removed: true })
    await assert.rejects(e2b.getWorkspaceE2BApiKey(ws.id, on), (error: unknown) => error instanceof e2b.E2BKeyError && error.code === 'e2b_key_missing')
    assert.equal(await e2b.getWorkspaceE2BApiKey(ws.id, { ...on, MIKKA_BYO_E2B_KEY: '0' }), 'platform')
    await pool.query('delete from workspace_e2b_verify_attempts')
  })

  await t.test('BYO E2B getter: off = platform key (unchanged); on = workspace key or e2b_key_missing', async () => {
    await pool.query('delete from workspace_e2b_verify_attempts')
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

  await t.test('4e2 runtime: sandbox env + output masking are flag-gated and workspace-scoped', async () => {
    const runtime = await import('../lib/secrets/runtime')
    const { maskDeep } = await import('../lib/secrets/mask')
    const third = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const TOKEN = 'ghp_' + randomBytes(12).toString('hex')
    const keyEnv = { WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY }
    const on = { ...keyEnv, MIKKA_BYO_E2B_KEY: '1' }, off = { ...keyEnv }
    await store.createWorkspaceSecret(admin, third.id, { name: 'GH_TOKEN', kind: 'secret', value: TOKEN })
    await store.createWorkspaceSecret(admin, third.id, { name: 'SHORT', kind: 'secret', value: 'abc1234' })
    await store.createWorkspaceSecret(admin, third.id, { name: 'REGION', kind: 'env', value: 'us-east-1-long' })
    await store.createWorkspaceSecret(admin, third.id, { name: 'REPO_ONLY', kind: 'secret', value: 'repo-scoped-value', scope: { type: 'repository', repository: 'acme/app' } })
    assert.deepEqual(await runtime.sandboxSecretEnv(third.id, off), {}, 'flag off: nothing injected')
    await store.createWorkspaceSecret(admin, third.id, { name: 'PROD_ONLY', kind: 'env', value: 'prod-value', environment: 'production' })
    await store.createWorkspaceSecret(admin, third.id, { name: 'PREVIEW_ONLY', kind: 'secret', value: 'preview-secret-value', environment: 'preview' })
    await store.createWorkspaceSecret(admin, third.id, { name: 'DEV_ONLY', kind: 'secret', value: 'dev-secret-value', environment: 'development' })
    assert.deepEqual(await runtime.sandboxSecretEnv(third.id, on), { GH_TOKEN: TOKEN, SHORT: 'abc1234', REGION: 'us-east-1-long', PROD_ONLY: 'prod-value' }, 'only environment all + production are injected')
    assert.equal((await runtime.workspaceSecretMasker(third.id, on))('preview-secret-value dev-secret-value'), 'preview-secret-value dev-secret-value', 'preview/development values are not loaded at runtime')
    const chunk = { type: 'text-delta', delta: `push ${TOKEN} b64=${Buffer.from(TOKEN).toString('base64')} short=abc1234 region=us-east-1-long`, nested: [{ url: `https://x/?t=${encodeURIComponent(TOKEN)}` }] }
    const offMask = await runtime.workspaceSecretMasker(third.id, off)
    assert.deepEqual(maskDeep(chunk, offMask), chunk, 'flag off: stored verbatim (today)')
    const masked = maskDeep(chunk, await runtime.workspaceSecretMasker(third.id, on))
    const text = JSON.stringify(masked)
    assert.ok(!text.includes(TOKEN) && !text.includes(Buffer.from(TOKEN).toString('base64')))
    assert.match(masked.delta, /push \[secret:GH_TOKEN\] b64=\[secret:GH_TOKEN\] short=abc1234 region=us-east-1-long/)
    assert.equal(masked.nested[0].url, 'https://x/?t=[secret:GH_TOKEN]')
    const otherMask = await runtime.workspaceSecretMasker(other.id, on)
    assert.ok(otherMask(TOKEN) === TOKEN, 'another workspace does not mask this one\'s values')
    assert.equal((await runtime.workspaceSecretMasker(null, on))('x'), 'x')
    await assert.rejects(runtime.sandboxSecretEnv(third.id, { MIKKA_BYO_E2B_KEY: '1' }), (error: unknown) => error instanceof e2b.E2BKeyError && error.code === 'e2b_unavailable')
  })

  await t.test('4e2 runtime: E2B errors map to codes and mark the card (flag on only)', async () => {
    const { withE2BErrors } = await import('../lib/secrets/e2b-runtime')
    const { AuthenticationError, NotFoundError } = await import('e2b')
    const on = { MIKKA_BYO_E2B_KEY: '1' }
    await assert.rejects(withE2BErrors(other.id, false, async () => { throw new AuthenticationError('nope') }, {}), AuthenticationError, 'flag off: unchanged')
    await assert.rejects(withE2BErrors(other.id, true, async () => { throw new NotFoundError('template x not found') }, on), (error: unknown) => error instanceof e2b.E2BKeyError && error.code === 'e2b_template_unavailable')
    assert.equal((await e2b.getE2BKeyStatus(admin, other.id)).lastErrorCode, 'template_unavailable')
    await assert.rejects(withE2BErrors(other.id, false, async () => { throw new AuthenticationError('nope') }, on), (error: unknown) => error instanceof e2b.E2BKeyError && error.code === 'e2b_key_invalid')
    assert.equal((await e2b.getE2BKeyStatus(admin, other.id)).lastErrorCode, 'invalid')
  })

  // ---- #436 QA round (cases from qa-pr436.db.test.ts) ----
  const crypto = await import('../lib/secrets/crypto')
  const captureLogs = async <T>(work: () => Promise<T>) => {
    const lines: string[] = [], original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
    for (const k of Object.keys(original) as (keyof typeof original)[]) console[k] = (...args: unknown[]) => { lines.push(args.map(a => a instanceof Error ? `${a.stack} ${JSON.stringify(a)} ${String((a as { cause?: unknown }).cause)}` : typeof a === 'string' ? a : JSON.stringify(a)).join(' ')) }
    try { return { result: await work().then(v => ({ ok: v }), (e: unknown) => ({ error: e })), lines } } finally { Object.assign(console, original) }
  }

  await t.test('crypto: same plaintext twice gives different iv and ciphertext; AAD binds workspace, scope, kind and name', () => {
    const aad = crypto.secretAad({ workspaceId: ws.id, kind: 'secret', scopeType: 'workspace', scopeRef: '', environment: 'all', name: 'N' })
    const one = crypto.sealSecret(SECRET, aad), two = crypto.sealSecret(SECRET, aad)
    assert.notEqual(one.iv, two.iv); assert.notEqual(one.ciphertext, two.ciphertext)
    assert.equal(Buffer.from(one.iv, 'base64').length, 12)
    assert.equal(crypto.openSecret(one, aad), SECRET); assert.equal(crypto.openSecret(two, aad), SECRET)
    for (const moved of [{ workspaceId: other.id }, { name: 'M' }, { kind: 'env' as const }, { scopeType: 'repository' as const, scopeRef: 'o/r' }, { environment: 'production' }])
      assert.throws(() => crypto.openSecret(one, crypto.secretAad({ workspaceId: ws.id, kind: 'secret', scopeType: 'workspace', scopeRef: '', environment: 'all', name: 'N', ...moved })), JSON.stringify(moved))
  })

  await t.test('moved ciphertext (other workspace / other scope) fails to decrypt: row marked unavailable, rest of the list works, one id-only log line', async () => {
    const a = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }]), b = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const V = 'moved_' + randomBytes(12).toString('hex')
    const source = await store.createWorkspaceSecret(admin, a.id, { name: 'SRC', kind: 'env', value: V })
    const okRow = await store.createWorkspaceSecret(admin, b.id, { name: 'FINE', kind: 'env', value: 'still-readable' })
    const crossWs = await store.createWorkspaceSecret(admin, b.id, { name: 'SRC', kind: 'env', value: 'placeholder-1' })
    const crossScope = await store.createWorkspaceSecret(admin, a.id, { name: 'SRC', kind: 'env', value: 'placeholder-2', scope: { type: 'repository', repository: 'o/r' } })
    await pool.query('update workspace_secrets t set ciphertext=s.ciphertext, iv=s.iv from workspace_secrets s where s.id=$1 and t.id = any($2)', [source.id, [crossWs.id, crossScope.id]])
    for (const [workspaceId, brokenId] of [[b.id, crossWs.id], [a.id, crossScope.id]]) {
      const { result, lines } = await captureLogs(() => store.listWorkspaceSecrets(admin, workspaceId))
      assert.ok('ok' in result, 'list still works')
      const rows = (result as { ok: Awaited<ReturnType<typeof store.listWorkspaceSecrets>> }).ok
      const broken = rows.find(row => row.id === brokenId)!
      assert.deepEqual([broken.unavailable, broken.value], [true, null])
      assert.ok(rows.filter(row => row.id !== brokenId).every(row => !row.unavailable && row.value), 'other rows decrypt')
      assert.deepEqual(lines, [`[secrets] secretDecryptFailed id=${brokenId}`])
    }
    assert.equal((await store.listWorkspaceSecrets(admin, b.id)).find(row => row.id === okRow.id)?.value, 'still-readable')
    assert.equal((await store.listWorkspaceSecrets(admin, a.id)).find(row => row.id === source.id)?.value, V)
  })

  await t.test('moved E2B key fails to decrypt: e2b_unavailable, never the raw crypto Error, one id-only log line', async () => {
    await pool.query('delete from workspace_e2b_verify_attempts')
    const a = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }]), b = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const K = 'e2b_' + randomBytes(16).toString('hex'), on = { MIKKA_BYO_E2B_KEY: '1', WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY }
    await e2b.setE2BKey(admin, a.id, { apiKey: K }, { verify: async () => ({ ok: true }) })
    assert.equal(await e2b.getWorkspaceE2BApiKey(a.id, on), K)
    await pool.query(`insert into workspace_e2b_keys select $1,ciphertext,iv,"keyVersion",last4,"e2bTeamHint","verifiedAt","lastErrorCode","lastErrorAt","createdBy","updatedBy","createdAt","updatedAt" from workspace_e2b_keys where "workspaceId"=$2`, [b.id, a.id])
    const { result, lines } = await captureLogs(() => e2b.getWorkspaceE2BApiKey(b.id, on))
    const error = (result as { error?: unknown }).error
    assert.ok(error instanceof e2b.E2BKeyError && error.code === 'e2b_unavailable', 'mapped, not the raw crypto Error')
    assert.deepEqual(lines, [`[secrets] e2b_unavailable id=${b.id}`])
    assert.ok(!JSON.stringify([error, String((error as Error).stack), lines]).includes(K))
    await pool.query('delete from workspace_e2b_verify_attempts')
  })

  await t.test('DB failures become a generic SecretsStoreError: params, ciphertext and iv never reach logs or the caller', async () => {
    const V = 'leak_' + randomBytes(12).toString('hex')
    const { db } = await import('../lib/db')
    const { sql } = await import('drizzle-orm')
    // Raw drizzle failure carries the bound params; the guard must drop them.
    const raw = await db.execute(sql`select ${V}::int`).then(() => null, (e: unknown) => e)
    assert.ok(String((raw as Error).message).includes(V), 'precondition: DrizzleQueryError leaks params')
    // Real store path: a temporary trigger fails the insert after the value has been sealed into params.
    await pool.query(`create or replace function pg_temp_boom() returns trigger language plpgsql as $$ begin if new.name = 'BOOM' then raise exception 'boom' using errcode = 'P0001'; end if; return new; end $$`)
    await pool.query('create trigger qa_boom before insert or update on workspace_secrets for each row execute function pg_temp_boom()')
    try {
      for (const work of [
        () => store.guardSecretsDb(() => db.execute(sql`select ${V}::int`)),
        () => store.createWorkspaceSecret(admin, other.id, { name: 'BOOM', kind: 'secret', value: V }),
      ]) {
        let caught: unknown
        const { lines } = await captureLogs(async () => { try { await work() } catch (error) { caught = error; console.error(error) } })
        assert.ok(caught instanceof store.SecretsStoreError, String(caught))
        assert.equal((caught as { cause?: unknown }).cause, undefined)
        const blob = [String((caught as Error).stack), JSON.stringify(caught), ...lines].join('\n')
        assert.ok(!blob.includes(V) && !/params:|insert into|select /i.test(blob), blob.slice(0, 300))
      }
    } finally {
      await pool.query('drop trigger if exists qa_boom on workspace_secrets'); await pool.query('drop function if exists pg_temp_boom()')
    }
  })

  await t.test('500 cap holds under 30 concurrent creates from 490 rows (advisory lock store.ts)', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const filler = crypto.sealSecret('x', 'filler')
    await pool.query(`insert into workspace_secrets (id,"workspaceId",name,kind,"scopeType","scopeRef",ciphertext,iv,"keyVersion","createdBy","updatedBy") select gen_random_uuid(),$1,'N'||g,'env','workspace','',$2,$3,1,$4,$4 from generate_series(1,490) g`, [w.id, filler.ciphertext, filler.iv, admin])
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => store.createWorkspaceSecret(admin, w.id, { name: 'C' + i, kind: 'secret', value: 'valuevalue' })))
    const { rows } = await pool.query('select count(*)::int n from workspace_secrets where "workspaceId"=$1', [w.id])
    assert.equal(rows[0].n, 500)
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 10)
    assert.deepEqual([...new Set(results.flatMap(r => r.status === 'rejected' ? [r.reason instanceof WorkspaceError ? r.reason.code : String(r.reason)] : []))], ['secretLimitReached'])
  })

  await t.test('E2B verify limiter admits exactly 5 of 10 concurrent attempts (advisory lock e2b.ts)', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    let calls = 0
    const now = new Date()
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => e2b.setE2BKey(admin, w.id, { apiKey: 'e2b_' + randomBytes(16).toString('hex') }, { now, verify: async () => { calls++; return { ok: false, code: 'invalid' } } })))
    const codes = results.map(r => r.status === 'rejected' && r.reason instanceof WorkspaceError ? r.reason.code : 'other')
    assert.equal(codes.filter(c => c === 'e2bKeyInvalid').length, 5); assert.equal(codes.filter(c => c === 'e2bKeyRateLimited').length, 5); assert.equal(calls, 5)
    await pool.query('delete from workspace_e2b_verify_attempts where "workspaceId"=$1', [w.id])
  })

  await t.test('egress: admin check before validation, 200-domain limit with real count, 1-based lines, no IPs, open/none keep the allowlist', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    await rejects(store.updateNetworkPolicy(member, w.id, { mode: 'bogus', allowedDomains: ['bad domain'] }), 'secretPermissionDenied')
    await rejects(store.updateNetworkPolicy(member, w.id, { mode: 'allowlist', allowedDomains: Array.from({ length: 300 }, (_, i) => `d${i}.com`) }), 'secretPermissionDenied')
    const many = (n: number) => Array.from({ length: n }, (_, i) => `d${i}.com`)
    assert.equal((await store.updateNetworkPolicy(admin, w.id, { mode: 'allowlist', allowedDomains: [...many(200), '', 'D0.COM', 'd1.com.'] })).allowedDomains.length, 200)
    await assert.rejects(store.updateNetworkPolicy(admin, w.id, { mode: 'allowlist', allowedDomains: [...many(205), '', 'd0.com'] }), (error: unknown) => error instanceof store.EgressTooManyDomainsError && error.code === 'egressTooManyDomains' && error.count === 205)
    await assert.rejects(store.updateNetworkPolicy(admin, w.id, { mode: 'allowlist', allowedDomains: ['ok.com', '1.2.3.4', 'x.com', '::1'] }), (error: unknown) => error instanceof store.EgressDomainError && error.lines.join() === '2,4')
    const list = ['github.com', '*.mikka.app']
    await store.updateNetworkPolicy(admin, w.id, { mode: 'allowlist', allowedDomains: list })
    for (const mode of ['open', 'none'] as const) {
      const saved = await store.updateNetworkPolicy(admin, w.id, { mode, allowedDomains: ['ignored.com'] })
      assert.deepEqual([saved.mode, saved.allowedDomains], [mode, list], `${mode} keeps the stored allowlist`)
    }
    const fresh = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    assert.deepEqual((await store.updateNetworkPolicy(admin, fresh.id, { mode: 'none' })).allowedDomains, [])
  })

  await t.test('repository scope: . and .. rejected; owner/repo stored and compared lowercase', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    for (const repository of ['../x', 'o/..', './.', 'o/.']) await assert.rejects(store.createWorkspaceSecret(admin, w.id, { name: 'R', kind: 'env', value: 'repo-value', scope: { type: 'repository', repository } }), repository)
    const saved = await store.createWorkspaceSecret(admin, w.id, { name: 'R', kind: 'env', value: 'repo-value', scope: { type: 'repository', repository: 'AlexJ/Mikka' } })
    assert.deepEqual(saved.scope, { type: 'repository', repository: 'alexj/mikka' })
    await rejects(store.createWorkspaceSecret(admin, w.id, { name: 'R', kind: 'env', value: 'repo-value', scope: { type: 'repository', repository: 'alexj/MIKKA' } }), 'secretNameTaken')
    for (const ref of ['Alex/Mikka', 'o/..', '../x'])
      await assert.rejects(pool.query(`insert into workspace_secrets (id,"workspaceId",name,kind,"scopeType","scopeRef",ciphertext,iv,"keyVersion","createdBy","updatedBy") values (gen_random_uuid(),$1,'Q','env','repository',$2,'x','x',1,'u','u')`, [w.id, ref]), (error: { code?: string }) => error.code === '23514', ref)
  })

  await t.test('short-value warning counts code points', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const warn = async (value: string) => (await store.createWorkspaceSecret(admin, w.id, { name: 'W' + randomBytes(4).toString('hex'), kind: 'secret', value })).warning
    assert.equal(await warn('🔑🔑🔑🔑'), 'shortValueNotMasked', '4 code points, 8 UTF-16 units')
    assert.equal(await warn('1234567'), 'shortValueNotMasked')
    assert.equal(await warn('12345678'), null)
    assert.equal(await warn('🔑🔑🔑🔑🔑🔑🔑🔑'), null)
    assert.equal(store.isShortSecretValue('密钥密钥密钥密'), true)
  })

  await t.test('permission matrix: member and admin x create/replace/delete x scope x environment x kind', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const envs = ['all', 'production', 'preview', 'development'] as const
    const scopes = [{ type: 'workspace' as const }, { type: 'repository' as const, repository: 'acme/app' }]
    const memberMay = (scope: { type: string }, environment: string) => scope.type === 'repository' && (environment === 'preview' || environment === 'development')
    let n = 0
    for (const kind of ['secret', 'env'] as const) for (const scope of scopes) for (const environment of envs) {
      const cell = `${kind}/${scope.type}/${environment}`
      // create
      const memberCreate = store.createWorkspaceSecret(member, w.id, { name: `M${n}`, kind, value: 'membervalue', scope, environment })
      if (memberMay(scope, environment)) assert.equal((await memberCreate).environment, environment, cell)
      else await rejects(memberCreate, 'secretPermissionDenied')
      const byAdmin = await store.createWorkspaceSecret(admin, w.id, { name: `A${n}`, kind, value: 'adminvalue', scope, environment })
      assert.deepEqual([byAdmin.environment, byAdmin.scope.type], [environment, scope.type], cell)
      // replace (the admin-created row: also proves "including entries someone else created")
      const memberReplace = store.replaceWorkspaceSecret(member, w.id, { id: byAdmin.id, value: 'membervalue2' })
      if (memberMay(scope, environment)) await memberReplace; else await rejects(memberReplace, 'secretPermissionDenied')
      await store.replaceWorkspaceSecret(admin, w.id, { id: byAdmin.id, value: 'adminvalue2' })
      // delete: admin only, every cell
      await rejects(store.deleteWorkspaceSecret(member, w.id, { id: byAdmin.id }), 'secretPermissionDenied')
      assert.deepEqual(await store.deleteWorkspaceSecret(admin, w.id, { id: byAdmin.id }), { id: byAdmin.id })
      n++
    }
    // Same name may exist once per environment (environment is part of the unique key).
    for (const environment of envs) await store.createWorkspaceSecret(admin, w.id, { name: 'PER_ENV', kind: 'env', value: `v-${environment}`, scope: scopes[1], environment })
    await rejects(store.createWorkspaceSecret(member, w.id, { name: 'PER_ENV', kind: 'env', value: 'again', scope: scopes[1], environment: 'preview' }), 'secretNameTaken')
    // Read-side cells.
    assert.ok((await store.listWorkspaceSecrets(member, w.id)).length >= 4, 'members list')
    assert.equal((await store.listWorkspaceSecrets(member, w.id)).find(r => r.name === 'PER_ENV' && r.environment === 'production')?.value, 'v-production', 'env values are readable by members (plan 1.3)')
    const status = await e2b.getE2BKeyStatus(member, w.id)
    assert.ok(!('apiKey' in status), 'member E2B view is masked')
    await rejects(store.getNetworkPolicy(member, w.id), 'secretPermissionDenied')
    await rejects(store.updateNetworkPolicy(member, w.id, { mode: 'none' }), 'secretPermissionDenied')
    assert.equal((await store.getNetworkPolicy(admin, w.id)).mode, 'open')
    let verifyCalls = 0
    await rejects(e2b.setE2BKey(member, w.id, { apiKey: 'e2b_' + randomBytes(16).toString('hex') }, { verify: async () => { verifyCalls++; return { ok: true } } }), 'secretPermissionDenied')
    await rejects(e2b.removeE2BKey(member, w.id), 'secretPermissionDenied')
    assert.equal(verifyCalls, 0, 'member never reaches the E2B verify call')
  })

  await t.test('members cannot escalate by moving scope or environment; admins can', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const repo = { type: 'repository' as const, repository: 'acme/app' }
    const mine = await store.createWorkspaceSecret(member, w.id, { name: 'MINE', kind: 'secret', value: 'membervalue', scope: repo, environment: 'preview' })
    for (const move of [{ environment: 'production' }, { environment: 'all' }, { scope: { type: 'workspace' } }, { scope: { type: 'workspace' }, environment: 'development' }]) {
      await rejects(store.replaceWorkspaceSecret(member, w.id, { id: mine.id, value: 'escalated', ...move }), 'secretPermissionDenied')
    }
    const { rows: [still] } = await pool.query('select "scopeType","scopeRef",environment,"updatedBy" from workspace_secrets where id=$1', [mine.id])
    assert.deepEqual(still, { scopeType: 'repository', scopeRef: 'acme/app', environment: 'preview', updatedBy: member }, 'row untouched after denied moves')
    // Allowed lateral move inside the member area: other repo, development.
    const moved = await store.replaceWorkspaceSecret(member, w.id, { id: mine.id, value: 'membervalue', scope: { type: 'repository', repository: 'Acme/Other' }, environment: 'development' })
    assert.deepEqual([moved.scope, moved.environment], [{ type: 'repository', repository: 'acme/other' }, 'development'])
    // Pulling an admin entry down into member territory is also denied (old values are checked).
    const prod = await store.createWorkspaceSecret(admin, w.id, { name: 'PROD', kind: 'env', value: 'prodvalue', scope: repo, environment: 'production' })
    await rejects(store.replaceWorkspaceSecret(member, w.id, { id: prod.id, value: 'mine-now', environment: 'preview' }), 'secretPermissionDenied')
    const ws1 = await store.createWorkspaceSecret(admin, w.id, { name: 'WS', kind: 'env', value: 'wsvalue', environment: 'preview' })
    await rejects(store.replaceWorkspaceSecret(member, w.id, { id: ws1.id, value: 'mine-now', scope: repo }), 'secretPermissionDenied')
    assert.equal((await store.listWorkspaceSecrets(admin, w.id)).find(r => r.id === prod.id)?.value, 'prodvalue')
    // Admin moves work and the value still decrypts at its new place (AAD resealed with the new scope/environment).
    const promoted = await store.replaceWorkspaceSecret(admin, w.id, { id: ws1.id, value: 'wsvalue2', scope: repo, environment: 'production' })
    assert.deepEqual([promoted.scope, promoted.environment, promoted.value], [repo, 'production', 'wsvalue2'])
    // Member create straight into production / all / workspace denied, and nothing was written.
    for (const target of [{ environment: 'production' }, { environment: 'all' }, {}, { scope: { type: 'workspace' }, environment: 'preview' }])
      await rejects(store.createWorkspaceSecret(member, w.id, { name: 'SNEAK', kind: 'secret', value: 'membervalue', ...(target.scope || !('environment' in target) ? {} : { scope: repo }), ...target }), 'secretPermissionDenied')
    assert.equal((await pool.query(`select 1 from workspace_secrets where name='SNEAK'`)).rows.length, 0)
    // Name collision on a move maps to secretNameTaken.
    const a = await store.createWorkspaceSecret(member, w.id, { name: 'DUP', kind: 'env', value: 'aaaaaaaa', scope: repo, environment: 'preview' })
    await store.createWorkspaceSecret(member, w.id, { name: 'DUP', kind: 'env', value: 'bbbbbbbb', scope: repo, environment: 'development' })
    await rejects(store.replaceWorkspaceSecret(member, w.id, { id: a.id, value: 'aaaaaaaa', environment: 'development' }), 'secretNameTaken')
  })
})
