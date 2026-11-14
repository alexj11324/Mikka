import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { withBasePath } from '../base-path'
import { workspaceLink } from '../../components/workspace/workspace-navigation'

const base = process.env.E2E_DATABASE_URL
if (base) assert.ok(disposableDatabase(), 'memory authority regression only uses loopback *_e2e databases')
if (!base && process.env.REQUIRE_DB === '1') throw new Error('Memory authority regression requires PostgreSQL')

test('memory uses authoritative membership across two real PostgreSQL databases', { skip: !base, timeout: 120_000 }, async t => {
  const admin = new Pool({ connectionString: base, max: 1 })
  const suffix = randomUUID().replaceAll('-', '')
  const appName = `memory_app_${suffix}_e2e`, workspaceName = `memory_workspace_${suffix}_e2e`
  const appUrl = new URL(base!), workspaceUrl = new URL(base!)
  appUrl.pathname = `/${appName}`; workspaceUrl.pathname = `/${workspaceName}`
  const previous = { app: process.env.MIKKA_DATABASE_URL, workspace: process.env.DATABASE_URL, vercel: process.env.VERCEL_ENV }
  let app: Pool | undefined, workspace: Pool | undefined
  let modulePools: Pool[] = []
  try {
    await createTestDatabase(admin, appName, 'template0')
    await createTestDatabase(admin, workspaceName, 'template0')
    process.env.MIKKA_DATABASE_URL = appUrl.href
    process.env.DATABASE_URL = workspaceUrl.href
    delete process.env.VERCEL_ENV
    assert.notEqual(process.env.MIKKA_DATABASE_URL, process.env.DATABASE_URL)
    await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], { env: { ...process.env, MIGRATE: '1' }, maxBuffer: 4 << 20 })
    app = new Pool({ connectionString: appUrl.href, max: 2 })
    workspace = new Pool({ connectionString: workspaceUrl.href, max: 2 })
    const [{ db, pool }, { workspaceDb, workspacePool }, schema, wsSchema, memory, { projectDb, projects }, { teamProjects, teams }, { tokenWorkspace }, { eq }] = await Promise.all([
      import('../db'), import('../workspace-db'), import('../db/schema'), import('../db/workspace-schema'), import('./memory'),
      import('../db/projects'), import('../db/team-schema'), import('../tokens/principal'), import('drizzle-orm'),
    ])
    modulePools = [pool, workspacePool]
    const owner = `memory-owner-${suffix}`, peer = `memory-peer-${suffix}`
    const a = randomUUID(), b = randomUUID(), suspended = randomUUID(), personal = randomUUID(), foreign = randomUUID()
    const botId = randomUUID(), otherBot = randomUUID(), otherTask = randomUUID(), ownProject = randomUUID(), teamProject = randomUUID()
    for (const id of [owner, peer]) await app.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,false,now(),now())`, [id, `${id}@example.invalid`])
    await workspaceDb.insert(wsSchema.workspaces).values([
      { id: a, userId: owner, name: 'Authoritative A' }, { id: b, userId: owner, name: 'Authoritative B' },
      { id: suspended, userId: owner, name: 'Suspended authority' }, { id: personal, userId: owner, name: 'Personal', kind: 'personal' },
      { id: foreign, userId: peer, name: 'Foreign personal', kind: 'personal' },
    ])
    await workspaceDb.insert(wsSchema.workspaceMembers).values([
      ...[a, b, personal].map(workspaceId => ({ workspaceId, userId: owner, name: owner, email: `${owner}@example.invalid`, role: 'admin' as const })),
      { workspaceId: foreign, userId: peer, name: peer, email: `${peer}@example.invalid`, role: 'admin' },
      { workspaceId: suspended, userId: owner, name: owner, email: `${owner}@example.invalid`, role: 'admin', status: 'suspended' },
      { workspaceId: a, userId: peer, name: peer, email: `${peer}@example.invalid`, role: 'member' },
    ])
    await assert.rejects(workspace.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role) VALUES ($1,$2,$2,$3,'admin')`, [foreign, owner, `${owner}@example.invalid`]), { code: '23514' })
    assert.equal((await workspace.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [foreign, owner])).rowCount, 0)
    // Deliberately disagreeing legacy app-side copies must never grant or deny admission.
    await app.query(`CREATE TABLE IF NOT EXISTS mikka_workspaces (id uuid PRIMARY KEY,"userId" text NOT NULL,name text NOT NULL,kind text NOT NULL DEFAULT 'team',"createdAt" timestamptz NOT NULL DEFAULT now())`)
    await app.query(`CREATE TABLE IF NOT EXISTS mikka_workspace_members ("workspaceId" uuid NOT NULL,"userId" text NOT NULL,name text NOT NULL,email text NOT NULL,role text NOT NULL,status text NOT NULL DEFAULT 'active',"createdAt" timestamptz NOT NULL DEFAULT now(),PRIMARY KEY("workspaceId","userId"))`)
    await app.query(`INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$4,'Stale A'),($2,$4,'Stale suspended'),($3,$4,'Stale foreign')`, [a, suspended, foreign, owner])
    await app.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$4,'Synthetic','synthetic@example.invalid','admin','suspended'),($2,$4,'Synthetic','synthetic@example.invalid','admin','active'),($3,$4,'Synthetic','synthetic@example.invalid','admin','active')`, [a, suspended, foreign, owner])
    // Project v2 requires an owning workspace on insert (drizzle/20261111030000).
    // The team project lives in `b`; the owner's own project in their personal workspace.
    await projectDb.insert(projects).values([
      { id: ownProject, workspaceId: personal, userId: owner, name: 'Synthetic project', summary: '', description: '', status: 'started', priority: 'normal', lead: '', team: '', startDate: '', targetDate: '', issueIds: [], revision: 1 },
      { id: teamProject, workspaceId: b, userId: owner, name: 'Synthetic team project', summary: '', description: '', status: 'started', priority: 'normal', lead: '', team: '', startDate: '', targetDate: '', issueIds: [], revision: 1 },
    ])
    // A team project needs a real team in the same workspace: check_active_team_relation
    // rejects a teamId that does not resolve, and a personal workspace cannot hold one.
    const teamId = randomUUID()
    await projectDb.insert(teams).values({ id: teamId, workspaceId: b, userId: owner, name: 'Synthetic team', identifier: 'SYN' })
    await projectDb.insert(teamProjects).values({ projectId: teamProject, teamId, workspaceId: b, userId: owner })
    await db.insert(schema.bots).values([
      { id: botId, ownerId: owner, workspaceId: a, name: 'Split database memory' },
      { id: otherBot, ownerId: owner, workspaceId: b, name: 'Other workspace memory' },
    ])
    await db.insert(schema.coordinatorSessions).values([
      { userId: owner, botId, leaseHolder: 'synthetic-authority-turn' }, { userId: owner, botId: otherBot },
    ])
    await db.insert(schema.issues).values({ id: otherTask, userId: owner, workspaceId: b, ownershipState: 'bound', title: 'Synthetic other workspace task', content: {}, status: 'todo', priority: 'normal' })
    let factId = ''
    await t.test('active canonical membership permits CRUD and prompt use despite a suspended app copy', async () => {
      const requestId = randomUUID()
      factId = (await memory.addMemoryFact(owner, a, { requestId, kind: 'preference', subject: 'Authoritative memory fact', scope: { kind: 'global', ids: [] } }))!
      assert.ok(factId)
      const view = await memory.readMemoryView(owner, a)
      assert.equal(view.facts.find(fact => fact.id === factId)?.source?.kind, 'told')
      assert.deepEqual(new Set(view.scopeOptions.workspaces.map(item => item.id)), new Set([a, b, personal]))
      assert.equal(view.scopeOptions.workspaces.find(item => item.id === a)?.name, 'Authoritative A')
      assert.equal(await memory.reviewMemoryFact(owner, a, factId, 'approve'), true)
      assert.match(await memory.memoryForBotPrompt(owner, botId, true), /Authoritative memory fact/)
      assert.equal((await memory.readMemoryView(owner, a)).facts.find(fact => fact.id === factId)?.usedCount, 1)
      assert.equal(await memory.removeMemoryFact(owner, a, factId), true)
      assert.equal(await memory.undoMemoryFact(owner, a, factId), true)
      assert.deepEqual((await memory.readMemoryView(peer, a)).facts, [], 'team membership never shares personal facts')
      assert.equal(await memory.setMemoryFactScope(owner, a, factId, { kind: 'projects', ids: [teamProject] }), true)
      assert.equal((await memory.readMemoryView(owner, a)).facts.length, 0)
      assert.equal((await memory.readMemoryView(owner, b)).facts[0]?.id, factId)
      assert.equal(await memory.setMemoryFactScope(owner, b, factId, { kind: 'projects', ids: [ownProject] }), true)
      assert.equal((await memory.readMemoryView(owner, b)).facts.length, 0)
      assert.equal((await memory.readMemoryView(owner, personal)).facts[0]?.id, factId)
      assert.equal(await memory.setMemoryFactScope(owner, personal, factId, { kind: 'global', ids: [] }), true)
    })
    await t.test('global facts never reveal another workspace usage or an unverified source locator', async () => {
      assert.equal(await memory.recordMemoryFactUsage(owner, b, { eventId: randomUUID(), kind: 'thread', targetId: otherBot, url: '/mikka/chat' }, [factId]), 1)
      assert.equal(await memory.recordMemoryFactUsage(owner, b, { eventId: randomUUID(), kind: 'task', targetId: otherTask, url: '/mikka/tasks' }, [factId]), 1)
      await db.update(schema.userFacts).set({ sourceKind: 'thread', sourceId: otherBot, sourceUrl: '/mikka/chat' }).where(eq(schema.userFacts.id, factId))
      const pinned = Object.defineProperty({ id: owner }, tokenWorkspace, { value: a })
      const here = (await memory.readMemoryView(pinned, a)).facts.find(fact => fact.id === factId)!
      assert.equal(here.usedCount, 1, 'count is scoped, not a hidden all-account aggregate')
      assert.deepEqual(here.recentUses.map(use => use.id), [botId])
      assert.deepEqual(here.source, { kind: 'thread', id: null, url: null })
      const there = (await memory.readMemoryView(owner, b)).facts.find(fact => fact.id === factId)!
      assert.equal(there.usedCount, 2)
      assert.deepEqual(new Set(there.recentUses.map(use => use.id)), new Set([otherBot, otherTask]))
      assert.deepEqual(there.source, { kind: 'thread', id: otherBot, url: withBasePath(workspaceLink({ bot: otherBot })) })
      await db.update(schema.issues).set({ content: { attrs: { mikka: { deletedAt: new Date().toISOString() } } } }).where(eq(schema.issues.id, otherTask))
      assert.equal((await memory.readMemoryView(owner, b)).facts.find(fact => fact.id === factId)?.usedCount, 1, 'a deleted task is no longer a visible use target')
      for (const sourceKind of ['decision', 'file'] as const) {
        await db.update(schema.userFacts).set({ sourceKind, sourceId: 'unverified-target', sourceUrl: '/mikka/unverified' }).where(eq(schema.userFacts.id, factId))
        assert.deepEqual((await memory.readMemoryView(pinned, a)).facts.find(fact => fact.id === factId)?.source, { kind: sourceKind, id: null, url: null })
      }
    })
    await t.test('suspended authority and a rejected foreign personal membership cannot be rescued by app rows', async () => {
      for (const workspaceId of [suspended, foreign]) {
        await assert.rejects(memory.readMemoryView(owner, workspaceId), { code: 'workspaceAccessDenied' })
        await assert.rejects(memory.addMemoryFact(owner, workspaceId, { requestId: randomUUID(), kind: 'preference', subject: 'Refused', scope: { kind: 'global', ids: [] } }), { code: 'workspaceAccessDenied' })
      }
      await assert.rejects(memory.setMemoryFactScope(owner, a, factId, { kind: 'workspaces', ids: [suspended] }), { code: 'workspaceAccessDenied' })
      assert.equal((await db.select().from(schema.userFacts).where(eq(schema.userFacts.userId, owner))).length, 1)
    })
    await t.test('a pinned original reader cannot move facts to another workspace or its personal projects', async () => {
      const pinned = Object.defineProperty({ id: owner }, tokenWorkspace, { value: a })
      assert.deepEqual((await memory.readMemoryView(pinned, a)).scopeOptions.workspaces.map(item => item.id), [a])
      await assert.rejects(memory.readMemoryView(pinned, b), { code: 'workspaceAccessDenied' })
      for (const scope of [{ kind: 'workspaces' as const, ids: [b] }, { kind: 'projects' as const, ids: [ownProject] }, { kind: 'projects' as const, ids: [teamProject] }]) {
        await assert.rejects(memory.setMemoryFactScope(pinned, a, factId, scope), { code: 'workspaceAccessDenied' })
      }
      assert.equal(await memory.setMemoryFactScope(pinned, a, factId, { kind: 'workspaces', ids: [a] }), true)
      await workspaceDb.update(wsSchema.workspaceMembers).set({ status: 'suspended' }).where(eq(wsSchema.workspaceMembers.workspaceId, a))
      await assert.rejects(memory.memoryForBotPrompt(pinned, botId, true), { code: 'workspaceAccessDenied' })
      await assert.rejects(memory.removeMemoryFact(pinned, a, factId), { code: 'workspaceAccessDenied' })
    })
  } finally {
    if (previous.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = previous.app
    if (previous.workspace === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.workspace
    if (previous.vercel === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previous.vercel
    await Promise.all(modulePools.map(pool => pool.end()))
    await dropTestDatabase(admin, appName, app)
    await dropTestDatabase(admin, workspaceName, workspace)
    await admin.end()
  }
})
