// R-52 against a real PostgreSQL: an ended run is judged once by the decision
// model; a run it did not answer keeps no outcome and is asked again after as
// long as it has waited, at least an hour (#1371). The judge is substituted; no model is called.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { dropTestDatabase } from './support/drop-test-database'
import test from 'node:test'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser } from './support/workspace-admin-db'

test('ended runs get a judged outcome', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  // The real sweep selects all owners. A different file in the same required
  // suite must never have its fixtures judged or its retry timestamps changed.
  const admin = new Pool({ connectionString: dbUrl, max: 1 })
  const database = 'run_outcomes_' + randomUUID().replaceAll('-', '') + '_e2e'
  const target = new URL(dbUrl!); target.pathname = '/' + database
  const pool = new Pool({ connectionString: target.href, max: 2 })
  const modulePools: InstanceType<typeof Pool>[] = []
  const settings = ['E2E_DATABASE_URL', 'MIKKA_DATABASE_URL', 'DATABASE_URL'] as const
  const previous = settings.map(name => process.env[name])
  t.after(async () => {
    try { await dropTestDatabase(admin, database, pool, ...modulePools) }
    finally {
      settings.forEach((name, i) => { const old = previous[i]; if (old === undefined) delete process.env[name]; else process.env[name] = old })
      await admin.end()
    }
  })
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  for (const name of settings) process.env[name] = target.href
  await promisify(execFile)(process.execPath, ['scripts/migrate.mjs'], {
    env: { ...process.env, MIGRATE: '1' }, maxBuffer: 4 * 1024 * 1024,
  })
  const { pool: appPool } = await import('../lib/db')
  modulePools.push(appPool)
  const { judgeRunOutcome, judgePendingOutcomes } = await import('../lib/run-outcome-judge')
  type Judges = Parameters<typeof judgeRunOutcome>[1] & object
  const seen: string[] = []
  const judges = (decision: string | null): Judges => ({
    decision: async evidence => { seen.push(`decision:${evidence.lastReply}`); return decision ? { outcome: decision as never, decidedBy: 'decision', reason: 'judged' } : null },
  })

  const owner = await seedUser(pool, 'owner')
  const agent = await seedAgent(pool, owner, 'claude_code')
  const issue = await seedIssue(pool, owner)
  const run = async (status: string, lastReply: string, finishedAt = new Date()) => {
    const id = await seedRun(pool, { userId: owner, agentId: agent, issueId: issue, status, finishedAt })
    await pool.query('update agent_runs set "lastReply"=$2 where id=$1', [id, lastReply])
    return id
  }
  const row = async (id: string) => (await pool.query('select outcome, "outcomeDecidedBy", "outcomeReason", "outcomeAt" from agent_runs where id=$1', [id])).rows[0]

  await t.test('a finished run that says it was not logged in is judged blocked, once', async () => {
    const id = await run('succeeded', 'Not logged in · Please run /login')
    assert.equal(await judgeRunOutcome(id, judges('blocked')), 'blocked')
    const stored = await row(id)
    assert.deepEqual([stored.outcome, stored.outcomeDecidedBy, stored.outcomeReason], ['blocked', 'decision', 'judged'])
    assert.equal(await judgeRunOutcome(id, judges('done')), null, 'a judged run is not judged again')
    assert.equal((await row(id)).outcome, 'blocked')
  })

  await t.test('no answer: no outcome, not asked again within the hour, asked again after it', async () => {
    const id = await run('failed', '我没有创建 PR，gh 拿不到凭证')
    assert.equal(await judgeRunOutcome(id, judges(null)), null)
    const stored = await row(id)
    assert.equal(stored.outcome, null)
    assert.ok(stored.outcomeAt, 'asked')
    seen.length = 0
    await judgePendingOutcomes(judges('done'), 1000)
    assert.ok(!seen.includes('decision:我没有创建 PR，gh 拿不到凭证'), 'not within the hour')
    await pool.query('update agent_runs set "outcomeAt"=now()-interval \'2 hours\' where id=$1', [id])
    await judgePendingOutcomes(judges('blocked'), 1000)
    assert.deepEqual([(await row(id)).outcome, (await row(id)).outcomeDecidedBy], ['blocked', 'decision'])
  })

  await t.test('a run the judge never answers backs off: asked again after as long as it already waited', async () => {
    const id = await run('failed', 'never answered', new Date(Date.now() - 2 * 86_400_000))
    await pool.query('update agent_runs set "outcomeAt"=now()-interval \'3 hours\' where id=$1', [id])
    seen.length = 0
    await judgePendingOutcomes(judges('done'), 1000)
    assert.ok(!seen.includes('decision:never answered'), 'two days old and last asked 3 hours ago: not yet')
    await pool.query('update agent_runs set "outcomeAt"=now()-interval \'25 hours\' where id=$1', [id])
    await judgePendingOutcomes(judges(null), 1000)
    assert.ok(seen.includes('decision:never answered'), 'last asked a day ago: asked again')
    assert.equal(await judgeRunOutcome(id, judges('done')), null, 'just asked: the completion hook does not ask again either')
  })

  await t.test('a running run is not judged', async () => {
    const id = await run('running', 'working')
    assert.equal(await judgeRunOutcome(id, judges('done')), null)
    assert.equal((await row(id)).outcomeAt, null)
  })

  await t.test('the sweep judges ended runs from the last 7 days and leaves older ones alone', async () => {
    const recent = await run('stopped', 'recent stop')
    const old = await run('failed', 'old failure', new Date(Date.now() - 8 * 86_400_000))
    await judgePendingOutcomes(judges('idle'), 1000)
    assert.equal((await row(recent)).outcome, 'idle')
    assert.deepEqual([(await row(old)).outcome, (await row(old)).outcomeAt], [null, null])
  })
})
