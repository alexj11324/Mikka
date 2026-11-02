// 设置 › 密钥与登录 › 我的: a person's own secrets against a real PostgreSQL (decision 2026-11-02-2120).
// Uses a random per-run WORKSPACE_SECRETS_KEY only.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('personal secrets', { skip: !dbUrl }, async t => {
  const previousKey = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { WorkspaceError } = await import('../lib/workspace-access')
  const personal = await import('../lib/secrets/user-store')
  const store = await import('../lib/secrets/store')
  const runtime = await import('../lib/secrets/runtime')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => {
    if (previousKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = previousKey
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)
  const alex = await seedUser(pool, 'alex'), lin = await seedUser(pool, 'lin')
  const ws = await seedWorkspace(pool, alex, [{ userId: alex, role: 'admin' }, { userId: lin, role: 'member' }])
  const VALUE = 'sk_personal_' + randomBytes(12).toString('hex')
  const META = ['id', 'kind', 'name', 'note', 'updatedAt']

  await t.test('owner-only: list, create, replace, delete; ids of others are indistinguishable from missing ones', async () => {
    const saved = await personal.createUserSecret(alex, { name: 'OPENROUTER_API_KEY', kind: 'secret', value: VALUE, note: '测试用' }, { workspaceId: ws.id })
    assert.deepEqual(Object.keys(saved).filter(key => key !== 'warning').sort(), META)
    assert.ok(!JSON.stringify(saved).includes(VALUE))
    assert.deepEqual((await personal.listUserSecrets(alex)).map(row => [row.name, row.note]), [['OPENROUTER_API_KEY', '测试用']])
    assert.deepEqual(await personal.listUserSecrets(lin), [])
    await rejects(personal.replaceUserSecret(lin, { id: saved.id, value: 'stolen-value-1' }), 'secretNotFound')
    await rejects(personal.deleteUserSecret(lin, { id: saved.id }), 'secretNotFound')
    const noted = await personal.replaceUserSecret(alex, { id: saved.id, note: '换了说明' })
    assert.equal(noted.note, '换了说明')
    await rejects(personal.createUserSecret(alex, { name: 'OPENROUTER_API_KEY', kind: 'secret', value: VALUE }, { workspaceId: ws.id }), 'secretNameTaken')
    await rejects(personal.createUserSecret(alex, { name: 'PATH', kind: 'env', value: '/usr/bin' }, { workspaceId: ws.id }), 'secretNameReserved')
    const { rows } = await pool.query('select * from user_secrets where id=$1', [saved.id])
    assert.ok(!JSON.stringify(rows).includes(VALUE), 'ciphertext only')
    assert.deepEqual(await personal.deleteUserSecret(alex, { id: saved.id }), { id: saved.id })
    assert.deepEqual(await personal.listUserSecrets(alex), [])
  })

  await t.test('a personal name a workspace secret already has asks once; confirmed, the personal value wins in the owner\'s runs only', async () => {
    await store.createWorkspaceSecret(alex, ws.id, { name: 'VERCEL_TOKEN', kind: 'secret', value: 'team-value-1234' })
    await store.createWorkspaceSecret(alex, ws.id, { name: 'REPO_ONLY', kind: 'secret', value: 'repo-value-1234', scope: { type: 'repository', repository: 'alexj11324/mikka' } })
    await rejects(personal.createUserSecret(alex, { name: 'VERCEL_TOKEN', kind: 'secret', value: 'alex-value-1234' }, { workspaceId: ws.id }), 'secretNameShadowsWorkspace')
    await rejects(personal.createUserSecret(alex, { name: 'REPO_ONLY', kind: 'secret', value: 'alex-repo-1234' }, { workspaceId: ws.id }), 'secretNameShadowsWorkspace')
    await personal.createUserSecret(alex, { name: 'VERCEL_TOKEN', kind: 'secret', value: 'alex-value-1234', overrideWorkspace: true }, { workspaceId: ws.id })
    await personal.createUserSecret(alex, { name: 'ALEX_ONLY', kind: 'env', value: 'plain-config' }, { workspaceId: ws.id })

    const alexRun = await runtime.taskSecretInjection(ws.id, 'alexj11324/mikka', process.env, undefined, alex)
    assert.equal(alexRun.env.VERCEL_TOKEN, 'alex-value-1234', 'personal beats workspace')
    assert.equal(alexRun.env.REPO_ONLY, 'repo-value-1234')
    assert.equal(alexRun.env.ALEX_ONLY, 'plain-config')
    assert.deepEqual(alexRun.secretNames.sort(), ['REPO_ONLY', 'VERCEL_TOKEN'], 'only masked kinds are secret names')
    const linRun = await runtime.taskSecretInjection(ws.id, 'alexj11324/mikka', process.env, undefined, lin)
    assert.equal(linRun.env.VERCEL_TOKEN, 'team-value-1234', 'another member never gets it')
    assert.equal(linRun.env.ALEX_ONLY, undefined)
    const noOwner = await runtime.taskSecretInjection(ws.id, null)
    assert.equal(noOwner.env.VERCEL_TOKEN, 'team-value-1234')

    const masker = await runtime.secretMaskerFor({ workspaceId: ws.id, ownerId: alex })
    assert.ok(!masker('token alex-value-1234 and team-value-1234').includes('alex-value-1234'))
    assert.ok(!masker('team-value-1234').includes('team-value-1234'))
    assert.ok(masker('plain-config').includes('plain-config'), 'env kind stays readable')
    const masked = await runtime.maskFor({ workspaceId: ws.id, ownerId: alex }, { out: 'echo alex-value-1234' })
    assert.ok(!JSON.stringify(masked).includes('alex-value-1234'))
  })

  await t.test('bulk add for oneself: names and line errors back, never values; a workspace name is reported, not shadowed silently', async () => {
    const result = await personal.importUserSecrets(lin, { text: 'LIN_ONE=lin-value-0001 # 第一\nPATH=/x\nVERCEL_TOKEN=lin-shadow-1', masked: true, onConflict: 'skip' }, { workspaceId: ws.id })
    assert.deepEqual(result, { created: ['LIN_ONE'], replaced: [], kept: [], errors: [{ line: 2, name: 'PATH', reason: 'reserved' }, { line: 3, name: 'VERCEL_TOKEN', reason: 'shadowsWorkspace' }] })
    const confirmed = await personal.importUserSecrets(lin, { text: 'VERCEL_TOKEN=lin-shadow-1', masked: true, onConflict: 'skip', overrideWorkspace: true }, { workspaceId: ws.id })
    assert.deepEqual(confirmed.created, ['VERCEL_TOKEN'])
    assert.ok(!JSON.stringify([result, confirmed]).includes('lin-value-0001'))
  })

  await t.test('the shadow check needs membership of the workspace it reads', async () => {
    const other = await seedWorkspace(pool, alex, [{ userId: alex, role: 'admin' }])
    await rejects(personal.createUserSecret(lin, { name: 'ANY_NAME', kind: 'secret', value: 'value-1234' }, { workspaceId: other.id }), 'workspaceAccessDenied')
  })

  await t.test('a moved row fails to open; deleting the account deletes its secrets', async () => {
    const temp = await seedUser(pool, 'temp')
    const saved = await personal.createUserSecret(temp, { name: 'TEMP_KEY', kind: 'secret', value: 'temp-value-1234' }, {})
    await pool.query('update user_secrets set "userId"=$2 where id=$1', [saved.id, alex])
    await assert.rejects(runtime.taskSecretInjection(ws.id, null, process.env, undefined, alex))
    await pool.query('delete from user_secrets where id=$1', [saved.id])
    await personal.createUserSecret(temp, { name: 'TEMP_KEY', kind: 'secret', value: 'temp-value-1234' }, {})
    await pool.query('delete from "user" where id=$1', [temp])
    assert.equal((await pool.query('select count(*)::int as n from user_secrets where "userId"=$1', [temp])).rows[0].n, 0)
  })
})
