import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { factInput, type ConsolidationDecider } from './facts'
import { withBasePath } from '../base-path'
import { workspaceLink } from '../../components/workspace/workspace-navigation'

const base = process.env.E2E_DATABASE_URL
if (base) assert.ok(disposableDatabase(), 'memory provenance regression only uses loopback *_e2e databases')
if (!base && process.env.REQUIRE_DB === '1') throw new Error('Memory provenance regression requires PostgreSQL')

test('real memory producers persist authorized sources across separate application and workspace databases', { skip: !base, timeout: 120_000 }, async t => {
  const admin = new Pool({ connectionString: base, max: 1 }), suffix = randomUUID().replaceAll('-', '')
  const appName = `memory_sources_app_${suffix}_e2e`, workspaceName = `memory_sources_workspace_${suffix}_e2e`
  const appUrl = new URL(base!), workspaceUrl = new URL(base!)
  appUrl.pathname = `/${appName}`; workspaceUrl.pathname = `/${workspaceName}`
  const previous = { app: process.env.MIKKA_DATABASE_URL, workspace: process.env.DATABASE_URL, vercel: process.env.VERCEL_ENV }
  let app: Pool | undefined, workspace: Pool | undefined
  let modulePools: Pool[] = []
  try {
    await admin.query(`CREATE DATABASE "${appName}" TEMPLATE template0`)
    await admin.query(`CREATE DATABASE "${workspaceName}" TEMPLATE template0`)
    process.env.MIKKA_DATABASE_URL = appUrl.href; process.env.DATABASE_URL = workspaceUrl.href
    delete process.env.VERCEL_ENV
    assert.notEqual(appUrl.href, workspaceUrl.href)
    await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], { env: { ...process.env, MIGRATE: '1' }, maxBuffer: 4 << 20 })
    app = new Pool({ connectionString: appUrl.href, max: 2 }); workspace = new Pool({ connectionString: workspaceUrl.href, max: 2 })
    const [{ db, pool }, { workspaceDb, workspacePool }, schema, wsSchema, memory, store, { tokenWorkspace }, { eq, and }, { projectDb, projects }, { teamProjects, teams }] = await Promise.all([
      import('../db'), import('../workspace-db'), import('../db/schema'), import('../db/workspace-schema'), import('./memory'), import('./store'),
      import('../tokens/principal'), import('drizzle-orm'), import('../db/projects'), import('../db/team-schema'),
    ])
    modulePools = [pool, workspacePool]
    const owner = `source-owner-${suffix}`, peer = `source-peer-${suffix}`
    const home = randomUUID(), other = randomUUID(), homeBot = randomUUID(), otherBot = randomUUID(), peerBot = randomUUID(), project = randomUUID()
    for (const id of [owner, peer]) await app.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,false,now(),now())`, [id, `${id}@example.invalid`])
    await workspaceDb.insert(wsSchema.workspaces).values([{ id: home, userId: owner, name: 'Source home', kind: 'personal' }, { id: other, userId: owner, name: 'Other workspace' }])
    await workspaceDb.insert(wsSchema.workspaceMembers).values([
      ...[home, other].map(workspaceId => ({ workspaceId, userId: owner, name: owner, email: `${owner}@example.invalid`, role: 'admin' as const })),
      { workspaceId: other, userId: peer, name: peer, email: `${peer}@example.invalid`, role: 'member' },
    ])
    await db.insert(schema.bots).values([{ id: homeBot, ownerId: owner, workspaceId: home, name: 'Source Coordinator' },
      { id: otherBot, ownerId: owner, workspaceId: other, name: 'Other source' }, { id: peerBot, ownerId: peer, workspaceId: other, name: 'Peer source' }])
    // Project v2 requires an owning workspace on insert (drizzle/20261111030000);
    // this project is a team project of `other` (see teamProjects below).
    await projectDb.insert(projects).values({ id: project, workspaceId: other, userId: owner, name: 'Restricted source project', summary: '', description: '', status: 'started', priority: 'normal', lead: '', team: '', startDate: '', targetDate: '', issueIds: [], revision: 1 })
    // A team project needs a real team in the same workspace (check_active_team_relation).
    const teamId = randomUUID()
    await projectDb.insert(teams).values({ id: teamId, workspaceId: other, userId: owner, name: 'Synthetic team', identifier: 'SYN' })
    await projectDb.insert(teamProjects).values({ projectId: project, teamId, workspaceId: other, userId: owner })
    const pinned = Object.defineProperty({ id: owner }, tokenWorkspace, { value: home })
    const view = async (id: string, reader: string | { id: string } = owner, workspaceId = home) => {
      const result = await memory.readMemoryView(reader, workspaceId)
      return [...result.facts, ...result.pending, ...result.undoable].find(fact => fact.id === id)
    }
    const at = new Date('2026-11-09T10:00:00Z')
    let commentId = 12345
    const notice = async (userId = owner, botId = homeBot, source: 'github' | 'notion' = 'github') => {
      const id = randomUUID(), page = randomUUID(), comment = commentId++, externalId = source === 'github' ? `comment:${comment}` : `${page}:2026-11-09`
      const url = source === 'github' ? `https://github.com/owner/repo/issues/17#issuecomment-${comment}` : `https://www.notion.so/Plan-${page.replaceAll('-', '')}`
      await db.insert(schema.suggestions).values({ id, userId, botId, source, externalId, matterKey: source === 'github' ? 'github:owner/repo#17' : `notion:${page}`,
        action: 'read', title: 'Synthetic source event', url, shown: false, decidedBy: 'model', occurredAt: at })
      return { id, source, externalId, occurredAt: at, url }
    }
    const learn = async (subject: string, saved: Awaited<ReturnType<typeof notice>>, extra: { kind?: 'interest' | 'preference'; topic?: string } = {}) => {
      const input = factInput({ kind: extra.kind ?? 'preference', subject, confidence: 0.5, ...(extra.topic ? { topic: extra.topic } : {}) }, saved, saved.id)
      await store.recordFacts(owner, [input])
      return (await db.select().from(schema.userFacts).where(and(eq(schema.userFacts.userId, owner), eq(schema.userFacts.subject, subject))))[0]
    }

    await t.test('manual assertions identify the stored fact and keep request replay idempotent', async () => {
      const requestId = randomUUID(), input = { requestId, kind: 'preference' as const, subject: 'Actual assertion', scope: { kind: 'global' as const, ids: [] as [] } }
      const id = (await memory.addMemoryFact(owner, home, input))!
      assert.deepEqual((await view(id))?.source, { kind: 'told', id, url: null })
      assert.equal(await memory.addMemoryFact(owner, home, input), id)
      assert.deepEqual((await memory.readMemoryView(peer, other)).facts, [])
    })
    await t.test('the actual notification factInput/store path exposes its owned external source and original URL', async () => {
      const saved = await notice(), fact = await learn('Owned notice', saved)
      assert.deepEqual((await view(fact.id, pinned))?.source, { kind: 'thread', id: `suggestion:${saved.id}`, url: saved.url })
      assert.equal((await view(fact.id, pinned))?.createdAt, fact.createdAt.toISOString())
      assert.equal((await view(fact.id, pinned))?.firstSeenAt, saved.occurredAt.toISOString())
      const repeated = await learn('Owned notice', { ...saved, occurredAt: new Date('2026-11-10T10:00:00Z') })
      assert.equal(repeated.createdAt.toISOString(), fact.createdAt.toISOString())
      assert.equal((await view(fact.id, pinned))?.firstSeenAt, saved.occurredAt.toISOString(), 'repeat extraction cannot masquerade as a newly created fact')
      await db.update(schema.userFacts).set({ sourceUrl: 'https://outside.invalid/not-the-source' }).where(eq(schema.userFacts.id, fact.id))
      assert.equal((await view(fact.id))?.source?.url, saved.url, 'fact sourceUrl cannot override the verified stored notification')
      await db.update(schema.suggestions).set({ url: 'https://github.com/owner/other/issues/17#issuecomment-12345' }).where(eq(schema.suggestions.id, saved.id))
      assert.deepEqual((await view(fact.id))?.source, { kind: 'thread', id: `suggestion:${saved.id}`, url: null })
      const page = await notice(owner, homeBot, 'notion'), file = await learn('Owned page', page)
      assert.deepEqual((await view(file.id))?.source, { kind: 'file', id: `suggestion:${page.id}`, url: page.url })
    })
    await t.test('owner, workspace and the exact notice evidence all fence source metadata', async () => {
      const foreign = await notice(peer, peerBot), badOwner = await learn('Foreign notice reference', foreign)
      assert.deepEqual((await view(badOwner.id, owner, other))?.source, { kind: 'thread', id: null, url: null })
      const elsewhere = await notice(owner, otherBot), badWorkspace = await learn('Other workspace reference', elsewhere)
      assert.deepEqual((await view(badWorkspace.id, pinned))?.source, { kind: 'thread', id: null, url: null })
      assert.equal((await view(badWorkspace.id, owner, other))?.source?.id, `suggestion:${elsewhere.id}`)
      await assert.rejects(memory.readMemoryView(pinned, other), { code: 'workspaceAccessDenied' })
      await db.update(schema.userFacts).set({ evidence: [{ source: 'github', suggestionId: elsewhere.id, externalId: 'comment:9999', at: at.toISOString() }] }).where(eq(schema.userFacts.id, badWorkspace.id))
      assert.deepEqual((await view(badWorkspace.id, owner, other))?.source, { kind: 'thread', id: null, url: null })
    })
    await t.test('internal thread links are constructed from the authorized ID, never a stored arbitrary URL', async () => {
      const id = (await memory.addMemoryFact(owner, home, { requestId: randomUUID(), kind: 'preference', subject: 'Internal source', scope: { kind: 'global', ids: [] } }))!
      await db.update(schema.userFacts).set({ sourceKind: 'thread', sourceId: homeBot, sourceUrl: `/mikka/?bot=${otherBot}` }).where(eq(schema.userFacts.id, id))
      assert.deepEqual((await view(id, pinned))?.source, { kind: 'thread', id: homeBot, url: withBasePath(workspaceLink({ bot: homeBot })) })
      assert.deepEqual((await view(id, owner, other))?.source, { kind: 'thread', id: null, url: null })
    })
    const decide: ConsolidationDecider = async (_input, questions) => new Map(questions.filter(question => question.type === 'choice' && question.choices.some(choice => choice.value === 'interest'))
      .map(question => [question.name, { type: 'choice' as const, name: question.name, choice: 'interest' }]))
    let derivedId = '', decisionId = ''
    await t.test('applied consolidation persists the real parent relationship atomically and replays one decision', async () => {
      const saved = await notice(owner, homeBot, 'notion')
      const parents = await Promise.all(['Known ingredient one', 'Known ingredient two'].map(subject => learn(subject, saved, { kind: 'interest', topic: 'Known topic' })))
      await store.consolidateFacts(owner, 'UTC', at, decide)
      const [derived] = await db.select().from(schema.userFacts).where(and(eq(schema.userFacts.userId, owner), eq(schema.userFacts.subject, 'Known topic')))
      assert.ok(derived); derivedId = derived.id
      const [record] = await db.select().from(schema.userFactDecisions).where(eq(schema.userFactDecisions.factId, derivedId))
      assert.ok(record); decisionId = record.id
      assert.deepEqual(new Set(record.sourceFactIds), new Set(parents.map(parent => parent.id)))
      assert.equal(record.method, 'consolidation_answer')
      assert.deepEqual((await view(derivedId))?.source, { kind: 'decision', id: decisionId, url: null })
      await store.consolidateFacts(owner, 'UTC', at, decide)
      assert.equal((await db.select().from(schema.userFactDecisions).where(eq(schema.userFactDecisions.factId, derivedId))).length, 1)
      await memory.setMemoryFactScope(owner, home, parents[0].id, { kind: 'workspaces', ids: [other] })
      assert.deepEqual((await view(derivedId, pinned))?.source, { kind: 'decision', id: null, url: null }, 'hidden parents cannot be named indirectly')
      await memory.setMemoryFactScope(owner, other, parents[0].id, { kind: 'global', ids: [] })
    })
    await t.test('restricted inputs and a scope change while deciding cannot produce a global fact', async () => {
      const saved = await notice(owner, homeBot, 'notion')
      const one = await learn('Scoped ingredient one', saved, { kind: 'interest', topic: 'Restricted topic' })
      const two = await learn('Scoped ingredient two', saved, { kind: 'interest', topic: 'Restricted topic' })
      await memory.setMemoryFactScope(owner, home, one.id, { kind: 'workspaces', ids: [other] })
      await memory.setMemoryFactScope(owner, home, two.id, { kind: 'projects', ids: [project] })
      const before = await db.select().from(schema.userFacts).where(eq(schema.userFacts.id, one.id))
      await store.consolidateFacts(owner, 'UTC', at, decide)
      assert.equal((await db.select().from(schema.userFacts).where(eq(schema.userFacts.subject, 'Restricted topic'))).length, 0)
      assert.deepEqual(await db.select().from(schema.userFacts).where(eq(schema.userFacts.id, one.id)), before)
      const racing = await learn('Racing ingredient', saved, { kind: 'interest', topic: 'Racing topic' })
      await learn('Racing other ingredient', saved, { kind: 'interest', topic: 'Racing topic' })
      await store.consolidateFacts(owner, 'UTC', at, async (input, questions) => {
        await memory.setMemoryFactScope(owner, home, racing.id, { kind: 'workspaces', ids: [other] })
        return decide(input, questions)
      })
      assert.equal((await db.select().from(schema.userFacts).where(eq(schema.userFacts.subject, 'Racing topic'))).length, 0)
    })
    await t.test('a scope restriction during the Decision wait also refuses stale-fact updates', async () => {
      const saved = await notice(owner, homeBot, 'notion'), stale = await learn('Stale scope race', saved)
      let restricted: unknown
      await store.consolidateFacts(owner, 'UTC', new Date('2027-01-09T10:00:00Z'), async (_input, questions) => {
        await memory.setMemoryFactScope(owner, home, stale.id, { kind: 'workspaces', ids: [other] })
        restricted = (await db.select().from(schema.userFacts).where(eq(schema.userFacts.id, stale.id)))[0]
        return new Map(questions.filter(question => question.type === 'choice').map(question => [question.name,
          { type: 'choice' as const, name: question.name, choice: question.type === 'choice' && question.choices.some(choice => choice.value === 'lower') ? 'lower' : 'none' }]))
      })
      assert.ok(restricted, 'the real Decision callback changed scope after the initial global read')
      assert.deepEqual((await db.select().from(schema.userFacts).where(eq(schema.userFacts.id, stale.id)))[0], restricted,
        'the old global snapshot must not lower confidence or rewrite the newly restricted fact')
    })
    await t.test('forget, undo, expiry and clear preserve only reachable owner provenance', async () => {
      assert.ok(derivedId)
      await memory.removeMemoryFact(owner, home, derivedId)
      assert.equal((await view(derivedId))?.source, null)
      await memory.undoMemoryFact(owner, home, derivedId)
      assert.deepEqual((await view(derivedId))?.source, { kind: 'decision', id: decisionId, url: null })
      await memory.removeMemoryFact(owner, home, derivedId)
      await db.update(schema.userFactUndo).set({ expiresAt: new Date(0) }).where(eq(schema.userFactUndo.factId, derivedId))
      await memory.purgeExpiredMemoryUndo()
      assert.equal((await db.select().from(schema.userFactDecisions).where(eq(schema.userFactDecisions.factId, derivedId))).length, 0)
      assert.equal(await memory.undoMemoryFact(owner, home, derivedId), false)
      await store.clearFacts(owner)
      assert.equal((await db.select().from(schema.userFactDecisions).where(eq(schema.userFactDecisions.userId, owner))).length, 0)
      assert.ok((await db.select().from(schema.userFacts).where(eq(schema.userFacts.userId, owner))).every(fact => fact.sourceId === null && fact.sourceKind === null && fact.evidence.length === 0))
    })
  } finally {
    if (previous.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = previous.app
    if (previous.workspace === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.workspace
    if (previous.vercel === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previous.vercel
    await Promise.all(modulePools.map(pool => pool.end()))
    await dropTestDatabase(admin, appName, app); await dropTestDatabase(admin, workspaceName, workspace); await admin.end()
  }
})
