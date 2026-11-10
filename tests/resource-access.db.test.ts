import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { scopeMigrationBeforeCommit } from '../scripts/scope-migration-history.mjs'
import { backfillProjectResourceAccess } from '../scripts/resource-acl-backfill.mjs'
import { OWNER_RESOURCE_ACTIONS, RESOURCE_ACTIONS, SHARED_RESOURCE_ACTIONS } from '../lib/resource-access/contract'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Resource ACL tests require isolated loopback *_e2e databases')
if (!url && process.env.REQUIRE_DB === '1') throw new Error('Resource ACL tests cannot skip in required CI')

test('resource ACL: real split PostgreSQL migrations, fresh grants and concurrent revocation', { skip: !url, timeout: 240_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '')
  const appName = `acl_app_${suffix}_e2e`, wsName = `acl_ws_${suffix}_e2e`
  const admin = new Pool({ connectionString: url, max: 1 })
  const appUrl = new URL(url!), wsUrl = new URL(url!)
  appUrl.pathname = `/${appName}`; wsUrl.pathname = `/${wsName}`
  await admin.query(`create database "${appName}" template template0`)
  await admin.query(`create database "${wsName}" template template0`)
  const app = new Pool({ connectionString: appUrl.toString(), max: 6 })
  const ws = new Pool({ connectionString: wsUrl.toString(), max: 5 })
  const previous = { app: process.env.MIKKA_DATABASE_URL, ws: process.env.DATABASE_URL }
  process.env.MIKKA_DATABASE_URL = appUrl.toString(); process.env.DATABASE_URL = wsUrl.toString()
  let moduleApp: Pool | undefined, moduleWs: Pool | undefined
  try {
    const directory = new URL('../drizzle/', import.meta.url), boundary = '20261110150005_resource_acl.sql'
    const files = orderMigrations((await readdir(directory)).filter(file => file.endsWith('.sql')))
    for (const pool of [app, ws]) await pool.query('create table schema_migrations(name text primary key,"appliedAt" timestamptz not null default now())')
    const migrate = async (names: string[]) => {
      for (const name of names) {
        const source = await readFile(new URL(name, directory), 'utf8'), plan = planMigration(name, source)
        const client = await (plan.target === 'DATABASE_URL' ? ws : app).connect()
        try {
          const scope = scopeMigrationBeforeCommit(name, source)
          await applyMigration(client, name, scope === null ? plan : { ...plan, sql: scope })
          if (scope !== null) await client.query('commit')
        } finally { client.release() }
      }
    }
    await migrate(files.filter(file => file < boundary))
    const owner = `owner-${suffix}`, member = `member-${suffix}`, manager = `admin-${suffix}`, stranger = `outsider-${suffix}`
    const alpha = randomUUID(), beta = randomUUID(), personal = randomUUID(), team = randomUUID()
    const task = randomUUID(), run = randomUUID(), bot = randomUUID(), agent = randomUUID(), artifact = randomUUID(), project = randomUUID(), pending = randomUUID()
    for (const id of [owner, member, manager, stranger]) await app.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$1||\'@acl.example.invalid\',true,now(),now())', [id])
    for (const [id, kind] of [[alpha, 'team'], [beta, 'team'], [personal, 'personal']]) {
      await ws.query('insert into mikka_workspaces(id,"userId",name,kind) values($1,$2,\'ACL fixture\',$3)', [id, owner, kind])
      await ws.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role,status) values($1,$2,$2,$2,\'admin\',\'active\')', [id, owner])
    }
    for (const [id, role] of [[member, 'member'], [manager, 'admin']]) await ws.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role,status) values($1,$2,$2,$2,$3,\'active\')', [alpha, id, role])
    // Org membership is separate and never grants the outsider a Workspace.
    for (const tenant of [alpha, beta]) {
      const organization = randomUUID()
      await ws.query('insert into mikka_organizations(id,name,"createdBy") values($1,\'ACL Org\',$2)', [organization, owner])
      await ws.query('insert into mikka_organization_workspaces("workspaceId","organizationId") values($1,$2)', [tenant, organization])
      for (const id of [owner, member, manager, stranger]) await ws.query('insert into mikka_organization_members("organizationId","userId",role,status,name,email) values($1,$2,\'admin\',\'active\',$2,$2)', [organization, id])
    }
    await ws.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,\'ACL group\',\'ACL\')', [team, alpha, owner])
    await app.query('insert into issues(id,"userId","workspaceId",title,content,status,priority) values($1,$2,$3,\'Shared task\',\'{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"existing private payload must not migrate"}]}]}\',\'todo\',\'normal\')', [task, owner, alpha])
    await app.query('insert into issues(id,"userId",title,content,status,priority) values($1,$2,\'Unknown tenant\',\'{"type":"doc"}\',\'todo\',\'normal\')', [pending, owner])
    await app.query('insert into agents(id,"userId",harness,name) values($1,$2,\'codex\',\'ACL agent\')', [agent, owner])
    await app.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,\'Private bot\')', [bot, owner, alpha])
    await app.query('insert into agent_runs(id,"userId","agentId","workspaceId","issueId","botId",status) values($1,$2,$3,$4,$5,$6,\'succeeded\')', [run, owner, agent, alpha, task, bot])
    await app.query('insert into artifacts(id,"userId","workspaceId","runId","issueId",kind,title) values($1,$2,$3,$4,$5,\'markdown\',\'Private artifact\')', [artifact, owner, alpha, run, task])
    await app.query('insert into coordinator_sessions("userId","botId") values($1,$2)', [owner, bot])
    await ws.query('insert into workspace_projects(id,"userId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision) values($1,$2,\'Project\',\'\',\'\',\'planned\',\'none\',\'\',\'\',\'\',\'\',$3,1)', [project, owner, JSON.stringify([task])])
    await ws.query('insert into mikka_team_projects("projectId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [project, team, alpha, owner])
    const before = (await app.query('select id,content,"scopeVersion" from issues where id=$1', [task])).rows[0]
    await migrate(files.filter(file => file >= boundary))
    const backfill = await backfillProjectResourceAccess(app, ws)
    assert.deepEqual(backfill, { registered: 1, quarantined: 0, tasksBound: 1 })
    assert.deepEqual(await backfillProjectResourceAccess(app, ws), { registered: 0, quarantined: 0, tasksBound: 0 })
    assert.deepEqual((await app.query('select id,content,"scopeVersion" from issues where id=$1', [task])).rows[0], before)
    assert.equal((await app.query("select to_regclass('mikka_workspaces') as table")).rows[0].table, null)
    assert.equal((await ws.query("select to_regclass('resource_access_policies') as table")).rows[0].table, null)

    const { db, pool } = await import('../lib/db'); moduleApp = pool
    const { workspacePool } = await import('../lib/workspace-db'); moduleWs = workspacePool
    const { issueForUser } = await import('../lib/issue-access')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    const { requireResourceAccess, readResourceCapabilities, readResourceManagementMetadata, changeResourceAccess, withResourceAccess, botChatResourceId } = await import('../lib/resource-access/store')
    const reference = (kind: 'task' | 'thread' | 'project' | 'artifact' | 'bot' | 'chat', id: string, workspaceId = alpha) => ({ kind, id, workspaceId })
    const allowed = async (subject: string, kind: string, id: string, action = 'canReadContent', tenant = alpha, subjectKind = 'account') =>
      (await app.query('select mikka_resource_acl_allowed($1,$2,$3,$4,$5,$6) as allowed', [subjectKind, subject, tenant, kind, id, action])).rows[0].allowed
    const policy = async (kind: string, id: string) => (await app.query('select * from resource_access_policies where kind=$1 and id=$2', [kind, id])).rows[0]

    await t.test('legacy shared Tasks stay shared; old run/chat/bot/artifact stay private; unknown remains quarantined', async () => {
      assert.equal((await issueForUser(member, task))?.id, task)
      assert.equal(await issueForUser(stranger, task), null)
      assert.equal(await issueForUser(owner, pending), null)
      assert.equal((await policy('task', pending)).visibility, 'quarantined')
      for (const [kind, id] of [['thread', run], ['bot', bot], ['artifact', artifact], ['chat', botChatResourceId(owner, bot)]]) {
        assert.equal((await policy(kind, id)).visibility, 'private')
        assert.equal(await allowed(owner, kind, id), true)
        assert.equal(await allowed(member, kind, id), false)
        assert.equal(await allowed(manager, kind, id), false)
      }
      assert.equal(await issueForUser({ id: owner, [tokenWorkspace]: beta }, task), null)
      await assert.rejects(requireResourceAccess(stranger, reference('task', task)), { code: 'issueNotFound' })
    })

    await t.test('one SQL action contract; ownership and management do not authorize personal credentials, machines or billing', async () => {
      for (const action of RESOURCE_ACTIONS) {
        assert.equal(await allowed(owner, 'task', task, action), OWNER_RESOURCE_ACTIONS.includes(action), action)
        assert.equal(await allowed(member, 'task', task, action), SHARED_RESOURCE_ACTIONS.includes(action), action)
      }
      assert.equal(await allowed('worker', 'task', task, 'canReadContent', alpha, 'service'), false)
      assert.equal(await allowed(owner, 'task', task, 'unknown'), false)
      assert.equal(await allowed(owner, 'task', task, 'canReadContent', beta), false)
      const metadata = await readResourceManagementMetadata(manager, reference('thread', run))
      assert.ok(metadata)
      assert.deepEqual(Object.keys(metadata).sort(), ['kind','id','workspaceId','ownerId','visibility','revision','createdAt','updatedAt'].sort())
      const capabilities = await readResourceCapabilities(manager, reference('thread', run))
      assert.equal(capabilities.canReadMetadata, true); assert.equal(capabilities.canViewUsage, true)
      assert.equal(capabilities.canReadContent, false); assert.equal(capabilities.canDiscover, false)
      assert.equal(capabilities.canUseCredential, false); assert.equal(capabilities.canManageAccess, false)
    })

    await t.test('Private Project intersects the child owner, explicit grants expire and Workspace/PAT authority is still required', async () => {
      const child = randomUUID()
      await app.query('insert into issues(id,"userId","workspaceId",title,content,status,priority) values($1,$2,$3,\'Child\',\'{"type":"doc"}\',\'todo\',\'normal\')', [child, member, alpha])
      await app.query('update resource_access_policies set "parentKind"=\'project\',"parentId"=$1 where kind=\'task\' and id=$2', [project, child])
      await app.query('update resource_access_policies set visibility=\'private\' where kind=\'project\' and id=$1', [project])
      assert.equal(await issueForUser(member, child), null, 'child owner cannot bypass a private parent')
      await app.query('insert into resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities) values(\'project\',$1,\'account\',$2,ARRAY[\'canReadContent\'])', [project, member])
      assert.equal((await issueForUser(member, child))?.id, child)
      assert.equal(await allowed(member, 'task', child, 'canSteer'), false, 'parent read does not imply steer')
      await app.query('update resource_access_grants set "expiresAt"=now()-interval \'1 second\' where "resourceKind"=\'project\' and "resourceId"=$1', [project])
      assert.equal(await issueForUser(member, child), null)
      await app.query('delete from resource_access_grants where "resourceKind"=\'project\' and "resourceId"=$1', [project])
      await app.query('update resource_access_policies set visibility=\'shared\' where kind=\'project\' and id=$1', [project])
      await ws.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [alpha, member])
      assert.equal(await issueForUser(member, child), null, 'resource ownership does not survive membership revocation')
      await ws.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2', [alpha, member])
    })

    await t.test('missing parents, cross-tenant ancestry, cycles and excessive depth all fail closed', async () => {
      const malformed = async (parentKind: string | null, parentId: string | null, tenant = alpha) => {
        const id = randomUUID()
        await app.query('insert into resource_access_policies(kind,id,"workspaceId","ownerId",visibility,"parentKind","parentId",provenance) values(\'task\',$1,$2,$3,\'shared\',$4,$5,\'created\')', [id, tenant, owner, parentKind, parentId])
        return id
      }
      assert.equal(await allowed(owner, 'task', randomUUID()), false)
      assert.equal(await allowed(owner, 'task', await malformed('task', randomUUID())), false)
      const foreign = await malformed(null, null, beta)
      assert.equal(await allowed(owner, 'task', await malformed('task', foreign)), false)
      const first = await malformed(null, null), second = await malformed('task', first)
      await app.query('update resource_access_policies set "parentKind"=\'task\',"parentId"=$1 where kind=\'task\' and id=$2', [second, first])
      assert.equal(await allowed(owner, 'task', first), false)
      let deep = await malformed(null, null)
      for (let level = 0; level < 33; level++) deep = await malformed('task', deep)
      assert.equal(await allowed(owner, 'task', deep), false)
    })

    await t.test('sharing needs explicit expansion, rejects foreign members and personal-resource capabilities, and is audited', async () => {
      let current = await policy('task', task)
      const privateResult = await changeResourceAccess(owner, reference('task', task), { expectedRevision: current.revision, visibility: 'private', grants: [] })
      assert.equal(await issueForUser(member, task), null)
      await assert.rejects(changeResourceAccess(owner, reference('task', task), { expectedRevision: privateResult.revision, visibility: 'shared', grants: [] }), { code: 'validationGeneric' })
      await assert.rejects(changeResourceAccess(owner, reference('task', task), { expectedRevision: privateResult.revision, visibility: 'private', grants: [{ subjectId: stranger, capabilities: ['canReadContent'] }], confirmExpansion: true }), { code: 'workspaceAccessDenied' })
      await assert.rejects(changeResourceAccess(owner, reference('task', task), { expectedRevision: privateResult.revision, visibility: 'private', grants: [{ subjectId: member, capabilities: ['canReadContent','canUseCredential'] }], confirmExpansion: true }), { code: 'validationGeneric' })
      const shared = await changeResourceAccess(owner, reference('task', task), { expectedRevision: privateResult.revision, visibility: 'shared', grants: [], confirmExpansion: true })
      assert.ok(shared.revision > privateResult.revision)
      await assert.rejects(changeResourceAccess(owner, reference('task', task), { expectedRevision: privateResult.revision, visibility: 'private', grants: [] }), { code: 'issueOutdated' })
      current = await policy('task', task)
      assert.equal(current.revision, shared.revision)
      const events = (await app.query('select "actorId",detail from resource_access_events where "resourceKind"=\'task\' and "resourceId"=$1', [task])).rows
      assert.ok(events.some(event => event.actorId === owner))
      assert.equal(JSON.stringify(events).includes('existing private payload'), false)
      await assert.rejects(app.query('delete from resource_access_events where "resourceId"=$1', [task]), { code: '23514' })
    })

    await t.test('content write holds its ACL and membership until commit; later requests observe revocation', async () => {
      let entered!: () => void, release!: () => void
      const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
      const writing = withResourceAccess(member, reference('task', task), 'canSteer', async () => {
        entered(); await gate
        await db.execute(sql`update issues set title='Authorized before revocation' where id=${task}::uuid`)
      })
      await ready
      const revoke = await app.connect(), suspend = await ws.connect()
      try {
        await revoke.query("set lock_timeout='200ms'"); await suspend.query("set lock_timeout='200ms'")
        await assert.rejects(revoke.query('update resource_access_policies set visibility=\'private\' where kind=\'task\' and id=$1', [task]), { code: '55P03' })
        await assert.rejects(suspend.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [alpha, member]), { code: '55P03' })
      } finally { release(); await writing; revoke.release(); suspend.release() }
      await app.query('update resource_access_policies set visibility=\'private\' where kind=\'task\' and id=$1', [task])
      await assert.rejects(withResourceAccess(member, reference('task', task), 'canSteer', async () => assert.fail('revoked content write')), { code: 'issueNotFound' })
    })

    await t.test('continuations retain the private prior attempt boundary even when the child is explicitly shared', async () => {
      await app.query('update resource_access_policies set visibility=\'shared\' where kind=\'task\' and id=$1', [task])
      for (const relation of ['continuesRunId', 'retryOf', 'questionContinuation']) {
        const id = randomUUID()
        const extra = relation === 'questionContinuation' ? { originRunId: run } : run
        await app.query(`insert into agent_runs(id,"userId","agentId","workspaceId","issueId",status,"${relation}") values($1,$2,$3,$4,$5,'succeeded',$6)`, [id, owner, agent, alpha, task, extra])
        assert.equal((await policy('thread', id)).parentId, run)
        await app.query('update resource_access_policies set visibility=\'shared\' where kind=\'thread\' and id=$1', [id])
        assert.equal(await allowed(member, 'thread', id), false)
        assert.equal(await allowed(owner, 'thread', id), true)
      }
    })

    await t.test('account freeze refuses new authority while revocation and its immutable audit remain writable', async () => {
      const subject = `deleting-${suffix}`, resource = randomUUID()
      await app.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$1||\'@acl.example.invalid\',true,now(),now())', [subject])
      await app.query('insert into resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance) values(\'task\',$1,$2,$3,\'private\',\'created\')', [resource, alpha, subject])
      await app.query('insert into resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities) values(\'task\',$1,\'account\',$2,ARRAY[\'canReadContent\'])', [resource, member])
      await app.query('insert into account_deletion_guards("subjectId","jobId") values($1,$2)', [subject, randomUUID()])
      await assert.rejects(app.query('update resource_access_policies set visibility=\'shared\' where kind=\'task\' and id=$1', [resource]), { code: '55000' })
      await assert.rejects(app.query('insert into resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance) values(\'task\',$1,$2,$3,\'private\',\'created\')', [randomUUID(), alpha, subject]), { code: '55000' })
      await assert.rejects(app.query('insert into resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities) values(\'task\',$1,\'account\',$2,ARRAY[\'canReadContent\'])', [resource, manager]), { code: '55000' })
      const revision = (await policy('task', resource)).revision
      await app.query('delete from resource_access_grants where "resourceKind"=\'task\' and "resourceId"=$1', [resource])
      assert.ok((await policy('task', resource)).revision > revision)
      await app.query('delete from resource_access_policies where kind=\'task\' and id=$1', [resource])
      const events = (await app.query('select action from resource_access_events where "resourceKind"=\'task\' and "resourceId"=$1', [resource])).rows
      assert.ok(events.some(row => row.action === 'grant_delete'))
      assert.ok(events.some(row => row.action === 'delete'))
      await assert.rejects(app.query('delete from resource_access_events where "resourceId"=$1', [resource]), { code: '23514' })
    })
  } finally {
    if (previous.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = previous.app
    if (previous.ws === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.ws
    await dropTestDatabase(admin, appName, app, moduleApp)
    await dropTestDatabase(admin, wsName, ws, moduleWs)
    await admin.end()
  }
})
