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
import { githubAppStub } from './support/github-app-stub'

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
  // Push is what the person granted on GitHub: the synthetic App is installed on octo/repo with contents: write.
  const github = githubAppStub()
  github.install('octo/repo', { contents: 'write', pull_requests: 'write' })
  let githubAccount = 9_400_000
  t.after(async () => {
    github.restore()
    await pool.query('DELETE FROM run_messages WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
    await pool.query('UPDATE agent_runs SET "continuesRunId"=NULL,"threadReplacedBy"=NULL WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM github_repository_installations WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM account WHERE "userId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const person = async () => {
    const id = await seedUser(pool, 'one-thread')
    users.push(id)
    // Their own GitHub account, which may write to octo/repo.
    const githubAccountId = String(++githubAccount)
    await pool.query(`INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'github',$3,now(),now())`, [randomUUID(), githubAccountId, id])
    github.allowWriter('octo/repo', githubAccountId)
    await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [id, normalizeRepository('octo/repo').key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: id, approvedAt: new Date().toISOString() })])
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    const issueId = await seedIssue(pool, id)
    // A numbered task gets a publication branch; each person's own number keeps the branches apart.
    await pool.query(`UPDATE issues SET content=$2::jsonb WHERE id=$1`, [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1000 + users.length } } })])
    const deviceId = await computer(id, 'MacBook')
    const botId = await chatBotId(id, null, ws.id)
    return { id, issueId, botId, deviceId }
  }
  async function computer(userId: string, name: string, state: { online?: boolean; autoSchedule?: boolean; removed?: boolean } = {}) {
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses,"autoSchedule","removedAt") VALUES ($1,$2,$3,'local','laptop',true,$4,$5,$6,$7)`,
      [deviceId, userId, name, state.online === false ? new Date(Date.now() - 3_600_000) : new Date(), JSON.stringify(mac), state.autoSchedule ?? true, state.removed ? new Date() : null])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [randomUUID(), userId, deviceId, `codex-${deviceId.slice(0, 8)}`])
    return deviceId
  }
  type Dispatched = { runId: string; thread: string; threadId: string; status?: string; continuesRunId?: string; replacedThreadId?: string; error?: string; placement?: unknown; card?: { title: string } }
  const dispatch = async (who: { id: string; issueId: string; botId: string }, extra: { note?: string; readOnly?: boolean; newThread?: boolean; sourceEventId?: string; target?: 'cloud' | { deviceId: string } } = {}) =>
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
    const again = await dispatch(a)
    assert.deepEqual([again.thread, again.runId, again.threadId, again.status], ['message', first.runId, first.runId, 'alreadyWorking'])
    assert.deepEqual(again.placement, first.placement, 'it says where the thread runs')
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

    // A read-only request that continues a writable thread runs read-only.
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [third.runId])
    const look = await dispatch(a, { readOnly: true, note: 'Only look.' })
    assert.deepEqual([look.thread, look.threadId], ['continued', first.runId])
    const definition = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [look.runId])).rows[0].agentDefinition
    assert.equal(definition.readOnly, true)
    // A read-only thread stays read-only when it continues, even when the request does not say so.
    const b = await person()
    const looking = await dispatch(b, { readOnly: true })
    assert.equal(looking.thread, 'new')
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [looking.runId])
    const more = await dispatch(b, { note: 'Look further.' })
    assert.deepEqual([more.thread, more.threadId], ['continued', looking.runId])
    assert.equal((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [more.runId])).rows[0].agentDefinition.readOnly, true)
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

  await t.test('a named computer: the run is pinned there and the result says so; offline, not theirs or removed is refused', async () => {
    const a = await person()
    // Not picked by the rules (auto-schedule off), but the person named it.
    const studio = await computer(a.id, 'Mac Studio', { autoSchedule: false })
    const pinned = await dispatch(a, { target: { deviceId: studio } })
    assert.equal(pinned.thread, 'new')
    assert.deepEqual(pinned.placement, { kind: 'device', deviceId: studio, name: 'Mac Studio' })
    assert.equal((await pool.query('SELECT "deviceId","agentDefinition"->>\'pinnedDeviceId\' AS pinned FROM agent_runs WHERE id=$1', [pinned.runId])).rows[0].pinned, studio)
    // Offline: the card at once, nothing queued, no other computer used.
    const b = await person()
    const asleep = await computer(b.id, 'Old Mac', { online: false })
    const offline = await dispatch(b, { target: { deviceId: asleep } })
    assert.equal(offline.error, 'machineUnavailable')
    assert.ok(offline.card?.title)
    assert.equal((await runs(b.id)).length, 0)
    // Someone else's computer, or a removed one: refused.
    assert.equal((await dispatch(b, { target: { deviceId: a.deviceId } })).error, 'deviceNotFound')
    assert.equal((await dispatch(b, { target: { deviceId: await computer(b.id, 'Gone', { removed: true }) } })).error, 'deviceNotFound')
    assert.equal((await runs(b.id)).length, 0)
    // No target: the saved rules pick (here the auto-schedule MacBook), and the result names it.
    const ruled = await dispatch(b)
    assert.deepEqual(ruled.placement, { kind: 'device', deviceId: b.deviceId, name: 'MacBook' })
  })

  await t.test('naming another computer for a task that has a thread is a move, granted only by the person\'s explicit request', async () => {
    const a = await person()
    const first = await dispatch(a)
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [first.runId])
    const studio = await computer(a.id, 'Mac Studio')
    judged = 0.2
    const kept = await dispatch(a, { target: { deviceId: studio }, sourceEventId: await said(a, '再试一次') })
    assert.deepEqual([kept.thread, kept.threadId], ['continued', first.runId])
    assert.deepEqual(kept.placement, { kind: 'device', deviceId: a.deviceId, name: 'MacBook' }, 'the thread stays where it ran')
    await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=now() WHERE id=$1`, [kept.runId])
    judged = 0.95
    const moved = await dispatch(a, { target: { deviceId: studio }, sourceEventId: await said(a, '换到我的 Mac Studio 上跑') })
    assert.equal(moved.thread, 'new')
    assert.deepEqual(moved.placement, { kind: 'device', deviceId: studio, name: 'Mac Studio' })
    judged = null
  })
})
