import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { applyAuditRetention, configureAuditRetention, readAuditRetention, sweepAuditRetention } from './retention'
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
    await main.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${constraint} CHECK("workspaceId"<>'${ws.id}'::uuid OR action<>'audit.retention_changed') NOT VALID`)
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
    await main.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${constraint} CHECK("workspaceId"<>'${ws.id}'::uuid OR action<>'audit.retention_applied') NOT VALID`)
    try { await assert.rejects(applyAuditRetention(ws.id, new Date(), database)) }
    finally { await main.query(`ALTER TABLE workspace_audit_events DROP CONSTRAINT ${constraint}`) }
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE id=$1', [id])).rows[0].n, 1)
    await configureAuditRetention(owner, ws.id, { retentionDays: null, legalHold: false }, database)
    assert.deepEqual(await applyAuditRetention(ws.id, new Date(), database), { deleted: 0, skipped: 'retain' })
  })
  await t.test('a deleted workspace keeps its events 90 days, then the sweep removes them; a hold or a live workspace keeps them', async () => {
    const drop = async (workspaceId: string) => {
      await workspace.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspaceId])
      await workspace.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspaceId])
    }
    const seed = async () => seedWorkspace(workspace, other, [{ userId: other, role: 'admin' }])
    const count = async (id: string) => (await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE id=$1', [id])).rows[0].n
    const gone = await seed(), expired = await event(gone.id, 91), recent = await event(gone.id, 89)
    const swept = await seed(), sweptOld = await event(swept.id, 100)
    const held = await seed(), heldOld = await event(held.id, 100)
    const live = await seed(), liveOld = await event(live.id, 400)
    await configureAuditRetention(other, held.id, { retentionDays: null, legalHold: true }, database)
    for (const deleted of [gone, swept, held]) await drop(deleted.id)

    assert.deepEqual(await applyAuditRetention(gone.id, new Date(), database), { deleted: 1, skipped: null })
    assert.equal(await count(expired), 0, 'expired after 90 days')
    assert.equal(await count(recent), 1, 'unexpired kept')
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE "workspaceId"=$1 AND action=\'audit.retention_applied\'', [gone.id])).rows[0].n, 0, 'nothing new is logged into a deleted workspace')

    const result = await sweepAuditRetention(database)
    assert.equal(result.pending, 0)
    assert.equal(await count(sweptOld), 0, 'the sweep covers deleted workspaces with no setting')
    assert.equal(await count(heldOld), 1, 'a legal hold still holds')
    assert.equal(await count(liveOld), 1, 'a live workspace with no setting keeps its log')
    assert.equal(await count(recent), 1)
    // Once its last event has expired, its policy row goes too.
    await configureAuditRetention(other, live.id, { retentionDays: 30, legalHold: false }, database)
    await drop(live.id)
    // A retention the admin chose before deleting still applies; its own change event is the last to expire.
    assert.deepEqual(await applyAuditRetention(live.id, new Date(), database), { deleted: 1, skipped: null })
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_retention WHERE "workspaceId"=$1', [live.id])).rows[0].n, 1)
    assert.deepEqual(await applyAuditRetention(live.id, new Date(Date.now() + 31 * 86_400_000), database), { deleted: 1, skipped: null })
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_retention WHERE "workspaceId"=$1', [live.id])).rows[0].n, 0)
  })
})
