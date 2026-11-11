import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { scopeMigrationBeforeCommit } from '../scripts/scope-migration-history.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { disposableDatabase } from './helpers/e2e-target.mjs'
// Framework/session/background only; Task writers and ACL decisions stay real.
import './fixtures/activity-runtime.mjs'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Task ACL tests require isolated loopback *_e2e databases')
if (!url && process.env.REQUIRE_DB === '1') throw new Error('Task ACL tests cannot skip in required CI')

test('Task registration works with legacy and private SQL defaults; kind authority stays in WS', { skip: !url, timeout: 180_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString: url, max: 1 })
  const appName = `task_acl_app_${suffix}_e2e`, wsName = `task_acl_ws_${suffix}_e2e`
  const appUrl = new URL(url!), wsUrl = new URL(url!)
  appUrl.pathname = `/${appName}`; wsUrl.pathname = `/${wsName}`
  await admin.query(`CREATE DATABASE "${appName}" TEMPLATE template0`)
  await admin.query(`CREATE DATABASE "${wsName}" TEMPLATE template0`)
  const app = new Pool({ connectionString: appUrl.toString(), max: 4 })
  const ws = new Pool({ connectionString: wsUrl.toString(), max: 4 })
  const prior = { app: process.env.MIKKA_DATABASE_URL, ws: process.env.DATABASE_URL }
  process.env.MIKKA_DATABASE_URL = appUrl.toString(); process.env.DATABASE_URL = wsUrl.toString()
  let moduleApp: Pool | undefined, moduleWs: Pool | undefined
  try {
    const dir = new URL('../drizzle/', import.meta.url)
    const files = orderMigrations((await readdir(dir)).filter(name => name.endsWith('.sql')))
    for (const database of [app, ws]) await database.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
    const migrate = async (name: string) => {
      const source = await readFile(new URL(name, dir), 'utf8'), plan = planMigration(name, source)
      const client = await (plan.target === 'DATABASE_URL' ? ws : app).connect()
      try {
        const scope = scopeMigrationBeforeCommit(name, source)
        await applyMigration(client, name, scope === null ? plan : { ...plan, sql: scope })
        if (scope !== null) await client.query('COMMIT')
      } finally { client.release() }
    }
    const correction = await readFile(new URL('./fixtures/task-acl-private-default.sql', import.meta.url), 'utf8')
    const ownership = '20261109035000_task_workspace_ownership.sql'
    for (const file of files.filter(name => name < ownership)) await migrate(file)
    const owner = `owner-${suffix}`, peer = `peer-${suffix}`, nextOwner = `next-owner-${suffix}`
    for (const id of [owner, peer, nextOwner]) await app.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||'@example.invalid',true,now(),now())`, [id])
    const personal = randomUUID(), team = randomUUID(), nextPersonal = randomUUID(), nextTeam = randomUUID()
    for (const [id, actor, kind] of [[personal, owner, 'personal'], [team, owner, 'team'], [nextPersonal, nextOwner, 'personal'], [nextTeam, nextOwner, 'team']]) {
      await ws.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,$3,$4)', [id, actor, kind, kind])
      await ws.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'admin','active')`, [id, actor])
    }
    await ws.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [team, peer])
    await ws.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [nextTeam, peer])
    // Persist genuine pre-ownership evidence; no Team is invented in personal.
    const legacyPersonal = randomUUID(), legacyBot = randomUUID(), agent = randomUUID()
    await app.query(`INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,'codex','Legacy personal fixture')`, [agent, owner])
    await app.query(`INSERT INTO issues(id,"userId",scope,title,content,status,priority)
      VALUES($1,$2,'personal','Legacy personal task','{"type":"doc"}','todo','normal')`, [legacyPersonal, owner])
    await app.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,'Legacy personal evidence')`, [legacyBot, owner, personal])
    await app.query(`INSERT INTO agent_runs(id,"userId","agentId","issueId","botId",status)
      VALUES($1,$2,$3,$4,$5,'succeeded')`, [randomUUID(), owner, agent, legacyPersonal, legacyBot])
    for (const file of files.filter(name => name >= ownership)) await migrate(file)
    const insert = async (workspaceId: string | null, legacyScope = 'personal', creator = owner) => {
      const id = randomUUID()
      await app.query(`INSERT INTO issues(id,"userId","workspaceId",scope,title,content,status,priority)
        VALUES($1,$2,$3,$4,'Task','{"type":"doc","content":[{"type":"paragraph"}]}','todo','normal')`, [id, creator, workspaceId, legacyScope])
      return id
    }
    const historical = await insert(personal)
    assert.equal((await app.query(`SELECT visibility FROM resource_access_policies WHERE kind='task' AND id=$1`, [historical])).rows[0].visibility,
      'shared', 'the upgrade fixture reproduces the retired SQL personal default')
    for (const resourceId of [historical, legacyPersonal]) for (const kind of ['account', 'service']) await app.query(`INSERT INTO resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities)
      VALUES('task',$1,$2,$3,ARRAY['canReadContent'])`, [resourceId, kind, `${kind}-explicit`])
    const grants = (await app.query('SELECT * FROM resource_access_grants ORDER BY "subjectKind"')).rows
    const { db, pool } = await import('../lib/db')
    const { workspacePool, workspaceTransactionKey } = await import('../lib/workspace-db')
    moduleApp = pool; moduleWs = workspacePool
    const { withTaskWorkspace } = await import('../lib/task-workspace')
    const { createIssueForUserInTransaction } = await import('../lib/issue-create')
    const { registerTaskResourceAccess } = await import('../lib/task-resource-registration')
    const { withoutDatabaseClient } = await import('../lib/db/request-scope')
    const create = (workspaceId: string, creator = owner) => withTaskWorkspace(creator, workspaceId, () => db.transaction(tx => createIssueForUserInTransaction(tx, creator, {
      title: 'Real creation', content: { type: 'doc', content: [{ type: 'paragraph' }] }, status: 'todo', priority: 'normal',
    }, { actorType: 'user', actorId: creator }, { workspaceId })))
    const visibility = async (id: string) => (await app.query(`SELECT visibility FROM resource_access_policies WHERE kind='task' AND id=$1`, [id])).rows[0].visibility
    const verifyProduction = async (label: string, privateDefault: boolean, creationScope: { owner: string; personal: string; team: string }) => {
      const { owner, personal, team } = creationScope
      await t.test(label + ': production creation preserves Team sharing and personal privacy in split databases', async () => {
        const personalTask = await create(personal, owner), teamTask = await create(team, owner)
        assert.ok(personalTask && teamTask)
        assert.equal(await visibility(personalTask.id), 'private')
        assert.equal(await visibility(teamTask.id), 'shared')
        const revision = async (id: string) => (await app.query(`SELECT revision FROM resource_access_policies WHERE kind='task' AND id=$1`, [id])).rows[0].revision
        assert.equal(await revision(personalTask.id), privateDefault ? 1 : 2, 'already-private creation is a validated no-op')
        assert.equal(await revision(teamTask.id), privateDefault ? 2 : 1, 'already-shared Team creation is a validated no-op')
        const allowed = (await app.query(`SELECT mikka_resource_acl_allowed('account',$1,$2,'task',$3,'canReadContent') AS allowed`, [peer, team, teamTask.id])).rows[0].allowed
        assert.equal(allowed, true, 'ordinary Team collaborators retain the existing shared Task policy')
      })
      await t.test(label + ': the real incoming Linear writer registers Team sharing and keeps personal imports private', async () => {
        const { linearTeamSyncs } = await import('../lib/db/schema')
        const { createAppIssueFromLinear } = await import('../lib/linear-sync/issue-sync')
        for (const workspaceId of [personal, team]) {
          const [binding] = await db.insert(linearTeamSyncs).values({ id: randomUUID(), ownerId: owner, workspaceId, linearTeamId: randomUUID(), linearTeamKey: 'ACL', linearTeamName: 'ACL import' }).returning()
          const imported = await createAppIssueFromLinear(binding, {
            id: randomUUID(), identifier: 'ACL-1', title: 'Imported task', description: '', dueDate: null, priority: 0,
            url: 'https://example.invalid/linear', updatedAt: new Date().toISOString(), state: null,
            team: { id: binding.linearTeamId, key: binding.linearTeamKey, name: binding.linearTeamName }, assignee: null, labels: [],
          })
          assert.ok(imported)
          assert.equal(await visibility(imported.id), workspaceId === personal ? 'private' : 'shared')
        }
      })
      await t.test(label + ': actual child and duplicate actions preserve personal privacy and Team ancestry', async () => {
        const { actAs } = await import('../lib/acting-user')
        const { createLinkedIssue } = await import('../app/actions/issue-operations')
        const { tokenWorkspace } = await import('../lib/tokens/principal')
        for (const workspaceId of [personal, team]) {
          const source = await create(workspaceId, owner)
          assert.ok(source)
          const child = await actAs({ id: owner, [tokenWorkspace]: workspaceId }, () => createLinkedIssue({ id: source.id, revision: source.revision, kind: 'child', title: 'Child Task' }))
          assert.ok('issue' in child && child.issue, JSON.stringify({ workspaceId, child }))
          assert.equal(await visibility(child.issue.id), workspaceId === personal ? 'private' : 'shared')
          const parent = (await app.query(`SELECT "parentId" FROM resource_access_policies WHERE kind='task' AND id=$1`, [child.issue.id])).rows[0].parentId
          assert.equal(parent, source.id)
          const duplicate = await actAs({ id: owner, [tokenWorkspace]: workspaceId }, () => createLinkedIssue({ id: source.id, revision: source.revision, kind: 'duplicate' }))
          assert.ok('issue' in duplicate && duplicate.issue, JSON.stringify(duplicate))
          assert.equal(await visibility(duplicate.issue.id), 'private')
          await assert.rejects(withTaskWorkspace(owner, workspaceId, () => db.transaction(tx => registerTaskResourceAccess(tx, {
            id: duplicate.issue.id, ownerId: owner, workspaceId, workspaceKind: workspaceId === personal ? 'personal' : 'team',
          }))), { code: 'workspaceAccessDenied' })
          assert.equal(await visibility(duplicate.issue.id), 'private', 'later registration cannot publish a private copy')
        }
      })
      await t.test(label + ': historical rebind publishes a Team root only from locked Workspace evidence', async () => {
        const id = await insert(null, 'personal', owner), teamId = randomUUID()
        await ws.query(`INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,'ACL Team','ACL')`, [teamId, team, owner])
        await ws.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`, [id, teamId, team, owner])
        const { backfillTaskWorkspaces } = await import('../scripts/task-workspace-backfill.mjs')
        await backfillTaskWorkspaces(app, ws)
        assert.equal(await visibility(legacyPersonal), 'private', 'trusted personal legacy evidence cannot publish implicit sharing')
        assert.equal(await visibility(id), 'shared')
        assert.equal((await app.query('SELECT "workspaceId" FROM issues WHERE id=$1', [id])).rows[0].workspaceId, team)
        assert.deepEqual((await app.query('SELECT * FROM resource_access_grants ORDER BY "subjectKind"')).rows, grants)
      })
      await t.test(label + ': registration refuses missing, forged and expired Workspace authority', async () => {
        const created = await create(personal, owner)
        assert.ok(created)
        const id = created.id
        await assert.rejects(db.transaction(tx => registerTaskResourceAccess(tx, { id, ownerId: owner, workspaceId: personal, workspaceKind: 'team' })), { code: 'workspaceAccessDenied' })
        await assert.rejects(withTaskWorkspace(owner, personal, () => db.transaction(tx => registerTaskResourceAccess(tx, { id, ownerId: owner, workspaceId: personal, workspaceKind: 'team' }))), { code: 'workspaceAccessDenied' })
        let delayed: (() => Promise<unknown>) | undefined
        await withTaskWorkspace(owner, team, async () => { delayed = AsyncLocalStorage.bind(() => db.transaction(tx => registerTaskResourceAccess(tx, { id, ownerId: owner, workspaceId: team, workspaceKind: 'team' }))) })
        await assert.rejects(delayed!(), { code: 'workspaceAccessDenied' })
        await assert.rejects(withTaskWorkspace(owner, personal, () => db.transaction(tx => registerTaskResourceAccess(tx, {
          id, ownerId: owner, workspaceId: personal, workspaceKind: 'personal',
        }))), { code: 'workspaceAccessDenied' })
        assert.equal(await visibility(id), 'private')
      })
      await t.test(label + ': an independent APP boundary cannot borrow the parent kind proof; its own WS lease can register', async () => {
        const write = () => db.transaction(tx => createIssueForUserInTransaction(tx, owner, {
          title: 'Independent creation', content: { type: 'doc', content: [{ type: 'paragraph' }] }, status: 'todo', priority: 'normal',
        }, { actorType: 'user', actorId: owner }, { workspaceId: team }))
        await withTaskWorkspace(owner, team, async () => {
          const parent = workspaceTransactionKey()
          assert.ok(parent)
          await assert.rejects(withoutDatabaseClient(write), { code: 'workspaceAccessDenied' })
          const created = await withoutDatabaseClient(() => withTaskWorkspace(owner, team, () => {
            assert.notEqual(workspaceTransactionKey(), parent, 'independent work owns its Workspace transaction')
            return write()
          }))
          assert.ok(created)
          assert.equal(await visibility(created.id), 'shared')
        })
      })
      await t.test(label + ': the authoritative kind lock survives the complete APP registration transaction', async () => {
        const writer = await ws.connect()
        try {
          await withTaskWorkspace(owner, team, async workspace => {
            await writer.query('BEGIN')
            await writer.query("SET LOCAL lock_timeout='100ms'")
            await assert.rejects(writer.query('UPDATE mikka_workspaces SET name=name WHERE id=$1', [team]), { code: '55P03' })
            await writer.query('ROLLBACK')
            await db.transaction(async tx => { await tx.execute(sql`select 1`); assert.equal(workspace.kind, 'team') })
          })
        } finally { await writer.query('ROLLBACK'); writer.release() }
      })
    }
    await verifyProduction('legacy shared SQL default', false, { owner, personal, team })
    await app.query(correction)
    assert.deepEqual((await app.query('SELECT * FROM resource_access_grants ORDER BY "subjectKind"')).rows, grants, 'changing creation defaults never revokes explicit grants')
    assert.equal((await app.query("SELECT to_regclass('mikka_workspaces') AS ws")).rows[0].ws, null, 'APP has no Workspace mirror')
    await t.test('raw personal, forged scope and unregistered Team writes all default private', async () => {
      assert.equal(await visibility(await insert(personal, 'workspace')), 'private')
      assert.equal(await visibility(await insert(team, 'personal')), 'private')
    })
    await t.test('quarantined historical binding defaults private without kind evidence', async () => {
      for (const workspaceId of [personal, team]) {
        const id = await insert(null)
        assert.equal(await visibility(id), 'quarantined')
        await app.query('UPDATE issues SET "workspaceId"=$2 WHERE id=$1', [id, workspaceId])
        assert.equal(await visibility(id), 'private')
      }
    })
    await verifyProduction('private SQL default', true, { owner: nextOwner, personal: nextPersonal, team: nextTeam })
    await t.test('a later Team lease cannot republish an existing private root as new creation', async () => {
      const id = await insert(team)
      await assert.rejects(withTaskWorkspace(owner, team, () => db.transaction(tx => registerTaskResourceAccess(tx, {
        id, ownerId: owner, workspaceId: team, workspaceKind: 'team',
      }))), { code: 'workspaceAccessDenied' })
      assert.equal(await visibility(id), 'private')
    })
  } finally {
    await Promise.all([moduleApp?.end(), moduleWs?.end(), app.end(), ws.end()])
    if (prior.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = prior.app
    if (prior.ws === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prior.ws
    await dropTestDatabase(admin, appName); await dropTestDatabase(admin, wsName); await admin.end()
  }
})
