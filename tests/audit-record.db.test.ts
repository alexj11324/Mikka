// lib/audit/record.ts against a real PostgreSQL (CI: ephemeral mikka_e2e).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { dbUrl } from './support/workspace-admin-db'

test('workspace audit writer', { skip: !dbUrl }, async t => {
  const { pool, db } = await import('../lib/db')
  const { recordAudit, recordAuditSafe, auditFailureSummary, AuditEventError } = await import('../lib/audit/record')
  t.after(async () => { await pool.end() })
  const rows = (ws: string) => pool.query('select * from workspace_audit_events where "workspaceId"=$1 order by "createdAt", id', [ws]).then(r => r.rows)

  await t.test('stores snapshot names, derived category, ip and city', async () => {
    const ws = randomUUID()
    const saved = await recordAudit(db, { workspaceId: ws, actor: { type: 'user', id: 'u-alex', name: 'Alex' }, action: 'member.role_changed', target: { type: 'member', id: 'u-mia', label: 'Mia' }, metadata: { from: 'member', to: 'admin' }, ip: '203.0.113.4', geoCity: 'San Francisco' })
    assert.match(saved.id, /^[0-9a-f-]{36}$/)
    assert.ok(saved.createdAt instanceof Date)
    const [row] = await rows(ws)
    assert.equal(row.id, saved.id)
    assert.deepEqual([row.actorType, row.actorId, row.actorName, row.action, row.category, row.targetType, row.targetId, row.targetLabel, row.ip, row.geoCity], ['user', 'u-alex', 'Alex', 'member.role_changed', 'permission', 'member', 'u-mia', 'Mia', '203.0.113.4', 'San Francisco'])
    assert.deepEqual(row.metadata, { from: 'member', to: 'admin' })
  })

  await t.test('commits and rolls back with the business transaction', async () => {
    const ws = randomUUID()
    await assert.rejects(db.transaction(async tx => {
      await recordAudit(tx, { workspaceId: ws, actor: { type: 'user', id: 'u', name: 'A' }, action: 'token.created', target: { type: 'token', id: 't1', label: 'CLI · MacBook' } })
      throw new Error('business failed')
    }), /business failed/)
    assert.equal((await rows(ws)).length, 0)
    await db.transaction(tx => recordAudit(tx, { workspaceId: ws, actor: { type: 'system' }, action: 'token.revoked' }))
    const [row] = await rows(ws)
    assert.deepEqual([row.category, row.actorType, row.actorId, row.actorName], ['security', 'system', null, 'Mikka'])
  })

  await t.test('database constraints back up the writer', async () => {
    const ws = randomUUID()
    const insert = (sql: string) => pool.query(`insert into workspace_audit_events ("workspaceId","actorType","actorId","actorName",action,category,metadata) values ($1,${sql})`, [ws])
    await assert.rejects(insert(`'user','u','A','x.y','finance','{}'`), /check/i)
    await assert.rejects(insert(`'user',null,'A','x.y','security','{}'`), /check/i)
    await assert.rejects(insert(`'user','u','A','Bad Action','security','{}'`), /check/i)
    await assert.rejects(insert(`'user','u','A','x.y','security','[]'`), /check/i)
    assert.equal((await rows(ws)).length, 0)
  })

  await t.test('invalid events never reach the table; safe variant swallows and logs', async () => {
    const ws = randomUUID()
    await assert.rejects(recordAudit(db, { workspaceId: ws, actor: { type: 'user', id: 'u', name: 'A' }, action: 'secret.created', metadata: { value: 'hunter2' } }), AuditEventError)
    const logged: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => { logged.push(args) }
    try {
      assert.equal(await recordAuditSafe({ workspaceId: ws, actor: { type: 'user', id: 'u', name: 'A' }, action: 'secret.created', metadata: { value: 'hunter2' } }), null)
    } finally { console.error = original }
    assert.equal(logged.length, 1)
    assert.ok(!JSON.stringify(logged).includes('hunter2'), 'secret value must not be logged')
    assert.equal((await rows(ws)).length, 0)
    assert.ok(await recordAuditSafe({ workspaceId: ws, actor: { type: 'bot', id: 'b1', name: 'Reviewer' }, action: 'billing.limits_changed' }))
  })

  await t.test('failed writes never log query params (aborted tx and a DB-rejected row)', async () => {
    const ws = randomUUID()
    const marks = { label: 'LEAK-LABEL-7f3a', meta: 'LEAK-META-91c2', ip: '198.51.100.77', name: 'LEAK-ACTOR-55e1' }
    const leaky = { workspaceId: ws, actor: { type: 'user' as const, id: 'u', name: marks.name }, action: 'member.invited' as const, target: { type: 'member', id: 'm', label: marks.label }, metadata: { note: marks.meta }, ip: marks.ip }
    const leaks = (text: string) => Object.values(marks).filter(mark => text.includes(mark))
    // 1. A transaction already in aborted state: the driver error message carries the params.
    let captured: unknown
    await assert.rejects(db.transaction(async tx => {
      await tx.execute(sql`select 1/0`).catch(() => undefined)
      try { await recordAudit(tx, leaky) } catch (error) { captured = error }
      throw new Error('rollback')
    }))
    assert.ok(captured instanceof Error)
    assert.ok(leaks(String((captured as Error).message)).length > 0, 'precondition: drizzle message includes params')
    const summary = auditFailureSummary(captured)
    assert.equal(summary.code, '25P02')
    assert.deepEqual(leaks(JSON.stringify(summary)), [])
    // 2. recordAuditSafe on a DB-level rejection: the log has name/code/constraint only.
    const client = await pool.connect()
    const logged: unknown[][] = []
    const original = console.error
    try {
      await client.query(`alter table workspace_audit_events add constraint audit_test_reject check ("workspaceId" <> '${ws}') not valid`)
      console.error = (...args: unknown[]) => { logged.push(args) }
      assert.equal(await recordAuditSafe(leaky), null)
    } finally {
      console.error = original
      await client.query('alter table workspace_audit_events drop constraint if exists audit_test_reject')
      client.release()
    }
    assert.equal(logged.length, 1)
    assert.deepEqual(leaks(JSON.stringify(logged)), [])
    assert.deepEqual(logged[0][1], { action: 'member.invited', workspaceId: ws, name: 'DrizzleQueryError', code: '23514', constraint: 'audit_test_reject' })
    assert.equal((await rows(ws)).length, 0)
  })

  await t.test('category filter and keyset order use the indexes', async () => {
    const ws = randomUUID()
    for (const action of ['member.invited', 'token.created', 'secret.created', 'auth.signed_in'] as const)
      await recordAudit(db, { workspaceId: ws, actor: { type: 'user', id: 'u', name: 'A' }, action })
    const security = await pool.query(`select action from workspace_audit_events where "workspaceId"=$1 and category='security' order by "createdAt" desc, id desc`, [ws])
    assert.deepEqual(security.rows.map(r => r.action), ['auth.signed_in', 'token.created'])
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query('set local enable_seqscan = off')
      const plan = (await client.query(`explain select id from workspace_audit_events where "workspaceId"=$1 and category='security' order by "createdAt" desc, id desc limit 50`, [ws])).rows.map(r => r['QUERY PLAN']).join('\n')
      assert.match(plan, /workspace_audit_events_ws_category_created_idx/)
    } finally { await client.query('rollback'); client.release() }
  })
})
