// Server-side cycle guard for updateIssueRelation, against a real database.
// Runs the action through actAs (the same path MCP tools use).
// Needs MIKKA_DATABASE_URL (issues) and DATABASE_URL (workspace tables, read by issue access);
// run it via ~/.mikka/local-run.sh, which sets both to dev-local. CI runs it with REQUIRE_DB=1 once #85 (MIK-19) merges.
// Skips without them; REQUIRE_DB=1 makes a missing database a failure.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const hasDb = Boolean(process.env.MIKKA_DATABASE_URL && process.env.DATABASE_URL)
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
