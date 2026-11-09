import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'

// No mocks for authorization, PostgreSQL or the fact ledger. Runs only against
// the existing disposable *_e2e loopback PG, exactly like the other profile tests.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no disposable test target */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching isolated PG database')
const pgTest = databaseUrl ? test : test.skip

pgTest('memory: manual idempotency, real provenance/usage, review, scoped reads/writes and short undo', async t => {
  const [{ createRequestDatabaseScope, db }, schema, { projects }, { workspaces, workspaceMembers }, memory, profile, { and, eq, inArray, sql }] = await Promise.all([
    import('../db'), import('../db/schema'), import('../db/project-schema'), import('../db/workspace-schema'),
    import('./memory'), import('./store'), import('drizzle-orm'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-memory-owner-${randomUUID()}`
  const teammate = `test-memory-peer-${randomUUID()}`
  const outsider = `test-memory-outsider-${randomUUID()}`
  const users = [owner, teammate, outsider]
  const wsA = randomUUID(), wsB = randomUUID(), wsForeign = randomUUID(), personal = randomUUID()
  const projectId = randomUUID(), botId = randomUUID()
  const cleanup = async () => {
    await db.delete(schema.userFactUses).where(inArray(schema.userFactUses.userId, users))
    await db.delete(schema.userFactUndo).where(inArray(schema.userFactUndo.userId, users))
    await db.delete(schema.userFacts).where(inArray(schema.userFacts.userId, users))
    await db.delete(schema.coordinatorSessions).where(eq(schema.coordinatorSessions.userId, owner))
    await db.delete(schema.bots).where(eq(schema.bots.ownerId, owner))
    await db.delete(projects).where(eq(projects.id, projectId))
    await db.delete(workspaceMembers).where(inArray(workspaceMembers.workspaceId, [wsA, wsB, wsForeign, personal]))
    await db.delete(workspaces).where(inArray(workspaces.id, [wsA, wsB, wsForeign, personal]))
    await db.delete(schema.users).where(inArray(schema.users.id, users))
  }
  t.after(async () => {
    try { await scope.run(cleanup) } finally { await scope.close() }
  })
  await scope.run(async () => {
    for (const id of users) await db.execute(sql`insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt")
      values (${id},${id},${`${id}@example.invalid`},false,now(),now())`)
    await db.insert(workspaces).values([
      { id: wsA, userId: owner, name: 'A' },
      { id: wsB, userId: owner, name: 'B' },
      { id: wsForeign, userId: outsider, name: 'Foreign' },
      { id: personal, userId: owner, name: 'Personal', kind: 'personal' },
    ])
    await db.insert(workspaceMembers).values([
      { workspaceId: wsA, userId: owner, name: 'Owner', email: `${owner}@example.invalid`, role: 'admin' },
      { workspaceId: wsB, userId: owner, name: 'Owner', email: `${owner}@example.invalid`, role: 'admin' },
      { workspaceId: personal, userId: owner, name: 'Owner', email: `${owner}@example.invalid`, role: 'admin' },
      { workspaceId: wsA, userId: teammate, name: 'Peer', email: `${teammate}@example.invalid`, role: 'member' },
      { workspaceId: wsForeign, userId: outsider, name: 'Outsider', email: `${outsider}@example.invalid`, role: 'admin' },
    ])
    await db.insert(projects).values({
      id: projectId, userId: owner, name: 'Private project', summary: '', description: '',
      status: 'active', priority: 'medium', lead: '', team: '', startDate: '', targetDate: '',
      issueIds: [], revision: 1,
    })
    await db.insert(schema.bots).values({ id: botId, ownerId: owner, workspaceId: wsA, name: 'Memory consumer' })
    await db.insert(schema.coordinatorSessions).values({ userId: owner, botId })

    const requestId = randomUUID()
    const manual = await memory.addMemoryFact(owner, wsA, { requestId, kind: 'preference', subject: 'Own fact', scope: { kind: 'global', ids: [] } })
    assert.ok(manual)
    assert.equal(await memory.addMemoryFact(owner, wsA, {
      requestId, kind: 'preference', subject: 'Changed replay', scope: { kind: 'global', ids: [] },
    }), manual, 'a repeated requestId never creates or edits a fact')
    assert.equal(await memory.addMemoryFact(owner, wsA, {
      requestId: randomUUID(), kind: 'preference', subject: 'Own fact', scope: { kind: 'global', ids: [] },
    }), null, 'same subject with unrelated requestId cannot overwrite')
    let view = await memory.readMemoryView(owner, wsA)
    assert.equal(view.total, 1)
    assert.equal(view.facts[0].source?.kind, 'told')
    assert.deepEqual(view.facts[0].actions, ['correct', 'remove', 'setScope'])
    assert.deepEqual(view.facts[0].recentUses, [])
    assert.equal(view.facts[0].usedCount, 0)
    assert.deepEqual((await memory.readMemoryView(teammate, wsA)).facts, [], 'same workspace is not fact sharing')
    assert.equal(await memory.removeMemoryFact(teammate, wsA, manual!), false)

    assert.equal(await memory.setMemoryFactScope(owner, wsA, manual!, { kind: 'workspaces', ids: [wsA] }), true)
    assert.deepEqual((await memory.readMemoryView(owner, wsB)).facts, [], 'fact cannot cross a workspace scope')
    assert.equal(await memory.removeMemoryFact(owner, wsB, manual!), false)
    await assert.rejects(memory.setMemoryFactScope(owner, wsA, manual!, { kind: 'workspaces', ids: [wsForeign] }), {
      code: 'workspaceAccessDenied',
    })
    await assert.rejects(memory.setMemoryFactScope(owner, wsA, manual!, { kind: 'projects', ids: [randomUUID()] }), {
      code: 'workspaceAccessDenied',
    })
    assert.equal((await memory.readMemoryView(owner, wsA)).facts.length, 1)
    assert.equal(await memory.setMemoryFactScope(owner, wsA, manual!, { kind: 'workspaces', ids: [wsA] }), true, 'same scope idempotent')

    const eventId = randomUUID()
    const event = { kind: 'thread' as const, targetId: botId, eventId, url: '/mikka/chat' }
    assert.equal(await memory.recordMemoryFactUsage(owner, wsA, event, [manual!]), 1)
    assert.equal(await memory.recordMemoryFactUsage(owner, wsA, event, [manual!]), 0, 'retry never double-counts')
    assert.equal(await memory.recordMemoryFactUsage(teammate, wsA, event, [manual!]), 0, 'other person cannot record usage')
    assert.equal(await memory.recordMemoryFactUsage(owner, wsB, event, [manual!]), 0, 'wrong workspace cannot attribute a thread')
    view = await memory.readMemoryView(owner, wsA)
    assert.equal(view.facts[0].usedCount, 1)
    assert.equal(view.facts[0].recentUses[0].url, '/mikka/chat')
    assert.equal(view.facts[0].recentUses[0].id, botId)
    assert.equal(await memory.recordMemoryFactUsage(owner, wsA,
      { ...event, eventId: randomUUID(), url: 'https://evil.invalid/capture' }, [manual!]), 1)
    assert.equal((await memory.readMemoryView(owner, wsA)).facts[0].recentUses[0].url, null, 'external URL never stored')

    // New, model-extracted facts require approval. Provenance is a trusted reference
    // supplied by the internal producer, not fabricated from old evidence.
    const at = new Date('2026-11-09T12:00:00Z')
    assert.equal(await profile.recordFacts(owner, [{
      kind: 'interest', subject: 'First candidate', value: { slot: 'hobby' },
      evidence: [], confidence: 0.5, seenAt: at, expiresAt: null,
      source: { kind: 'thread', id: botId, url: '/mikka/chat' },
    }]), 1)
    assert.equal(await profile.recordFacts(owner, [{
      kind: 'interest', subject: 'Conflicting candidate', value: { slot: 'hobby' },
      evidence: [], confidence: 0.5, seenAt: at, expiresAt: null,
    }]), 1)
    view = await memory.readMemoryView(owner, wsA)
    assert.equal(view.pending.length, 2, 'both conflicting claims await review')
    const first = view.pending.find(item => item.subject === 'First candidate')!
    const conflicting = view.pending.find(item => item.subject === 'Conflicting candidate')!
    assert.deepEqual(first.source, { kind: 'thread', id: botId, url: '/mikka/chat' })
    assert.equal(conflicting.source, null, 'no fake history')
    assert.deepEqual(first.actions.slice(0, 2), ['approve', 'reject'])
    assert.equal(await memory.recordMemoryFactUsage(owner, wsA, { ...event, eventId: randomUUID() }, [first.id]), 0, 'pending not injectable')
    assert.equal(await memory.reviewMemoryFact(owner, wsA, first.id, 'approve'), true)
    assert.equal(await memory.reviewMemoryFact(owner, wsA, first.id, 'approve'), true)
    assert.equal(await memory.reviewMemoryFact(owner, wsA, conflicting.id, 'reject'), true)
    assert.equal(await memory.reviewMemoryFact(owner, wsA, conflicting.id, 'reject'), true)
    view = await memory.readMemoryView(owner, wsA)
    assert.equal(view.pending.length, 0)
    assert.ok(view.facts.some(item => item.id === first.id))
    assert.ok(view.undoable.some(item => item.id === conflicting.id))

    // A historical record has genuinely unknown provenance and no usage.
    const legacy = randomUUID()
    await db.insert(schema.userFacts).values({
      id: legacy, userId: owner, kind: 'tool', subject: 'Legacy', subjectKey: 'legacy',
      value: {}, evidence: [], confidence: 0.5, firstSeenAt: at, lastSeenAt: at,
    })
    const legacyView = (await memory.readMemoryView(owner, wsA)).facts.find(item => item.id === legacy)!
    assert.equal(legacyView.source, null)
    assert.equal(legacyView.usedCount, 0)
    assert.deepEqual(legacyView.recentUses, [])

    // Scope to a real, owner-accessible project; it does not show in unrelated teams.
    assert.equal(await memory.setMemoryFactScope(owner, wsA, manual!, { kind: 'projects', ids: [projectId] }), true)
    assert.equal((await memory.readMemoryView(owner, wsA)).facts.some(item => item.id === manual), false)
    assert.equal((await memory.readMemoryView(owner, personal)).facts.some(item => item.id === manual), true)
    assert.equal(await memory.removeMemoryFact(owner, wsA, manual!), false, 'hidden project fact cannot be removed from A')
    assert.equal(await memory.removeMemoryFact(owner, personal, manual!), true)
    assert.equal(await memory.removeMemoryFact(owner, personal, manual!), true, 'delete retried is idempotent')
    const [scrubbed] = await db.select().from(schema.userFacts).where(eq(schema.userFacts.id, manual!))
    assert.equal(scrubbed.state, 'deleted')
    assert.deepEqual(scrubbed.value, {})
    assert.deepEqual(scrubbed.evidence, [])
    assert.equal(scrubbed.sourceKind, null)
    assert.equal(await memory.undoMemoryFact(teammate, wsA, manual!), false)
    assert.equal(await memory.undoMemoryFact(owner, personal, manual!), true)
    assert.equal(await memory.undoMemoryFact(owner, personal, manual!), true, 'undo retried is idempotent')
    assert.equal((await memory.readMemoryView(owner, personal)).facts.find(item => item.id === manual)?.source?.kind, 'told')
    assert.equal(await memory.removeMemoryFact(owner, personal, manual!), true)
    await db.update(schema.userFactUndo).set({ expiresAt: new Date(Date.now() - 2000) })
      .where(eq(schema.userFactUndo.factId, manual!))
    assert.equal(await memory.undoMemoryFact(owner, personal, manual!), false, 'expired undo is rejected')
    assert.equal((await memory.readMemoryView(owner, personal)).undoable.some(item => item.id === manual), false)
    assert.ok(await memory.purgeExpiredMemoryUndo() >= 1)
    assert.equal((await db.select().from(schema.userFactUndo).where(eq(schema.userFactUndo.factId, manual!))).length, 0)
  })
})

pgTest('memory migration is additive and idempotent on an empty old fact table', async () => {
  const [{ pool }, { readFile }] = await Promise.all([import('../db'), import('node:fs/promises')])
  const sqlText = await readFile(new URL('../../drizzle/20261109151500_memory_provenance_scope.sql', import.meta.url), 'utf8')
  const client = await pool.connect()
  try {
    await client.query('begin')
    const name = `mem_migration_${randomUUID().replaceAll('-', '')}`
    await client.query(`create schema "${name}"`)
    await client.query(`set local search_path to "${name}"`)
    await client.query('create table user_facts (id uuid primary key, "userId" text not null, state text not null default \'active\')')
    await client.query(sqlText)
    await client.query(sqlText)
    const columns = await client.query(`select column_name from information_schema.columns where table_schema = $1 and table_name = 'user_facts'`, [name])
    for (const field of ['reviewStatus', 'sourceKind', 'scopeKind', 'scopeIds', 'clientRequestId'])
      assert.ok(columns.rows.some(row => row.column_name === field), field)
  } finally {
    await client.query('rollback')
    client.release()
  }
})
