// 审计日志 read API (lib/audit/query.ts) against a real PostgreSQL.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('workspace audit read API', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { db, pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { WorkspaceError } = await import('../lib/workspace-access')
  const { recordAudit } = await import('../lib/audit/record')
  const query = await import('../lib/audit/query')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)

  const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
  const actor = { type: 'user' as const, id: admin, name: 'Alex' }
  for (let i = 0; i < 5; i++) await recordAudit(db, { workspaceId: ws.id, actor, action: 'secret.created', target: { type: 'secret', id: `s${i}`, label: `KEY_${i}` }, metadata: { scope: 'workspace' } })
  await recordAudit(db, { workspaceId: ws.id, actor: { type: 'token', id: 't1', name: 'CI 脚本' }, action: 'token.created', target: { type: 'token', id: 't1', label: 'CI 脚本' }, ip: '198.51.100.23', geoCity: 'Ashburn' })
  await recordAudit(db, { workspaceId: other.id, actor, action: 'token.revoked' })
  // Same timestamp for two rows: paging must neither skip nor repeat them.
  await pool.query(`update workspace_audit_events set "createdAt" = '2026-10-29T10:00:00.123456Z' where "workspaceId"=$1 and "targetLabel" in ('KEY_1','KEY_2')`, [ws.id])
  await pool.query(`update workspace_audit_events set "createdAt" = now() - interval '91 days' where "workspaceId"=$1 and "targetLabel"='KEY_0'`, [ws.id])

  await t.test('admins page through the window newest first without gaps; members are refused', async () => {
    const now = new Date('2026-10-30T12:00:00Z')
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: Awaited<ReturnType<typeof query.listWorkspaceAudit>> = await query.listWorkspaceAudit(admin, ws.id, { cursor, limit: 2 }, now)
      seen.push(...page.events.map(event => event.targetLabel ?? ''))
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(seen.length, new Set(seen).size, 'no repeats')
    assert.deepEqual([...seen].sort(), ['CI 脚本', 'KEY_1', 'KEY_2', 'KEY_3', 'KEY_4'], 'the 91-day-old row and the other workspace stay out')
    await rejects(query.listWorkspaceAudit(member, ws.id, {}, now), 'workspaceAccessDenied')
    await rejects(query.listWorkspaceAudit(admin, ws.id, { cursor: 'not-a-cursor' }, now), 'validationGeneric')
  })

  await t.test('安全 filter, ip and city for admins, CSV export rows', async () => {
    const security = await query.listWorkspaceAudit(admin, ws.id, { filter: 'security' })
    assert.deepEqual(security.events.map(event => [event.action, event.actorType, event.ip, event.geoCity]), [['token.created', 'token', '198.51.100.23', 'Ashburn']])
    const all = await query.exportWorkspaceAudit(admin, ws.id, 'all')
    assert.equal(all.length, 5)
  })
})
