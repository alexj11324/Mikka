import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { applyAuditRetention, configureAuditRetention, readAuditRetention } from './retention'
import { createAuditExport } from './export'

test('audit retention requires an explicit admin policy, honors hold/export leases and audits destructive work atomically', { skip: !dbUrl }, async t => {
  const main = new Pool({ connectionString: dbUrl, max: 5 }), workspace = new Pool({ connectionString: dbUrl, max: 5 }), database = { main, workspace }
  t.after(async () => { await Promise.all([main.end(), workspace.end()]) })
  const owner = await seedUser(main, 'retention-owner'), member = await seedUser(main, 'retention-member'), other = await seedUser(main, 'retention-other')
  const ws = await seedWorkspace(workspace, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }]), otherWs = await seedWorkspace(workspace, other, [{ userId: other, role: 'admin' }])
  const event = async (workspaceId: string, days: number) => (await main.query<{ id: string }>(`INSERT INTO workspace_audit_events("workspaceId","actorType","actorName",action,category,metadata,"createdAt") VALUES($1,'system','Mikka','token.revoked','security','{}',now()-($2::int*interval '1 day')) RETURNING id`, [workspaceId, days])).rows[0].id
  const old = await event(ws.id, 120), peer = await event(otherWs.id, 120)
  await t.test('default is retain and ordinary members/other tenants cannot set or inspect policy', async () => {
    assert.deepEqual(await readAuditRetention(owner, ws.id, database), { retentionDays: null, legalHold: false, revision: 0, updatedAt: null })
    assert.deepEqual(await applyAuditRetention(ws.id, new Date(), database), { deleted: 0, skipped: 'retain' })
    for (const user of [member, other]) {
      await assert.rejects(configureAuditRetention(user, ws.id, { retentionDays: 30, legalHold: false }, database), /workspaceAccessDenied/)
      await assert.rejects(readAuditRetention(user, ws.id, database), /workspaceAccessDenied/)
    }
  })
  await t.test('legal hold blocks configured expiry, and an audit failure rolls policy back', async () => {
    await configureAuditRetention(owner, ws.id, { retentionDays: 30, legalHold: true }, database)
    assert.deepEqual(await applyAuditRetention(ws.id, new Date(), database), { deleted: 0, skipped: 'legal_hold' })
    const constraint = `retention_change_fail_${randomUUID().replaceAll('-', '')}`
    await main.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${constraint} CHECK(action<>'audit.retention_changed') NOT VALID`)
    try { await assert.rejects(configureAuditRetention(owner, ws.id, { retentionDays: 1, legalHold: false }, database)) }
    finally { await main.query(`ALTER TABLE workspace_audit_events DROP CONSTRAINT ${constraint}`) }
    const policy = await readAuditRetention(owner, ws.id, database)
    assert.equal(policy.legalHold, true); assert.equal(policy.retentionDays, 30)
  })
  await t.test('explicit expiry deletes only this tenant and records its exact row count', async () => {
    await configureAuditRetention(owner, ws.id, { retentionDays: 30, legalHold: false }, database)
    assert.deepEqual(await applyAuditRetention(ws.id, new Date(), database), { deleted: 1, skipped: null })
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE id=$1', [old])).rows[0].n, 0)
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE id=$1', [peer])).rows[0].n, 1)
    assert.deepEqual((await main.query('SELECT metadata FROM workspace_audit_events WHERE "workspaceId"=$1 AND action=\'audit.retention_applied\'', [ws.id])).rows.map(row => row.metadata), [{ count: 1, retentionDays: 30 }])
  })
  await t.test('an active export keeps its referenced events available until the receipt expires', async () => {
    const id = await event(ws.id, 60), snapshot = await createAuditExport(owner, ws.id, 'all', new Date(), 100, database)
    assert.ok(snapshot.events.some(row => row.id === id))
    assert.deepEqual(await applyAuditRetention(ws.id, new Date(), database), { deleted: 0, skipped: 'active_export' })
    await workspace.query('UPDATE workspace_audit_exports SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [snapshot.manifest.id])
    assert.deepEqual(await applyAuditRetention(ws.id, new Date(), database), { deleted: 1, skipped: null })
  })
  await t.test('cleanup audit failure rolls event deletion back; NULL restores retention without deleting anything', async () => {
    const id = await event(ws.id, 100), constraint = `retention_apply_fail_${randomUUID().replaceAll('-', '')}`
    await main.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${constraint} CHECK(action<>'audit.retention_applied') NOT VALID`)
    try { await assert.rejects(applyAuditRetention(ws.id, new Date(), database)) }
    finally { await main.query(`ALTER TABLE workspace_audit_events DROP CONSTRAINT ${constraint}`) }
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE id=$1', [id])).rows[0].n, 1)
    await configureAuditRetention(owner, ws.id, { retentionDays: null, legalHold: false }, database)
    assert.deepEqual(await applyAuditRetention(ws.id, new Date(), database), { deleted: 0, skipped: 'retain' })
  })
})
