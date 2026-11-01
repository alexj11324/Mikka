// One task, one thread (decision 2026-11-01-1330-one-thread-per-task, R-81),
// against a real PostgreSQL: dispatching a task that has a thread never starts
// a second one. A working thread gets the note as a message; an ended one runs
// again in the same thread (same chain root); only the person's explicit
// request, as the Decision API judges it, starts a new thread.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

const mac = [{ harness: 'codex', installed: true, models: ['gpt-5'], defaultModelSlot: 'default' }]
// The Decision API's judgment of the person's message, scripted per case.
let judged: number | null = null
const judgments: string[] = []
mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: {
  invokeDecision: async (purpose: string, input: { text: string }) => {
    judgments.push(`${purpose}:${input.text.includes('<message>') ? 'quoted' : 'raw'}`)
    return judged === null ? null : { answers: new Map([['new_thread', { type: 'predicate', name: 'new_thread', probability: judged }]]), execution: {} }
  },
} })

test('one task, one thread: dispatch continues the task\'s thread unless the person explicitly asks for a new one', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { readRunChain } = await import('../lib/run-chain')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { chatBotId } = await import('../lib/coordinator/coordinator-bot')
  const users: string[] = []
  t.after(async () => {
    await pool.query('DELETE FROM run_messages WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
    await pool.query('UPDATE agent_runs SET "continuesRunId"=NULL,"threadReplacedBy"=NULL WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const person = async () => {
    const id = await seedUser(pool, 'one-thread')
    users.push(id)
    await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [id, normalizeRepository('octo/repo').key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: id, approvedAt: new Date().toISOString() })])
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    const issueId = await seedIssue(pool, id)
    // A numbered task gets a publication branch; each person's own number keeps the branches apart.
    await pool.query(`UPDATE issues SET content=$2::jsonb WHERE id=$1`, [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1000 + users.length } } })])
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses,"autoSchedule") VALUES ($1,$2,'MacBook','local','laptop',true,now(),$3,true)`, [deviceId, id, JSON.stringify(mac)])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex','codex')`, [randomUUID(), id, deviceId])
    const botId = await chatBotId(id, null, ws.id)
    return { id, issueId, botId }
  }
  type Dispatched = { runId: string; thread: string; threadId: string; status?: string; continuesRunId?: string; replacedThreadId?: string; error?: string }
  const dispatch = async (who: { id: string; issueId: string; botId: string }, extra: { note?: string; newThread?: boolean; sourceEventId?: string } = {}) =>
    await steps.dispatchRun(who.id, { issueId: who.issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}`, ...extra }, undefined, who.botId) as unknown as Dispatched
  const runs = async (userId: string) => (await pool.query('SELECT id,status,"continuesRunId","threadReplacedBy" FROM agent_runs WHERE "userId"=$1 ORDER BY "createdAt"', [userId])).rows
  const said = async (who: { id: string; botId: string }, text: string) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,'user_message',$5,$4)`, [id, who.id, who.botId, JSON.stringify({ text }), `test:${id}`])
    return id
  }

  await t.test('dispatching twice leaves one thread; the second note reaches it as a message', async () => {
    const a = await person()
    const first = await dispatch(a)
    assert.equal(first.thread, 'new')
    const second = await dispatch(a, { note: 'Also cover the empty input.' })
    assert.deepEqual([second.thread, second.runId, second.threadId, second.status], ['message', first.runId, first.runId, 'messageSent'])
    assert.equal((await runs(a.id)).length, 1, 'still one run, one thread')
    const messages = (await pool.query('SELECT text FROM run_messages WHERE "runId"=$1', [first.runId])).rows
    assert.equal(messages.length, 1)
    assert.match(messages[0].text, /Also cover the empty input\./)
    assert.deepEqual(await dispatch(a), { thread: 'message', runId: first.runId, threadId: first.runId, status: 'alreadyWorking' })
    // Two dispatches at once still find one thread.
    const b = await person()
    const both = await Promise.all([dispatch(b, { note: 'one' }), dispatch(b, { note: 'two' })])
    assert.equal((await runs(b.id)).length, 1)
    assert.deepEqual(both.map(r => r.thread).sort(), ['message', 'new'])
  })

  await t.test('after the thread fails, dispatching again is the same thread\'s next run', async () => {
    const a = await person()
    const first = await dispatch(a)
    await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='tests failed',"finishedAt"=now() WHERE id=$1`, [first.runId])
    const again = await dispatch(a, { note: 'Fix the failing tests.' })
    assert.equal(again.thread, 'continued')
    assert.notEqual(again.runId, first.runId)
    assert.equal(again.threadId, first.runId, 'the thread id does not change')
    assert.equal(again.continuesRunId, first.runId)
    const [, next] = await runs(a.id)
    assert.equal(next.continuesRunId, first.runId)
    const chain = await readRunChain(appPool, a.id, again.runId)
    assert.deepEqual([chain?.rootRunId, chain?.latestRunId, chain?.attempts.length], [first.runId, again.runId, 2])
    const prompt = (await pool.query('SELECT prompt FROM agent_runs WHERE id=$1', [again.runId])).rows[0].prompt as string
    assert.match(prompt, /## More work in this thread/)
    assert.match(prompt, /Fix the failing tests\./)
    assert.match(prompt, /Status: failed \(error\)/)
    // A stopped thread continues the same way.
    await pool.query(`UPDATE agent_runs SET status='stopped',"finishedAt"=now() WHERE id=$1`, [again.runId])
    const third = await dispatch(a)
    assert.deepEqual([third.thread, third.threadId, third.continuesRunId], ['continued', first.runId, again.runId])
  })

  await t.test('a new thread only when the person explicitly asked for one; the old one is marked replaced', async () => {
    const a = await person()
    const first = await dispatch(a)
    // The model asks for a new thread, but the person only added information: the thread is kept.
    judged = 0.1
    const kept = await dispatch(a, { note: 'More detail', newThread: true, sourceEventId: await said(a, '再补充一点：还要支持空输入') })
    assert.deepEqual([kept.thread, kept.runId], ['message', first.runId])
    // No message of the person's to judge: kept as well, without asking the Decision API.
    const before = judgments.length
    assert.equal((await dispatch(a, { newThread: true })).thread, 'message')
    assert.equal(judgments.length, before)
    // The person explicitly asked to start over in a new session.
    judged = 0.97
    const fresh = await dispatch(a, { newThread: true, sourceEventId: await said(a, '换一个 session 重新开始做这个任务') })
    assert.equal(fresh.thread, 'new')
    assert.notEqual(fresh.runId, first.runId)
    assert.equal(fresh.replacedThreadId, first.runId)
    const all = await runs(a.id)
    assert.equal(all.length, 2)
    assert.equal(all[0].threadReplacedBy, fresh.runId)
    assert.equal(all[1].continuesRunId, null, 'a new thread is its own chain')
    assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [first.runId])).rows[0].stopRequestedAt || all[0].status === 'stopped', 'the replaced thread is stopped')
    assert.ok(judgments.every(entry => entry === 'thread-switch:quoted'))
    judged = null
  })
})
