// R-52 against a real PostgreSQL: an ended run is judged once (decision model,
// then the agent model), and a run no judge answered keeps no outcome. The
// judges are substituted; no model is called.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser } from './support/workspace-admin-db'

test('ended runs get a judged outcome', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool: appPool } = await import('../lib/db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end()]) })
  const { judgeRunOutcome, judgePendingOutcomes } = await import('../lib/run-outcome-judge')
  type Judges = Parameters<typeof judgeRunOutcome>[1] & object
  const seen: string[] = []
  const judges = (decision: string | null, agentModel: string | null): Judges => ({
    decision: async evidence => { seen.push(`decision:${evidence.lastReply}`); return decision ? { outcome: decision as never, decidedBy: 'decision', reason: 'judged' } : null },
    agentModel: async evidence => { seen.push(`agent:${evidence.lastReply}`); return agentModel ? { outcome: agentModel as never, decidedBy: 'agent_model', reason: 'fallback' } : null },
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

  await t.test('a finished run that says it was not logged in is judged blocked by the decision model, once', async () => {
    const id = await run('succeeded', 'Not logged in · Please run /login')
    assert.equal(await judgeRunOutcome(id, judges('blocked', 'done')), 'blocked')
    const stored = await row(id)
    assert.deepEqual([stored.outcome, stored.outcomeDecidedBy, stored.outcomeReason], ['blocked', 'decision', 'judged'])
    assert.equal(await judgeRunOutcome(id, judges('done', 'done')), null, 'a judged run is not judged again')
    assert.equal((await row(id)).outcome, 'blocked')
  })

  await t.test('the agent model judges when the decision model gives no answer', async () => {
    const id = await run('failed', '我没有创建 PR，gh 拿不到凭证')
    assert.equal(await judgeRunOutcome(id, judges(null, 'blocked')), 'blocked')
    assert.equal((await row(id)).outcomeDecidedBy, 'agent_model')
  })

  await t.test('no judge answers: no outcome, and the run is not judged again by the sweep', async () => {
    const id = await run('succeeded', 'I couldn\'t open the PR')
    assert.equal(await judgeRunOutcome(id, judges(null, null)), null)
    const stored = await row(id)
    assert.equal(stored.outcome, null)
    assert.ok(stored.outcomeAt, 'claimed')
    seen.length = 0
    await judgePendingOutcomes(judges('done', 'done'), 1000)
    assert.ok(!seen.some(entry => entry.endsWith('I couldn\'t open the PR')))
  })

  await t.test('a running run is not judged', async () => {
    const id = await run('running', 'working')
    assert.equal(await judgeRunOutcome(id, judges('done', 'done')), null)
    assert.equal((await row(id)).outcomeAt, null)
  })

  await t.test('the sweep judges ended runs from the last 7 days and leaves older ones alone', async () => {
    const recent = await run('stopped', 'recent stop')
    const old = await run('failed', 'old failure', new Date(Date.now() - 8 * 86_400_000))
    await judgePendingOutcomes(judges('idle', null), 1000)
    assert.equal((await row(recent)).outcome, 'idle')
    assert.deepEqual([(await row(old)).outcome, (await row(old)).outcomeAt], [null, null])
  })
})
