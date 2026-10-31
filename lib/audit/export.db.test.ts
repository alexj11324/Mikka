import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { AuditExportError, createAuditExport, readAuditExportPage } from './export'
import { verifyAuditExport } from './integrity'

test('audit snapshots are complete, resumable, tenant-bound and detect changed/missing/reordered data', { skip: !dbUrl }, async t => {
  const main = new Pool({ connectionString: dbUrl, max: 4 }), workspace = new Pool({ connectionString: dbUrl, max: 4 })
  const targets = { main, workspace }
  t.after(async () => { await Promise.all([main.end(), workspace.end()]) })
  const admin = await seedUser(main, 'audit-owner'), member = await seedUser(main, 'audit-member'), outsider = await seedUser(main, 'audit-other')
  const ws = await seedWorkspace(main, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(main, outsider, [{ userId: outsider, role: 'admin' }])
  await main.query(`INSERT INTO workspace_audit_events("workspaceId","actorType","actorId","actorName",action,category,"targetId",metadata,"createdAt")
    SELECT $1,'user',$2,'Owner','token.revoked','security',gen_random_uuid()::text,'{}',now()-interval '1 second' FROM generate_series(1,120)`, [ws.id, admin])
  await main.query(`INSERT INTO workspace_audit_events("workspaceId","actorType","actorId","actorName",action,category,metadata) VALUES($1,'user',$2,'Other','token.revoked','security','{}')`, [other.id, outsider])
  await t.test('an export that exceeds its bound fails without returning a silently truncated file', async () => {
    await assert.rejects(createAuditExport(admin, ws.id, 'all', new Date(), 100, targets), (error: unknown) => error instanceof AuditExportError && error.status === 413)
    assert.equal((await workspace.query('SELECT count(*)::int n FROM workspace_audit_exports WHERE "workspaceId"=$1', [ws.id])).rows[0].n, 0)
  })
  const bundle = await createAuditExport(admin, ws.id, 'all', new Date(), 200, targets)
  await t.test('separate database clients persist the anchor and audit the export itself', async () => {
    assert.equal(bundle.manifest.count, 120)
    assert.equal(verifyAuditExport(bundle.manifest, bundle.events), true)
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE "workspaceId"=$1 AND action=\'audit.exported\'', [ws.id])).rows[0].n, 1)
    assert.equal((await workspace.query('SELECT count(*)::int n FROM workspace_audit_exports WHERE id=$1', [bundle.manifest.id])).rows[0].n, 1)
  })
  await t.test('new events cannot move an existing export page or introduce gaps', async () => {
    await main.query(`INSERT INTO workspace_audit_events("workspaceId","actorType","actorId","actorName",action,category,metadata) VALUES($1,'user',$2,'Owner','token.revoked','security','{}')`, [ws.id, admin])
    const collected: typeof bundle.events = []
    let offset: number | null = 0
    do {
      const page = await readAuditExportPage(admin, ws.id, bundle.manifest.id, offset, 17, new Date(), targets)
      collected.push(...page.events); offset = page.nextOffset
    } while (offset !== null)
    assert.deepEqual(collected, bundle.events)
    assert.equal(new Set(collected.map(row => row.id)).size, 120)
    assert.equal(verifyAuditExport(bundle.manifest, collected), true)
    assert.equal(verifyAuditExport(bundle.manifest, [...collected].reverse()), false)
    assert.equal(verifyAuditExport(bundle.manifest, collected.slice(1)), false)
  })
  await t.test('members, other tenants, expired exports and revoked admins cannot resume', async () => {
    await assert.rejects(readAuditExportPage(member, ws.id, bundle.manifest.id, 0, 10, new Date(), targets), /workspaceAccessDenied/)
    await assert.rejects(readAuditExportPage(outsider, ws.id, bundle.manifest.id, 0, 10, new Date(), targets), /workspaceAccessDenied/)
    await assert.rejects(readAuditExportPage(outsider, other.id, bundle.manifest.id, 0, 10, new Date(), targets), /auditExportUnavailable/)
    await assert.rejects(readAuditExportPage(admin, ws.id, bundle.manifest.id, 0, 10, new Date(Date.now() + 16 * 60_000), targets), /auditExportUnavailable/)
    await workspace.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [ws.id, admin])
    await assert.rejects(readAuditExportPage(admin, ws.id, bundle.manifest.id, 0, 10, new Date(), targets), /workspaceAccessDenied/)
    await workspace.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [ws.id, admin])
  })
  await t.test('row alteration, removal and anchor reordering cannot be returned as a valid page', async () => {
    const id = bundle.events[0].id
    await main.query('UPDATE workspace_audit_events SET "targetLabel"=$2 WHERE id=$1', [id, 'Changed'])
    await assert.rejects(readAuditExportPage(admin, ws.id, bundle.manifest.id, 0, 10, new Date(), targets), /auditExportChanged/)
    await main.query('UPDATE workspace_audit_events SET "targetLabel"=NULL WHERE id=$1', [id])
    await main.query('DELETE FROM workspace_audit_events WHERE id=$1', [id])
    await assert.rejects(readAuditExportPage(admin, ws.id, bundle.manifest.id, 0, 10, new Date(), targets), /auditExportChanged/)
    await workspace.query('UPDATE workspace_audit_exports SET records=(SELECT jsonb_agg(value ORDER BY ordinality DESC) FROM jsonb_array_elements(records) WITH ORDINALITY) WHERE id=$1', [bundle.manifest.id])
    await assert.rejects(readAuditExportPage(admin, ws.id, bundle.manifest.id, 0, 10, new Date(), targets), /auditExportChanged/)
  })
  await t.test('audit failure prevents an unrecorded export from becoming available', async () => {
    const receiptCount = Number((await workspace.query('SELECT count(*) FROM workspace_audit_exports WHERE "workspaceId"=$1', [ws.id])).rows[0].count)
    const constraint = `audit_export_fail_${randomUUID().replaceAll('-', '')}`
    await main.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${constraint} CHECK ("workspaceId"<>'${ws.id}'::uuid OR action<>'audit.exported') NOT VALID`)
    try { await assert.rejects(createAuditExport(admin, ws.id, 'all', new Date(), 200, targets)) }
    finally { await main.query(`ALTER TABLE workspace_audit_events DROP CONSTRAINT ${constraint}`) }
    assert.equal(Number((await workspace.query('SELECT count(*) FROM workspace_audit_exports WHERE "workspaceId"=$1', [ws.id])).rows[0].count), receiptCount)
  })
})
