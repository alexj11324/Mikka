import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { MCP_REPLY_CHANNEL, listenOn, notifyChannel, subscribeShared } from '../db/listen'
import { coordinatorSessionScope } from '../live/coordinator-session'
import { observeReplySignals } from './reply-signals'
import { waitForReply } from './reply-wait'

const target = process.env.E2E_DATABASE_URL
const valid = Boolean(target && disposableDatabase(process.env, target))
if (process.env.REQUIRE_DB === '1') assert.ok(valid, 'an isolated loopback *_e2e database is required')

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Committed PG notification did not arrive')), 5_000)
    })])
  } finally { clearTimeout(timer) }
}

/** A writer COMMIT need not have reached the shared LISTEN socket yet. Consume
 * a later marker on that same session before attaching the measured waiter. */
async function fixtureCommitBarrier(database: Pool) {
  const key = 'fixture-barrier:' + randomUUID(), controller = new AbortController()
  const subscription = await subscribeShared(database, MCP_REPLY_CHANNEL, [key], controller.signal)
  assert.ok(subscription, 'the fixture barrier needs the actual shared LISTEN session')
  try {
    const delivered = subscription.next(2_147_483_647, controller.signal)
    await notifyChannel(database, MCP_REPLY_CHANNEL, [key])
    await bounded(delivered)
    assert.equal(subscription.lost, false, 'connection loss is not a committed fixture barrier')
  } finally { controller.abort(); subscription.close() }
}

// Only the four notification tables are needed here. The normal migration and
// existing reply-live DB suite exercise the complete schema and actual writers.
const tables = `
  CREATE TABLE bots(id uuid PRIMARY KEY, "ownerId" text, "workspaceId" uuid);
  CREATE TABLE coordinator_messages(id uuid PRIMARY KEY, "userId" text, "botId" uuid, position integer, message jsonb);
  CREATE TABLE coordinator_sessions("userId" text, "botId" uuid, "leaseHolder" text, "leaseUntil" timestamptz,
    "lastError" text, "lastErrorAt" timestamptz, summary text);
  CREATE TABLE mikka_workspace_members("workspaceId" uuid, "userId" text, status text);
  CREATE TABLE mikka_workspaces(id uuid PRIMARY KEY, "userId" text, kind text);
`

