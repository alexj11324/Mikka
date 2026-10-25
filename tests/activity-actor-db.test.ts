import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { Pool } from 'pg'

// Do not connect on developers' machines, even to a local database. In CI this
// command is required, and only the job's disposable PG17 service is admissible.
const connection = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1'
const enabled = process.env.CI === 'true' && (process.env.GITHUB_ACTIONS === 'true' || process.env.MIKKA_ISOLATED_DATA_TEST === '1') && !!connection
if (required && !enabled) throw new Error('Actor DB regression requires GitHub Actions temporary PG17')
if (enabled) {
  const url = new URL(connection!)
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(url.pathname.endsWith('_e2e'))
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
    client.release()
    await pool.end()
  }
})

test('actual action writer matrix records acting member/agent/system, ignores forged input, gates history', { skip: !enabled }, async () => {
  const { db, pool } = await import('../lib/db')
  const { eq, desc } = await import('drizzle-orm')
  const tables = await import('../lib/db/schema')
  const { issues, issueVersions, issueMembers, linearTeamSyncs, telegramLinks, telegramConversations } = tables
  const { actAs } = await import('../lib/acting-user')
  const { agentActor } = await import('../lib/activity-actor')
  const { saveIssue, listIssueVersions, setIssueScope } = await import('../app/actions/issues')
  const { updateIssueMetadata } = await import('../app/actions/issue-metadata')
  const { createLinkedIssue, updateIssueRelation } = await import('../app/actions/issue-operations')
  const { createAppIssueFromLinear, applyLinearIssueToApp } = await import('../lib/linear-sync/issue-sync')
  const { handleTelegramDirectMessage } = await import('../lib/telegram/handler')
  const owner = `actor-owner-${randomUUID()}`
  const member = `actor-member-${randomUUID()}`
  const stranger = `actor-stranger-${randomUUID()}`
  const threadId = `actor-test-${randomUUID()}`
  const telegramId = randomUUID()
  const workspaceURL = process.env.VISIBILITY_WORKSPACE_DATABASE_URL ?? connection!
  assert.ok(workspaceURL && new URL(workspaceURL).hostname === '127.0.0.1' && new URL(workspaceURL).pathname.endsWith('_e2e'))
  const workspacePool = new Pool({connectionString:workspaceURL})
  const workspace = randomUUID(), teamId = randomUUID()
  const publish = async (id: string) => {
    await pool.query("update issues set scope='workspace' where id=$1",[id])
    await workspacePool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)',[id,teamId,workspace,owner])
  }
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
    await workspacePool.query(`insert into mikka_workspaces(id,"userId",name) values($1,$2,'Actor fixture')`,[workspace,owner])
    for (const u of [owner,member]) await workspacePool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role,status) values($1,$2,$2,$3,'member','active')`,[workspace,u,u+'@example.invalid'])
    await workspacePool.query(`insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,'Actor fixture','ACT')`,[teamId,workspace,owner])
    const root = expectIssue(await actAs(owner, () => saveIssue({ ...input, actorType: 'agent', actorId: 'spoof' } as Parameters<typeof saveIssue>[0])))
    await history(root.id, 'user', owner)
    await publish(root.id)
    await db.insert(issueMembers).values({ issueId: root.id, userId: owner, memberId: member })
    let saved = expectIssue(await actAs(member, () => saveIssue({ ...input, id: root.id, revision: 1, title: 'Member edit' })))
    await history(root.id, 'user', member)
    saved = expectIssue(await actAs(member, () => updateIssueMetadata({ id: root.id, revision: saved.revision, patch: { estimate: 3 } })))
    await history(root.id, 'user', member)
    const second = expectIssue(await actAs(owner, () => saveIssue({ ...input, title: 'Relation target' })))
    await publish(second.id)
    await db.insert(issueMembers).values({ issueId: second.id, userId: owner, memberId: member })
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
    // Member-removal writer is not executed: this acceptance retains all records.
    saved = expectIssue(await actAs(owner, async () => setIssueScope({ id: root.id, revision: (await latest(root.id)).revision, scope: 'workspace' })))
    await history(root.id, 'user', owner)
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
    // Baseline Telegram emits backlog, but the current SQL check permits only
    // todo/doing/done/canceled. Preserve that unrelated contract and attest rollback.
    await assert.rejects(handleTelegramDirectMessage({ id: threadId, isDM: true, post: async (text: unknown) => { posts.push(text) } } as never,
      { author: { isBot: false, isMe: false, userId: telegramId, userName: 'Fixture' }, raw: null, text: '/confirm' } as never),
      (error: unknown) => (error as {cause?: {code?: string}}).cause?.code === '23514')
    const [conversation] = await db.select().from(telegramConversations).where(eq(telegramConversations.threadId, threadId))
    assert.equal(conversation.issueId, null)
    assert.equal(posts.length, 0)
    const visible = await actAs(owner, () => listIssueVersions(root.id))
    assert.equal(visible.find(row => row.actorId === member)?.actor?.name, 'Member')
    await assert.rejects(actAs(stranger, () => listIssueVersions(root.id)), { code: 'issueNotFound' })
    // Historical NULL identity stays NULL, not attributed to today's viewer.
    const legacy = expectIssue(await actAs(owner, () => saveIssue(input)))
    await db.update(issueVersions).set({ actorType: null, actorId: null }).where(eq(issueVersions.issueId, legacy.id))
    assert.equal((await actAs(owner, () => listIssueVersions(legacy.id)))[0].actor, null)
  } finally {
    await workspacePool.end()
    await pool.end()
  }
})
