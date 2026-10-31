// Server-side cycle guard for updateIssueRelation, against a real database.
// Runs the action through actAs (the same path MCP tools use).
// Only GitHub Actions' disposable mikka_e2e service may run this fixture.
// REQUIRE_DB=1 makes missing or foreign targets a failure before any connection.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'

let hasDb = false
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  hasDb = isE2eTarget(target.href)
    && process.env.MIKKA_DATABASE_URL === process.env.E2E_DATABASE_URL
    && process.env.DATABASE_URL === process.env.E2E_DATABASE_URL
    && (!process.env.ORVILO_DATABASE_URL || process.env.ORVILO_DATABASE_URL === process.env.E2E_DATABASE_URL)
} catch { /* no eligible ephemeral service */ }
if (!hasDb && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 but MIKKA_DATABASE_URL or DATABASE_URL is not set')

test('updateIssueRelation rejects a parent cycle on the server', { skip: !hasDb && 'no MIKKA_DATABASE_URL / DATABASE_URL' }, async () => {
  const { eq, inArray, sql } = await import('drizzle-orm')
  const { db } = await import('./db')
  const { issues, issueVersions, users } = await import('./db/schema')
  const { actAs } = await import('./acting-user')
  const { updateIssueRelation } = await import('../app/actions/issue-operations')
  const owner = `cycle-test-${randomUUID()}`
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()]
  const doc = (parentId: string | null) => ({ type: 'doc', content: [], attrs: { mikka: { parentId } } })
  // Raw SQL with every not-null column spelled out (as issue-search.db.test does), so the insert
  // does not depend on schema defaults that differ between databases.
  await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${owner}, 'Cycle Test', ${owner + '@example.test'}, false, now(), now())`)
  try {
    // a <- b <- c  (b's parent is a, c's parent is b)
    await db.insert(issues).values([
      { id: a, userId: owner, title: 'cycle a', status: 'todo', priority: 'normal', content: doc(null) },
      { id: b, userId: owner, title: 'cycle b', status: 'todo', priority: 'normal', content: doc(a) },
      { id: c, userId: owner, title: 'cycle c', status: 'todo', priority: 'normal', content: doc(b) },
    ])
    const before = await db.select().from(issues).where(inArray(issues.id, [a, b, c]))
    const revisionOf = (id: string) => before.find(row => row.id === id)!.revision

    // a -> parent c would close a loop: refused, nothing written.
    assert.deepEqual(await actAs(owner, () => updateIssueRelation({ id: a, revision: revisionOf(a), targetId: c, kind: 'parent' })), { error: 'issueParentCycle' })
    // Same loop from the other side ("c gets child a").
    assert.deepEqual(await actAs(owner, () => updateIssueRelation({ id: c, revision: revisionOf(c), targetId: a, kind: 'child' })), { error: 'issueParentCycle' })
    // Self-parent is caught before the graph walk.
    assert.deepEqual(await actAs(owner, () => updateIssueRelation({ id: a, revision: revisionOf(a), targetId: a, kind: 'parent' })), { error: 'issueSelfLink' })
    const after = await db.select().from(issues).where(inArray(issues.id, [a, b, c]))
    for (const row of after) {
      const was = before.find(item => item.id === row.id)!
      assert.equal(row.revision, was.revision, 'rejected writes do not bump revision')
      assert.deepEqual(row.content, was.content, 'rejected writes do not change relations')
    }

    // Control: a non-cycle (c -> parent a) is written, so the rejections above come from the cycle guard.
    // Scheduling Linear work after commit fails here (no request for `after`); that is logged
    // only, so the action still returns the saved issue.
    const saved = await actAs(owner, () => updateIssueRelation({ id: c, revision: revisionOf(c), targetId: a, kind: 'parent' }))
    assert.ok('issue' in saved, `expected { issue }, got ${JSON.stringify(saved)}`)
    assert.equal(saved.issue.id, c)
    assert.equal(saved.issue.revision, revisionOf(c) + 1)
    const [moved] = await db.select().from(issues).where(eq(issues.id, c))
    assert.equal(moved.revision, revisionOf(c) + 1)
    assert.equal((moved.content as { attrs: { mikka: { parentId: string } } }).attrs.mikka.parentId, a)
  } finally {
    await db.delete(issueVersions).where(inArray(issueVersions.issueId, [a, b, c]))
    await db.delete(issues).where(inArray(issues.id, [a, b, c]))
    await db.delete(users).where(eq(users.id, owner))
  }
})

// A graph read may inspect every owner issue, but it must not lock unrelated
// rows. Keep the existing owner graph lock so concurrent, disjoint edits cannot
// independently pass a cycle check against an obsolete graph.
test('relation edits lock only their pair while preserving concurrent graph cycle checks', { skip: !hasDb && 'no isolated database' }, async t => {
  const { eq, inArray, sql } = await import('drizzle-orm')
  const { db, pool, withDatabaseClient } = await import('./db')
  const { issues, issueVersions, users } = await import('./db/schema')
  const { actAs } = await import('./acting-user')
  const { updateIssueRelation } = await import('../app/actions/issue-operations')
  const owner = `relation-locks-${randomUUID()}`
  const [a, b, c, d, unrelated] = Array.from({ length: 5 }, () => randomUUID())
  const ids = [a, b, c, d, unrelated]
  const doc = (metadata: object = {}) => ({ type: 'doc', content: [], attrs: { mikka: metadata } })
  await db.execute(sql`insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values (${owner},'Relation Locks',${owner + '@example.test'},false,now(),now())`)
  try {
    await db.insert(issues).values(ids.map(id => ({ id, userId: owner, title: 'relation lock fixture', status: 'todo', priority: 'normal', content: doc() })))

    await t.test('an unrelated write lock does not block an edge edit or its full graph read', async () => {
      const blocker = await pool.connect()
      const writer = await pool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [unrelated])
        await writer.query("SET lock_timeout='1s'")
        // This used to time out on the full-owner FOR UPDATE scan. A parent
        // edit also exercises the now nonlocking transitive graph read.
        const result = await withDatabaseClient(writer, () => actAs(owner, () => updateIssueRelation({ id: a, revision: 1, targetId: b, kind: 'parent' })))
        assert.ok('issue' in result, JSON.stringify(result))
        assert.equal(result.issue.id, a)
        assert.equal((result.issue.content.attrs as { mikka: { parentId: string } }).mikka.parentId, b)
        assert.equal((await blocker.query('SELECT id FROM issues WHERE id=$1', [unrelated])).rowCount, 1)
      } finally {
        await blocker.query('ROLLBACK')
        await writer.query('RESET lock_timeout')
        blocker.release(); writer.release()
      }
    })

    for (const [kind, field, cycleError] of [
      ['parent', 'parentId', 'issueParentCycle'],
      ['duplicate', 'duplicateOfId', 'issueDuplicateCycle'],
      ['blockedBy', 'blockedByIds', 'issueBlockCycle'],
    ] as const) {
      await t.test(`${kind}: concurrent disjoint edges cannot jointly close a transitive cycle`, async () => {
        // Existing A -> B and C -> D; B -> C plus D -> A would close a loop.
        // The two edits touch disjoint row pairs, so row locks alone cannot
        // serialize their graph observations.
        for (const id of [a, b, c, d]) {
          const target = id === a ? b : id === c ? d : null
          await db.update(issues).set({ content: doc({ [field]: field === 'blockedByIds' ? target ? [target] : [] : target }), revision: sql`${issues.revision} + 1`, status: 'todo' }).where(eq(issues.id, id))
        }
        const revisions = new Map((await db.select({ id: issues.id, revision: issues.revision }).from(issues).where(inArray(issues.id, [b, d]))).map(row => [row.id, row.revision]))
        const gate = await pool.connect(), left = await pool.connect(), right = await pool.connect()
        let edits: ReturnType<typeof updateIssueRelation>[] = []
        try {
          await gate.query('BEGIN')
          await gate.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [owner])
          await left.query("SET lock_timeout='5s'")
          await right.query("SET lock_timeout='5s'")
          const leftPid = (await left.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
          const rightPid = (await right.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
          edits = [
            withDatabaseClient(left, () => actAs(owner, () => updateIssueRelation({ id: b, revision: revisions.get(b)!, targetId: c, kind }))),
            withDatabaseClient(right, () => actAs(owner, () => updateIssueRelation({ id: d, revision: revisions.get(d)!, targetId: a, kind }))),
          ]
          const deadline = Date.now() + 3000
          let waiting = 0
          while (Date.now() < deadline) {
            waiting = Number((await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event='advisory'`, [[leftPid, rightPid]])).rows[0].n)
            if (waiting === 2) break
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          assert.equal(waiting, 2, 'both graph edits must serialize on the existing owner advisory lock')
          await gate.query('ROLLBACK')
          const results = await Promise.all(edits)
          assert.equal(results.filter(result => 'issue' in result).length, 1, JSON.stringify(results))
          assert.equal(results.filter(result => 'error' in result && result.error === cycleError).length, 1, JSON.stringify(results))
        } finally {
          await gate.query('ROLLBACK')
          await Promise.allSettled(edits)
          await left.query('RESET lock_timeout'); await right.query('RESET lock_timeout')
          gate.release(); left.release(); right.release()
        }
      })
    }
  } finally {
    await db.delete(issueVersions).where(inArray(issueVersions.issueId, ids))
    await db.delete(issues).where(inArray(issues.id, ids))
    await db.delete(users).where(eq(users.id, owner))
  }
})
