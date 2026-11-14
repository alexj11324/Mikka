import assert from 'node:assert/strict'
import { wireKeys } from './wire-keys.test-support'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'
import type { LiveInvalidation } from './events'
import { liveChannelId, type LiveScope } from './scope'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

// The app's 置顶 / 通知 used to reach the person's other screens by a 15–60 s poll; now the actual writer
// (lib/chat-preferences.ts setChatPreference) pushes the bot's chat keys in its persisted workspace.
test('a pin or mute change pushes its bot chat keys to the owner in the bot workspace, after the write', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const nextServer = await import('next/server')
  mock.module('next/server', { namedExports: { ...nextServer, after: (work: () => Promise<void>) => { pending.push(work) } } })
  const channelScopes = new Map<string, LiveScope>(), unexpected: string[] = []
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-preference-live-secret'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(input))
    assert.equal(target.hostname, 'gateway.example.invalid', 'no provider or production request is allowed')
    const scope = channelScopes.get(target.pathname)
    if (!scope) unexpected.push(target.pathname)
    const events: LiveInvalidation[] = wireKeys(JSON.parse(String(options?.body)), 'a key carries a kind and an id, never the preference')
    sent.push({ scope: scope ?? { ownerId: 'unexpected', workspaceId: target.pathname }, events })
    return new Response(null, { status: 204 })
  })
  const admin = new Pool({ connectionString: url, max: 1 })
  const name = `preference_live_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, name, 'template0')
  const target = new URL(url!); target.pathname = `/${name}`
  const database = new Pool({ connectionString: target.toString(), max: 6 })
  observePoolCommits(database)
  const globalDb = globalThis as unknown as { workspacePool?: Pool }
  const previousWorkspace = globalDb.workspacePool
  globalDb.workspacePool = database
  const { createRequestDatabaseScope } = await import('../db/request-scope')
  const scope = createRequestDatabaseScope(target.toString())
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0).map(work => work())) }
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await database.query(await readFile(new URL(file, dir), 'utf8'))
    for (const userId of ['owner', 'peer']) {
      await database.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$1||'@preference.example.invalid',true,now(),now())`, [userId])
    }
    const home = randomUUID(), team = randomUUID()
    for (const ownerId of ['owner', 'peer']) for (const workspaceId of [home, team]) {
      const value = { ownerId, workspaceId }; channelScopes.set(`/v1/live/${liveChannelId(value)}/push`, value)
    }
    await database.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES ($1,'owner','Home','personal'),($2,'owner','Team','team')`, [home, team])
    for (const [workspace, userId] of [[home, 'owner'], [team, 'owner'], [team, 'peer']]) {
      await database.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [workspace, userId])
    }
    const bot = randomUUID()
    await database.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,'Scout')`, [bot, team])
    const { setChatPreference, chatPreferences } = await import('../chat-preferences')

    await t.test('the owner gets the bot list and chat keys in the bot tenant; the personal home and other members get nothing', async () => {
      sent.length = 0
      assert.equal(await scope.run(() => setChatPreference('owner', bot, { pinned: true })), 'ok')
      await drain()
      assert.deepEqual(sent, [{ scope: { ownerId: 'owner', workspaceId: team }, events: [{ kind: 'bot_chat_list', id: team }, { kind: 'bot_chat', id: bot }] }])
      assert.equal((await scope.run(() => chatPreferences('owner')))[bot]?.pinned, true, 'the write itself is unchanged')
    })

    const { setGroupPreference, setChatOrder, MAX_PINNED_CHATS } = await import('../chat-preferences')
    const group = randomUUID()
    await database.query(`INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy") VALUES($1,$2,'group','Launch','owner')`, [group, team])
    await database.query(`INSERT INTO conversation_members("conversationId","memberType","memberId",role) VALUES($1,'user','owner','owner')`, [group])

    await t.test('a group chat the person is in takes pin, hide and mark; one they are not in takes nothing', async () => {
      assert.equal(await scope.run(() => setGroupPreference('owner', group, { hidden: true, markedUnread: true })), 'ok')
      const mine = (await scope.run(() => chatPreferences('owner')))[group]
      assert.deepEqual({ hidden: mine?.hidden, markedUnread: mine?.markedUnread, pinned: mine?.pinned }, { hidden: true, markedUnread: true, pinned: false })
      assert.equal(await scope.run(() => setGroupPreference('peer', group, { hidden: true })), 'notFound')
      await drain()
    })

    await t.test('a drag sets the pins and the list in order; a chat moved to the list is unpinned', async () => {
      assert.equal(await scope.run(() => setChatOrder('owner', { pinned: [group, bot], list: [] })), 'ok')
      let mine = await scope.run(() => chatPreferences('owner'))
      assert.deepEqual([mine[group]?.pinOrder, mine[bot]?.pinOrder, mine[group]?.pinned], [1, 2, true])
      assert.equal(await scope.run(() => setChatOrder('owner', { pinned: [bot], list: [group] })), 'ok')
      mine = await scope.run(() => chatPreferences('owner'))
      assert.deepEqual([mine[group]?.pinned, mine[group]?.listOrder, mine[bot]?.pinOrder], [false, 1, 1])
      assert.equal(await scope.run(() => setChatOrder('peer', { pinned: [bot], list: [] })), 'notFound', 'another person’s bot is refused whole')
      await drain()
    })

    await t.test('pinning past the limit is refused', async () => {
      const extra = Array.from({ length: MAX_PINNED_CHATS }, () => randomUUID())
      for (const id of extra) await database.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,$3)`, [id, team, `Extra ${id.slice(0, 8)}`])
      assert.equal(await scope.run(() => setChatOrder('owner', { pinned: extra, list: [bot, group] })), 'ok')
      assert.equal(await scope.run(() => setChatPreference('owner', bot, { pinned: true })), 'pinLimit')
      assert.equal(await scope.run(() => setGroupPreference('owner', group, { pinned: true })), 'pinLimit')
      assert.equal(await scope.run(() => setChatPreference('owner', extra[0]!, { pinned: true })), 'ok', 'a chat already pinned can be set again')
      await drain()
    })

    await t.test('a bot that is not the caller’s writes and pushes nothing', async () => {
      sent.length = 0
      assert.equal(await scope.run(() => setChatPreference('peer', bot, { muted: true })), 'notFound')
      await drain()
      assert.deepEqual(sent, [])
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
