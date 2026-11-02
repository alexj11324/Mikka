// An open thread always ends in the composer (R-10); what is typed there in an
// ended thread runs it again in the same thread (R-81, lib/thread-continue.ts).
// Against a real PostgreSQL: done, failed, stopped and cancelled threads each
// get a new run that continues the last one, the chain's latestRunId moves to
// it, and the words show in the thread without being delivered twice. A working
// thread still gets a message; nobody but the thread's owner can send.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { githubAppStub } from './support/github-app-stub'

const mac = [{ harness: 'codex', installed: true, models: ['gpt-5'], defaultModelSlot: 'default' }]
mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: { invokeDecision: async () => null } })

test('a message to an ended thread runs it again in the same thread; only its owner can send', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { readRunChain } = await import('../lib/run-chain')
  const { sendThreadMessage } = await import('../lib/thread-continue')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { chatBotId } = await import('../lib/coordinator/coordinator-bot')
  const users: string[] = []
  const github = githubAppStub()
  github.install('octo/repo', { contents: 'write', pull_requests: 'write' })
  let githubAccount = 9_500_000
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
    const id = await seedUser(pool, 'thread-continue')
    users.push(id)
    const githubAccountId = String(++githubAccount)
    await pool.query(`INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'github',$3,now(),now())`, [randomUUID(), githubAccountId, id])
    github.allowWriter('octo/repo', githubAccountId)
    await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [id, normalizeRepository('octo/repo').key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: id, approvedAt: new Date().toISOString() })])
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    const issueId = await seedIssue(pool, id)
    await pool.query(`UPDATE issues SET content=$2::jsonb WHERE id=$1`, [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 2000 + users.length } } })])
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses,"autoSchedule") VALUES ($1,$2,'MacBook','local','laptop',true,now(),$3,true)`, [deviceId, id, JSON.stringify(mac)])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [randomUUID(), id, deviceId, `codex-${deviceId.slice(0, 8)}`])
    const botId = await chatBotId(id, null, ws.id)
    return { id, issueId, botId, ws }
  }
  const end = (runId: string, status: string) => pool.query(`UPDATE agent_runs SET status=$2,"finishedAt"=now(),"updatedAt"=now() WHERE id=$1`, [runId, status])

  const a = await person()
  const first = await steps.dispatchRun(a.id, { issueId: a.issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` }, undefined, a.botId) as unknown as { runId: string; thread: string }
  assert.equal(first.thread, 'new')

  await t.test('a working thread gets the words as a message, as before', async () => {
    const sent = await sendThreadMessage(a.id, first.runId, 'Also cover the empty input.')
    assert.deepEqual(sent, { runId: first.runId, continued: false })
    const { rows } = await pool.query('SELECT text,"deliveredAt" FROM run_messages WHERE "runId"=$1', [first.runId])
    assert.equal(rows.length, 1)
    assert.match(rows[0].text, /Also cover the empty input\./)
    assert.equal(rows[0].deliveredAt, null, 'the daemon still delivers it')
  })

  await t.test('done, failed, stopped and cancelled threads each run again in the same thread', async () => {
    let last = first.runId
    for (const status of ['succeeded', 'failed', 'stopped', 'cancelled']) {
      await end(last, status)
      const text = `Go on after ${status}.`
      // Sent from the thread as it was opened: the first run's id, never the newest.
      const sent = await sendThreadMessage(a.id, first.runId, text)
      assert.equal(sent.continued, true, status)
      assert.notEqual(sent.runId, last, `${status}: a new run`)
      const { rows: [run] } = await pool.query('SELECT status,"continuesRunId","issueId",prompt FROM agent_runs WHERE id=$1', [sent.runId])
      assert.deepEqual([run.status, run.continuesRunId, run.issueId], ['queued', last, a.issueId], status)
      assert.match(run.prompt, new RegExp(text.replace('.', '\\.')), `${status}: the words are the run's note`)
      const chain = await readRunChain(pool, a.id, first.runId)
      assert.equal(chain?.rootRunId, first.runId, `${status}: same thread`)
      assert.equal(chain?.latestRunId, sent.runId, `${status}: latestRunId moved to the new run`)
      const { rows: shown } = await pool.query('SELECT text,"deliveredAt",origin FROM run_messages WHERE "runId"=$1', [sent.runId])
      assert.equal(shown.length, 1, `${status}: the words show in the thread`)
      assert.equal(shown[0].text, text)
      assert.equal(shown[0].origin, 'owner')
      assert.notEqual(shown[0].deliveredAt, null, `${status}: already in the note, never delivered again`)
      last = sent.runId
    }
  })

  await t.test('nobody else can send: another person, a teammate in the same workspace, or an unknown run', async () => {
    const before = (await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [a.id])).rows[0].n
    const stranger = await person()
    await assert.rejects(sendThreadMessage(stranger.id, first.runId, 'Take over.'), { code: 'runNotFound' })
    // A member of the owner's workspace, who may see a bot's thread there, still cannot run it.
    const teammate = { id: await seedUser(pool, 'thread-continue') }
    users.push(teammate.id)
    await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,$4,$5)', [a.ws.id, teammate.id, `${teammate.id}@example.invalid`, 'member', 'active'])
    await assert.rejects(sendThreadMessage(teammate.id, first.runId, 'Take over.'), { code: 'runNotFound' })
    await assert.rejects(sendThreadMessage(a.id, randomUUID(), 'Hello?'), { code: 'runNotFound' })
    const after = (await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [a.id])).rows[0].n
    assert.equal(after, before, 'no run was started for them')
    const { rows } = await pool.query('SELECT 1 FROM run_messages WHERE "userId" = ANY($1)', [[stranger.id, teammate.id]])
    assert.equal(rows.length, 0, 'no message was stored for them')
  })

  await t.test('a thread another thread replaced cannot run again', async () => {
    const b = await person()
    const old = await steps.dispatchRun(b.id, { issueId: b.issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` }, undefined, b.botId) as unknown as { runId: string }
    await end(old.runId, 'succeeded')
    // A newer thread on the same task (the person asked for a new one).
    const newer = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"botId") SELECT $1,"userId","issueId","agentId","deviceId","deviceRepoId",'succeeded','newer',"botId" FROM agent_runs WHERE id=$2`, [newer, old.runId])
    await pool.query(`UPDATE agent_runs SET "threadReplacedBy"=$1 WHERE id=$2`, [newer, old.runId])
    await assert.rejects(sendThreadMessage(b.id, old.runId, 'Again.'), { code: 'threadReplaced' })
  })
})