test('PG reply triggers are transaction-bound and cover both databases and scope loss', { skip: !valid, timeout: 120_000 }, async t => {
  const admin = new Pool({ connectionString: target, max: 1 })
  const names = [`mcp_reply_app_${randomUUID().replaceAll('-', '')}_e2e`, `mcp_reply_workspace_${randomUUID().replaceAll('-', '')}_e2e`]
  const pools: Pool[] = []
  const created: string[] = []
  const appSql = await readFile(new URL('../../drizzle/20261107120001_mcp_reply_notifications.sql', import.meta.url), 'utf8')
  const workspaceSql = await readFile(new URL('../../drizzle/20261107120002_mcp_membership_notifications.sql', import.meta.url), 'utf8')
  try {
    for (const name of names) {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`)
      created.push(name)
      const url = new URL(target!); url.pathname = '/' + name
      const pool = new Pool({ connectionString: url.toString(), max: 3 })
      pools.push(pool)
      await pool.query(tables)
    }
    const [app, workspace] = pools
    await app.query(appSql)
    await workspace.query(workspaceSql)
    // Preview/local CI can put both migration targets into one database.
    await app.query(workspaceSql)

    await t.test('same target options use one physical LISTEN, while the second database uses its own', async () => {
      const [one, two, other] = await Promise.all([
        subscribeShared(app, MCP_REPLY_CHANNEL, ['bot:one']),
        subscribeShared({ options: { ...app.options } }, MCP_REPLY_CHANNEL, ['member:one']),
        subscribeShared(workspace, MCP_REPLY_CHANNEL, ['member:one']),
      ])
      assert.ok(one && two && other)
      try {
        const result = await admin.query<{ datname: string; n: number }>(`SELECT datname,count(*)::int AS n FROM pg_stat_activity
          WHERE datname=ANY($1::text[]) AND application_name='mikka-listen' GROUP BY datname`, [names])
        assert.deepEqual(result.rows.sort((a, b) => a.datname.localeCompare(b.datname)), names.map(datname => ({ datname, n: 1 })).sort((a, b) => a.datname.localeCompare(b.datname)))
      } finally { one.close(); two.close(); other.close() }
    })

    await t.test('real triggers commit once per Bot, exclude rollback/savepoint, and cover assistant/session writes', async () => {
      const botId = randomUUID(), owner = randomUUID(), home = randomUUID()
      await app.query('INSERT INTO bots VALUES($1,$2,$3)', [botId, owner, home])
      const reader = await app.connect(), writer = await app.connect()
      const listener = await listenOn(reader, MCP_REPLY_CHANNEL)
      const heard: string[] = []
      const off = listener.on('bot:' + botId, () => { heard.push(botId) })
      const barrier = async () => {
        const key = 'barrier:' + randomUUID()
        let release!: () => void
        const wait = new Promise<void>(resolve => { release = resolve })
        const stop = listener.on(key, release)
        try { await notifyChannel(app, MCP_REPLY_CHANNEL, [key]); await bounded(wait) } finally { stop() }
      }
      const insert = () => writer.query('INSERT INTO coordinator_messages VALUES($1,$2,$3,1,$4)', [randomUUID(), owner, botId, { role: 'assistant', content: 'DB fixture only' }])
      try {
        await writer.query('BEGIN'); await insert(); await barrier()
        assert.equal(heard.length, 0, 'uncommitted assistant is not a signal')
        await writer.query('ROLLBACK'); await barrier()
        assert.equal(heard.length, 0)
        await writer.query('BEGIN'); await writer.query('SAVEPOINT nested_reply'); await insert()
        await writer.query('ROLLBACK TO SAVEPOINT nested_reply'); await writer.query('COMMIT'); await barrier()
        assert.equal(heard.length, 0, 'rollback-to-savepoint is not published by outer commit')
        await writer.query('BEGIN'); await insert(); await insert()
        await writer.query('INSERT INTO coordinator_sessions VALUES($1,$2,$3,now()+interval \'1 minute\',NULL,NULL,NULL)', [owner, botId, 'held'])
        await writer.query('COMMIT'); await barrier()
        assert.equal(heard.length, 1, 'same transaction Bot payload is deduplicated by PG')
        await writer.query('UPDATE coordinator_sessions SET summary=\'summary only\' WHERE "botId"=$1', [botId]); await barrier()
        assert.equal(heard.length, 1, 'unread summary does not wake MCP')
        await writer.query('UPDATE coordinator_sessions SET "leaseUntil"=now()+interval \'2 minutes\' WHERE "botId"=$1', [botId]); await barrier()
        assert.equal(heard.length, 2, 'lease renewal is a committed session change')
        await writer.query('UPDATE coordinator_sessions SET "leaseHolder"=NULL,"leaseUntil"=NULL WHERE "botId"=$1', [botId]); await barrier()
        assert.equal(heard.length, 3, 'release is covered')
        await writer.query('UPDATE coordinator_sessions SET "lastError"=\'fixture error\',"lastErrorAt"=now() WHERE "botId"=$1', [botId]); await barrier()
        assert.equal(heard.length, 4, 'failure is covered')
        await writer.query('UPDATE coordinator_messages SET message=message || \'{"content":"edited fixture"}\' WHERE "botId"=$1', [botId]); await barrier()
        assert.equal(heard.length, 5, 'assistant edit is covered, duplicate rows coalesce')
        await writer.query('DELETE FROM coordinator_messages WHERE "botId"=$1', [botId]); await barrier()
        assert.equal(heard.length, 6, 'assistant deletion is covered')
        await writer.query('INSERT INTO coordinator_messages VALUES($1,$2,$3,1,$4)', [randomUUID(), owner, botId, { role: 'user', content: 'not an assistant reply' }]); await barrier()
        assert.equal(heard.length, 6, 'a user message alone cannot satisfy the reply wait')
      } finally {
        await writer.query('ROLLBACK'); off(); listener.stop()
        await reader.query(`UNLISTEN ${MCP_REPLY_CHANNEL}`)
        writer.release(); reader.release()
      }
    })

    for (const change of ['bot-transfer', 'bot-workspace', 'bot-delete', 'member-suspend', 'member-delete', 'member-key'] as const) {
      await t.test(`${change} wakes the two-database waiter and its fresh scope check rejects`, async () => {
        const owner = randomUUID(), botId = randomUUID(), home = randomUUID(), nextHome = randomUUID()
        await app.query('INSERT INTO bots VALUES($1,$2,$3)', [botId, owner, home])
        await workspace.query('INSERT INTO mikka_workspaces VALUES($1,$2,\'team\'),($3,$2,\'team\')', [home, owner, nextHome])
        await workspace.query('INSERT INTO mikka_workspace_members VALUES($1,$2,\'active\'),($3,$2,\'active\')', [home, owner, nextHome])
        await Promise.all([fixtureCommitBarrier(app), fixtureCommitBarrier(workspace)])
        const controller = new AbortController()
        let ready!: () => void, reads = 0
        const first = new Promise<void>(resolve => { ready = resolve })
        const pending = waitForReply(async final => {
          reads++
          const current = await coordinatorSessionScope(app, workspace, owner, botId)
          if (!current || current.workspaceId !== home) throw new Error('workspaceAccessDenied')
          ready()
          return final ? { done: true, value: 'deadline without scope change' } : { done: false }
        }, { deadline: Date.now() + 90_000, signal: controller.signal,
          subscribe: (changed, signal) => observeReplySignals(signal => Promise.all([
            subscribeShared(app, MCP_REPLY_CHANNEL, ['bot:' + botId], signal),
            subscribeShared(workspace, MCP_REPLY_CHANNEL, [`member:${home}:${owner}`], signal),
          ]), changed, signal),
        })
        const denied = assert.rejects(pending, /workspaceAccessDenied/)
        try {
          await bounded(first)
          if (change === 'bot-transfer') await app.query('UPDATE bots SET "ownerId"=$2 WHERE id=$1', [botId, randomUUID()])
          if (change === 'bot-workspace') await app.query('UPDATE bots SET "workspaceId"=$2 WHERE id=$1', [botId, nextHome])
          if (change === 'bot-delete') await app.query('DELETE FROM bots WHERE id=$1', [botId])
          if (change === 'member-suspend') await workspace.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [home, owner])
          if (change === 'member-delete') await workspace.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [home, owner])
          if (change === 'member-key') await workspace.query('UPDATE mikka_workspace_members SET "userId"=$3 WHERE "workspaceId"=$1 AND "userId"=$2', [home, owner, randomUUID()])
          await bounded(denied)
          assert.equal(reads, 2, 'exactly initial read plus the committed scope invalidation')
        } finally { controller.abort(); await denied.catch(() => {}) }
      })
    }

    await t.test('terminating the actual LISTEN backend wakes lost subscribers without waiting for the deadline', async () => {
      const controller = new AbortController()
      let wake!: () => void
      const lost = new Promise<void>(resolve => { wake = resolve })
      const observer = await observeReplySignals(signal => Promise.all([
        subscribeShared(app, MCP_REPLY_CHANNEL, ['bot:loss'], signal),
        subscribeShared(workspace, MCP_REPLY_CHANNEL, ['member:loss'], signal),
      ]), () => wake(), controller.signal)
      try {
        assert.equal(observer.lost, false)
        const { rows } = await admin.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name='mikka-listen'`, [names[0]])
        assert.equal(rows.length, 1)
        await admin.query('SELECT pg_terminate_backend($1)', [rows[0].pid])
        await bounded(lost)
        assert.equal(observer.lost, true)
      } finally { observer.close(); controller.abort() }
    })
  } finally {
    for (const [index, name] of created.entries()) await dropTestDatabase(admin, name, pools[index])
    await admin.end()
  }
})

