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
import { connectGitHub, githubAppStub } from './support/github-app-stub'

// The computer's Codex reported gpt-5, the model the person's ChatGPT account lists (decision 2026-11-02-1400).
const mac = [{ harness: 'codex', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'gpt-5', model: 'gpt-5', name: 'gpt-5' }] }]
mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: { invokeDecision: async () => null } })

test('a message to an ended thread runs it again in the same thread; only its owner can send', { skip: !dbUrl }, async t => {
  const priorByos = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  t.after(() => { if (priorByos === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = priorByos })
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
    await pool.query('DELETE FROM model_order_entries WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_order_settings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [users])
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
    // Connected in 插件 › GitHub, with the App on the repositories these tasks name: dispatch checks the live list.
    await connectGitHub(github, id, githubAccountId, ['octo/repo'])
    await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [id, normalizeRepository('octo/repo').key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: id, approvedAt: new Date().toISOString() })])
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    // A connected ChatGPT subscription whose account lists gpt-5: 优先使用的模型 is that model by default, 运行位置 本地.
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,'codex','connected',1,$4,$5,'synthetic-subject',$6,$7)`,
      [connection, id, ws.id, `synthetic-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models: ['gpt-5'] }), JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: null }] })])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5')`, [randomUUID(), id, ws.id, connection])
    const issueId = await seedIssue(pool, id)
    await pool.query(`UPDATE issues SET content=$2::jsonb WHERE id=$1`, [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 2000 + users.length } } })])
    // A computer that takes part (参与调度) and runs gpt-5.
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'MacBook','local','laptop',true,now(),$3)`, [deviceId, id, JSON.stringify(mac)])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [randomUUID(), id, deviceId, `codex-${deviceId.slice(0, 8)}`])
    const botId = await chatBotId(id, null, ws.id)
    return { id, issueId, botId, ws }
  }
  const end = (runId: string, status: string) => pool.query(`UPDATE agent_runs SET status=$2,"finishedAt"=now(),"updatedAt"=now() WHERE id=$1`, [runId, status])

  const a = await person()
  const first = await steps.dispatchRun(a.id, { issueId: a.issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` }, undefined, a.botId) as unknown as { runId: string; thread: string }
  assert.equal(first.thread, 'new', JSON.stringify(first))

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

  await t.test('a new owner request freezes a new Factory epoch without changing accepted history or waking the Bot', async () => {
    const b = await person()
    const oldText = 'factory-1146-cc-87c38e7e\n2 + 3 = 5\nverified artifact\n'
    const newText = oldText.replace('87c38e7e\n', '87c38e7e resume-1146-589b807d\n')
    assert.equal(Buffer.byteLength(oldText), 53)
    assert.equal(Buffer.byteLength(newText), 74)
    const body = { type: 'doc', attrs: { mikka: { number: 4400 } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Initial exact 53-byte file: ' + JSON.stringify(oldText) }] }] }
    await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [b.issueId, JSON.stringify(body)])
    const initial = await steps.dispatchRun(b.id, { issueId: b.issueId, repo: 'octo/repo', requestKey: `first:${randomUUID()}` }, undefined, b.botId) as unknown as { runId: string }
    const oldTask = (await pool.query('SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1', [initial.runId])).rows[0]
    const oldCandidateId = randomUUID()
    // A synthetic accepted ledger is the immutable first-epoch fixture. Only
    // the following owner dispatch/check configuration is exercised here.
    await end(initial.runId, 'succeeded')
    await pool.query(`UPDATE agent_runs SET report=$2 WHERE id=$1`, [initial.runId, JSON.stringify({ summary: oldText, criteria: [{ text: 'exact old 53 bytes', passed: true, evidence: oldText }] })])
    await pool.query(`INSERT INTO factory_candidates (id,"taskId",kind,sha,repository,environment,scope,"runId") VALUES ($1,$2,'deliverable',NULL,'https://github.com/octo/repo.git','fixture','fixture',$3)`, [oldCandidateId, oldTask.id, initial.runId])
    await pool.query(`UPDATE factory_tasks SET stage='approval',status='passed',"candidateId"=$2 WHERE id=$1`, [oldTask.id, oldCandidateId])
    await pool.query(`INSERT INTO factory_deliverable_acceptances (id,"taskId","candidateId","userId","sessionId","eventId") VALUES ($1,$2,$3,$4,'synthetic-owner-session',$5)`, [randomUUID(), oldTask.id, oldCandidateId, b.id, randomUUID()])
    await pool.query(`UPDATE coordinator_events SET tier='background',"deliveredAt"=now() WHERE id=$1`, [oldTask.sourceEventId])
    const accepted = async () => (await pool.query(`SELECT jsonb_build_object('task',to_jsonb(t),'source',to_jsonb(e),'candidate',to_jsonb(c),'acceptance',to_jsonb(a),'report',r.report,'issueContent',i.content) AS value FROM factory_tasks t JOIN issues i ON i.id=t."issueId" JOIN coordinator_events e ON e.id=t."sourceEventId" JOIN factory_candidates c ON c.id=t."candidateId" JOIN factory_deliverable_acceptances a ON a."taskId"=t.id JOIN agent_runs r ON r.id=c."runId" WHERE t.id=$1`, [oldTask.id])).rows[0].value
    const before = await accepted()
    const botMessages = async () => (await pool.query('SELECT count(*)::int AS n FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2', [b.id, b.botId])).rows[0].n
    const messagesBefore = await botMessages()
    const request = 'Current owner request: append resume-1146-589b807d only on the first line; the new exact 74-byte file is ' + JSON.stringify(newText)
    const { latestTaskRun } = await import('../lib/thread-dispatch')
    const { latestThreadRunModel } = await import('../lib/computer/run-model')
    const { continuationNote } = await import('../lib/thread-continuation')
    const previous = (await latestTaskRun(pool, b.id, b.issueId))!
    const priorModel = (await latestThreadRunModel(pool, b.id, b.issueId, previous.agentId))!
    const sent = await sendThreadMessage(b.id, initial.runId, request)
    assert.equal(sent.continued, true)
    const task = (await pool.query('SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1', [sent.runId])).rows[0]
    assert.notEqual(task.id, oldTask.id)
    const event = (await pool.query('SELECT * FROM coordinator_events WHERE id=$1', [task.sourceEventId])).rows[0]
    assert.equal(event.payload.text, request, 'raw owner request, without a continuationNote/old summary wrapper')
    assert.equal(event.payload.previousRunId, initial.runId)
    assert.equal(event.payload.source, 'thread_continuation')
    assert.equal(event.payload.postedToChat, true)
    assert.equal(event.tier, 'background')
    assert.ok(event.deliveredAt, 'provenance only: never a second Bot inbox turn')
    const { createWakeRecovery } = await import('../lib/coordinator/wake-recovery')
    const wake = createWakeRecovery(pool)
    const claimed = await wake.claim({ userId: b.id, botId: b.botId })
    assert.equal(claimed?.ids.includes(event.id) ?? false, false, 'wake recovery cannot claim the provenance event')
    const prompt = (await pool.query('SELECT prompt FROM agent_runs WHERE id=$1', [sent.runId])).rows[0].prompt
    assert.match(prompt, /Current owner request for this Factory task/)
    assert.ok(prompt.indexOf(request) < prompt.indexOf('Initial exact 53-byte file'))
    const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM factory_tasks WHERE "userId"=$1) tasks,(SELECT count(*)::int FROM agent_runs WHERE "userId"=$1) runs`, [b.id])).rows[0]
    assert.deepEqual(counts, { tasks: 2, runs: 2 }, 'one owner turn creates exactly one additional execute and task')
    const { queueTaskRun } = await import('../lib/factory/queue-local')
    const replay = await queueTaskRun(b.id, { issueId: b.issueId, agentId: previous.agentId, repo: previous.remoteUrl!,
      note: continuationNote(request, previous), ...priorModel, threadRunId: initial.runId,
      requestKey: `thread:${initial.runId}:${event.id}` }, b.botId, undefined, event.id)
    assert.equal(replay.runId, sent.runId, 'same source/key replay returns the one existing execute')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [b.id])).rows[0].n, 2)
    const execution = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [sent.runId])).rows[0]
    const repo = (await pool.query('SELECT * FROM device_repos WHERE id=$1', [execution.deviceRepoId])).rows[0]
    const candidateId = randomUUID(), sha = 'a'.repeat(40), reviewId = randomUUID(), reviewAttempt = randomUUID()
    await pool.query(`UPDATE agent_runs SET status='succeeded',report=$2 WHERE id=$1`, [sent.runId, JSON.stringify({ deliverableCommit: sha, summary: newText })])
    await pool.query(`INSERT INTO factory_candidates (id,"taskId",kind,sha,repository,environment,scope,"runId") VALUES ($1,$2,'deliverable',NULL,$3,$4,'fixture',$5)`, [candidateId, task.id, repo.remoteUrl, `device:${execution.deviceId}`, sent.runId])
    const insertRun = async (id: string) => pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"botId","agentDefinition") SELECT $1,"userId","issueId","agentId","deviceId","deviceRepoId",'queued',$2,"botId","agentDefinition" FROM agent_runs WHERE id=$3`, [id, 'Historical issue context: Initial exact 53-byte file: ' + JSON.stringify(oldText), sent.runId])
    await insertRun(reviewId)
    await pool.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId","candidateId",reason) VALUES ($1,$2,'review',1,2,'pending',$3,$4,'synthetic review')`, [reviewAttempt, task.id, reviewId, candidateId])
    await pool.query(`UPDATE factory_tasks SET stage='review',status='pending',"attemptId"=$2,"candidateId"=$3 WHERE id=$1`, [task.id, reviewAttempt, candidateId])
    const { configureFactoryCheck } = await import('../lib/factory/checks')
    const checkingTask = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [task.id])).rows[0]
    await configureFactoryCheck(pool as never, checkingTask, reviewId)
    const checkPrompt = (await pool.query('SELECT prompt FROM agent_runs WHERE id=$1', [reviewId])).rows[0].prompt
    assert.ok(checkPrompt.startsWith('Current owner request for this Factory task:'))
    assert.ok(checkPrompt.indexOf(request) < checkPrompt.indexOf('Historical issue context:'))
    assert.match(checkPrompt, /supersedes that older target/)
    // The next automatic repair keeps this task/source instead of replacing
    // its target with a previous issue contract or the producer's summary.
    const repairAttempt = randomUUID(), repairId = randomUUID()
    await pool.query(`UPDATE factory_attempts SET status='failed' WHERE id=$1`, [reviewAttempt])
    await end(reviewId, 'failed')
    await pool.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,reason,output) VALUES ($1,$2,'execute',2,3,'pending','synthetic automatic repair',$3)`, [repairAttempt, task.id, JSON.stringify({ recovery: { choice: 'repair_code', failedAttemptId: reviewAttempt, failedRunId: reviewId, candidateId, rationale: 'Keep the new owner target.' } })])
    await pool.query(`UPDATE factory_tasks SET stage='execute',status='pending',"attemptId"=$2 WHERE id=$1`, [task.id, repairAttempt])
    const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
    const { createFactoryDispatch, factoryBinding } = await import('../lib/factory/dispatch')
    const repairingTask = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [task.id])).rows[0]
    let repairQueues = 0
    const dispatch = createFactoryDispatch(pool, factoryRuntimeForBot(b.botId).store, async tx => {
      repairQueues++
      await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"botId","agentDefinition") SELECT $1,"userId","issueId","agentId","deviceId","deviceRepoId",'queued',$2,"botId","agentDefinition" FROM agent_runs WHERE id=$3`, [repairId, 'Historical issue: ' + JSON.stringify(oldText), sent.runId])
      return { runId: repairId }
    })
    await dispatch(b.id, { binding: factoryBinding(repairingTask), agentId: execution.agentId, deviceRepoId: execution.deviceRepoId })
    assert.equal((await dispatch(b.id, { binding: factoryBinding(repairingTask), agentId: execution.agentId, deviceRepoId: execution.deviceRepoId })).runId, repairId)
    assert.equal(repairQueues, 1, 'same automatic repair/source replay does not queue another execute')
    const repaired = (await pool.query('SELECT t."sourceEventId",r.prompt FROM factory_tasks t JOIN agent_runs r ON r.id=$2 WHERE t.id=$1', [task.id, repairId])).rows[0]
    assert.equal(repaired.sourceEventId, event.id)
    assert.ok(repaired.prompt.startsWith('Current owner request for this Factory task:'))
    assert.ok(repaired.prompt.indexOf(request) < repaired.prompt.indexOf('Historical issue:'))
    await pool.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [repairId, sent.runId])
    await end(repairId, 'failed')
    const nextRequest = 'A fresh owner follow-up after this failure: keep the exact 74-byte target ' + JSON.stringify(newText)
    const next = await sendThreadMessage(b.id, initial.runId, nextRequest)
    const nextTask = (await pool.query('SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1', [next.runId])).rows[0]
    assert.notEqual(nextTask.id, task.id, 'explicit owner work after failed repair is another epoch')
    assert.notEqual(nextTask.sourceEventId, event.id)
    assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [task.id])).rows[0].status, 'cancelled')
    assert.deepEqual((await pool.query('SELECT payload FROM coordinator_events WHERE id=$1', [event.id])).rows[0].payload, event.payload, 'the previous epoch request remains frozen')
    assert.equal((await pool.query('SELECT payload FROM coordinator_events WHERE id=$1', [nextTask.sourceEventId])).rows[0].payload.text, nextRequest)
    for (const invalid of [
      { userId: a.id, botId: b.botId, issueId: b.issueId, previousRunId: repairId },
      { userId: b.id, botId: a.botId, issueId: b.issueId, previousRunId: repairId },
      { userId: b.id, botId: b.botId, issueId: a.issueId, previousRunId: repairId },
      { userId: b.id, botId: b.botId, issueId: b.issueId, previousRunId: initial.runId },
    ]) {
      const badSource = randomUUID()
      await pool.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt") VALUES ($1::uuid,$2,$3,$4,'user_message',$1::text,$5,'background',now())`, [badSource, invalid.userId, invalid.botId, invalid.issueId, JSON.stringify({ source: 'thread_continuation', previousRunId: invalid.previousRunId, text: request, postedToChat: true })])
      await assert.rejects(queueTaskRun(b.id, { issueId: b.issueId, agentId: execution.agentId, repo: repo.remoteUrl, note: request,
        ...priorModel, threadRunId: repairId, requestKey: `invalid:${badSource}` }, b.botId, undefined, badSource), { code: 'factorySourceMismatch' })
    }
    assert.deepEqual(await accepted(), before, 'issue and accepted source/criteria/candidate/receipt remain unchanged')
    assert.equal(await botMessages(), messagesBefore, 'the private thread reply is not posted to the main Bot chat')
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
    const deniedSources = await pool.query(`SELECT 1 FROM coordinator_events WHERE "userId"=ANY($1) AND payload->>'source'='thread_continuation'`, [[stranger.id, teammate.id]])
    assert.equal(deniedSources.rows.length, 0, 'no owner continuation provenance was created for unauthorized callers')
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
