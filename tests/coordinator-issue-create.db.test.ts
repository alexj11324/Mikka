import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const connection = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1'
const enabled = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && !!connection
if (required && !enabled) throw new Error('Coordinator issue creation requires GitHub Actions temporary PG17')
if (enabled) {
  const url = new URL(connection!)
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.port, '5432')
  assert.equal(url.pathname, '/mikka_e2e')
  assert.equal(url.search, '')
  assert.equal(url.hash, '')
  assert.equal(process.env.MIKKA_DATABASE_URL, connection)
  assert.equal(process.env.DATABASE_URL, connection)
}

test('authenticated request creates one real issue across ten concurrent calls and rejects invalid provenance or inaccessible bindings', { skip: !enabled }, async () => {
  const { db, pool } = await import('../lib/db')
  const { and, eq } = await import('drizzle-orm')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const { users, issues, issueVersions, coordinatorEvents } = await import('../lib/db/schema')
  const { createIssueFromRequest } = await import('../lib/coordinator/issue-create')
  const { createFactoryStore } = await import('../lib/factory/store')
  const { issueForUser } = await import('../lib/issue-access')
  const { readIssueMetadata, withIssueMetadata } = await import('../lib/issue-metadata')
  const owner = `coordinator-owner-${randomUUID()}`, stranger = `coordinator-stranger-${randomUUID()}`
  const text = 'Please implement the requested change.\nPreserve this exact source text, including <markup> and 中文.\n'
  const event = async (userId = owner, patch: Partial<typeof coordinatorEvents.$inferInsert> = {}) => {
    const id = randomUUID()
    await db.insert(coordinatorEvents).values({ id, userId, kind: 'user_message', dedupeKey: id, payload: { text }, ...patch })
    return id
  }
  const versions = async (issueId: string) => db.select().from(issueVersions).where(eq(issueVersions.issueId, issueId))
  const expectError = async (sourceEventId: string, code: string) => assert.rejects(
    createIssueFromRequest(owner, { sourceEventId, title: 'Requested task' }), { code },
  )
  try {
    assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    for (const id of [owner, stranger]) await pool.query(
      'insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())',
      [id, `${id}@example.invalid`],
    )
    const sourceEventId = await event()
    const created = await Promise.all(Array.from({ length: 10 }, () => createIssueFromRequest(owner, { sourceEventId, title: '  Implement requested change  ' })))
    const { issueId } = created[0]
    assert.ok(created.every(result => result.issueId === issueId && result.title === 'Implement requested change'))
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId))
    assert.equal(issue.userId, owner)
    assert.equal(issue.scope, 'personal')
    assert.equal(issue.status, 'todo')
    assert.equal(issue.revision, 1)
    assert.deepEqual(issue.content.content, [{ type: 'paragraph', content: [{ type: 'text', text }] }])
    assert.equal(readIssueMetadata(issue.content).number, 1)
    assert.equal((await db.select().from(issues).where(eq(issues.userId, owner))).length, 1)
    const history = await versions(issueId)
    assert.equal(history.length, 1)
    assert.equal(history[0].actorType, 'system')
    assert.equal(history[0].actorId, 'coordinator')
    assert.deepEqual(history[0].content, issue.content)
    assert.equal((await db.select().from(coordinatorEvents).where(eq(coordinatorEvents.id, sourceEventId)))[0].issueId, issueId)
    assert.deepEqual(await createIssueFromRequest(owner, { sourceEventId, title: 'Replay cannot rename' }), created[0])

    // The returned id passes the existing Factory source/issue authorization boundary.
    const factory = createFactoryStore(pool, async (userId, id, tx) => Boolean(await issueForUser(userId, id, false, drizzle(tx))))
    const routed = await factory.route(owner, { sourceEventId, issueId, eventId: sourceEventId, rationale: text, missingInformation: [], missingPermissions: [], needsSpec: false })
    assert.equal(routed.task.issueId, issueId)
    assert.equal(routed.task.stage, 'execute')
    assert.equal(routed.task.status, 'pending')

    const prebound = await event(owner, { issueId })
    assert.deepEqual(await createIssueFromRequest(owner, { sourceEventId: prebound, title: 'Existing task' }), created[0])
    assert.equal((await versions(issueId)).length, 1)
    await expectError(randomUUID(), 'factoryHumanRequired')
    await expectError(await event(stranger), 'factoryHumanRequired')
    await expectError(await event(owner, { kind: 'run_finished' }), 'factoryHumanRequired')
    for (const payload of [{}, { text: ' \n\t ' }, { text: 123 }]) await expectError(await event(owner, { payload }), 'factoryHumanRequired')
    for (const title of ['', ' '.repeat(2), 'x'.repeat(201)]) await assert.rejects(createIssueFromRequest(owner, { sourceEventId, title }), { code: 'factoryInvalid' })
    await assert.rejects(createIssueFromRequest(owner, { sourceEventId, title: 'Forged', actorId: stranger } as Parameters<typeof createIssueFromRequest>[1]), { code: 'factoryInvalid' })

    const foreign = await createIssueFromRequest(stranger, { sourceEventId: await event(stranger), title: 'Private task' })
    await expectError(await event(owner, { issueId: foreign.issueId }), 'factoryNotFound')
    await db.update(issues).set({ content: withIssueMetadata(issue.content, { ...readIssueMetadata(issue.content), deletedAt: new Date().toISOString() }) }).where(eq(issues.id, issueId))
    await expectError(sourceEventId, 'factoryNotFound')
    assert.equal((await versions(issueId)).length, 1)
    assert.equal((await db.select().from(issues).where(eq(issues.userId, owner))).length, 1)
    // A hard delete cascades the source event; replay must not replace the deleted task.
    const deletedSource = await event()
    const deleted = await createIssueFromRequest(owner, { sourceEventId: deletedSource, title: 'Deleted fixture' })
    await db.delete(issues).where(eq(issues.id, deleted.issueId))
    await expectError(deletedSource, 'factoryHumanRequired')
    assert.equal((await db.select().from(issues).where(and(eq(issues.userId, owner), eq(issues.title, 'Deleted fixture')))).length, 0)
  } finally {
    for (const id of [owner, stranger]) {
      await pool.query('delete from factory_tasks where "userId"=$1', [id])
      await db.delete(coordinatorEvents).where(eq(coordinatorEvents.userId, id))
      await db.delete(issueVersions).where(eq(issueVersions.userId, id))
      await db.delete(issues).where(eq(issues.userId, id))
      await db.delete(users).where(eq(users.id, id))
    }
    await pool.end()
    await (globalThis as unknown as { workspacePool?: { end(): Promise<void> } }).workspacePool?.end()
  }
})
