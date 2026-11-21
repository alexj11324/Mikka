import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { applyAuditRetention, configureAuditRetention, readAuditRetention, sweepAuditRetention } from './retention'
import { createAuditExport } from './export'

test('failed main checkout returns the workspace connection for each audit operation', { skip: !dbUrl }, async t => {
  const main = new Pool({ connectionString: dbUrl }), workspace = new Pool({ connectionString: dbUrl, max: 1 })
  const database = { main, workspace }
  // The ended pool reports a real pg checkout error before any transaction begins.
  await main.end()
  const checkedOut = new Set<PoolClient>()
  workspace.on('acquire', client => checkedOut.add(client))
  workspace.on('release', (_error, client) => checkedOut.delete(client))
  t.after(async () => {
    for (const client of checkedOut) client.release()
    await workspace.end()
  })
  const now = new Date()
  const operations = [
    () => createAuditExport('admin', 'workspace', 'all', now, 10, database),
    () => configureAuditRetention('admin', 'workspace', { retentionDays: 30, legalHold: true }, database),
    () => applyAuditRetention('workspace', now, database),
  ]
  for (const operation of operations) {
    await assert.rejects(operation, /Cannot use a pool after calling end/)
    assert.equal(workspace.idleCount, 1)
  }
})

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
  await t.test('a deleted workspace keeps every event until 90 days after its deletion, then the job removes them', async () => {
    const day = 86_400_000, deletedAt = new Date(Date.now() - 200 * day), at = (days: number) => new Date(deletedAt.getTime() + days * day)
    const deletedEvent = async (workspaceId: string, daysBeforeDeletion: number) => (await main.query<{ id: string }>(`INSERT INTO workspace_audit_events("workspaceId","actorType","actorName",action,category,metadata,"createdAt") VALUES($1,'system','Mikka','token.revoked','security','{}',$2) RETURNING id`, [workspaceId, at(-daysBeforeDeletion)])).rows[0].id
    const markDeleted = async (workspaceId: string, policy?: { retentionDays: number | null; legalHold: boolean }) => {
      if (policy) await main.query(`INSERT INTO workspace_audit_retention("workspaceId","retentionDays","legalHold","configuredBy") VALUES($1,$2,$3,'fixture-admin')`, [workspaceId, policy.retentionDays, policy.legalHold])
      await main.query('INSERT INTO workspace_deletions(id,"deletedAt") VALUES($1,$2)', [workspaceId, deletedAt])
    }
    const deletionRecord = async (workspaceId: string) => (await main.query('SELECT 1 FROM workspace_deletions WHERE id=$1', [workspaceId])).rowCount === 1
    const exists = async (id: string) => (await main.query('SELECT 1 FROM workspace_audit_events WHERE id=$1', [id])).rowCount === 1
    const policyRow = async (workspaceId: string) => (await main.query('SELECT 1 FROM workspace_audit_retention WHERE "workspaceId"=$1', [workspaceId])).rowCount === 1

    // No retention of its own: an event a year older than the deletion is still there at +89 days, gone at +91.
    const gone = randomUUID(), ancient = await deletedEvent(gone, 365), last = await deletedEvent(gone, 0)
    await markDeleted(gone)
    assert.deepEqual(await applyAuditRetention(gone, at(89), database), { deleted: 0, skipped: 'deleted_workspace_grace' })
    assert.ok(await exists(ancient)); assert.ok(await exists(last))
    assert.deepEqual(await applyAuditRetention(gone, at(91), database), { deleted: 2, skipped: null })
    assert.ok(!(await exists(ancient))); assert.ok(!(await exists(last)))
    assert.ok(!(await deletionRecord(gone)), 'the deletion record goes with the last event')
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE "workspaceId"=$1', [gone])).rows[0].n, 0, 'nothing is logged into a deleted workspace')

    // A retention chosen before deletion keeps an event longer when it says so; a legal hold keeps everything.
    const kept = randomUUID(), pastRule = await deletedEvent(kept, 300), withinRule = await deletedEvent(kept, 10)
    await markDeleted(kept, { retentionDays: 200, legalHold: false })
    assert.deepEqual(await applyAuditRetention(kept, at(91), database), { deleted: 1, skipped: null })
    assert.ok(!(await exists(pastRule))); assert.ok(await exists(withinRule)); assert.ok(await policyRow(kept)); assert.ok(await deletionRecord(kept))
    const held = randomUUID(), heldEvent = await deletedEvent(held, 365)
    await markDeleted(held, { retentionDays: null, legalHold: true })
    assert.deepEqual(await applyAuditRetention(held, at(400), database), { deleted: 0, skipped: 'legal_hold' })
    assert.ok(await exists(heldEvent))

    // The job reaches deleted workspaces (past their 90 days now); a live workspace with no policy is untouched, as before.
    const swept = randomUUID(), sweptEvent = await deletedEvent(swept, 30)
    await markDeleted(swept)
    const live = await seedWorkspace(workspace, other, [{ userId: other, role: 'admin' }]), liveEvent = await event(live.id, 400)
    const result = await sweepAuditRetention(database)
    assert.equal(result.pending, 0)
    assert.ok(!(await exists(sweptEvent)))
    assert.ok(await exists(liveEvent))
    assert.deepEqual(await applyAuditRetention(live.id, new Date(), database), { deleted: 0, skipped: 'retain' })
  })
})