test('immediate MCP history authorizes once at the actual read', { skip: !valid }, async t => {
  const { measured, readMetrics } = await import('../../tests/helpers/read-metrics')
  const { seedUser } = await import('../../tests/support/workspace-admin-db')
  const { seedCoordinator } = await import('../../tests/support/coordinator-bot')
  const { pool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  t.after(async () => { await Promise.all([pool.end(), workspacePool.end()]) })
  const { actAs } = await import('../acting-user')
  const { tokenWorkspace } = await import('../tokens/principal')
  const scopeCheck = t.mock.fn(coordinatorSessionScope)
  const sessionModule = await import('../live/coordinator-session')
  t.mock.module('../live/coordinator-session', { namedExports: { ...sessionModule, coordinatorSessionScope: scopeCheck } })
  const { readCoordinatorMessages } = await import('./tools')
  const owner = await seedUser(pool, 'mcp-snapshot')
  const { workspaceId } = await seedCoordinator(owner)
  const history = () => actAs({ id: owner, [tokenWorkspace]: workspaceId }, () => readCoordinatorMessages(owner, {}))
  try {
    await history()
    scopeCheck.mock.resetCalls()
    const result = await measured(history)
    t.diagnostic('Immediate MCP history ' + JSON.stringify(readMetrics(result)))
    assert.deepEqual(result.value.messages, [])
    assert.equal(scopeCheck.mock.callCount(), 1, 'only the actual read checks current Bot and Workspace access')
    await pool.query('UPDATE mikka_workspace_members SET status=$3 WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner, 'suspended'])
    await assert.rejects(history(), /workspaceAccessDenied/)
  } finally {
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
  }
})
