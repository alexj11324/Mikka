// 设置 › 密钥与环境 + BYO E2B key against a real PostgreSQL. Uses a random per-run WORKSPACE_SECRETS_KEY only.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('workspace secrets and E2B key', { skip: !dbUrl }, async t => {
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
  const secretCrypto = await import('../lib/secrets/crypto')
  /** Test-only read-back of the stored value (no endpoint returns it any more). */
  const stored = async (id: string) => { const { rows: [row] } = await pool.query('select * from workspace_secrets where id=$1', [id]); return secretCrypto.openSecret(row, secretCrypto.secretAad(row)) }
  const META_KEYS = ['id', 'kind', 'name', 'scopeRef', 'scopeType']

  await t.test('secret value is never returned; DB holds ciphertext only', async () => {
    const created = await store.createWorkspaceSecret(admin, ws.id, { name: 'STRIPE_KEY', kind: 'secret', value: SECRET })
    assert.deepEqual(Object.keys(created).filter(k => k !== 'warning').sort(), META_KEYS, 'metadata only')
    const replaced = await store.replaceWorkspaceSecret(admin, ws.id, { id: created.id, value: SECRET + 'x' })
    const listed = await store.listWorkspaceSecrets(admin, ws.id)
    assert.ok(!JSON.stringify([created, replaced, listed]).includes(SECRET))
    for (const row of listed) assert.deepEqual(Object.keys(row).sort(), META_KEYS, 'list: name/kind/scopeType/scopeRef (+id handle) only')
    const { rows } = await pool.query('select * from workspace_secrets where id=$1', [created.id])
    assert.ok(!JSON.stringify(rows).includes(SECRET), 'no plaintext in the row')
    assert.equal(rows[0].keyVersion, 1)
    assert.ok(rows[0].ciphertext.length > 0 && rows[0].iv.length > 0)
  })

  await t.test('env values are write-only too (design update); kind is fixed; scopes and names are unique per scope', async () => {
    const env = await store.createWorkspaceSecret(admin, ws.id, { name: 'NODE_ENV', kind: 'env', value: 'production' })
    assert.ok(!('value' in env))
    assert.ok(!JSON.stringify(await store.replaceWorkspaceSecret(admin, ws.id, { id: env.id, value: 'test' })).includes('"test"'))
    assert.ok(!JSON.stringify(await store.listWorkspaceSecrets(admin, ws.id)).includes('"test"'))
    assert.equal(await stored(env.id), 'test')
    await assert.rejects(store.replaceWorkspaceSecret(admin, ws.id, { id: env.id, value: 'x', kind: 'secret' }))
    await rejects(store.createWorkspaceSecret(admin, ws.id, { name: 'NODE_ENV', kind: 'secret', value: 'v' }), 'secretNameTaken')
    const repo = await store.createWorkspaceSecret(admin, ws.id, { name: 'NODE_ENV', kind: 'env', value: 'repo', scope: { type: 'repository', repository: 'alexj11324/mikka' } })
    assert.deepEqual([repo.scopeType, repo.scopeRef], ['repository', 'alexj11324/mikka'])
  })

  await t.test('members only (outsiders denied) and workspace scoped', async () => {
    const outsider = await seedUser(pool, 'outsider')
    await rejects(store.listWorkspaceSecrets(outsider, ws.id), 'workspaceAccessDenied')
    await rejects(store.createWorkspaceSecret(outsider, ws.id, { name: 'X', kind: 'env', value: 'v', scope: { type: 'repository', repository: 'o/r' } }), 'workspaceAccessDenied')
    await rejects(e2b.getE2BKeyStatus(outsider, ws.id), 'workspaceAccessDenied')
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
    assert.equal(await stored(env.id), 'v1')
  })

  await t.test('missing WORKSPACE_SECRETS_KEY fails closed', async () => {
    const key = process.env.WORKSPACE_SECRETS_KEY
    delete process.env.WORKSPACE_SECRETS_KEY
    try {
      await rejects(store.createWorkspaceSecret(admin, ws.id, { name: 'NOPE', kind: 'secret', value: 'v' }), 'secretsUnavailable')
      assert.ok(Array.isArray(await store.listWorkspaceSecrets(admin, ws.id)), 'list is metadata only: works without the key')
      let called = false
      await rejects(e2b.setE2BKey(admin, ws.id, { apiKey: 'e2b_nokeyconfigured' }, { verify: async () => { called = true; return { ok: true } } }), 'secretsUnavailable')
      assert.equal(called, false, 'E2B is not called when we cannot store the key')
    } finally { process.env.WORKSPACE_SECRETS_KEY = key }
    const { rows } = await pool.query(`select 1 from workspace_secrets where name='NOPE'`)
    assert.equal(rows.length, 0)
  })

  await t.test('E2B key: verified before save, write-only, audited as secret.* with label "E2B API Key"', async () => {
    const KEY = 'e2b_' + randomBytes(16).toString('hex')
    await rejects(e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: false, code: 'invalid' }) }), 'e2bKeyInvalid')
    await rejects(e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: false, code: 'unavailable' }) }), 'e2bKeyUnverifiable')
    await rejects(e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: false, code: 'rate_limited' }) }), 'e2bKeyRateLimited') // E2B answered 429
    assert.equal((await e2b.getE2BKeyStatus(admin, ws.id)).configured, false, 'nothing saved on failure')
    const events: string[] = []
    const status = await e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: true }), audit: async (_tx, e) => { events.push(`${e.action}:${e.target.type}:${e.target.label}`) } })
    assert.deepEqual(Object.keys(status).sort(), ['configured', 'lastErrorAt', 'lastErrorCode'], 'no last4 / verifiedAt / updatedAt')
    assert.equal(status.configured, true)
    assert.ok((await pool.query('select last4, "verifiedAt" from workspace_e2b_keys where "workspaceId"=$1', [ws.id])).rows[0].verifiedAt, 'still stored')
    assert.ok(!JSON.stringify(status).includes(KEY))
    const { rows } = await pool.query('select * from workspace_e2b_keys where "workspaceId"=$1', [ws.id])
    assert.ok(!JSON.stringify(rows).includes(KEY), 'ciphertext only')
    await e2b.setE2BKey(admin, ws.id, { apiKey: KEY + 'z' }, { verify: async () => ({ ok: true }), audit: async (_tx, e) => { events.push(`${e.action}:${e.target.type}:${e.target.label}`) } })
    await e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: true }) }) // no hook
    assert.deepEqual((await e2b.removeE2BKey(admin, ws.id, async (_tx, e) => { events.push(`${e.action}:${e.target.type}:${e.target.label}`) })), { removed: true })
    assert.deepEqual(events, ['secret.created:e2b_key:E2B API Key', 'secret.replaced:e2b_key:E2B API Key', 'secret.deleted:e2b_key:E2B API Key'] /* the third set used no hook */)
    assert.deepEqual(await e2b.removeE2BKey(admin, ws.id), { removed: false })
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
    const KEY = 'e2b_' + randomBytes(16).toString('hex')
    const on = { WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY, E2B_API_KEY: 'platform', MIKKA_BYO_E2B_KEY: '1' }
    await e2b.setE2BKey(admin, ws.id, { apiKey: KEY }, { verify: async () => ({ ok: true }) })
    assert.equal(await e2b.getWorkspaceE2BApiKey(ws.id, on), KEY)
    await rejects(e2b.removeE2BKey(member, ws.id), 'secretPermissionDenied')
    assert.equal(await e2b.getWorkspaceE2BApiKey(ws.id, on), KEY, 'non-admin delete changed nothing')
    assert.deepEqual(await e2b.removeE2BKey(admin, ws.id), { removed: true })
    await assert.rejects(e2b.getWorkspaceE2BApiKey(ws.id, on), (error: unknown) => error instanceof e2b.E2BKeyError && error.code === 'e2b_key_missing')
    assert.equal(await e2b.getWorkspaceE2BApiKey(ws.id, { ...on, MIKKA_BYO_E2B_KEY: '0' }), 'platform')
  })

  await t.test('BYO E2B getter: off = platform key (unchanged); on = workspace key or e2b_key_missing', async () => {
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
    assert.deepEqual(await runtime.taskSecretEnv(third.id, null, off), {}, 'flag off: nothing injected')
    assert.deepEqual(await runtime.taskSecretEnv(third.id, null, on), { GH_TOKEN: TOKEN, SHORT: 'abc1234', REGION: 'us-east-1-long' }, 'workspace-scoped values are injected; repo-scoped ones only for their repo')
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
    await assert.rejects(runtime.taskSecretEnv(third.id, null, { MIKKA_BYO_E2B_KEY: '1' }), (error: unknown) => error instanceof e2b.E2BKeyError && error.code === 'e2b_unavailable')
  })

  await t.test('4e3 task env: workspace + matching repo only, repo overrides, lowercase; masker covers repo secrets', async () => {
    const runtime = await import('../lib/secrets/runtime')
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const on = { WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY, MIKKA_BYO_E2B_KEY: '1' }, off = { WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY }
    const REPO_TOKEN = 'repo_' + randomBytes(12).toString('hex'), OTHER_TOKEN = 'other_' + randomBytes(12).toString('hex')
    await store.createWorkspaceSecret(admin, w.id, { name: 'API_TOKEN', kind: 'secret', value: 'workspace-api-token' })
    await store.createWorkspaceSecret(admin, w.id, { name: 'REGION', kind: 'env', value: 'ws-region' })
    await store.createWorkspaceSecret(admin, w.id, { name: 'API_TOKEN', kind: 'secret', value: REPO_TOKEN, scope: { type: 'repository', repository: 'Acme/App' } })
    await store.createWorkspaceSecret(admin, w.id, { name: 'REPO_ENV', kind: 'env', value: 'repo-env', scope: { type: 'repository', repository: 'acme/app' } })
    await store.createWorkspaceSecret(admin, w.id, { name: 'OTHER', kind: 'secret', value: OTHER_TOKEN, scope: { type: 'repository', repository: 'acme/other' } })
    assert.deepEqual(await runtime.taskSecretEnv(w.id, 'acme/app', off), {}, 'flag off: nothing')
    assert.deepEqual(await runtime.taskSecretEnv(w.id, null, on), { API_TOKEN: 'workspace-api-token', REGION: 'ws-region' }, 'no repo: workspace only')
    assert.deepEqual(await runtime.taskSecretEnv(w.id, 'ACME/App', on), { API_TOKEN: REPO_TOKEN, REGION: 'ws-region', REPO_ENV: 'repo-env' }, 'repo overrides workspace; case-insensitive; no other repo')
    assert.deepEqual(await runtime.taskSecretEnv(w.id, 'acme/unknown', on), { API_TOKEN: 'workspace-api-token', REGION: 'ws-region' })
    assert.deepEqual((await runtime.taskSecretInjection(w.id, 'acme/app', on)).secretNames.sort(), ['API_TOKEN'], 'only kind=secret names go to the daemon for masking; env vars are not listed')
    assert.deepEqual(await runtime.taskSecretInjection(w.id, 'acme/app', off), { env: {}, secretNames: [] })
    assert.equal(runtime.remoteRepositoryRef('https://github.com/Acme/App.git'), 'acme/app')
    assert.equal(runtime.remoteRepositoryRef('git@github.com:Acme/App.git'), 'acme/app')
    assert.equal(runtime.remoteRepositoryRef('ssh://git@github.com/acme/app'), 'acme/app')
    assert.equal(runtime.remoteRepositoryRef('https://x-access-token@github.com/acme/app/'), 'acme/app')
    assert.equal(runtime.remoteRepositoryRef('https://github.com.evil.dev/acme/app.git'), null, 'lookalike host never matches')
    assert.equal(runtime.remoteRepositoryRef('https://gitlab.com/acme/app.git'), null)
    assert.equal(runtime.remoteRepositoryRef('https://github.com/acme/../app'), null)
    assert.equal(runtime.remoteRepositoryRef(null), null)
    const mask = await runtime.workspaceSecretMasker(w.id, on)
    assert.equal(mask(`${REPO_TOKEN} ${OTHER_TOKEN} repo-env`), '[secret:API_TOKEN] [secret:OTHER] repo-env', 'repo-scoped secrets masked; env not')
  })

  await t.test('#436 defense in depth: a reserved name reaching injection is skipped and audited by name only', async () => {
    const events: { action: string; label: string; json: string }[] = []
    const audit = async (_tx: unknown, e: { action: string; target: { label: string } }) => { events.push({ action: e.action, label: e.target.label, json: JSON.stringify(e) }) }
    const value = 'reserved-value-' + randomUUID()
    const runtime = await import('../lib/secrets/runtime')
    const out = await runtime.reservedInjectionFilter(randomUUID(), [
      { id: randomUUID(), name: 'BASH_ENV', kind: 'env', value },
      { id: randomUUID(), name: 'npm_config_registry', kind: 'env', value },
      { id: randomUUID(), name: 'OK_NAME', kind: 'secret', value: 'fine' },
    ], { actorId: admin, audit })
    assert.deepEqual(out, { OK_NAME: 'fine' })
    assert.deepEqual(events.map(e => [e.action, e.label]), [['secret.injection_skipped', 'BASH_ENV'], ['secret.injection_skipped', 'npm_config_registry']])
    assert.ok(events.every(e => !e.json.includes(value)), 'the value is never in the audit entry')
  })

  await t.test('4e2 item 4: run-scoped masking resolves the cloud token workspace; checkpoint patch/files masked', async () => {
    const runtime = await import('../lib/secrets/runtime')
    const { maskCheckpoint } = await import('../lib/secrets/checkpoint')
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const TOKEN = 'tok_' + randomBytes(12).toString('hex')
    await store.createWorkspaceSecret(admin, w.id, { name: 'API_TOKEN', kind: 'secret', value: TOKEN })
    await store.createWorkspaceSecret(admin, w.id, { name: 'PLAIN_ENV', kind: 'env', value: 'plain-env-value' })
    const on = { WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY, MIKKA_BYO_E2B_KEY: '1' }, off = { WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY }
    const device = (await pool.query(`insert into devices (id,name,"ownerId") values (gen_random_uuid(),'cloud',$1) returning id`, [admin])).rows[0].id
    const local = (await pool.query(`insert into devices (id,name,"ownerId") values (gen_random_uuid(),'local',$1) returning id`, [admin])).rows[0].id
    await pool.query(`insert into device_tokens (id,"userId","tokenHash","boundDeviceId","boundWorkspaceId") values (gen_random_uuid(),$1,$2,$3,$4)`, [admin, randomBytes(16).toString('hex'), device, w.id])
    const agent = (await pool.query(`insert into agents (id,"userId",harness,name) values (gen_random_uuid(),$1,'codex','a') returning id`, [admin])).rows[0].id
    const run = (await pool.query(`insert into agent_runs (id,"agentId","userId","deviceId") values (gen_random_uuid(),$1,$2,$3) returning id`, [agent, admin, device])).rows[0].id
    const localRun = (await pool.query(`insert into agent_runs (id,"agentId","userId","deviceId") values (gen_random_uuid(),$1,$2,$3) returning id`, [agent, admin, local])).rows[0].id
    assert.equal(await runtime.runWorkspaceId(run), w.id)
    assert.equal(await runtime.runWorkspaceId(localRun), null, 'local device: no injected secrets, nothing to mask')
    const out = { title: `report ${TOKEN}`, content: `b64 ${Buffer.from(TOKEN).toString('base64')} env plain-env-value` }
    assert.deepEqual(await runtime.maskForRun(run, out, off), out, 'flag off: verbatim')
    assert.deepEqual(await runtime.maskForRun(run, out, on), { title: 'report [secret:API_TOKEN]', content: 'b64 [secret:API_TOKEN] env plain-env-value' }, 'kind=env never masked')
    assert.deepEqual(await runtime.maskForRun(localRun, out, on), out)
    assert.equal(await runtime.maskForWorkspace(w.id, `x ${encodeURIComponent(TOKEN)}`, on), 'x [secret:API_TOKEN]')
    const patch = Buffer.from(`--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A=1\n+API_TOKEN=${TOKEN}\n`)
    const mask = await runtime.workspaceSecretMasker(w.id, on)
    const cp = maskCheckpoint({ patch, files: [{ path: 'a', preview: TOKEN }] }, mask)
    assert.ok(!cp.patch.includes(TOKEN) && cp.patch.toString().includes('+API_TOKEN=[secret:API_TOKEN]'))
    assert.deepEqual(cp.files, [{ path: 'a', preview: '[secret:API_TOKEN]' }])
    const binary = Buffer.from([0xff, 0xfe, 0x00, ...Buffer.from(TOKEN)])
    assert.equal(maskCheckpoint({ patch: binary, files: [] }, mask).patch, binary, 'non-UTF-8 patch left as is (documented gap)')
    const offCp = { patch, files: [] }
    assert.equal(maskCheckpoint(offCp, await runtime.workspaceSecretMasker(w.id, off)), offCp, 'flag off: same object')
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
    const aad = crypto.secretAad({ workspaceId: ws.id, kind: 'secret', scopeType: 'workspace', scopeRef: '', name: 'N' })
    const one = crypto.sealSecret(SECRET, aad), two = crypto.sealSecret(SECRET, aad)
    assert.notEqual(one.iv, two.iv); assert.notEqual(one.ciphertext, two.ciphertext)
    assert.equal(Buffer.from(one.iv, 'base64').length, 12)
    assert.equal(crypto.openSecret(one, aad), SECRET); assert.equal(crypto.openSecret(two, aad), SECRET)
    for (const moved of [{ workspaceId: other.id }, { name: 'M' }, { kind: 'env' as const }, { scopeType: 'repository' as const, scopeRef: 'o/r' }])
      assert.throws(() => crypto.openSecret(one, crypto.secretAad({ workspaceId: ws.id, kind: 'secret', scopeType: 'workspace', scopeRef: '', name: 'N', ...moved })), JSON.stringify(moved))
  })

  await t.test('moved ciphertext: list never decrypts (metadata only), so it still works and logs nothing; the moved row fails to open', async () => {
    const a = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }]), b = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const V = 'moved_' + randomBytes(12).toString('hex')
    const source = await store.createWorkspaceSecret(admin, a.id, { name: 'SRC', kind: 'env', value: V })
    const crossWs = await store.createWorkspaceSecret(admin, b.id, { name: 'SRC', kind: 'env', value: 'placeholder-1' })
    await pool.query('update workspace_secrets t set ciphertext=s.ciphertext, iv=s.iv from workspace_secrets s where s.id=$1 and t.id=$2', [source.id, crossWs.id])
    const { result, lines } = await captureLogs(() => store.listWorkspaceSecrets(admin, b.id))
    assert.ok('ok' in result && !JSON.stringify(result).includes(V))
    assert.deepEqual(lines, [])
    await assert.rejects(stored(crossWs.id), 'AAD binds the row: moved ciphertext does not open')
    assert.equal(await stored(source.id), V)
  })

  await t.test('moved E2B key fails to decrypt: e2b_unavailable, never the raw crypto Error, one id-only log line', async () => {
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

  await t.test('repository scope: . and .. rejected; owner/repo stored and compared lowercase', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    for (const repository of ['../x', 'o/..', './.', 'o/.']) await assert.rejects(store.createWorkspaceSecret(admin, w.id, { name: 'R', kind: 'env', value: 'repo-value', scope: { type: 'repository', repository } }), repository)
    const saved = await store.createWorkspaceSecret(admin, w.id, { name: 'R', kind: 'env', value: 'repo-value', scope: { type: 'repository', repository: 'AlexJ/Mikka' } })
    assert.deepEqual([saved.scopeType, saved.scopeRef], ['repository', 'alexj/mikka'])
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

  await t.test('permission matrix: member and admin x create/replace/delete x scope x kind', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const scopes = [{ type: 'workspace' as const }, { type: 'repository' as const, repository: 'acme/app' }]
    const memberMay = (scope: { type: string }) => scope.type === 'repository'
    let n = 0
    for (const kind of ['secret', 'env'] as const) for (const scope of scopes) {
      const cell = `${kind}/${scope.type}`
      // create
      const memberCreate = store.createWorkspaceSecret(member, w.id, { name: `M${n}`, kind, value: 'membervalue', scope })
      if (memberMay(scope)) assert.equal((await memberCreate).scopeType, scope.type, cell)
      else await rejects(memberCreate, 'secretPermissionDenied')
      const byAdmin = await store.createWorkspaceSecret(admin, w.id, { name: `A${n}`, kind, value: 'adminvalue', scope })
      assert.equal(byAdmin.scopeType, scope.type, cell)
      // replace (the admin-created row: also proves "including entries someone else created")
      const memberReplace = store.replaceWorkspaceSecret(member, w.id, { id: byAdmin.id, value: 'membervalue2' })
      if (memberMay(scope)) await memberReplace; else await rejects(memberReplace, 'secretNotFound')
      await store.replaceWorkspaceSecret(admin, w.id, { id: byAdmin.id, value: 'adminvalue2' })
      // delete: admin only, every cell
      await rejects(store.deleteWorkspaceSecret(member, w.id, { id: byAdmin.id }), 'secretPermissionDenied')
      assert.deepEqual(await store.deleteWorkspaceSecret(admin, w.id, { id: byAdmin.id }), { id: byAdmin.id })
      n++
    }
    // Same name may exist once per scope (workspace + each repo).
    await store.createWorkspaceSecret(admin, w.id, { name: 'PER_SCOPE', kind: 'env', value: 'v-workspace' })
    await store.createWorkspaceSecret(member, w.id, { name: 'PER_SCOPE', kind: 'env', value: 'v-repo', scope: scopes[1] })
    await rejects(store.createWorkspaceSecret(member, w.id, { name: 'PER_SCOPE', kind: 'env', value: 'again', scope: scopes[1] }), 'secretNameTaken')
    // Read-side cells.
    assert.ok((await store.listWorkspaceSecrets(member, w.id)).length >= 2, 'members list')
    assert.ok((await store.listWorkspaceSecrets(member, w.id)).every(r => !('value' in r)), 'no values for anyone (design update)')
    const status = await e2b.getE2BKeyStatus(member, w.id)
    assert.ok(!('apiKey' in status), 'member E2B view is masked')
    let verifyCalls = 0
    await rejects(e2b.setE2BKey(member, w.id, { apiKey: 'e2b_' + randomBytes(16).toString('hex') }, { verify: async () => { verifyCalls++; return { ok: true } } }), 'secretPermissionDenied')
    await rejects(e2b.removeE2BKey(member, w.id), 'secretPermissionDenied')
    assert.equal(verifyCalls, 0, 'member never reaches the E2B verify call')
  })

  await t.test('members cannot escalate by moving scope; admins can', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const repo = { type: 'repository' as const, repository: 'acme/app' }
    const mine = await store.createWorkspaceSecret(member, w.id, { name: 'MINE', kind: 'secret', value: 'membervalue', scope: repo })
    await rejects(store.replaceWorkspaceSecret(member, w.id, { id: mine.id, value: 'escalated', scope: { type: 'workspace' } }), 'secretPermissionDenied')
    await assert.rejects(store.replaceWorkspaceSecret(member, w.id, { id: mine.id, value: 'escalated', environment: 'production' }), 'environment is no longer an input')
    const { rows: [still] } = await pool.query('select "scopeType","scopeRef","updatedBy" from workspace_secrets where id=$1', [mine.id])
    assert.deepEqual(still, { scopeType: 'repository', scopeRef: 'acme/app', updatedBy: member }, 'row untouched after denied moves')
    // Allowed lateral move inside the member area: another repo.
    const moved = await store.replaceWorkspaceSecret(member, w.id, { id: mine.id, value: 'membervalue', scope: { type: 'repository', repository: 'Acme/Other' } })
    assert.deepEqual([moved.scopeType, moved.scopeRef], ['repository', 'acme/other'])
    // Pulling an admin workspace entry down into member territory is also denied (old values are checked).
    const ws1 = await store.createWorkspaceSecret(admin, w.id, { name: 'WS', kind: 'env', value: 'wsvalue' })
    await rejects(store.replaceWorkspaceSecret(member, w.id, { id: ws1.id, value: 'mine-now', scope: repo }), 'secretNotFound')
    assert.equal(await stored(ws1.id), 'wsvalue')
    // Admin moves work and the value still decrypts at its new place (AAD resealed with the new scope).
    const promoted = await store.replaceWorkspaceSecret(admin, w.id, { id: ws1.id, value: 'wsvalue2', scope: repo })
    assert.deepEqual([promoted.scopeType, promoted.scopeRef, await stored(ws1.id)], ['repository', 'acme/app', 'wsvalue2'])
    // Member create straight into workspace scope denied, and nothing was written.
    for (const target of [{}, { scope: { type: 'workspace' } }])
      await rejects(store.createWorkspaceSecret(member, w.id, { name: 'SNEAK', kind: 'secret', value: 'membervalue', ...target }), 'secretPermissionDenied')
    assert.equal((await pool.query(`select 1 from workspace_secrets where name='SNEAK'`)).rows.length, 0)
    // Name collision on a move maps to secretNameTaken.
    const a = await store.createWorkspaceSecret(member, w.id, { name: 'DUP', kind: 'env', value: 'aaaaaaaa', scope: repo })
    await store.createWorkspaceSecret(member, w.id, { name: 'DUP', kind: 'env', value: 'bbbbbbbb', scope: { type: 'repository', repository: 'acme/third' } })
    await rejects(store.replaceWorkspaceSecret(member, w.id, { id: a.id, value: 'aaaaaaaa', scope: { type: 'repository', repository: 'acme/third' } }), 'secretNameTaken')
  })

  await t.test('#436 blocker: for a member, missing / other-workspace / not-permitted ids are indistinguishable; denied audited', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const elsewhere = await store.createWorkspaceSecret(admin, other.id, { name: 'ELSEWHERE', kind: 'env', value: 'elsewhere-value' })
    const forbidden = await store.createWorkspaceSecret(admin, w.id, { name: 'FORBIDDEN', kind: 'secret', value: 'forbidden-value' })
    const events: string[] = []
    const hook: import('../lib/secrets/store').SecretAuditHook = async (_tx, e) => { events.push(`${e.action}:${e.metadata?.reason}`) }
    const codes: string[] = []
    for (const id of [globalThis.crypto.randomUUID(), elsewhere.id, forbidden.id]) {
      const error = await store.replaceWorkspaceSecret(member, w.id, { id, value: 'membervalue' }, hook).then(() => null, (e: unknown) => e)
      codes.push(error instanceof WorkspaceError ? error.code : String(error))
    }
    assert.deepEqual(codes, ['secretNotFound', 'secretNotFound', 'secretNotFound'], 'same code for all three')
    assert.deepEqual(events, ['secret.replace_denied:notFound', 'secret.replace_denied:notFound', 'secret.replace_denied:permission'], 'same path (one audit write each); internal reason kept')
    assert.equal(await stored(forbidden.id), 'forbidden-value')
    // Admins unaffected.
    await rejects(store.replaceWorkspaceSecret(admin, w.id, { id: globalThis.crypto.randomUUID(), value: 'x' }), 'secretNotFound')
    await store.replaceWorkspaceSecret(admin, w.id, { id: forbidden.id, value: 'admin-new-value' })
    assert.equal(await stored(forbidden.id), 'admin-new-value')
  })

  await t.test('#436 race: an uncommitted move to workspace scope blocks a concurrent member replace (FOR UPDATE)', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const row = await store.createWorkspaceSecret(admin, w.id, { name: 'RACY', kind: 'env', value: 'repo-value', scope: { type: 'repository', repository: 'acme/app' } })
    const holder = await pool.connect()
    try {
      await holder.query('begin')
      await holder.query(`update workspace_secrets set "scopeType"='workspace', "scopeRef"='' where id=$1`, [row.id])
      const replace = store.replaceWorkspaceSecret(member, w.id, { id: row.id, value: 'member-value' }).then(() => 'ok', (e: unknown) => e instanceof WorkspaceError ? e.code : String(e))
      await new Promise(resolve => setTimeout(resolve, 300))
      await holder.query('commit')
      assert.equal(await replace, 'secretNotFound', 'member sees the committed workspace row and is denied')
    } finally { holder.release() }
    const { rows: [after] } = await pool.query('select "scopeType", "updatedBy" from workspace_secrets where id=$1', [row.id])
    assert.equal(after.scopeType, 'workspace')
    assert.notEqual(after.updatedBy, member)
  })

  await t.test('B: reserved env names are rejected on create (secretNameReserved), any case', async () => {
    const w = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    for (const name of ['PATH', 'path', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'http_proxy', 'HTTPS_PROXY', 'ALL_PROXY', 'no_proxy', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'GIT_DIR', 'HOME', 'SHELL', 'E2B_API_KEY', 'MIKKA_ANYTHING', 'CLAUDE_CODE_OAUTH_TOKEN'])
      await rejects(store.createWorkspaceSecret(admin, w.id, { name, kind: 'env', value: 'value-1234' }), 'secretNameReserved')
    assert.equal((await pool.query('select 1 from workspace_secrets where "workspaceId"=$1', [w.id])).rows.length, 0)
    await store.createWorkspaceSecret(admin, w.id, { name: 'PATHFINDER', kind: 'env', value: 'ok-value' })
  })
})
