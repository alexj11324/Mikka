import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import { botChatTargets, runBotChatTargets } from './chats'
import type { LiveInvalidation } from './events'
import { liveChannelId, type LiveScope } from './scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('bot chat keys reach only the owner in the bot workspace, after the actual writer commits', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const nextServer = await import('next/server')
  mock.module('next/server', { namedExports: { ...nextServer, after: (work: () => Promise<void>) => { pending.push(work) } } })
  // Run writers also wake thread panels; panels.db.test.ts covers those keys.
  const panels = await import('./panels')
  mock.module(new URL('./panels.ts', import.meta.url).href, { namedExports: Object.fromEntries(Object.entries(panels).map(([name, value]) =>
    [name, name.endsWith('ScopesBeforeChange') ? async () => [] : name.endsWith('Changed') ? async () => {} : value])) })
  const channelScopes = new Map<string, LiveScope>(), unexpected: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-chat-live-secret'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(input))
    assert.equal(target.hostname, 'gateway.example.invalid', 'no provider or production request is allowed')
    const scope = channelScopes.get(target.pathname)
    if (!scope) unexpected.push(target.pathname)
    const events: LiveInvalidation[] = wireKeys(JSON.parse(String(options?.body)), 'a key carries a kind and an id, never a message')
    // The same writers wake an MCP reply wait on the bot's workspace; lib/mcp/reply-live.db.test.ts covers that key.
    const chatEvents = events.filter(event => event.kind !== 'coordinator_session')
    if (chatEvents.length) sent.push({ scope: scope ?? { ownerId: 'unexpected', workspaceId: target.pathname }, events: chatEvents })
    return new Response(null, { status: 204 })
  })
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `chat_live_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${name}`
  const database = new Pool({ connectionString: target.toString(), max: 6 })
  observePoolCommits(database)
  const globalDb = globalThis as unknown as { workspacePool?: Pool }
  const previousWorkspace = globalDb.workspacePool
  globalDb.workspacePool = database
  const { db, createRequestDatabaseScope, withDatabaseTransaction } = await import('../db/request-scope')
  const scope = createRequestDatabaseScope(target.toString())
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0).map(work => work())) }
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, dir), 'utf8'))
    for (const userId of ['owner', 'peer', 'foreign']) {
      await database.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@chat.example.invalid',true,now(),now())`, [userId])
    }
    const home = randomUUID(), team = randomUUID(), foreignHome = randomUUID()
    for (const ownerId of ['owner', 'peer', 'foreign']) for (const workspaceId of [home, team, foreignHome]) {
      const value = { ownerId, workspaceId }; channelScopes.set(`/v1/live/${liveChannelId(value)}/push`, value)
    }
    for (const [id, owner, kind] of [[home, 'owner', 'personal'], [team, 'owner', 'team'], [foreignHome, 'foreign', 'personal']]) {
      await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,$2,'Fixture',$3)`, [id, owner, kind])
    }
    // The peer shares the owner's home and team; neither makes the owner's chat theirs.
    for (const [workspace, userId] of [[home, 'owner'], [home, 'peer'], [team, 'owner'], [team, 'peer'], [foreignHome, 'foreign']]) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [workspace, userId])
    }
    const bot = randomUUID(), foreignBot = randomUUID(), agent = randomUUID()
    await database.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,'Scout'),($3,'foreign',$4,'Other')`, [bot, team, foreignBot, foreignHome])
    await database.query(`INSERT INTO agents(id,"userId",name,harness) VALUES($1,'owner','Fixture','codex')`, [agent])
    const run = async (botId: string | null) => {
      const id = randomUUID()
      await database.query(`INSERT INTO agent_runs(id,"userId","agentId","botId",status,prompt) VALUES($1,'owner',$2,$3,'running','Fixture')`, [id, agent, botId])
      return id
    }
    const botRun = await run(bot), plainRun = await run(null)
    const keys = (botId: string) => [{ scope: { ownerId: 'owner', workspaceId: team }, events: [{ kind: 'bot_chat_list', id: team }, { kind: 'bot_chat', id: botId }] }]

    await t.test('a chat key stays in the bot tenant and reaches only its current owner member', async () => {
      assert.deepEqual(await botChatTargets(database, database, 'owner', bot), keys(bot), 'the personal home and another workspace member receive no private chat key')
      assert.deepEqual(await botChatTargets(database, database, 'owner', foreignBot), [],
        'a caller cannot route another owner’s bot ID onto this channel')
      assert.deepEqual(await botChatTargets(database, database, 'peer', bot), [], 'sharing a workspace does not grant ownership of another member’s chat')
      assert.deepEqual(await runBotChatTargets(database, database, botRun), [{ scope: { ownerId: 'owner', workspaceId: team }, events: [{ kind: 'bot_chat', id: bot }] }])
      assert.deepEqual(await runBotChatTargets(database, database, plainRun), [])
      await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='owner'`, [team])
      assert.deepEqual(await botChatTargets(database, database, 'owner', bot), [])
      await database.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='owner'`, [team])
    })

    await t.test('the actual turn writers publish once after COMMIT and nothing on rollback', async () => {
      const store = await import('../coordinator/store')
      await database.query(`INSERT INTO coordinator_sessions("userId","botId","leaseHolder","leaseUntil") VALUES('owner',$1,'fixture-holder',now()+interval '5 minutes')`, [bot])
      await database.query(`INSERT INTO coordinator_messages(id,"userId","botId",position,message) VALUES($1,'owner',$2,1,'{"role":"user","content":"Hello"}')`, [randomUUID(), bot])
      sent.length = 0
      await assert.rejects(scope.run(() => db.transaction(outer => withDatabaseTransaction(outer, async () => {
        await store.failTurn('owner', 'fixture-holder', 'fixture failure', bot)
        assert.equal(pending.length, 0, 'nothing is scheduled before COMMIT')
        throw new Error('outer rollback')
      }))), /outer rollback/)
      await drain(); assert.deepEqual(sent, [], 'a rolled-back turn failure sends nothing')
      assert.equal((await database.query(`SELECT "leaseHolder" FROM coordinator_sessions WHERE "botId"=$1`, [bot])).rows[0].leaseHolder, 'fixture-holder')
      await scope.run(() => store.failTurn('owner', 'fixture-holder', 'fixture failure', bot))
      await drain()
      assert.deepEqual(sent, keys(bot))
      sent.length = 0
      await scope.run(() => store.failTurn('owner', 'fixture-holder', 'fixture failure', bot))
      await drain(); assert.deepEqual(sent, [], 'a lease already released is not a new change')
    })

    await t.test('an inbox event and a run state change wake the chat; membership is rechecked after scheduling', async () => {
      const { recordCoordinatorEvent } = await import('../coordinator-event-store')
      const { userMessageEvent } = await import('../coordinator-events')
      const { runListChanged } = await import('./lists')
      sent.length = 0
      await scope.run(() => recordCoordinatorEvent(db, userMessageEvent('owner', 'A new question', { botId: bot })))
      await drain(); assert.deepEqual(sent, keys(bot))
      sent.length = 0
      await scope.run(() => db.transaction(outer => withDatabaseTransaction(outer, async () => {
        await outer.execute(sql`UPDATE agent_runs SET status='waiting_input' WHERE id=${botRun}`)
        await runListChanged(outer, botRun)
      })))
      await drain()
      assert.ok(sent.some(value => value.scope.ownerId === 'owner' && value.scope.workspaceId === team && value.events.some(event => event.kind === 'bot_chat' && event.id === bot)))
      assert.ok(sent.every(value => value.scope.ownerId === 'owner' && value.scope.workspaceId === team))
      sent.length = 0
      await scope.run(() => runListChanged(db, botRun, true)); await drain()
      assert.ok(!sent.some(value => value.events.some(event => event.kind === 'bot_chat')), 'a reply preview is not a state change on the card')
      sent.length = 0
      await scope.run(() => recordCoordinatorEvent(db, userMessageEvent('owner', 'Another question', { botId: bot })))
      await database.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='owner'`, [team])
      await drain(); assert.deepEqual(sent, [], 'membership lost between COMMIT and delivery suppresses this tenant’s keys')
      await database.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='owner'`, [team])
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
