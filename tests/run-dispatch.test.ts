import { isolatedPostgresURL } from './helpers/isolated-postgres.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import test from 'node:test'
import { Pool } from 'pg'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { ActionFailureError } from '../lib/action-error'
import { dispatchInput, insertRunOnce, type DispatchInput } from '../lib/run-dispatch'
import { agentRuns, agents, deviceRepos, devices, issues } from '../lib/db/schema'
import * as databaseSchema from '../lib/db/schema'

const run = promisify(execFile)
test('dispatch keys are optional, bounded and normalized with caller parameters', () => {
  const input = { issueId: randomUUID(), agentId: randomUUID(), deviceRepoId: randomUUID() }
  assert.equal(dispatchInput.safeParse(input).success, true)
  for (const requestKey of ['', '   ', 'k'.repeat(201)]) assert.equal(dispatchInput.safeParse({ ...input, requestKey }).success, false)
  assert.deepEqual(dispatchInput.parse({ ...input, requestKey: ' work-1 ', note: ' hello ' }), { ...input, requestKey: 'work-1', note: 'hello' })
})

// Explicit disposable target only; never fall back to application credentials.
test('real Postgres dispatch transactions and recovery', {
  skip: process.env.RUN_DISPATCH_DB_TESTS !== '1', timeout: 90000,
}, async t => {
  const target = new URL(process.env.E2E_DATABASE_URL!)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  assert.equal(target.pathname, '/mikka_e2e')
  const schema = `dispatch_${randomUUID().replaceAll('-', '')}`
  const scoped = new URL(await isolatedPostgresURL(target.toString()))
  const admin = new Pool({ connectionString: scoped.toString(), max: 1 })
  scoped.searchParams.set('options', `-c search_path=${schema}`)
  const connectionString = scoped.toString()
  const client = new Pool({ connectionString, max: 12 })
  const db = drizzle(client, { schema: databaseSchema })
  const owner = `dispatch-owner-${randomUUID()}`
  const deviceId = randomUUID(), agentId = randomUUID(), deviceRepoId = randomUUID()
  const brief = { deviceId, baseBranch: 'main', prompt: 'Controlled dispatch acceptance; no external actions.' }
  async function task(userId = owner): Promise<DispatchInput> {
    const issueId = randomUUID()
    await db.insert(issues).values({ id: issueId, userId, title: 'Dispatch acceptance fixture', content: { type: 'doc', content: [] }, status: 'todo', priority: 'normal' })
    return { issueId, agentId, deviceRepoId }
  }
  const isFailure = (code: string) => (error: unknown) => error instanceof ActionFailureError && error.code === code
  try {
    await admin.query(`create schema "${schema}"`)
    await run(process.execPath, ['scripts/migrate.mjs'], {
      cwd: new URL('..', import.meta.url), timeout: 30000,
      env: { ...process.env, MIKKA_DATABASE_URL: connectionString, DATABASE_URL: connectionString, MIGRATE: '1', VERCEL_ENV: '' },
    })
    await db.insert(devices).values({ id: deviceId, ownerId: owner, name: 'Controlled dispatch device' })
    await db.insert(agents).values({ id: agentId, userId: owner, name: 'Dispatch CC', harness: 'claude_code', deviceId })
    await db.insert(deviceRepos).values({ id: deviceRepoId, userId: owner, deviceId, repoPath: '/controlled/dispatch-test' })

    await t.test('10 same-key calls create one run; completed replays retain real state', async () => {
      const input = { ...await task(), requestKey: 'same-request' }
      const results = await Promise.all(Array.from({ length: 10 }, () => insertRunOnce(db, owner, input, brief)))
      assert.equal(new Set(results.map(result => result.runId)).size, 1)
      assert.equal(results.filter(result => !result.replayed).length, 1)
      assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.issueId, input.issueId))).length, 1)
      const runId = results[0].runId
      await db.update(agentRuns).set({ status: 'succeeded' }).where(eq(agentRuns.id, runId))
      assert.deepEqual(await insertRunOnce(db, owner, input, { ...brief, prompt: 'Later issue text' }), { runId, status: 'succeeded', replayed: true })
      assert.notEqual((await insertRunOnce(db, owner, { ...input, requestKey: 'next-round' }, brief)).runId, runId)
    })
    await t.test('keys cannot be rebound to a different issue, agent, repo or note', async () => {
      const input = { ...await task(), requestKey: 'bound-input' }
      await insertRunOnce(db, owner, input, brief)
      for (const changed of [{ issueId: randomUUID() }, { agentId: randomUUID() }, { deviceRepoId: randomUUID() }, { note: 'Different work' }]) {
        await assert.rejects(insertRunOnce(db, owner, { ...input, ...changed }, brief), isFailure('runDispatchKeyConflict'))
      }
    })
    await t.test('10 different-key and legacy calls create at most one live run', async () => {
      const input = await task()
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => insertRunOnce(db, owner,
        { ...input, ...(index % 2 ? { requestKey: `competing-${index}` } : {}) }, brief)))
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
      const rejected = results.filter(result => result.status === 'rejected')
      assert.equal(rejected.length, 9)
      for (const result of rejected) assert.ok(isFailure('runAlreadyActive')(result.reason))
      assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.issueId, input.issueId))).length, 1)
    })
    await t.test('every live state blocks; terminal unkeyed runs allow new work', async () => {
      const input = await task()
      const first = await insertRunOnce(db, owner, input, brief)
      for (const status of ['queued', 'preparing', 'running', 'waiting_input', 'finishing'] as const) {
        await db.update(agentRuns).set({ status }).where(eq(agentRuns.id, first.runId))
        await assert.rejects(insertRunOnce(db, owner, input, brief), isFailure('runAlreadyActive'))
      }
      await db.update(agentRuns).set({ status: 'cancelled' }).where(eq(agentRuns.id, first.runId))
      assert.notEqual((await insertRunOnce(db, owner, input, brief)).runId, first.runId)
    })
    await t.test('the same key is independent across owners', async () => {
      const other = `dispatch-owner-${randomUUID()}`
      const otherDevice = randomUUID(), otherAgent = randomUUID(), otherRepo = randomUUID()
      await db.insert(devices).values({ id: otherDevice, ownerId: other, name: 'Second controlled device' })
      await db.insert(agents).values({ id: otherAgent, userId: other, name: 'Second Codex', harness: 'codex', deviceId: otherDevice })
      await db.insert(deviceRepos).values({ id: otherRepo, userId: other, deviceId: otherDevice, repoPath: '/controlled/second-test' })
      const first = await insertRunOnce(db, owner, { ...await task(), requestKey: 'owner-local' }, brief)
      const second = await insertRunOnce(db, other, { ...await task(other), agentId: otherAgent, deviceRepoId: otherRepo, requestKey: 'owner-local' }, { ...brief, deviceId: otherDevice })
      assert.notEqual(first.runId, second.runId)
      const rows = await db.select().from(agentRuns).where(eq(agentRuns.dispatchKey, 'owner-local'))
      assert.deepEqual(new Set(rows.map(row => row.userId)), new Set([owner, other]))
    })
    await t.test('a real FK rejection rolls back both locks and the request record', async () => {
      const input = { ...await task(), requestKey: 'rollback-key' }
      await assert.rejects(insertRunOnce(db, owner, input, { ...brief, deviceId: randomUUID() }))
      assert.equal((await db.select().from(agentRuns).where(and(eq(agentRuns.userId, owner), eq(agentRuns.dispatchKey, input.requestKey)))).length, 0)
      assert.equal((await insertRunOnce(db, owner, input, brief)).replayed, false)
    })
    await t.test('a fresh Node process replays a committed key after losing the response', async () => {
      const input = { ...await task(), requestKey: 'process-restart' }
      const first = await insertRunOnce(db, owner, input, brief)
      const script = `
        import { Pool } from 'pg';
        import { drizzle } from 'drizzle-orm/node-postgres';
        import { insertRunOnce } from './lib/run-dispatch.ts';
        const data = JSON.parse(process.env.DISPATCH_TEST_DATA);
        const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL });
        try { console.log(JSON.stringify(await insertRunOnce(drizzle(pool), data.owner, data.input, data.brief))); }
        finally { await pool.end(); }
      `
      const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: new URL('..', import.meta.url), timeout: 15000,
        env: { ...process.env, E2E_DATABASE_URL: connectionString, DISPATCH_TEST_DATA: JSON.stringify({ owner, input, brief }) },
      })
      assert.deepEqual(JSON.parse(stdout), { ...first, replayed: true })
    })
  } finally {
    await client.end()
    await admin.query(`drop schema if exists "${schema}" cascade`)
    await admin.end()
  }
})
