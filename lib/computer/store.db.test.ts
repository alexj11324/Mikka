import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { ComputerStore } from './store'
import { bindComputerRun } from './run-binding'
import type * as provider from './e2b-provider'

const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Computer database test URL required')
test('real PostgreSQL: allocation, owner boundary, control generations and recovery', { skip: !databaseURL }, async () => {
  const schema = `computer_${randomUUID().replaceAll('-', '')}`
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(databaseURL!).hostname))
  const admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  let created = 0, failSync = false, failStart = false, epoch = 0
  const runtime = {
    async createComputer() { created++; return { sandboxId: 'sandbox-test' } },
    async connectComputer() { return { sandboxId: 'sandbox-test' } },
    async computerState() { return 'sleeping' },
    async installComputerRuntime() {}, async startDesktop() { if (failStart) throw new Error('start response lost') },
    async syncDesktopLease(_sandbox: unknown, lease: { epoch: number }) { epoch = lease.epoch; if (failSync) throw new Error('transport failed') },
    async viewerGrant() { return { url: 'wss://test.invalid', expiresAt: new Date().toISOString() } },
  } as unknown as typeof provider
  const actor = { userId: 'alice', workspaceId: randomUUID() }
  const bob = { ...actor, userId: 'bob' }
  const otherWorkspace = { ...actor, workspaceId: randomUUID() }
  try {
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES (\'alice\'),(\'bob\')')
    const migration = await readFile(new URL('../../drizzle/20261026235901_cloud_computers.sql', import.meta.url), 'utf8')
    await pool.query(migration); await pool.query(migration)
    await pool.query('CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, status text NOT NULL)')
    const bindingMigration = await readFile(new URL('../../drizzle/20261027000000_computer_run_bindings.sql', import.meta.url), 'utf8')
    await pool.query(bindingMigration); await pool.query(bindingMigration)
    const store = new ComputerStore(pool, runtime)
    const bot = await store.createBot(actor, 'Desktop')
    assert.deepEqual(await store.state(actor, bot.id), { machine: 'sleeping', control: 'idle' })
    await assert.rejects(store.state(bob, bot.id), { status: 404 })
    await assert.rejects(store.operate(otherWorkspace, bot.id, 'wake'), { status: 404 })
    await Promise.all([store.operate(actor, bot.id, 'wake'), store.operate(actor, bot.id, 'wake')])
    assert.equal(created, 1)
    const bobBot = await store.createBot(bob, 'Other owner')
    const runId = randomUUID()
    await pool.query('INSERT INTO agent_runs VALUES ($1,$2,$3)', [runId, actor.userId, 'queued'])
    await assert.rejects(bindComputerRun(pool, bob, runId, bobBot.id), { status: 404 })
    await assert.rejects(bindComputerRun(pool, otherWorkspace, runId, bot.id), { status: 404 })
    await assert.rejects(bindComputerRun(pool, actor, runId, bobBot.id), { status: 404 })
    await bindComputerRun(pool, actor, runId, bot.id)
    await bindComputerRun(pool, actor, runId, bot.id)
    const another = await store.createBot(actor, 'Another bot')
    await assert.rejects(bindComputerRun(pool, actor, runId, another.id), { status: 409 })
    const startedId = randomUUID()
    await pool.query('INSERT INTO agent_runs VALUES ($1,$2,$3)', [startedId, actor.userId, 'running'])
    await assert.rejects(bindComputerRun(pool, actor, startedId, bot.id), { status: 409 })
    await assert.rejects(pool.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [startedId, bobBot.id, actor.workspaceId, actor.userId]), { code: '23503' })
    await assert.rejects(store.operate(bob, bobBot.id, 'wake'), { status: 409 })
    await assert.rejects(store.operate(actor, bot.id, 'viewer', 'control'), { status: 403 })
    await store.operate(actor, bot.id, 'takeover')
    const taken = epoch
    assert.equal((await store.state(actor, bot.id)).control, 'user')
    await store.operate(actor, bot.id, 'handback')
    assert.ok(epoch > taken)
    failSync = true
    await assert.rejects(store.operate(actor, bot.id, 'takeover'))
    const failedEpoch = epoch
    const restarted = new ComputerStore(pool, runtime)
    failSync = false
    await restarted.operate(actor, bot.id, 'handback')
    assert.ok(epoch > failedEpoch, 'failed synchronization cannot reuse an old generation')
    assert.equal((await restarted.state(actor, bot.id)).machine, 'sleeping', 'provider pause is reflected')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bot_desktops')).rows[0].n, 1)
    const interrupted = await store.createBot(actor, 'Interrupted start')
    failStart = true
    await assert.rejects(store.operate(actor, interrupted.id, 'wake'))
    failStart = false
    const later = await store.createBot(actor, 'Later bot')
    await store.operate(actor, later.id, 'wake')
    const displays = (await pool.query('SELECT display FROM bot_desktops ORDER BY display')).rows.map(row => row.display)
    assert.deepEqual(displays, [1, 2, 3], 'uncertain start keeps its binding rather than leaking its desktop to a later bot')
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
