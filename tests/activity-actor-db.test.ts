import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { Pool } from 'pg'

// Do not connect on developers' machines, even to a local database. In CI this
// command is required, and only the job's disposable PG17 service is admissible.
const connection = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1'
const enabled = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && !!connection
if (required && !enabled) throw new Error('Actor DB regression requires GitHub Actions temporary PG17')
if (enabled) {
  const url = new URL(connection!)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.pathname, '/mikka_e2e')
  assert.equal(process.env.MIKKA_DATABASE_URL, connection)
}

test('actor migration: legacy rows stay NULL, reruns preserve identity, new rows enforce type', { skip: !enabled }, async () => {
  const pool = new Pool({ connectionString: connection, max: 1 })
  const schema = `actor_${randomUUID().replaceAll('-', '')}`
  const client = await pool.connect()
  try {
    assert.equal((await client.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    await client.query(`create schema "${schema}"`)
    await client.query('begin')
    await client.query(`set local search_path to "${schema}"`)
    await client.query('create table issue_versions(id text primary key)')
    await client.query("insert into issue_versions(id) values ('legacy')")
    const file = readdirSync('drizzle').find(file => file.endsWith('_activity_version_actor.sql'))!
    const migration = readFileSync(`drizzle/${file}`, 'utf8')
    await client.query(migration)
    await client.query("insert into issue_versions values ('person','user','member'),('agent','agent','verified-agent'),('job','system','linear')")
    await client.query(migration)
    assert.deepEqual((await client.query("select actor_type,actor_id from issue_versions where id='legacy'")).rows, [{ actor_type: null, actor_id: null }])
    assert.deepEqual((await client.query("select actor_type,actor_id from issue_versions where id='person'")).rows, [{ actor_type: 'user', actor_id: 'member' }])
    for (const values of ["('bad','forged','x')", "('bad',null,'x')"]) {
      await client.query('savepoint invalid_actor')
      await assert.rejects(client.query(`insert into issue_versions values ${values}`), { code: '23514' })
      await client.query('rollback to savepoint invalid_actor')
    }
    await client.query('commit')
  } finally {
    await client.query('rollback')
    await client.query(`drop schema if exists "${schema}" cascade`)
    client.release()
    await pool.end()
  }
})

test('actual action writer matrix records acting member/agent/system, ignores forged input, gates history', { skip: !enabled }, async () => {
  const { db, pool } = await import('../lib/db')
  const { eq, desc } = await import('drizzle-orm')
  const tables = await import('../lib/db/schema')
  const { users, issues, issueVersions, issueMembers, linearTeamSyncs, linearIssueLinks, issueDocuments, telegramLinks, telegramConversations } = tables
  const { actAs } = await import('../lib/acting-user')
  const { agentActor } = await import('../lib/activity-actor')
  const { saveIssue, listIssueVersions, setIssueScope } = await import('../app/actions/issues')
  const { updateIssueMetadata } = await import('../app/actions/issue-metadata')
  const { readIssueMetadata, withIssueMetadata } = await import('../lib/issue-metadata')
  const { createLinkedIssue, updateIssueRelation } = await import('../app/actions/issue-operations')
  const { removeMember } = await import('../app/actions/collaboration')
  const { createAppIssueFromLinear, applyLinearIssueToApp } = await import('../lib/linear-sync/issue-sync')
  const { handleTelegramDirectMessage } = await import('../lib/telegram/handler')
  const owner = `actor-owner-${randomUUID()}`
  const member = `actor-member-${randomUUID()}`
  const stranger = `actor-stranger-${randomUUID()}`
  const threadId = `actor-test-${randomUUID()}`
  const telegramId = randomUUID()
  const workspace = randomUUID(), workspaceTeam = randomUUID()
  const input = { title: 'Actor regression', content: { type: 'doc', content: [{ type: 'paragraph' }] }, status: 'todo' as const, priority: 'normal' as const }
  const expectIssue = (result: unknown): typeof issues.$inferSelect => {
    assert.ok(result && typeof result === 'object' && 'issue' in result, JSON.stringify(result))
    return (result as { issue: typeof issues.$inferSelect }).issue
  }
  const latest = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]
  const history = async (id: string, type: string, actorId: string | null) => {
    const [row] = await db.select().from(issueVersions).where(eq(issueVersions.issueId, id)).orderBy(desc(issueVersions.revision)).limit(1)
    assert.ok(row)
    assert.deepEqual({ type: row.actorType, id: row.actorId }, { type, id: actorId })
  }
  try {
    for (const [id, name] of [[owner, 'Owner'], [member, 'Member'], [stranger, 'Stranger']]) {
      await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$2,$3,false,now(),now())', [id, name, `${id}@example.invalid`])
    }
    // R-26: a nonowner sees a task only when it is workspace-scoped and linked
    // to a team in a workspace where they are active. The stranger is not a member.
    await pool.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,$3)', [workspace, owner, `Actor ${workspace}`])
    for (const user of [owner, member]) await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'member\',\'active\')', [workspace, user, `${user}@example.invalid`])
    await pool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Actor\',\'ACX\')', [workspaceTeam, workspace, owner])
    // Share a task the way the product does: owner flips it to workspace scope,
    // it is linked to the team, and the legacy invitation the write actions
    // still require for nonowners is present.
    const share = async (id: string) => {
      expectIssue(await actAs(owner, async () => setIssueScope({ id, revision: (await latest(id)).revision, scope: 'workspace' })))
      await history(id, 'user', owner)
      await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id, workspaceTeam, workspace, owner])
      await db.insert(issueMembers).values({ issueId: id, userId: owner, memberId: member })
      return (await latest(id)).revision
    }
    const root = expectIssue(await actAs(owner, () => saveIssue({ ...input, actorType: 'agent', actorId: 'spoof' } as Parameters<typeof saveIssue>[0])))
    await history(root.id, 'user', owner)
    const shared = await share(root.id)
    let saved = expectIssue(await actAs(member, () => saveIssue({ ...input, id: root.id, revision: shared, title: 'Member edit' })))
    await history(root.id, 'user', member)
    saved = expectIssue(await actAs(member, () => updateIssueMetadata({ id: root.id, revision: saved.revision, patch: { estimate: 3 } })))
    await history(root.id, 'user', member)
    const second = expectIssue(await actAs(owner, () => saveIssue({ ...input, title: 'Relation target' })))
    await share(second.id)
    saved = expectIssue(await actAs(member, () => updateIssueRelation({ id: root.id, revision: saved.revision, kind: 'related', targetId: second.id })))
    await history(root.id, 'user', member)
    await history(second.id, 'user', member)
    const child = expectIssue(await actAs(member, () => createLinkedIssue({ id: root.id, revision: saved.revision, kind: 'child', title: 'Child' })))
    await history(child.id, 'user', member)
    const duplicate = expectIssue(await actAs(owner, () => createLinkedIssue({ id: root.id, revision: saved.revision, kind: 'duplicate', includeSubissues: true })))
    await history(duplicate.id, 'user', owner)
    const copies = await db.select().from(issues).where(eq(issues.userId, owner))
    const copiedChild = copies.find(row => (row.content.attrs?.mikka as { parentId?: string } | undefined)?.parentId === duplicate.id)
    assert.ok(copiedChild, 'duplicate path actually copied its child')
    await history(copiedChild.id, 'user', owner)
    saved = expectIssue(await actAs(owner, () => updateIssueMetadata({ id: root.id, revision: saved.revision, patch: { assignee: { kind: 'member', id: member } } })))
    // R-60: crafted action input cannot assign a hidden execution identity.
    const rejectedAssignee = await actAs(owner, () => updateIssueMetadata({
      id: root.id, revision: saved.revision, patch: { assignee: { kind: 'agent', id: randomUUID() } },
    } as unknown as Parameters<typeof updateIssueMetadata>[0]))
    assert.deepEqual(rejectedAssignee, { error: 'issueMetadataInvalid' })
    assert.equal((await latest(root.id)).revision, saved.revision)
    assert.equal(readIssueMetadata((await latest(root.id)).content).assignee?.id, member)
    assert.deepEqual(await actAs(owner, () => removeMember(root.id, member)), { success: true })
    await history(root.id, 'user', owner)
    // Root was shared above; flipping it back to personal is the scope writer
    // under test here, and it immediately gates the former viewer's history read.
    saved = expectIssue(await actAs(owner, async () => setIssueScope({ id: root.id, revision: (await latest(root.id)).revision, scope: 'personal' })))
    await history(root.id, 'user', owner)
    await assert.rejects(actAs(member, () => listIssueVersions(root.id)), { code: 'issueNotFound' })
    const agentId = randomUUID()
    const agent = expectIssue(await actAs(owner, () => saveIssue({ ...input, actorType: 'user', actorId: 'spoof' } as Parameters<typeof saveIssue>[0]), agentActor(agentId)))
    await history(agent.id, 'agent', agentId)
    expectIssue(await actAs(owner, () => saveIssue({ ...input, id: agent.id, revision: 1, title: 'Agent edit' }), agentActor(agentId)))
    await history(agent.id, 'agent', agentId)
    // Linear import/update exercise the actual local synchronization writers;
    // no remote API, token or customer data is involved.
    const [team] = await db.insert(linearTeamSyncs).values({ id: randomUUID(), ownerId: owner, linearTeamId: randomUUID(), linearTeamKey: 'ACT', linearTeamName: 'Actor fixture' }).returning()
    const remote = { id: randomUUID(), identifier: 'ACT-1', title: 'Remote fixture', description: '', dueDate: null, priority: 0, url: 'https://example.invalid/fixture', updatedAt: new Date().toISOString(), state: null, team: { id: team.linearTeamId, key: 'ACT', name: team.linearTeamName }, assignee: null, labels: [] }
    const imported = await createAppIssueFromLinear(team, remote)
    await history(imported.id, 'system', 'linear')
    await applyLinearIssueToApp(team, { ...remote, title: 'Remote changed', updatedAt: new Date(Date.now() + 10000).toISOString() }, true)
    await history(imported.id, 'system', 'linear')
    assert.equal((await latest(imported.id)).revision, 2)
    await db.insert(telegramLinks).values({ userId: owner, telegramUserId: telegramId })
    await db.insert(telegramConversations).values({ threadId, userId: owner, draftTitle: 'Telegram fixture' })
    const posts: unknown[] = []
    await handleTelegramDirectMessage({ id: threadId, isDM: true, post: async (text: unknown) => { posts.push(text) } } as never,
      { author: { isBot: false, isMe: false, userId: telegramId, userName: 'Fixture' }, raw: null, text: '/confirm' } as never)
    const [conversation] = await db.select().from(telegramConversations).where(eq(telegramConversations.threadId, threadId))
    assert.ok(conversation.issueId)
    await history(conversation.issueId, 'user', owner)
    assert.equal(posts.length, 1)
    const visible = await actAs(owner, () => listIssueVersions(root.id))
    assert.equal(visible.find(row => row.actorId === member)?.actor?.name, 'Member')
    await assert.rejects(actAs(stranger, () => listIssueVersions(root.id)), { code: 'issueNotFound' })
    // Historical NULL identity stays NULL, not attributed to today's viewer.
    const legacy = expectIssue(await actAs(owner, () => saveIssue(input)))
    await db.update(issueVersions).set({ actorType: null, actorId: null }).where(eq(issueVersions.issueId, legacy.id))
    assert.equal((await actAs(owner, () => listIssueVersions(legacy.id)))[0].actor, null)
    // Old execution-assignee metadata is retained when an unrelated property changes.
    const legacyAssignee = { kind: 'agent' as const, id: randomUUID(), name: 'Historical executor', image: null }
    const legacyContent = withIssueMetadata(legacy.content, { ...readIssueMetadata(legacy.content), assignee: legacyAssignee })
    await db.update(issues).set({ content: legacyContent }).where(eq(issues.id, legacy.id))
    const editedLegacy = expectIssue(await actAs(owner, () => updateIssueMetadata({ id: legacy.id, revision: legacy.revision, patch: { estimate: 8 } })))
    assert.deepEqual(readIssueMetadata(editedLegacy.content).assignee, legacyAssignee)
  } finally {
    const owned = await db.select({ id: issues.id }).from(issues).where(eq(issues.userId, owner))
    for (const { id } of owned) {
      await db.delete(linearIssueLinks).where(eq(linearIssueLinks.issueId, id))
      await db.delete(issueDocuments).where(eq(issueDocuments.issueId, id))
      await db.delete(issueMembers).where(eq(issueMembers.issueId, id))
      await db.delete(issueVersions).where(eq(issueVersions.issueId, id))
    }
    await pool.query('delete from mikka_team_issues where "teamId"=$1', [workspaceTeam])
    await pool.query('delete from mikka_teams where id=$1', [workspaceTeam])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=$1', [workspace])
    await pool.query('delete from mikka_workspaces where id=$1', [workspace])
    await db.delete(telegramConversations).where(eq(telegramConversations.threadId, threadId))
    await db.delete(telegramLinks).where(eq(telegramLinks.userId, owner))
    await db.delete(issues).where(eq(issues.userId, owner))
    await db.delete(linearTeamSyncs).where(eq(linearTeamSyncs.ownerId, owner))
    for (const id of [owner, member, stranger]) await db.delete(users).where(eq(users.id, id))
    await pool.end()
  }
})
