import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { dbUrl, seedIssue, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('Telegram /link resolves stable and historical task identity inside the current workspace ACL', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const connection = new Pool({ connectionString: dbUrl, max: 3 })
  const viewer = await seedUser(connection, 'telegram-viewer')
  const creator = await seedUser(connection, 'telegram-creator')
  const foreignOwner = await seedUser(connection, 'telegram-foreign')
  const workspace = await seedWorkspace(connection, creator, [{ userId: creator, role: 'admin' }, { userId: viewer, role: 'member' }])
  // Membership in another workspace must not widen this channel's binding.
  const foreign = await seedWorkspace(connection, foreignOwner, [{ userId: foreignOwner, role: 'admin' }, { userId: viewer, role: 'member' }])
  const current = await seedIssue(connection, creator, workspace.id, { registered: true })
  const anchor = await seedIssue(connection, viewer, workspace.id, { registered: true })
  const outside = await seedIssue(connection, foreignOwner, foreign.id, { registered: true })
  const telegramUserId = randomUUID(), threadId = `telegram-task-link-${randomUUID()}`, botId = randomUUID()
  await connection.query('insert into telegram_links("userId","telegramUserId") values($1,$2)', [viewer, telegramUserId])
  await connection.query('insert into telegram_conversations("threadId","userId","issueId") values($1,$2,$3)', [threadId, viewer, anchor])

  // Only the transport's already-selected Coordinator binding and translated
  // copy are fixtures. The handler, alias resolver, tenant lease and SQL ACL run.
  const intl = await import('next-intl/server')
  mock.module('next-intl/server', { namedExports: { ...intl, getLocale: async () => 'en',
    getTranslations: async () => Object.assign((key: string, values?: Record<string, unknown>) => JSON.stringify({ key, ...values }), { has: () => true }) } })
  const coordinator = await import('../lib/coordinator/coordinator-bot')
  mock.module('../lib/coordinator/coordinator-bot', { namedExports: { ...coordinator,
    coordinatorBot: async (ownerId: string, requestedWorkspace: string | null) => {
      assert.equal(ownerId, viewer)
      assert.equal(requestedWorkspace, null)
      return { botId, workspaceId: workspace.id }
    } } })
  const { handleTelegramDirectMessage } = await import('../lib/telegram/handler')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { mock.restoreAll(); await Promise.all([connection.end(), appPool.end(), workspacePool.end()]) })
  await t.test('plugin status reads the verified Telegram link for the current user only', async () => {
    const { readTelegramIntegrationStatus } = await import('../lib/telegram/connection-status')
    const own = await readTelegramIntegrationStatus(viewer)
    const other = await readTelegramIntegrationStatus(foreignOwner)
    assert.equal(own.connected, true)
    assert.ok(own.linkedAt)
    assert.equal(other.connected, false)
    assert.equal(other.linkedAt, null)
  })
  const identifier = async (issueId: string) => (await connection.query<{ issuedIdentifier: string }>('select "issuedIdentifier" from issues where id=$1', [issueId])).rows[0].issuedIdentifier
  const conversation = async () => (await connection.query('select * from telegram_conversations where "threadId"=$1', [threadId])).rows[0]
  const reset = () => connection.query('update telegram_conversations set "issueId"=$2 where "threadId"=$1', [threadId, anchor])
  const alias = (issueId: string, workspaceId: string, ownerId: string, value: string) => connection.query(
    'insert into task_identifier_aliases("issueId","workspaceId","ownerId",identifier,kind) values($1,$2,$3,$4,\'publication\')', [issueId, workspaceId, ownerId, value])
  const posts: string[] = []
  const link = async (value: string) => {
    posts.length = 0
    await handleTelegramDirectMessage({ id: threadId, isDM: true, post: async (text: string) => { posts.push(text) } } as never,
      { author: { isBot: false, isMe: false, userId: telegramUserId, userName: 'Fixture' }, raw: null, text: `/link ${value}` } as never)
    assert.equal(posts.length, 1)
    return JSON.parse(posts[0]) as { key: string; issue?: string; title?: string }
  }
  const canonical = await identifier(current)

  await t.test('canonical Workspace identifiers resolve another creator\'s ungrouped task', async () => {
    assert.match(canonical, /^W[0-9A-F]{12,32}-[1-9]\d*$/)
    assert.deepEqual(await link(canonical.toLowerCase()), { key: 'linked', issue: canonical, title: 'Task' })
    assert.equal((await conversation()).issueId, current)
  })

  await t.test('published aliases and removed Team aliases resolve without matching today\'s label', async () => {
    await alias(current, workspace.id, creator, 'OLD9-731')
    const team = await seedTeam(connection, workspace.id, creator, 'Former grouping')
    await connection.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [current, team.id, workspace.id, creator])
    const former = (await connection.query<{ identifier: string }>('select identifier from mikka_task_identifier_aliases where "issueId"=$1', [current])).rows[0].identifier
    await connection.query('delete from mikka_team_issues where "issueId"=$1', [current])
    await connection.query('delete from mikka_team_members where "teamId"=$1', [team.id])
    await connection.query('delete from mikka_teams where id=$1', [team.id])
    for (const historical of ['OLD9-731', former]) {
      assert.notEqual(historical, canonical)
      await reset()
      assert.deepEqual(await link(historical), { key: 'linked', issue: canonical, title: 'Task' })
      assert.equal((await conversation()).issueId, current)
    }
  })

  await t.test('UUID links retain the same current permission and canonical response', async () => {
    await reset()
    assert.deepEqual(await link(current), { key: 'linked', issue: canonical, title: 'Task' })
    assert.equal((await conversation()).issueId, current)
  })

  await t.test('ambiguous aliases never choose a creator or modify the existing conversation', async () => {
    await alias(current, workspace.id, creator, 'SAME8-42')
    await alias(anchor, workspace.id, viewer, 'SAME8-42')
    await reset()
    const before = await conversation()
    assert.deepEqual(await link('SAME8-42'), { key: 'ambiguous' })
    assert.deepEqual(await conversation(), before)
  })

  await t.test('other-workspace canonical, historical and UUID links cannot escape channel scope', async () => {
    await alias(outside, foreign.id, foreignOwner, 'FOREIGN7-91')
    for (const value of [await identifier(outside), 'FOREIGN7-91', outside]) {
      await reset()
      const before = await conversation()
      assert.deepEqual(await link(value), { key: 'taskUnavailable' })
      assert.deepEqual(await conversation(), before)
    }
  })

  await t.test('a uniquely resolved alias cannot grant access to a deleted task', async () => {
    const removed = await seedIssue(connection, creator, workspace.id, { registered: true })
    const label = await identifier(removed)
    const content = (await connection.query('select content from issues where id=$1', [removed])).rows[0].content
    content.attrs.mikka.deletedAt = '2026-11-08T00:00:00.000Z'
    await connection.query('update issues set content=$2 where id=$1', [removed, JSON.stringify(content)])
    for (const value of [label, removed]) {
      await reset()
      const before = await conversation()
      assert.deepEqual(await link(value), { key: 'taskUnavailable' })
      assert.deepEqual(await conversation(), before)
    }
  })

  await t.test('revoked membership rejects the same valid identifier before linking', async () => {
    await reset()
    const before = await conversation()
    await connection.query('update mikka_workspace_members set status=\'removed\' where "workspaceId"=$1 and "userId"=$2', [workspace.id, viewer])
    await assert.rejects(link(canonical), { code: 'workspaceAccessDenied' })
    assert.deepEqual(posts, [])
    assert.deepEqual(await conversation(), before)
  })
})
