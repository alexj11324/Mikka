// 团队权限 › 允许使用的应用 (lib/app-policy/store.ts) against a real PostgreSQL.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedBot, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('workspace app policy', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { WorkspaceError } = await import('../lib/workspace-access')
  const store = await import('../lib/app-policy/store')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)

  const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
  const bot = await seedBot(pool, ws.id, member), otherBot = await seedBot(pool, other.id, admin)

  await t.test('defaults to 允许; members read without edit rights and cannot write', async () => {
    const view = await store.getAppPolicies(member, ws.id)
    assert.equal(view.canEdit, false)
    assert.deepEqual(view.apps.map(item => item.access), ['allow', 'allow', 'allow', 'allow'])
    await rejects(store.setAppPolicy({ id: member, name: 'Mia' }, ws.id, { app: 'slack', access: 'deny' }), 'workspaceAccessDenied')
    assert.equal(await store.botMayUseApp(bot, 'slack'), true)
  })

  await t.test('an admin blocks an app: that workspace’s bots are refused, others and the Coordinator are not; audited once', async () => {
    const view = await store.setAppPolicy({ id: admin, name: 'Alex' }, ws.id, { app: 'slack', access: 'deny' })
    assert.equal(view.apps.find(item => item.app === 'slack')?.access, 'deny')
    await store.setAppPolicy({ id: admin, name: 'Alex' }, ws.id, { app: 'slack', access: 'deny' })
    assert.equal(await store.botMayUseApp(bot, 'slack'), false)
    assert.equal(await store.botMayUseApp(bot, 'gmail'), true)
    assert.equal(await store.botMayUseApp(otherBot, 'slack'), true)
    assert.equal(await store.botMayUseApp(null, 'slack'), true)
    assert.equal(await store.botMayUseApp('00000000-0000-4000-8000-000000000000', 'slack'), false, 'an unknown bot is refused')
    const { rows } = await pool.query('select action, metadata from workspace_audit_events where "workspaceId"=$1', [ws.id])
    assert.deepEqual(rows, [{ action: 'integration.permission_changed', metadata: { integration: 'slack', capability: 'use', from: 'allow', to: 'deny' } }])
    await store.setAppPolicy({ id: admin, name: 'Alex' }, ws.id, { app: 'slack', access: 'allow' })
    assert.equal(await store.botMayUseApp(bot, 'slack'), true)
    await assert.rejects(store.setAppPolicy({ id: admin, name: 'Alex' }, ws.id, { app: 'github', access: 'deny' }))
  })

  await t.test('an admin switches members\' personal app connections off: that workspace only, audited, never in a personal workspace', async () => {
    const personal = await import('../lib/personal-policy-server')
    assert.deepEqual(await personal.getPersonalPolicy(member, ws.id), { subscriptions: true, apps: true, devices: true, canEdit: false }, 'on by default')
    await rejects(personal.setPersonalPolicy({ id: member, name: 'Mia' }, ws.id, { resource: 'apps', allowed: false }), 'workspaceAccessDenied')
    const view = await personal.setPersonalPolicy({ id: admin, name: 'Alex' }, ws.id, { resource: 'apps', allowed: false })
    assert.deepEqual(view, { subscriptions: true, apps: false, devices: true, canEdit: true })
    await personal.setPersonalPolicy({ id: admin, name: 'Alex' }, ws.id, { resource: 'apps', allowed: false })
    assert.equal(await store.botMayUseApp(bot, 'gmail'), false)
    assert.equal(await store.botMayUseApp(otherBot, 'gmail'), true)
    const { rows } = await pool.query(`select metadata from workspace_audit_events where "workspaceId"=$1 and metadata->>'integration'='personal_apps'`, [ws.id])
    assert.deepEqual(rows, [{ metadata: { integration: 'personal_apps', capability: 'use', from: 'allow', to: 'deny' } }], 'audited once')
    await personal.setPersonalPolicy({ id: admin, name: 'Alex' }, ws.id, { resource: 'apps', allowed: true })
    assert.equal(await store.botMayUseApp(bot, 'gmail'), true)
    await pool.query(`update mikka_workspaces set kind='personal' where id=$1`, [other.id])
    assert.equal((await personal.getPersonalPolicy(admin, other.id)).canEdit, false)
    await rejects(personal.setPersonalPolicy({ id: admin, name: 'Alex' }, other.id, { resource: 'apps', allowed: false }), 'validationGeneric')
  })
})
