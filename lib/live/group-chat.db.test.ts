import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import type { LiveInvalidation } from './events'
import { liveChannelId, type LiveScope } from './scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('the group chat key reaches only its participants, after real group writers commit', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next, after: (work: () => Promise<void>) => { pending.push(work) } } })
  const channelScopes = new Map<string, LiveScope>(), unexpected: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-group-chat-secret'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(input))
    assert.equal(target.hostname, 'gateway.example.invalid', 'no provider or production request is allowed')
    const scope = channelScopes.get(target.pathname)
    if (!scope) unexpected.push(target.pathname)
    const events: LiveInvalidation[] = JSON.parse(String(options?.body))
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['id', 'kind'], 'a key carries a kind and an id only')
    const chat = events.filter(event => event.kind === 'group_chat')
    if (chat.length) sent.push({ scope: scope ?? { ownerId: 'unexpected', workspaceId: target.pathname }, events: chat })
    return new Response(null, { status: 204 })
  })
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `group_chat_live_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${name}`
  const database = new Pool({ connectionString: target.toString(), max: 6 })
  observePoolCommits(database)
  const globalDb = globalThis as unknown as { workspacePool?: Pool }
  const previousWorkspace = globalDb.workspacePool
  globalDb.workspacePool = database
  const { createRequestDatabaseScope } = await import('../db/request-scope')
  const scope = createRequestDatabaseScope(target.toString())
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0).map(work => work())) }
  const deliveries = async () => { await drain(); return sent.splice(0).map(value => `${value.scope.ownerId}@${value.scope.workspaceId === team ? 'team' : value.scope.workspaceId}:${value.events.map(event => `${event.kind}:${event.id === group ? 'group' : event.id}`).join(',')}`).sort() }
  const team = randomUUID(), group = randomUUID()
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, dir), 'utf8'))
    for (const userId of ['owner', 'peer', 'outsider']) {
      await database.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@group.example.invalid',true,now(),now())`, [userId])
      const value = { ownerId: userId, workspaceId: team }; channelScopes.set(`/v1/live/${liveChannelId(value)}/push`, value)
    }
    await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,'owner','Team','team')`, [team])
    // The outsider shares the workspace but is not in the group.
    for (const userId of ['owner', 'peer', 'outsider']) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [team, userId])
    }
    await database.query(`INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy") VALUES($1,$2,'group','Private fixture','owner')`, [group, team])
    await database.query(`INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,'user','owner','owner'),($1,'user','peer','member')`, [group])
    const directory = async (workspaceId: string, userId: string, members: { memberType: string; memberId: string }[]) => {
      if (workspaceId !== team || members.some(member => member.memberType !== 'user')) return false
      const ids = [...new Set([userId, ...members.map(member => member.memberId)])]
      const rows = await database.query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`, [workspaceId, ids])
      return rows.rowCount === ids.length
    }
    const { handleGroup } = await import('../group-conversations-store')
    const base = { userId: 'owner', id: group, origin: 'https://group.example.invalid', host: 'group.example.invalid', workspaceId: team }
    const participants = ['owner@team:group_chat:group', 'peer@team:group_chat:group']

    await t.test('a stored message reaches both participants, never the workspace member outside the group; reads send nothing', async () => {
      const read = await scope.run(() => handleGroup(database, directory, { ...base, method: 'GET', resource: 'messages' }))
      assert.equal(read.status, 200)
      assert.deepEqual(await deliveries(), [], 'a history read is not a change')
      const posted = await scope.run(() => handleGroup(database, directory, { ...base, userId: 'peer', method: 'POST', resource: 'messages', body: JSON.stringify({ body: 'Committed group message' }) }, true))
      assert.equal(posted.status, 201)
      assert.deepEqual(await deliveries(), participants)
      const marked = await scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'read', body: JSON.stringify({ messageId: (posted.body as { id: string }).id }) }))
      assert.equal(marked.status, 200)
      assert.deepEqual(await deliveries(), [], 'a read receipt changes the list row, not the open chat')
    })

    await t.test('a message whose COMMIT fails sends nothing', async () => {
      await database.query(`CREATE FUNCTION reject_group_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'group message rejected'; END $$`)
      await database.query(`CREATE CONSTRAINT TRIGGER reject_group_message AFTER INSERT ON conversation_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_group_message()`)
      try {
        await assert.rejects(scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'messages', body: JSON.stringify({ body: 'Rolled back' }) }, true)), /group message rejected/)
        assert.deepEqual(await deliveries(), [], 'a failed COMMIT discards the registered key')
      } finally {
        await database.query('DROP TRIGGER reject_group_message ON conversation_messages')
        await database.query('DROP FUNCTION reject_group_message()')
      }
    })

    await t.test('the reply failing and 停止 reach the participants; a stop with nothing to stop sends nothing', async () => {
      // The queued turn from the first message: a worker that finds its sender no longer authorized marks it failed.
      const { processGroupTurn } = await import('../coordinator/group-turns')
      const refuse = async () => false
      await assert.rejects(scope.run(() => processGroupTurn(database, group, { authorized: refuse, agents: async () => [], route: async () => { throw new Error('unused') }, correction: async () => { throw new Error('unused') }, generate: async () => { throw new Error('unused') } })), /group_actor_no_longer_authorized/)
      assert.equal((await database.query(`SELECT status FROM group_turns WHERE "conversationId"=$1`, [group])).rows[0].status, 'failed')
      assert.deepEqual(await deliveries(), participants, 'the spinner goes away without a read on a timer')
      const posted = await scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'messages', body: JSON.stringify({ body: 'Another question' }) }, true))
      assert.equal(posted.status, 201)
      await deliveries()
      const stopped = await scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'stop' }, true))
      assert.deepEqual(stopped.body, { stopped: 1 })
      assert.deepEqual(await deliveries(), participants)
      const again = await scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'stop' }, true))
      assert.deepEqual(again.body, { stopped: 0 })
      assert.deepEqual(await deliveries(), [])
    })

    await t.test('a removed participant receives the key once to clear the chat, then nothing', async () => {
      const removed = await scope.run(() => handleGroup(database, directory, { ...base, method: 'DELETE', resource: 'members', body: JSON.stringify({ memberType: 'user', memberId: 'peer' }) }))
      assert.equal(removed.status, 200)
      assert.deepEqual(await deliveries(), participants)
      const posted = await scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'messages', body: JSON.stringify({ body: 'After removal' }) }))
      assert.equal(posted.status, 201)
      assert.deepEqual(await deliveries(), ['owner@team:group_chat:group'])
      await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='owner'`, [team])
      await scope.run(() => handleGroup(database, directory, { ...base, userId: 'owner', method: 'POST', resource: 'members', body: JSON.stringify({ memberType: 'user', memberId: 'peer' }) }))
      assert.deepEqual(await deliveries(), [], 'a suspended member is refused before any write')
      assert.deepEqual(unexpected, [])
    })
  } finally {
    await drain().catch(() => {})
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    globalDb.workspacePool = previousWorkspace
    await scope.close(); await database.end()
    await dropTestDatabase(admin, name); await admin.end()
    mock.restoreAll()
  }
})
