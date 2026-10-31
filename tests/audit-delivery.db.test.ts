import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { SQL, is, sql } from 'drizzle-orm'
import { PgDialect, PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import * as workspaceSchema from '../lib/db/workspace-schema'
import * as teamSchema from '../lib/db/team-schema'
import * as projectSchema from '../lib/db/project-schema'

const mainURL = process.env.E2E_DATABASE_URL
function isolated(value: string) {
  const target = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== '127.0.0.1' || !target.pathname.endsWith('_e2e') || target.search || target.hash) throw new Error('Audit delivery requires isolated loopback *_e2e targets')
  return target
}
if (mainURL && (process.env.MIKKA_DATABASE_URL !== mainURL || process.env.DATABASE_URL !== mainURL)) throw new Error('Audit delivery starts from the matching isolated E2E target')
if (mainURL) isolated(mainURL)
if (!mainURL && process.env.REQUIRE_DB === '1') throw new Error('Required audit delivery database cannot skip')
const exec = promisify(execFile)

// Mirrors the existing E2E setup's real Drizzle table definitions; no customer data or external services.
async function prepareWorkspace(database: Pool) {
  for (const name of ['0006_workspace_tables.sql', '0014_workspace_teams.sql', '20261029213938_workspace_admin_identity.sql']) await database.query(await readFile(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'))
  const dialect = new PgDialect(), ident = (name: string) => dialect.sqlToQuery(sql`${sql.identifier(name)}`).sql
  function defaultValue(value: unknown) {
    if (value instanceof SQL) return dialect.sqlToQuery(value).sql
    if (typeof value === 'boolean' || typeof value === 'number') return String(value)
    return `'${String(value).replaceAll("'", "''")}'`
  }
  for (const table of [...Object.values(workspaceSchema), ...Object.values(teamSchema), ...Object.values(projectSchema)]) {
    if (!is(table, PgTable) || table === workspaceSchema.workspaceAuditOutbox) continue
    const config = getTableConfig(table)
    const columns = config.columns.map(column => [ident(column.name), column.getSQLType(), column.notNull ? 'NOT NULL' : '', column.primary ? 'PRIMARY KEY' : '', column.isUnique ? 'UNIQUE' : '', column.default === undefined ? '' : `DEFAULT ${defaultValue(column.default)}`].filter(Boolean).join(' '))
    const keys = [...config.primaryKeys.map(key => `PRIMARY KEY (${key.columns.map(column => ident(column.name)).join(',')})`), ...config.uniqueConstraints.map(key => `UNIQUE (${key.columns.map(column => ident(column.name)).join(',')})`)]
    await database.query(`CREATE TABLE IF NOT EXISTS ${ident(config.name)} (${[...columns, ...keys].join(',')})`)
  }
  if (!(await database.query("SELECT to_regclass('workspace_audit_outbox') relation")).rows[0].relation) await database.query(await readFile(new URL('../drizzle/20261031052204_workspace_audit_outbox.sql', import.meta.url), 'utf8'))
}

test('workspace mutations retain and idempotently deliver audit intent across two logical PostgreSQL stores', { skip: !mainURL }, async t => {
  const main = new Pool({ connectionString: mainURL, max: 4 })
  const previousWorkspace = process.env.DATABASE_URL
  const allocated = !process.env.AUDIT_WORKSPACE_DATABASE_URL
  const target = new URL(mainURL!), databaseName = `audit_delivery_${randomUUID().replaceAll('-', '')}_e2e`
  if (allocated) { await main.query(`CREATE DATABASE "${databaseName}"`); target.pathname = `/${databaseName}` }
  const workspaceURL = process.env.AUDIT_WORKSPACE_DATABASE_URL ?? target.href
  isolated(workspaceURL)
  assert.notEqual(new URL(workspaceURL).pathname, new URL(mainURL!).pathname)
  process.env.DATABASE_URL = workspaceURL
  const workspace = new Pool({ connectionString: workspaceURL, max: 4 }), targets = { main, workspace }
  const actor = { id: `audit-owner-${randomUUID()}`, name: 'Audit Owner', email: 'owner@example.invalid' }
  let user = actor
  const translate = Object.assign((key: string) => key, { has: () => true })
  mock.module('@/lib/issue-access', { namedExports: { requireUser: async () => user } })
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ set() {}, delete() {} }) } })
  mock.module('next-intl/server', { namedExports: { getTranslations: async () => translate, getLocale: async () => 'en' } })
  await prepareWorkspace(workspace)
  const [{ deliverWorkspaceAudits, enqueueWorkspaceAudit }, actions, general, members, { workspaceDb, workspacePool }, { pool }] = await Promise.all([
    import('../lib/audit/delivery'), import('../app/actions/workspace'), import('../lib/workspace-admin/general'), import('../lib/workspace-admin/members'), import('../lib/workspace-db'), import('../lib/db'),
  ])
  t.after(async () => {
    process.env.DATABASE_URL = previousWorkspace
    await Promise.all([workspace.end(), workspacePool.end(), pool.end()])
    if (allocated) await main.query(`DROP DATABASE "${databaseName}"`)
    await main.end()
  })
  const seed = async () => {
    const id = randomUUID(), peer = `audit-peer-${randomUUID()}`, slug = `audit-${id.slice(0, 8)}`
    await workspace.query('INSERT INTO mikka_workspaces(id,"userId",name,slug) VALUES($1,$2,\'Audit Workspace\',$3)', [id, actor.id, slug])
    await workspace.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,\'Audit Owner\',\'owner@example.invalid\',\'admin\'),($1,$3,\'Audit Peer\',\'peer@example.invalid\',\'member\')', [id, actor.id, peer])
    return { id, peer, slug }
  }
  const pending = (id: string) => workspace.query('SELECT * FROM workspace_audit_outbox WHERE "workspaceId"=$1 AND "deliveredAt" IS NULL ORDER BY "createdAt",id', [id]).then(result => result.rows)
  const restart = async () => {
    const child = await exec(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', 'tests/fixtures/audit-delivery-process.mts'], { cwd: process.cwd(), env: { ...process.env, MIKKA_DATABASE_URL: mainURL!, DATABASE_URL: workspaceURL }, timeout: 30_000 })
    return JSON.parse(child.stdout) as { delivered: number; failed: number }
  }
  await t.test('main failure cannot lose a committed role change; a real new process delivers its original ID once', async () => {
    const ws = await seed(), constraint = `audit_delivery_fail_${randomUUID().replaceAll('-', '')}`
    assert.notEqual((await main.query('SELECT current_database() name')).rows[0].name, (await workspace.query('SELECT current_database() name')).rows[0].name)
    await main.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${constraint} CHECK("workspaceId"<>'${ws.id}'::uuid) NOT VALID`)
    let receiptId: string
    try {
      assert.equal((await actions.updateWorkspaceMember({ workspaceId: ws.id, userId: ws.peer, role: 'admin', status: 'active' })).ok, true)
      assert.equal((await workspace.query('SELECT role FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [ws.id, ws.peer])).rows[0].role, 'admin')
      const receipts = await pending(ws.id); assert.equal(receipts.length, 1); receiptId = receipts[0].id
      assert.deepEqual(receipts[0].payload.metadata, { oldRole: 'member', newRole: 'admin' })
      assert.equal((await deliverWorkspaceAudits(targets)).failed, 1)
      assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE id=$1', [receiptId])).rows[0].n, 0)
      assert.equal((await pending(ws.id)).length, 1)
    } finally { await main.query(`ALTER TABLE workspace_audit_events DROP CONSTRAINT ${constraint}`) }
    assert.equal((await restart()).failed, 0)
    const delivered = (await main.query('SELECT * FROM workspace_audit_events WHERE id=$1', [receiptId!])).rows
    assert.equal(delivered.length, 1); assert.equal(delivered[0].actorId, actor.id); assert.equal(delivered[0].targetId, ws.peer)
    const receipt = (await workspace.query('SELECT payload,"deliveredAt" FROM workspace_audit_outbox WHERE id=$1', [receiptId!])).rows[0]
    assert.equal(receipt.payload, null); assert.ok(receipt.deliveredAt)
    await restart()
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE id=$1', [receiptId!])).rows[0].n, 1)
  })
  await t.test('failure to persist audit intent rolls workspace changes back; invalid metadata never enters the queue', async () => {
    const ws = await seed(), name = `audit_enqueue_fail_${randomUUID().replaceAll('-', '')}`
    await workspace.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."workspaceId"='${ws.id}'::uuid THEN RAISE EXCEPTION 'fixture_audit_enqueue_failed'; END IF; RETURN NEW; END $$`)
    await workspace.query(`CREATE TRIGGER ${name} BEFORE INSERT ON workspace_audit_outbox FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try {
      assert.equal((await actions.updateWorkspaceMember({ workspaceId: ws.id, userId: ws.peer, role: 'admin', status: 'active' })).ok, false)
      assert.equal((await workspace.query('SELECT role FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [ws.id, ws.peer])).rows[0].role, 'member')
      assert.equal((await actions.createWorkspaceInvitation({ workspaceId: ws.id, emails: ['new@example.invalid'], role: 'member' })).ok, false)
      assert.equal((await workspace.query('SELECT count(*)::int n FROM mikka_workspace_invitations WHERE "workspaceId"=$1', [ws.id])).rows[0].n, 0)
    } finally { await workspace.query(`DROP TRIGGER ${name} ON workspace_audit_outbox`); await workspace.query(`DROP FUNCTION ${name}()`) }
    await assert.rejects(workspaceDb.transaction(tx => enqueueWorkspaceAudit(tx, { workspaceId: ws.id, actor: { type: 'system' }, action: 'secret.created', metadata: { value: 'must-not-persist' } })))
    assert.equal((await pending(ws.id)).length, 0)
  })
  await t.test('a committed main insert followed by lost source acknowledgment replays without duplicate or overwritten events', async () => {
    const ws = await seed(), request = { ip: '2001:0db8:0:0:0:0:0:1', geoCity: 'Fixture', geoCountry: 'ZZ', geoRegion: 'Fixture' }
    await general.updateWorkspaceGeneral(actor.id, ws.id, { slug: `changed-${ws.id.slice(0, 8)}` }, request)
    const [receipt] = await pending(ws.id), name = `audit_ack_fail_${randomUUID().replaceAll('-', '')}`
    await workspace.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${receipt.id}'::uuid AND NEW."deliveredAt" IS NOT NULL THEN RAISE EXCEPTION 'fixture_ack_failed'; END IF; RETURN NEW; END $$`)
    await workspace.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON workspace_audit_outbox FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try {
      await assert.rejects(deliverWorkspaceAudits(targets), /fixture_ack_failed/)
      assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE id=$1', [receipt.id])).rows[0].n, 1)
      assert.equal((await pending(ws.id)).length, 1)
    } finally { await workspace.query(`DROP TRIGGER ${name} ON workspace_audit_outbox`); await workspace.query(`DROP FUNCTION ${name}()`) }
    assert.equal((await restart()).failed, 0)
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE id=$1', [receipt.id])).rows[0].n, 1)
    assert.equal((await main.query('SELECT host(ip) ip FROM workspace_audit_events WHERE id=$1', [receipt.id])).rows[0].ip, '2001:db8::1')
  })
  await t.test('readback mismatch is not acknowledged or overwritten, and authorization still fences other tenants', async () => {
    const ws = await seed()
    await general.updateWorkspaceGeneral(actor.id, ws.id, { slug: `mismatch-${ws.id.slice(0, 8)}` })
    const [receipt] = await pending(ws.id)
    await main.query('INSERT INTO workspace_audit_events(id,"workspaceId","actorType","actorName",action,category,metadata,"createdAt") VALUES($1,$2,\'system\',\'Mikka\',\'token.revoked\',\'security\',\'{}\',$3)', [receipt.id, ws.id, receipt.createdAt])
    assert.equal((await deliverWorkspaceAudits(targets)).failed, 1)
    assert.equal((await pending(ws.id)).length, 1)
    assert.equal((await main.query('SELECT action FROM workspace_audit_events WHERE id=$1', [receipt.id])).rows[0].action, 'token.revoked')
    await main.query('DELETE FROM workspace_audit_events WHERE id=$1', [receipt.id]); await restart()
    user = { ...actor, id: ws.peer }
    try { assert.equal((await actions.updateWorkspaceMember({ workspaceId: ws.id, userId: actor.id, role: 'member', status: 'active' })).ok, false) }
    finally { user = actor }
    assert.equal((await pending(ws.id)).length, 0)
  })
  await t.test('invitation, promotion, ownership and removal snapshots are atomic and exclude invitation bearer material', async () => {
    const ws = await seed()
    const invitation = await actions.createWorkspaceInvitation({ workspaceId: ws.id, emails: ['invited@example.invalid'], role: 'member' })
    assert.equal(invitation.ok, true)
    if (!invitation.ok) throw new Error('Invitation unexpectedly failed')
    const token = invitation.data[0].path.split('/').at(-1)!
    assert.equal(JSON.stringify((await pending(ws.id)).map(row => row.payload)).includes(token), false)
    await general.transferWorkspaceOwnership(actor.id, ws.id, ws.peer)
    await members.removeMember(actor.id, ws.id, ws.peer)
    const actionsRecorded = (await pending(ws.id)).map(row => row.payload.action).sort()
    assert.deepEqual(actionsRecorded, ['member.invited', 'member.removed', 'member.role_changed', 'workspace.ownership_transferred'].sort())
    await workspace.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [ws.id]); await workspace.query('DELETE FROM mikka_workspaces WHERE id=$1', [ws.id])
    assert.equal((await restart()).failed, 0)
    assert.equal((await main.query('SELECT count(*)::int n FROM workspace_audit_events WHERE "workspaceId"=$1', [ws.id])).rows[0].n, 4, 'subject removal cannot cascade away undelivered audit intent')
  })
})
