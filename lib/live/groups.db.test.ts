import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
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

// The app's group page read its messages every 2.5–8 s, members every 60 s and reactions every 15 s.
// Now the actual writers push `group_chat` (the group's id) to its current human members only, after COMMIT.
test('group chat keys reach only current members, after the actual writer commits', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const nextServer = await import('next/server')
  mock.module('next/server', { namedExports: { ...nextServer, after: (work: () => Promise<void>) => { pending.push(work) } } })
  const channelScopes = new Map<string, LiveScope>(), unexpected: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-group-live-secret'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(input))
    assert.equal(target.hostname, 'gateway.example.invalid', 'no provider or production request is allowed')
    const scope = channelScopes.get(target.pathname)
    if (!scope) unexpected.push(target.pathname)
    const events: LiveInvalidation[] = wireKeys(JSON.parse(String(options?.body)), 'a key carries a kind and an id, never a message')
    // An older gateway refuses a kind it does not know per request: group_chat is never batched with another kind.
    if (events.some(event => event.kind === 'group_chat')) assert.ok(events.every(event => event.kind === 'group_chat'))
    // group_list (lists.db.test.ts) and bot chat keys (chats.db.test.ts) are covered there; collect the rest.
    const own = events.filter(event => event.kind === 'group_chat' || event.kind === 'bot_chat')
    if (own.length) sent.push({ scope: scope ?? { ownerId: 'unexpected', workspaceId: target.pathname }, events: own })
    return new Response(null, { status: 204 })
  })
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `group_live_${randomUUID().replaceAll('-', '')}_e2e`
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
  const owners = (values = sent) => new Set(values.map(value => value.scope.ownerId))
  // A function, not the array: an earlier assert.deepEqual(sent, []) narrows the variable to never[].
  const delivered = (): typeof sent => sent
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, dir), 'utf8'))
    for (const userId of ['owner', 'peer', 'outsider']) {
      await database.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@group.example.invalid',true,now(),now())`, [userId])
    }
    const home = randomUUID(), team = randomUUID()
    for (const ownerId of ['owner', 'peer', 'outsider']) for (const workspaceId of [home, team]) {
      const value = { ownerId, workspaceId }; channelScopes.set(`/v1/live/${liveChannelId(value)}/push`, value)
    }
    await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,'owner','Home','personal'),($2,'owner','Team','team')`, [home, team])
    // The outsider is in the team but not in the group: the group's id never reaches them.
    for (const [workspace, userId] of [[home, 'owner'], [team, 'owner'], [team, 'peer'], [team, 'outsider']]) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [workspace, userId])
    }
    const groupId = randomUUID()
    await database.query(`INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy") VALUES($1,$2,'group','Private fixture','owner')`, [groupId, team])
    await database.query(`INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,'user','owner','owner'),($1,'user','peer','member')`, [groupId])
    const key = [{ kind: 'group_chat', id: groupId }]
    const { handleGroup } = await import('../group-conversations-store')
    const directory = async (workspaceId: string, userId: string, members: { memberType: string; memberId: string }[]) => {
      if (workspaceId !== team || members.some(member => member.memberType !== 'user')) return false
      const ids = [...new Set([userId, ...members.map(member => member.memberId)])]
      const rows = await database.query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`, [workspaceId, ids])
      return rows.rowCount === ids.length
    }
    const base = { userId: 'owner', id: groupId, origin: 'https://group.example.invalid', host: 'group.example.invalid', workspaceId: team }
    let messageId = ''

    await t.test('a posted message: both members on the group workspace channel, nobody else, nothing for reads', async () => {
      sent.length = 0
      const history = await scope.run(() => handleGroup(database, directory, { ...base, method: 'GET', resource: 'messages' }))
      assert.equal(history.status, 200)
      await drain(); assert.deepEqual(sent, [], 'a read is not a write')
      const posted = await scope.run(() => handleGroup(database, directory, { ...base, userId: 'peer', method: 'POST', resource: 'messages', body: JSON.stringify({ body: 'Committed private group message' }) }))
      assert.equal(posted.status, 201)
      messageId = (posted.body as { id: string }).id
      assert.equal(pending.length > 0, true)
      await drain()
      assert.deepEqual(owners(), new Set(['owner', 'peer']))
      assert.ok(delivered().every(value => value.scope.workspaceId === team && JSON.stringify(value.events) === JSON.stringify(key)))
      sent.length = 0
      assert.equal((await scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'read', body: JSON.stringify({ messageId }) }))).status, 200)
      await drain(); assert.deepEqual(sent, [], 'a read receipt changes the list row, not the group page')
    })

    await t.test('a rejected write sends nothing', async () => {
      sent.length = 0
      const refused = await scope.run(() => handleGroup(database, directory, { ...base, userId: 'outsider', method: 'POST', resource: 'messages', body: JSON.stringify({ body: 'Not a member' }) }))
      assert.equal(refused.status, 404)
      await drain(); assert.deepEqual(sent, [])
    })

    await t.test('a reaction on a group message reaches its current members', async () => {
      const { setReaction } = await import('../reactions')
      sent.length = 0
      assert.equal(await scope.run(() => setReaction('owner', messageId, '👍')), true)
      await drain()
      assert.deepEqual(owners(), new Set(['owner', 'peer']))
      assert.ok(delivered().every(value => JSON.stringify(value.events) === JSON.stringify(key)))
      sent.length = 0
      assert.equal(await scope.run(() => setReaction('outsider', messageId, '👍')), false, 'not a member: no reaction')
      await drain(); assert.deepEqual(sent, [])
    })

    await t.test('a reaction in a bot chat goes to its owner in the bot tenant as that chat’s key', async () => {
      const { setReaction } = await import('../reactions')
      const bot = randomUUID(), botMessage = randomUUID()
      await database.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,'Scout')`, [bot, team])
      await database.query(`INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,'owner',$2,1,'{"role":"assistant","content":"Hi"}')`, [botMessage, bot])
      sent.length = 0
      assert.equal(await scope.run(() => setReaction('owner', botMessage, '❤️')), true)
      await drain()
      assert.deepEqual(sent, [{ scope: { ownerId: 'owner', workspaceId: team }, events: [{ kind: 'bot_chat', id: bot }] }])
    })

    await t.test('停止 ends who is answering: pushed after COMMIT, nothing on rollback', async () => {
      const { stopGroupTurns } = await import('../coordinator/group-turns')
      await database.query(`INSERT INTO group_turns("messageId","conversationId","userId",status) VALUES($1,$2,'peer','running')`, [messageId, groupId])
      sent.length = 0
      const client = await database.connect()
      try {
        await client.query('BEGIN')
        assert.equal(await stopGroupTurns(client, groupId), 1)
        assert.equal(pending.length, 0, 'nothing is scheduled before COMMIT')
        await client.query('ROLLBACK')
      } finally { client.release() }
      await drain(); assert.deepEqual(sent, [], 'a rolled-back stop sends nothing')
      const stopped = await scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'stop' }, true))
      assert.equal(stopped.status, 200)
      await drain()
      assert.deepEqual(owners(), new Set(['owner', 'peer']))
      assert.ok(delivered().every(value => JSON.stringify(value.events) === JSON.stringify(key)))
    })

    await t.test('a stop with nothing to stop sends nothing; a message whose COMMIT fails sends nothing', async () => {
      sent.length = 0
      const again = await scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'stop' }, true))
      assert.deepEqual(again.body, { stopped: 0 })
      await drain(); assert.deepEqual(sent, [])
      await database.query(`CREATE FUNCTION reject_group_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'group message rejected'; END $$`)
      await database.query(`CREATE CONSTRAINT TRIGGER reject_group_message AFTER INSERT ON conversation_messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_group_message()`)
      try {
        await assert.rejects(scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'messages', body: JSON.stringify({ body: 'Rolled back' }) }, true)), /group message rejected/)
        await drain(); assert.deepEqual(sent, [], 'a failed COMMIT discards the registered key')
      } finally {
        await database.query('DROP TRIGGER reject_group_message ON conversation_messages')
        await database.query('DROP FUNCTION reject_group_message()')
      }
    })

    await t.test('the reply worker: each committed turn change sends once per member, never twice in one commit', async () => {
      sent.length = 0
      // One transaction stores the message and queues its turn: one key per member.
      const posted = await scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'messages', body: JSON.stringify({ body: 'Who can take this?' }) }, true))
      assert.equal(posted.status, 201)
      await drain()
      assert.deepEqual(delivered().map(value => value.scope.ownerId).sort(), ['owner', 'peer'])
      sent.length = 0
      // The worker claims the turn, then finds its sender no longer authorized and marks it failed: two commits.
      const { processGroupTurn } = await import('../coordinator/group-turns')
      const unused = async () => { throw new Error('unused') }
      await assert.rejects(scope.run(() => processGroupTurn(database, groupId, { authorized: async () => false, agents: async () => [], route: unused, correction: unused, generate: unused })), /group_actor_no_longer_authorized/)
      assert.equal((await database.query(`SELECT status FROM group_turns WHERE "messageId"=$1`, [(posted.body as { id: string }).id])).rows[0].status, 'failed')
      await drain()
      assert.deepEqual(delivered().map(value => value.scope.ownerId).sort(), ['owner', 'owner', 'peer', 'peer'], 'running, then failed: the spinner comes and goes without a timer')
      assert.ok(delivered().every(value => value.scope.workspaceId === team && JSON.stringify(value.events) === JSON.stringify(key)))
    })

    await t.test('removing a member: the remaining member re-reads; the removed one never gets the group id again', async () => {
      sent.length = 0
      const removed = await scope.run(() => handleGroup(database, directory, { ...base, method: 'DELETE', resource: 'members', body: JSON.stringify({ memberType: 'user', memberId: 'peer' }) }))
      assert.equal(removed.status, 200)
      await drain()
      assert.deepEqual(owners(), new Set(['owner']))
      sent.length = 0
      assert.equal((await scope.run(() => handleGroup(database, directory, { ...base, method: 'POST', resource: 'messages', body: JSON.stringify({ body: 'After removal' }) }))).status, 201)
      await drain()
      assert.deepEqual(owners(), new Set(['owner']))
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
