import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedCoordinator } from './support/coordinator-bot'

const connection = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Coordinator issue creation requires a loopback *_e2e database')
if (enabled) {
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
  const { coordinatorBot } = await import('../lib/coordinator/coordinator-bot')
  const { actAs } = await import('../lib/acting-user')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const owner = `coordinator-owner-${randomUUID()}`, stranger = `coordinator-stranger-${randomUUID()}`
  const sharedWorkspace = randomUUID()
  const personalBots = new Map<string, { botId: string; workspaceId: string }>()
  const text = 'Please implement the requested change.\nPreserve this exact source text, including <markup> and 中文.\n'
  const event = async (userId = owner, patch: Partial<typeof coordinatorEvents.$inferInsert> = {}) => {
    const id = randomUUID()
    await db.insert(coordinatorEvents).values({ id, userId, botId: personalBots.get(userId)!.botId, kind: 'user_message', dedupeKey: id, payload: { text }, ...patch })
    return id
  }
  const versions = async (issueId: string) => db.select().from(issueVersions).where(eq(issueVersions.issueId, issueId))
  const snapshot = async (sourceEventId: string) => ({
    issues: (await pool.query('select id,title,content,revision,"workspaceId" from issues where "userId"=$1 order by id', [owner])).rows,
    versions: (await pool.query('select id from issue_versions where "userId"=$1 order by id', [owner])).rows,
    factory: (await pool.query('select id from factory_tasks where "userId"=$1 order by id', [owner])).rows,
    counter: (await pool.query('select "lastIssueNumber" from "user" where id=$1', [owner])).rows,
    source: (await pool.query('select "issueId" from coordinator_events where id=$1', [sourceEventId])).rows,
  })
  const expectError = async (sourceEventId: string, code: string) => {
    const before = await snapshot(sourceEventId)
    await assert.rejects(createIssueFromRequest(owner, { sourceEventId, title: 'Requested task' }), { code })
    assert.deepEqual(await snapshot(sourceEventId), before, 'denied creation/replay leaves issues, history, counters, Factory and the source unchanged')
  }
  try {
    assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    for (const id of [owner, stranger]) await pool.query(
      'insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())',
      [id, `${id}@example.invalid`],
    )
    for (const id of [owner, stranger]) personalBots.set(id, await seedCoordinator(id))
    const sourceEventId = await event()
    const summary = 'Preserve the original workspace across sign-in.'
    const created = await Promise.all(Array.from({ length: 10 }, () => createIssueFromRequest(owner, { sourceEventId, title: '  Implement requested change  ', summary })))
    const { issueId } = created[0]
    assert.ok(created.every(result => result.issueId === issueId && result.title === 'Implement requested change'))
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId))
    assert.equal(issue.userId, owner)
    assert.equal(issue.scope, 'personal')
    assert.equal(issue.workspaceId, personalBots.get(owner)!.workspaceId)
    assert.equal(issue.ownershipState, 'bound')
    assert.equal(issue.status, 'todo')
    assert.equal(issue.revision, 1)
    assert.deepEqual(issue.content.content, [{ type: 'paragraph', content: [{ type: 'text', text: summary }] }])
    assert.equal(readIssueMetadata(issue.content).number, 1)
    assert.equal((await db.select().from(issues).where(eq(issues.userId, owner))).length, 1)
    const history = await versions(issueId)
    assert.equal(history.length, 1)
    assert.equal(history[0].actorType, 'system')
    assert.equal(history[0].actorId, 'coordinator')
    assert.deepEqual(history[0].content, issue.content)
    const [conversationRequest] = await db.select().from(coordinatorEvents).where(eq(coordinatorEvents.id, sourceEventId))
    assert.equal(conversationRequest.issueId, issueId)
    assert.equal(conversationRequest.payload.text, text)
    assert.deepEqual(await createIssueFromRequest(owner, { sourceEventId, title: 'Replay cannot rename', summary: 'Replay cannot replace the brief.' }), created[0])
    assert.deepEqual((await db.select().from(issues).where(eq(issues.id, issueId)))[0].content, issue.content)

    // The returned id passes the existing Factory source/issue authorization boundary.
    const factory = createFactoryStore(pool, async (userId, id, tx) => Boolean(await issueForUser(userId, id, false, drizzle(tx))), personalBots.get(owner)!.botId)
    const routed = await factory.route(owner, { sourceEventId, issueId, eventId: sourceEventId, rationale: text, missingInformation: [], missingPermissions: [], needsSpec: false })
    assert.equal(routed.task.issueId, issueId)
    assert.equal(routed.task.stage, 'execute')
    assert.equal(routed.task.status, 'pending')

    const prebound = await event(owner, { issueId })
    assert.deepEqual(await createIssueFromRequest(owner, { sourceEventId: prebound, title: 'Existing task' }), created[0])
    assert.equal((await versions(issueId)).length, 1)
    await expectError(randomUUID(), 'factoryHumanRequired')
    await expectError(await event(stranger), 'factoryHumanRequired')
    await expectError(await event(owner, { botId: null }), 'factoryHumanRequired')
    await expectError(await event(owner, { botId: personalBots.get(stranger)!.botId }), 'factoryHumanRequired')
    await expectError(await event(owner, { kind: 'run_finished' }), 'factoryHumanRequired')
    for (const payload of [{}, { text: ' \n\t ' }, { text: 123 }]) await expectError(await event(owner, { payload }), 'factoryHumanRequired')
    for (const title of ['', ' '.repeat(2), 'x'.repeat(201)]) await assert.rejects(createIssueFromRequest(owner, { sourceEventId, title }), { code: 'factoryInvalid' })
    await assert.rejects(createIssueFromRequest(owner, { sourceEventId, title: 'Forged', actorId: stranger } as Parameters<typeof createIssueFromRequest>[1]), { code: 'factoryInvalid' })

    const foreign = await createIssueFromRequest(stranger, { sourceEventId: await event(stranger), title: 'Private task' })
    const [withoutBrief] = await db.select().from(issues).where(eq(issues.id, foreign.issueId))
    assert.deepEqual(withoutBrief.content.content, [{ type: 'paragraph', content: [{ type: 'text', text: 'Private task' }] }])
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

    // The stored host Bot selects the tenant, even when the same person belongs
    // to two workspaces and the request payload names a different one.
    await pool.query('insert into mikka_workspaces (id,"userId",name,slug,kind) values ($1,$2,\'Shared source fixture\',$3,\'team\')', [sharedWorkspace, owner, `source-${sharedWorkspace}`])
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'admin\',\'active\')', [sharedWorkspace, owner, `${owner}@example.invalid`])
    const sharedBot = await coordinatorBot(owner, sharedWorkspace)
    const sharedSource = await event(owner, { botId: sharedBot.botId, payload: { text, workspaceId: personalBots.get(owner)!.workspaceId } })
    const beforePinned = await snapshot(sharedSource)
    await assert.rejects(actAs({ id: owner, [tokenWorkspace]: personalBots.get(owner)!.workspaceId }, () => createIssueFromRequest(owner, { sourceEventId: sharedSource, title: 'Wrong token workspace' })), { code: 'workspaceAccessDenied' })
    assert.deepEqual(await snapshot(sharedSource), beforePinned)
    const shared = await createIssueFromRequest(owner, { sourceEventId: sharedSource, title: 'Shared task without a Team link' })
    assert.deepEqual((await pool.query('select "workspaceId","ownershipState",scope from issues where id=$1', [shared.issueId])).rows, [{ workspaceId: sharedWorkspace, ownershipState: 'bound', scope: 'workspace' }])
    assert.equal((await pool.query('select count(*)::int n from mikka_team_issues where "issueId"=$1', [shared.issueId])).rows[0].n, 0)
    await expectError(await event(owner, { issueId: shared.issueId }), 'factoryNotFound')
    const suspendedSource = await event(owner, { botId: sharedBot.botId })
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [sharedWorkspace, owner])
    await expectError(suspendedSource, 'workspaceAccessDenied')
    await expectError(sharedSource, 'workspaceAccessDenied')
    await pool.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2', [sharedWorkspace, owner])
    assert.deepEqual(await createIssueFromRequest(owner, { sourceEventId: sharedSource, title: 'Replay after rejoining' }), shared)
  } finally {
    for (const id of [owner, stranger]) {
      await pool.query('delete from factory_tasks where "userId"=$1', [id])
      await db.delete(coordinatorEvents).where(eq(coordinatorEvents.userId, id))
      await db.delete(issueVersions).where(eq(issueVersions.userId, id))
      await db.delete(issues).where(eq(issues.userId, id))
      await pool.query('delete from bots where "ownerId"=$1', [id])
      await pool.query('delete from mikka_workspace_members where "userId"=$1', [id])
      await pool.query('delete from mikka_workspaces where "userId"=$1', [id])
      await db.delete(users).where(eq(users.id, id))
    }
    await pool.end()
    await (globalThis as unknown as { workspacePool?: { end(): Promise<void> } }).workspacePool?.end()
  }
})
