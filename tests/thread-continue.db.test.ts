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
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { connectGitHub, githubAppStub } from './support/github-app-stub'
import { isolateCoordinatorWakes } from './support/coordinator-wake'

// The computer's Codex reported gpt-5, the model the person's ChatGPT account lists (decision 2026-11-02-1400).
const mac = [{ harness: 'codex', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'gpt-5', model: 'gpt-5', name: 'gpt-5' }] }]
mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: { invokeDecision: async () => null } })

test('a message to an ended thread runs it again in the same thread; only its owner can send', { skip: !dbUrl }, async t => {
  const priorByos = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  t.after(() => { if (priorByos === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = priorByos })
  const coordinator = await isolateCoordinatorWakes(t)
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { readRunChain } = await import('../lib/run-chain')
  const { sendThreadMessage } = await import('../lib/thread-continue')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { withTaskWorkspace } = await import('../lib/task-workspace')
  const { chatBotId } = await import('../lib/coordinator/coordinator-bot')
  const users: string[] = []
  const github = githubAppStub()
  github.install('octo/repo', { contents: 'write', pull_requests: 'write' })
  let githubAccount = 9_500_000
  t.after(async () => {
    await coordinator.flush()
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
    const issueId = await seedIssue(pool, id, ws.id)
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

  await t.test('a dispatch records its entry and a person continuation is an app entry', async () => {
    const c = await person()
    const originRef = { kind: 'telegram', chatId: '42', messageId: 7 }
    const initial = await steps.dispatchRun(c.id, {
      issueId: c.issueId, repo: 'octo/repo', requestKey: `origin:${randomUUID()}`, origin: 'telegram', originRef,
    }, undefined, c.botId) as unknown as { runId: string }
    const [stored] = (await pool.query('SELECT origin,"originRef" FROM agent_runs WHERE id=$1', [initial.runId])).rows
    assert.deepEqual(stored, { origin: 'telegram', originRef })
    await end(initial.runId, 'succeeded')
    const next = await sendThreadMessage(c.id, initial.runId, 'Continue the same task from the app.')
    assert.equal(next.continued, true)
    const [continued] = (await pool.query('SELECT origin,"originRef" FROM agent_runs WHERE id=$1', [next.runId])).rows
    assert.deepEqual(continued, { origin: 'web', originRef: null }, 'a person’s continuation is the app entry, not the old one')
  })

  await t.test('a lost reply and concurrent retries reuse one owner submission, epoch, run and message', async () => {
    const b = await person()
    const initial = await steps.dispatchRun(b.id, { issueId: b.issueId, repo: 'octo/repo', requestKey: `submission:${randomUUID()}` }, undefined, b.botId) as unknown as { runId: string }
    await end(initial.runId, 'succeeded')
    const requestId = randomUUID(), text = 'Continue with exactly 74 bytes; this is one submitted request.'
    const accepted = await sendThreadMessage(b.id, initial.runId, text, 'user', requestId)
    // The first response may have been lost during a deployment. Neither the
    // latest run nor a repeated click changes this original request identity.
    const replay = await sendThreadMessage(b.id, initial.runId, text, 'user', requestId)
    assert.deepEqual(replay, accepted)
    const parallel = await Promise.all(Array.from({ length: 3 }, () => sendThreadMessage(b.id, initial.runId, text, 'user', requestId)))
    for (const result of parallel) assert.deepEqual(result, accepted)
    const { rows: [counts] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM coordinator_events WHERE "userId"=$1 AND payload->>'text'=$2) AS events,
      (SELECT count(*)::int FROM run_messages WHERE "userId"=$1 AND text=$2) AS messages,
      (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1) AS runs`, [b.id, text])
    assert.deepEqual(counts, { events: 1, messages: 1, runs: 2 })
    const eventId = (await pool.query(`SELECT id FROM coordinator_events WHERE "userId"=$1 AND payload->'threadSubmission'->>'requestId'=$2`, [b.id, requestId])).rows[0].id
    // Simulate a response/storage interruption after normal admission: the
    // durable Factory epoch remains, but the outer acknowledgement/display do not.
    await pool.query(`UPDATE coordinator_events SET payload=payload #- '{threadSubmission,result}' WHERE id=$1`, [eventId])
    await pool.query('DELETE FROM run_messages WHERE id=$1 AND "userId"=$2', [eventId, b.id])
    assert.deepEqual(await sendThreadMessage(b.id, initial.runId, text, 'user', requestId), accepted)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_messages WHERE id=$1', [eventId])).rows[0].n, 1)
    await assert.rejects(sendThreadMessage(b.id, initial.runId, 'Changed payload.', 'user', requestId), { code: 'submissionConflict' })
    const otherIssue = await seedIssue(pool, b.id, b.ws.id)
    await pool.query('UPDATE issues SET content=$2::jsonb WHERE id=$1', [otherIssue, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 9000 + users.length } } })])
    const other = await steps.dispatchRun(b.id, { issueId: otherIssue, repo: 'octo/repo', requestKey: `other:${randomUUID()}` }, undefined, b.botId) as unknown as { runId: string }
    assert.ok(other.runId, JSON.stringify(other))
    await assert.rejects(sendThreadMessage(b.id, other.runId, text, 'user', requestId), { code: 'submissionConflict' })
    const nextId = randomUUID()
    const concurrent = await Promise.allSettled(Array.from({ length: 3 }, () => sendThreadMessage(b.id, initial.runId, 'A later explicit owner request.', 'user', nextId)))
    assert.ok(concurrent.some(result => result.status === 'fulfilled'))
    for (const result of concurrent) if (result.status === 'rejected') assert.equal(result.reason.message, 'threadSubmissionOutcomeUnconfirmed')
    const next = await sendThreadMessage(b.id, initial.runId, 'A later explicit owner request.', 'user', nextId)
    assert.ok(next.runId)
    for (const result of concurrent) if (result.status === 'fulfilled') assert.deepEqual(result.value, next)
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE "userId"=$1 AND payload->'threadSubmission'->>'requestId'=$2`, [b.id, nextId])).rows[0].n, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_messages WHERE "userId"=$1 AND text=$2', [b.id, 'A later explicit owner request.'])).rows[0].n, 1)
    const beforeReplay = (await pool.query(`SELECT "sourceEventId","attemptId",revision FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2`, [b.id, b.issueId])).rows[0]
    assert.deepEqual(await sendThreadMessage(b.id, initial.runId, text, 'user', requestId), accepted)
    const afterReplay = (await pool.query(`SELECT "sourceEventId","attemptId",revision FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2`, [b.id, b.issueId])).rows[0]
    assert.deepEqual(afterReplay, beforeReplay, 'an old accepted request never advances or stops the newer epoch')
  })

  await t.test('an intent without a host receipt remains unconfirmed and is not executed again', async () => {
    const { submitThreadOnce } = await import('../lib/thread-submission')
    const input = { userId: a.id, requestId: randomUUID(), rootRunId: first.runId, requestedRunId: first.runId,
      previousRunId: first.runId, issueId: a.issueId, botId: a.botId, text: 'Synthetic interrupted owner submission.', mode: 'message' as const }
    let deliveries = 0
    await assert.rejects(submitThreadOnce(pool, input, async () => { deliveries++; throw new Error('synthetic interruption') }), /synthetic interruption/)
    await assert.rejects(submitThreadOnce(pool, input, async () => { deliveries++; return { runId: first.runId, continued: false } }), /threadSubmissionOutcomeUnconfirmed/)
    assert.equal(deliveries, 1)
  })


  await t.test('an authenticated thread answer uses its Factory task Bot scope and resumes exactly once', async t => {
    const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
    const { questionReference } = await import('../lib/factory/questions/store')
    const { freezeWorkerDefinition } = await import('../lib/agent-kit/worker')
    const { questionWakeRuntime, claimQuestionWake, finishQuestionWake } = await import('../lib/factory/questions/wake')
    const wake = mock.method(questionWakeRuntime, 'enqueue', async (..._args: Parameters<typeof questionWakeRuntime.enqueue>) => 'fixture-workflow')
    const workflowStatus = mock.method(questionWakeRuntime, 'status', async () => 'completed')
    t.after(() => { wake.mock.restore(); workflowStatus.mock.restore() })
    for (const scope of ['bot', 'legacy', 'separate-runtime'] as const) await t.test(scope === 'legacy' ? 'legacy task without a Bot' : scope === 'bot' ? 'Bot-owned task' : 'Coordinator task on another Bot computer in the same workspace', async () => {
      const legacyNullScope = scope === 'legacy'
      const b = await person()
      let wakeAvailable = false
      const woken: string[] = []
      wake.mock.mockImplementation(async (actor, runId, intent) => {
        assert.equal(actor.userId, b.id)
        const question = (await pool.query('SELECT status FROM factory_questions WHERE "continuationRunId"=$1', [runId])).rows[0]
        assert.equal(question?.status, 'resuming', 'the answer committed before the wake boundary')
        if (!wakeAvailable) throw new Error('Synthetic interruption after answer commit, before VM wake')
        const workflowId = `fixture-workflow-${randomUUID()}`
        assert.equal(await claimQuestionWake(pool, actor, runId, intent, workflowId), true)
        woken.push(runId)
        await pool.query(`UPDATE thread_machines SET state='running' WHERE "runId"=$1`, [runId])
        await finishQuestionWake(pool, actor, runId, intent, workflowId, false)
        return workflowId
      })
      const initial = await steps.dispatchRun(b.id, { issueId: b.issueId, repo: 'octo/repo', requestKey: `question:${randomUUID()}` }, undefined, b.botId) as unknown as { runId: string }
      assert.ok(initial.runId, JSON.stringify(initial))
      const task = (await pool.query('SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1', [initial.runId])).rows[0]
      // Preserve the historical personal task path with its null Bot scope.
      if (legacyNullScope) {
        await pool.query('UPDATE factory_tasks SET "botId"=NULL WHERE id=$1', [task.id])
        await pool.query('UPDATE agent_runs SET "botId"=NULL WHERE id=$1', [initial.runId])
        await pool.query('UPDATE coordinator_events SET "botId"=NULL WHERE id=$1', [task.sourceEventId])
      }
      // The CLI handoff and VM are synthetic; all task, question, credential,
      // answer, continuation and idempotency services use the real database.
      // Only the external VM wake is intercepted, after the transaction commits.
      const originRun = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [initial.runId])).rows[0]
      const runtimeBotId = scope === 'separate-runtime' ? await seedBot(pool, b.ws.id, b.id, 'Question runtime Bot') : b.botId
      const childDevice = randomUUID(), childRepo = randomUUID(), sandboxId = `fixture-vm-${initial.runId}`
      const definition = freezeWorkerDefinition({
        harness: 'codex', instructions: originRun.agentDefinition.instructions, prompt: originRun.prompt,
        parent: null, executionId: null, model: originRun.agentDefinition.model,
        modelDispatch: { mode: 'picked', location: 'cloud' },
        subscription: { id: originRun.agentDefinition.subscription.bindingId,
          modelId: originRun.agentDefinition.subscription.modelId, route: originRun.agentDefinition.subscription.route },
      })
      await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses)
        VALUES ($1,$2,'Question task VM','cloud',true,now(),$3)`, [childDevice, b.id, JSON.stringify(mac)])
      await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl","baseBranch")
        VALUES ($1,$2,$3,$4,NULL,'main')`, [childRepo, childDevice, b.id, `/isolated/question-${initial.runId}`])
      await pool.query('UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"agentDefinition"=$4,"baseBranch"=\'main\' WHERE id=$1',
        [initial.runId, childDevice, childRepo, JSON.stringify(definition)])
      if (scope === 'separate-runtime') await pool.query('UPDATE agent_runs SET "botId"=$2 WHERE id=$1', [initial.runId, runtimeBotId])
      await pool.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)',
        [initial.runId, runtimeBotId, b.ws.id, b.id])
      await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId")
        VALUES ($1,$2,$3,$4,$5,$6,'codex',$7,'running',$8,$9)`,
        [initial.runId, b.ws.id, b.id, runtimeBotId, b.issueId, sandboxId, randomUUID(), childDevice, childRepo])
      const questions = factoryRuntimeForBot(legacyNullScope ? null : b.botId).questions
      // Exercise the same host claim gate that admitted the production run.
      // A task's chat Bot may send work to another owned Bot in its workspace.
      await withTaskWorkspace(b.id, b.ws.id, async () => {
        const claimTx = await pool.connect()
        try {
          await claimTx.query('BEGIN')
          const originalClaim = await factoryRuntimeForBot(legacyNullScope ? null : b.botId).claim(claimTx, b.id, childDevice, initial.runId, new Date(Date.now() + 60_000).toISOString())
          assert.equal(originalClaim.preserveQuestionWorktree, true)
        } finally {
          try { await claimTx.query('ROLLBACK') } finally { claimTx.release() }
        }
      })
      const questionId = randomUUID(), sessionId = randomUUID(), nativeSessionId = `native:${initial.runId}`
      await pool.query(`INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt")
        VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`, [sessionId, b.id, `fixture-${randomUUID()}`])
      await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,"finishedAt"=now(),report=$3 WHERE id=$1`,
        [initial.runId, nativeSessionId, JSON.stringify({ summary: 'Synthetic CLI handoff', question: { questionId, kind: 'decision', question: 'Continue the original task?', options: [] } })])
      const recorded = await questions.record(b.id, initial.runId)
      await questions.escalate(b.id, { reference: questionReference(recorded), eventId: randomUUID(), reason: 'Only the owner can decide.' })
      const snapshot = async () => (await pool.query(`SELECT to_jsonb(q) AS question,to_jsonb(t) AS task,
        (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1) AS runs,
        (SELECT count(*)::int FROM run_messages WHERE "userId"=$1) AS messages
        FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId" WHERE q.id=$2`, [b.id, questionId])).rows[0]
      const before = await snapshot()
      const text = 'Continue once with the original constraints and original native session.'
      const human = { source: 'human' as const, sessionId }
      for (const source of ['user', 'peer', { source: 'orchestrator' }] as const)
        await assert.rejects(sendThreadMessage(b.id, initial.runId, text, source), { code: 'runNotFound' })
      await assert.rejects(sendThreadMessage(a.id, initial.runId, text, { source: 'human', sessionId }), { code: 'runNotFound' })
      await assert.rejects(sendThreadMessage(b.id, initial.runId, text, { source: 'human', sessionId: randomUUID() }), { code: 'factoryHumanRequired' })
      assert.deepEqual(await snapshot(), before, 'denied callers cannot answer, advance the task or create a continuation')

      // Even an owned thread cannot borrow another Bot\'s source event.
      await pool.query('UPDATE coordinator_events SET "botId"=$2 WHERE id=$1', [task.sourceEventId, a.botId])
      await assert.rejects(sendThreadMessage(b.id, initial.runId, text, human), { code: 'factoryNotFound' })
      await pool.query('UPDATE coordinator_events SET "botId"=$2 WHERE id=$1', [task.sourceEventId, legacyNullScope ? null : b.botId])
      assert.deepEqual(await snapshot(), before, 'source ownership and Bot authorization remain enforced')

      if (scope === 'separate-runtime') {
        const otherWorkspace = await seedWorkspace(pool, b.id, [{ userId: b.id, role: 'admin' }])
        const otherChatBot = await seedBot(pool, otherWorkspace.id, b.id, 'Question in another workspace')
        await assert.rejects(pool.query('UPDATE factory_tasks SET "botId"=$2 WHERE id=$1', [task.id, otherChatBot]), /taskWorkspaceMismatch/)
        assert.deepEqual(await snapshot(), before, 'the database refuses a task chat Bot from another workspace before continuation')
      }

      const requestId = randomUUID()
      // A real admission refusal commits neither answer nor continuation. The
      // browser still owns its durable submission ID and must be able to retry
      // this same question once the original VM is available again.
      await pool.query(`UPDATE thread_machines SET state='paused',"workerLeaseUntil"=now()+interval '1 hour' WHERE "runId"=$1`, [initial.runId])
      await assert.rejects(sendThreadMessage(b.id, initial.runId, text, human, requestId), { code: 'factoryQuestionContinuationUnavailable' })
      assert.deepEqual(await snapshot(), before, 'a refused question continuation rolls back the answer and task advance')
      await assert.rejects(sendThreadMessage(b.id, initial.runId, 'Changed answer.', human, requestId), { code: 'submissionConflict' })
      await assert.rejects(sendThreadMessage(a.id, initial.runId, text, human, requestId), { code: 'runNotFound' })
      await pool.query('UPDATE thread_machines SET "workerLeaseUntil"=NULL WHERE "runId"=$1', [initial.runId])
      const retried = await Promise.all(Array.from({ length: 3 }, () => sendThreadMessage(b.id, initial.runId, text, human, requestId)))
      const accepted = retried[0]
      for (const result of retried) assert.deepEqual(result, accepted)
      assert.deepEqual(accepted, { runId: initial.runId, continued: false })
      const answered = await questions.read(b.id, questionId)
      assert.equal(answered.status, 'resuming')
      assert.equal(answered.answerSource, 'human')
      assert.ok(answered.answerId)
      assert.ok(answered.continuationRunId)
      const origin = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [initial.runId])).rows[0]
      const next = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [answered.continuationRunId])).rows[0]
      assert.equal(next.status, 'queued')
      for (const field of ['agentId', 'deviceId', 'deviceRepoId', 'baseBranch', 'botId']) assert.equal(next[field], origin[field], field)
      assert.equal(next.agentDefinition.definitionDigest, origin.agentDefinition.definitionDigest)
      assert.equal(next.questionContinuation.questionId, questionId)
      assert.equal(next.questionContinuation.originRunId, initial.runId)
      assert.equal(next.questionContinuation.originSessionId, nativeSessionId)
      assert.equal(next.questionContinuation.requireSessionResume, true)
      assert.equal(next.questionContinuation.requiredSandboxId, sandboxId)
      assert.equal((await pool.query('SELECT "sandboxId" FROM thread_machines WHERE "runId"=$1', [next.id])).rows[0].sandboxId, sandboxId)
      assert.equal(wake.mock.calls.filter(call => call.arguments[1] === next.id).length, 1,
        'concurrent answer replays share the one reserved wake generation')
      assert.deepEqual(woken, [], 'the simulated postcommit interruption did not wake the VM')
      assert.equal((await pool.query('SELECT state FROM thread_machines WHERE "runId"=$1', [next.id])).rows[0].state, 'paused')
      assert.equal((await pool.query('SELECT "botId" FROM factory_tasks WHERE id=$1', [task.id])).rows[0].botId, legacyNullScope ? null : b.botId)
      const after = await snapshot()
      assert.equal(after.runs, before.runs + 1)
      assert.equal(after.messages, before.messages + 1)
      assert.deepEqual(await sendThreadMessage(b.id, initial.runId, text, human, requestId), accepted)
      assert.deepEqual(await snapshot(), after, 'the exact submission replays its receipt without creating another answer or native continuation')
      // The answer's transaction committed, but saving the outer HTTP receipt
      // did not. Its exact question-resume event must recover the same result;
      // replay must never target the now-latest continuation as a fresh message.
      const submission = (await pool.query(`SELECT id FROM coordinator_events WHERE "userId"=$1 AND payload->'threadSubmission'->>'requestId'=$2`, [b.id, requestId])).rows[0]
      assert.ok(submission)
      const loseAcknowledgement = () => pool.query(`UPDATE coordinator_events SET payload=payload #- '{threadSubmission,result}' WHERE id=$1`, [submission.id])
      wakeAvailable = true
      const expireWakeDeadline = () => pool.query(`UPDATE factory_events SET result=result || jsonb_build_object('nextAt',$2::text)
        WHERE "taskId"=$1 AND request->>'kind'='question_wake' AND request->>'runId'=$3`, [task.id, new Date(0).toISOString(), next.id])
      await loseAcknowledgement()
      assert.deepEqual(await sendThreadMessage(b.id, initial.runId, text, human, requestId), accepted)
      assert.deepEqual(woken, [], 'an unknown enqueue acknowledgement keeps its deadline before another wake')
      await expireWakeDeadline()
      // A historical acceptance is still acknowledged when cancellation or an
      // owner stop prevents the queued child from running. It grants no wake.
      await pool.query(`UPDATE factory_tasks SET status='cancelled' WHERE id=$1`, [task.id])
      await loseAcknowledgement()
      assert.deepEqual(await sendThreadMessage(b.id, initial.runId, text, human, requestId), accepted)
      assert.deepEqual(woken, [], 'a cancelled task never wakes its queued question continuation')
      await pool.query(`UPDATE factory_tasks SET status=$2 WHERE id=$1`, [task.id, after.task.status])
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [next.id])
      await loseAcknowledgement()
      assert.deepEqual(await sendThreadMessage(b.id, initial.runId, text, human, requestId), accepted)
      assert.deepEqual(woken, [], 'an owner-stopped child never wakes while recovering a receipt')
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [next.id])
      await pool.query(`UPDATE coordinator_events SET payload=payload #- '{threadSubmission,result}' WHERE id=$1`, [submission.id])
      const replayed = await Promise.all(Array.from({ length: 3 }, () => sendThreadMessage(b.id, initial.runId, text, human, requestId)))
      for (const result of replayed) assert.deepEqual(result, accepted)
      assert.ok(woken.length > 0, 'retry must finish the original postcommit wake, not merely acknowledge the answer')
      assert.ok(woken.every(runId => runId === next.id), 'every replay may wake only the original admitted child')
      assert.deepEqual((await pool.query('SELECT state,"sandboxId" FROM thread_machines WHERE "runId"=$1', [next.id])).rows[0], { state: 'running', sandboxId })
      // enqueue failure can also leave the outer result already saved. That
      // same accepted submission still retries only its pending native wake.
      await pool.query(`UPDATE thread_machines SET state='paused' WHERE "runId"=$1`, [next.id])
      const wakesBeforeSavedReplay = woken.length
      assert.deepEqual(await sendThreadMessage(b.id, initial.runId, text, human, requestId), accepted)
      assert.equal(woken.length, wakesBeforeSavedReplay, 'a saved acknowledgement cannot bypass the current wake deadline')
      await expireWakeDeadline()
      assert.deepEqual(await sendThreadMessage(b.id, initial.runId, text, human, requestId), accepted)
      assert.ok(woken.length > wakesBeforeSavedReplay, 'a saved outer acknowledgement must not strand its queued native continuation')
      assert.ok(woken.every(runId => runId === next.id))
      assert.deepEqual((await pool.query('SELECT state,"sandboxId" FROM thread_machines WHERE "runId"=$1', [next.id])).rows[0], { state: 'running', sandboxId })
      assert.deepEqual(await snapshot(), after, 'a lost outer acknowledgement cannot create a second answer, continuation or mailbox message')
      await assert.rejects(sendThreadMessage(b.id, initial.runId, 'Changed answer after acceptance.', human, requestId), { code: 'submissionConflict' })
      await assert.rejects(sendThreadMessage(a.id, initial.runId, text, human, requestId), { code: 'runNotFound' })

      // Continue through the actual cloud adapter and question settlement. The
      // CLI observations are synthetic; no provider or browser is contacted.
      // Normal answer() deliberately leaves the persisted continuesRunId null.
      assert.equal(next.continuesRunId, null)
      const { factoryBinding } = await import('../lib/factory/dispatch')
      const { factoryEventId } = await import('../lib/factory/event-id')
      const { questionExecutionContinuation } = await import('../lib/factory/questions/execution-continuation')
      const { producerCommandObservations } = await import('../lib/factory/checks')
      const runtime = factoryRuntimeForBot(legacyNullScope ? null : b.botId)
      const base = 'a'.repeat(40), head = 'b'.repeat(40), worktree = `/isolated/question-${initial.runId}`
      const observedAt = new Date(Date.now() - 240_000).toISOString()
      const inputId = randomUUID(), outputId = randomUUID()
      await pool.query(`UPDATE agent_runs SET "startedAt"=clock_timestamp()-interval '5 minutes',
        "finishedAt"=clock_timestamp()-interval '3 minutes',"worktreePath"=$2 WHERE id=$1`, [origin.id, worktree])
      await pool.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,1,$3,$4),($5,$2,2,$6,$4)`,
        [inputId, origin.id, JSON.stringify({ type: 'tool-input-available', toolName: 'shell', toolCallId: 'before-question',
          input: { command: 'wc -c REPORT.md && sha256sum REPORT.md' } }), observedAt, outputId,
          JSON.stringify({ type: 'tool-output-available', toolCallId: 'before-question', output: { exitCode: 0, output: '52 REPORT.md' } })])
      const claim = await questions.claimContinuation(b.id, childDevice, next.id, new Date(Date.now() + 60_000).toISOString())
      assert.equal(claim.continuesRunId, origin.id, 'the host handoff resumes the question origin')
      assert.equal((await pool.query('SELECT "continuesRunId" FROM agent_runs WHERE id=$1', [next.id])).rows[0].continuesRunId, null,
        'claim does not invent a persisted predecessor to make the reader pass')
      for (const id of [origin.id, next.id]) await pool.query('INSERT INTO byos_native_runs("runId","bindingId") VALUES($1,$2)',
        [id, next.agentDefinition.subscription.bindingId])
      await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,
        "worktreePath"=$3,"finishedAt"=clock_timestamp(),report=$4 WHERE id=$1`,
        [next.id, nativeSessionId, worktree, JSON.stringify({ summary: 'Synthetic resumed submission',
          sourceCommit: base, deliverableCommit: head, verify: { status: 'not_run' } })])
      assert.equal((await questions.settle(b.id, next.id))?.status, 'resolved')
      let current = (await runtime.store.read(b.id, task.id)).task
      current = (await runtime.store.apply(b.id, factoryBinding(current), randomUUID(), { action: 'candidate', runId: next.id,
        candidate: { kind: 'deliverable', sha: null, repository: worktree, environment: `device:${childDevice}`, scope: 'Question artifact' } })).task
      const candidate = { id: current.candidateId!, executionSha: head, producerExecution: { runId: next.id, sessionId: nativeSessionId } }
      current = (await runtime.store.apply(b.id, factoryBinding(current), randomUUID(), { action: 'finish', status: 'passed',
        reason: 'Synthetic producer submitted its artifact', output: { runId: next.id },
        evidence: [{ artifact: `run-report:${next.id}`, kind: 'report', runId: next.id, sessionId: nativeSessionId,
          candidateId: candidate.id, sha: null, environment: `device:${childDevice}`, recordedAt: new Date().toISOString() }] })).task
      const producerAttemptId = current.attemptId
      current = (await runtime.store.apply(b.id, factoryBinding(current), randomUUID(), {
        action: 'advance', stage: 'review', reason: 'Independent review remains required' })).task
      const result = JSON.parse(await producerCommandObservations(pool, current, candidate))
      assert.deepEqual(result.records, [], 'the resumed segment has no new command observations')
      assert.equal(result.inheritedRecordsOmitted, false)
      assert.equal(result.inheritedRecords.length, 1, 'normal cloud answer/claim/settle preserves the pre-question command')
      assert.deepEqual([result.inheritedRecords[0].sourceRunId, result.inheritedRecords[0].sourceSessionId,
        result.inheritedRecords[0].sourceStatus, result.inheritedRecords[0].outputChunkId,
        result.inheritedRecords[0].questionId, result.inheritedRecords[0].answerId,
        result.inheritedRecords[0].recoveryEventId, result.inheritedRecords[0].candidateSha],
        [origin.id, nativeSessionId, 'stopped', outputId, questionId, answered.answerId,
          factoryEventId('question-resume', answered.answerId!), head])
      assert.equal((await questionExecutionContinuation(pool, current, producerAttemptId))?.sourceRunId, origin.id)
      const otherWorkspace = await seedWorkspace(pool, b.id, [{ userId: b.id, role: 'admin' }])
      const otherBot = await chatBotId(b.id, null, otherWorkspace.id)
      const lineage = async () => (await pool.query('SELECT "userId","workspaceId","issueId","continuesRunId","questionContinuation",status FROM agent_runs WHERE id=$1', [next.id])).rows[0]
      const beforeLineage = await lineage()
      for (const [label, statement, args] of [
        ['another owner predecessor', 'UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [next.id, first.runId]],
        ['missing question origin', `UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{originRunId}',to_jsonb($2::text)) WHERE id=$1`, [next.id, randomUUID()]],
      ] as [string, string, unknown[]][]) {
        await assert.rejects(pool.query(statement, args), { code: '23514' }, label)
        assert.deepEqual(await lineage(), beforeLineage, `${label}: the rejected write changes no run authority`)
        assert.deepEqual(JSON.parse(await producerCommandObservations(pool, current, candidate)), result,
          `${label}: the admitted same-tenant question evidence stays intact`)
      }
      const corruptions: [string, string, unknown[]][] = [
        // These rows exist in the same owner/task/tenant. The question receipt
        // must still reject a self-cycle or an origin other than its real parent.
        ['explicit conflicting predecessor', 'UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [next.id, next.id]],
        ['wrong origin payload', `UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{originRunId}',to_jsonb($2::text)) WHERE id=$1`, [next.id, next.id]],
        ['missing receipt', 'DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, factoryEventId('question-resume', answered.answerId!)]],
        ['wrong answer fingerprint', `UPDATE factory_questions SET "answerFingerprint"='changed' WHERE id=$1`, [questionId]],
        ['different actual SID', 'UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [next.id, 'different-native-session']],
        ['changed definition', `UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{definitionDigest}','"changed"') WHERE id=$1`, [next.id]],
        ['missing source native claim', 'DELETE FROM byos_native_runs WHERE "runId"=$1', [origin.id]],
        ['different workspace', 'UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1', [next.id, otherWorkspace.id, otherBot]],
        ['wrong request epoch', `UPDATE factory_attempts SET output=jsonb_set(output,'{requestEpoch}',to_jsonb($2::text)) WHERE id=$1`, [producerAttemptId, randomUUID()]],
      ]
      for (const [label, sql, args] of corruptions) {
        const tx = await pool.connect()
        try {
          await tx.query('BEGIN')
          await tx.query(sql, args)
          assert.deepEqual(JSON.parse(await producerCommandObservations(tx, current, candidate)).inheritedRecords, [], label)
        } finally { await tx.query('ROLLBACK'); tx.release() }
      }
      assert.deepEqual(JSON.parse(await producerCommandObservations(pool, { ...current, userId: a.id }, candidate)).inheritedRecords, [])
      assert.deepEqual(JSON.parse(await producerCommandObservations(pool, current, { ...candidate, executionSha: 'c'.repeat(40) })).inheritedRecords, [])
      const wakesBeforeTerminalReplay = woken.length
      await loseAcknowledgement()
      assert.deepEqual(await sendThreadMessage(b.id, initial.runId, text, human, requestId), accepted)
      assert.equal(woken.length, wakesBeforeTerminalReplay, 'a completed child and advanced task remain history, without another wake')

    })
  })

  await t.test('an ordinary owned live message is acknowledged once even after its run ends', async () => {
    const runId = randomUUID(), requestId = randomUUID(), text = 'One ordinary owner message.'
    await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId",status,prompt,"botId")
      SELECT $1,"userId","agentId","deviceId",'running','Synthetic ordinary live thread',"botId"
      FROM agent_runs WHERE id=$2`, [runId, first.runId])
    assert.deepEqual(await sendThreadMessage(a.id, runId, text, 'user', requestId), { runId, continued: false })
    const eventId = (await pool.query(`SELECT id FROM coordinator_events WHERE "userId"=$1 AND payload->'threadSubmission'->>'requestId'=$2`, [a.id, requestId])).rows[0].id
    await end(runId, 'succeeded')
    await pool.query(`UPDATE coordinator_events SET payload=payload #- '{threadSubmission,result}' WHERE id=$1`, [eventId])
    assert.deepEqual(await sendThreadMessage(a.id, runId, text, 'user', requestId), { runId, continued: false })
    const { sendOwnedRunMessage } = await import('../lib/run-control')
    const { db } = await import('../lib/db')
    await sendOwnedRunMessage(db, a.id, { runId, text, messageId: eventId })
    await assert.rejects(sendOwnedRunMessage(db, a.id, { runId, text: 'Different.', messageId: eventId }), { code: 'submissionConflict' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_messages WHERE "runId"=$1', [runId])).rows[0].n, 1)
  })

  await t.test('a working Factory thread records the new target and stops its stale executor', async () => {
    const sent = await sendThreadMessage(a.id, first.runId, 'Also cover the empty input.')
    assert.deepEqual(sent, { runId: first.runId, continued: false })
    const { rows } = await pool.query('SELECT text,"deliveredAt" FROM run_messages WHERE "runId"=$1', [first.runId])
    assert.equal(rows.length, 1)
    assert.match(rows[0].text, /Also cover the empty input\./)
    assert.ok(rows[0].deliveredAt, 'the raw target is recorded once; the new epoch executor receives it through dispatch')
    assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [first.runId])).rows[0].stopRequestedAt)
  })

  await t.test('repeated owner text is a fresh request after an intervening target', async () => {
    const epochs: string[] = [];
    for (const text of ['Use exactly 74 bytes.', 'Use exactly 77 bytes.', 'Use exactly 74 bytes.']) {
      await sendThreadMessage(a.id, first.runId, text);
      const { rows: [task] } = await pool.query('SELECT "sourceEventId" FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2', [a.id, a.issueId]);
      epochs.push(task.sourceEventId);
    }
    assert.equal(new Set(epochs).size, 3, 'message identity is independent of text');
  });

  await t.test('done, failed, stopped and cancelled threads each run again in the same thread', async () => {
    // The preceding owner targets may already have replaced a queued stale
    // executor. End the current run, while keeping the original thread URL.
    let last = (await readRunChain(pool, a.id, first.runId))!.latestRunId
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

  await t.test('ordinary text cannot cancel a blocked original-session task or queue a fresh continuation', async () => {
    const b = await person()
    const initial = await steps.dispatchRun(b.id, { issueId: b.issueId, repo: 'octo/repo', requestKey: `strict:${randomUUID()}` }, undefined, b.botId) as unknown as { runId: string }
    const task = (await pool.query('SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1', [initial.runId])).rows[0]
    const failedId = randomUUID(), failedAttemptId = randomUUID(), questionId = randomUUID(), originalSession = `original:${initial.runId}`
    const continuation = { questionId, originRunId: initial.runId, originSessionId: originalSession, followUp: 'Previously answered question', requireSessionResume: true }
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,"finishedAt"=now() WHERE id=$1`, [initial.runId, originalSession])
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"botId","agentDefinition","baseBranch","sessionId","questionContinuation","continuesRunId","stopReason","createdAt","finishedAt")
      SELECT $1,"userId","issueId","agentId","deviceId","deviceRepoId",'failed',prompt,"botId","agentDefinition","baseBranch",$2,$3,id,'error',"createdAt"+interval '1 second',now() FROM agent_runs WHERE id=$4`,
    [failedId, originalSession, JSON.stringify(continuation), initial.runId])
    await pool.query(`UPDATE factory_attempts SET status='waiting' WHERE id=$1`, [task.attemptId])
    await pool.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason)
      VALUES ($1,$2,'execute',2,2,'blocked',$3,'Original session continuation failed')`, [failedAttemptId, task.id, failedId])
    await pool.query(`UPDATE factory_tasks SET status='blocked',"attemptId"=$2,revision=revision+2 WHERE id=$1`, [task.id, failedAttemptId])
    const waitingBinding = { taskId: task.id, issueId: b.issueId, attemptId: task.attemptId, candidateId: null, revision: task.revision }
    await pool.query(`INSERT INTO factory_questions (id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,request,status,reason,"sourceEventId","answerId","answerSource",answer,"answerFingerprint",result,"continuationRunId")
      VALUES ($1,$2,$3,$4,$5,'execute',$6,$7,$8,$9,'context','Continue?','{}','blocked','Explicit recovery required',$10,$11,'human',$12,'fixture-fingerprint',$13,$14)`,
    [questionId, b.id, b.issueId, task.id, task.attemptId, initial.runId, originalSession, task.revision, JSON.stringify(waitingBinding), task.sourceEventId,
      randomUUID(), JSON.stringify({ text: 'The original answer' }), JSON.stringify({ questionId, continuationRunId: failedId }), failedId])
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1) AS runs,
      (SELECT count(*)::int FROM coordinator_events WHERE "userId"=$1) AS events,
      (SELECT count(*)::int FROM run_messages WHERE "userId"=$1) AS messages,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM factory_tasks t WHERE t."userId"=$1) AS tasks,
      (SELECT to_jsonb(q) FROM factory_questions q WHERE q.id=$2) AS question`, [b.id, questionId])).rows[0]
    const before = await snapshot()
    for (const text of ['Retry', '重试', 'Continue the task.']) {
      await assert.rejects(sendThreadMessage(b.id, initial.runId, text), { code: 'threadCannotContinue' })
    }
    assert.deepEqual(await snapshot(), before, 'no replacement task, cancellation, provenance event, message or answer mutation')
  })

  await t.test('generic thread dispatch cannot bypass the current Factory repair budget', async t => {
    const { queueTaskRun } = await import('../lib/factory/queue-local')
    const { factoryRuntimeForBot, factoryAuthorize } = await import('../lib/factory/runtime')
    const { createLegacyFactoryStore } = await import('./helpers/factory-legacy')
    const { factoryBinding } = await import('../lib/factory/dispatch')
    const { latestThreadRunModel } = await import('../lib/computer/run-model')
    const { latestTaskRun } = await import('../lib/thread-dispatch')
    const fixture = async (executeCount: number, atExecution = false, legacyReview = false) => {
      const b = await person()
      const initial = await steps.dispatchRun(b.id, { issueId: b.issueId, repo: 'octo/repo', requestKey: `budget:${randomUUID()}` }, undefined, b.botId) as unknown as { runId: string }
      assert.ok(initial.runId, JSON.stringify(initial))
      const task = (await pool.query('SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1', [initial.runId])).rows[0]
      if (legacyReview) {
        // Only the three old review-retry budget scenarios use pre-upgrade
        // task semantics. Materialize them before any synthetic execution;
        // the real queue and Owner/source authorization remain unchanged.
        const queued = (await pool.query('SELECT status,"startedAt","sessionId" FROM agent_runs WHERE id=$1', [initial.runId])).rows[0]
        assert.deepEqual(queued, { status: 'queued', startedAt: null, sessionId: null })
        const route = { ...task.route }; delete route.flowVersion
        const legacy = await createLegacyFactoryStore(pool, factoryAuthorize, b.botId).route(b.id, route)
        assert.equal(legacy.task.id, task.id)
        task.route = legacy.task.route
      }
      assert.equal(task.route.flowVersion, legacyReview ? undefined : 2)

      // These completed executions are synthetic history, not real model
      // turns. Give them a past chronology so a fast local DB cannot put
      // several executions in one JS millisecond and let random UUIDs choose
      // the latest run in this repair-budget test.
      await pool.query(`UPDATE agent_runs SET status='succeeded',"updatedAt"=now(),
        "createdAt"=now()-$2::int*interval '1 second',
        "finishedAt"=now()-$2::int*interval '1 second'+interval '500 milliseconds' WHERE id=$1`, [initial.runId, executeCount])
      await pool.query(`UPDATE factory_attempts SET status='passed',output='{}' WHERE id=$1`, [task.attemptId])
      let producerRunId = initial.runId
      // Synthetic legacy history: every execution counts even without requestEpoch
      // and regardless of its old attempt status. No executor runs in this fixture.
      for (let ordinal = 2; ordinal <= executeCount; ordinal++) {
        const runId = randomUUID()
        await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"botId","agentDefinition","continuesRunId","createdAt","finishedAt") SELECT $1,"userId","issueId","agentId","deviceId","deviceRepoId",'succeeded',prompt,"botId","agentDefinition",id,"createdAt"+interval '1 second',"createdAt"+interval '1500 milliseconds' FROM agent_runs WHERE id=$2`, [runId, producerRunId])
        await pool.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason,output) VALUES ($1,$2,'execute',$3,$3,$4,$5,'Synthetic legacy execution','{}')`, [randomUUID(), task.id, ordinal, ordinal === 2 ? 'waiting' : 'blocked', runId])
        producerRunId = runId
      }
      const candidateId = randomUUID(), reviewId = randomUUID(), reviewAttemptId = randomUUID()
      const producer = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [producerRunId])).rows[0]
      const repo = (await pool.query('SELECT * FROM device_repos WHERE id=$1', [producer.deviceRepoId])).rows[0]
      if (atExecution) {
        await pool.query(`UPDATE factory_tasks SET stage='execute',status='failed',"attemptId"=(SELECT id FROM factory_attempts WHERE "taskId"=$1 AND stage='execute' ORDER BY position DESC LIMIT 1),"candidateId"=NULL,revision=revision+1 WHERE id=$1`, [task.id])
      } else {
      await pool.query(`INSERT INTO factory_candidates (id,"taskId",kind,sha,repository,environment,scope,"runId") VALUES ($1,$2,'deliverable',NULL,$3,$4,'fixture',$5)`, [candidateId, task.id, repo.remoteUrl, `device:${producer.deviceId}`, producerRunId])
      await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",kind,status,prompt,"botId","agentDefinition","sessionId","stopReason","finishedAt") SELECT $1,"userId","issueId","agentId","deviceId","deviceRepoId",'acceptance','succeeded',prompt,"botId","agentDefinition",$2,'submitted',now() FROM agent_runs WHERE id=$3`, [reviewId, `review:${reviewId}`, producerRunId])
      await pool.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId","sessionId","candidateId",reason,output) VALUES ($1,$2,'review',1,$3,'failed',$4,$5,$6,'Synthetic failed independent review',$7)`, [reviewAttemptId, task.id, executeCount + 1, reviewId, `review:${reviewId}`, candidateId, JSON.stringify({ requestEpoch: task.sourceEventId, completion: { runId: reviewId, trustedFailureProvenance: true } })])
      await pool.query(`UPDATE factory_tasks SET stage='review',status='failed',"attemptId"=$2,"candidateId"=$3,revision=revision+1 WHERE id=$1`, [task.id, reviewAttemptId, candidateId])
      }
      assert.equal((await readRunChain(pool, b.id, producerRunId))?.latestRunId, producerRunId, 'synthetic history ends at its last producer')
      assert.equal((await latestTaskRun(pool, b.id, b.issueId))?.id, producerRunId, 'task dispatch sees the same last producer')
      const model = (await latestThreadRunModel(pool, b.id, b.issueId, producer.agentId))!
      const request = { issueId: b.issueId, agentId: producer.agentId, repo: repo.remoteUrl, ...model, threadRunId: producerRunId, note: 'Continue the same request.', requestKey: `budget:${randomUUID()}` }
      const snapshot = async () => (await pool.query(`SELECT jsonb_build_object(
        'task',(SELECT to_jsonb(t) FROM factory_tasks t WHERE t.id=$1),
        'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.position) FROM factory_attempts a WHERE a."taskId"=$1),
        'candidates',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM factory_candidates c WHERE c."taskId"=$1),
        'receipts',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e."eventId") FROM factory_events e WHERE e."taskId"=$1),
        'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM agent_runs r WHERE r."userId"=$2),
        'sources',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM coordinator_events e WHERE e."userId"=$2)
      ) AS value`, [task.id, b.id])).rows[0].value
      const retryReview = async () => {
        const current = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [task.id])).rows[0]
        const result = await factoryRuntimeForBot(b.botId).store.apply(b.id, factoryBinding(current), randomUUID(), { action: 'retry', reason: 'Repeat the independent review of the same candidate.' })
        assert.equal(result.task.stage, 'review')
        assert.equal(result.task.status, 'pending')
        assert.equal(result.task.candidateId, candidateId)
        assert.equal(result.task.sourceEventId, task.sourceEventId)
        return result.task
      }
      return { b, task, candidateId, producerRunId, request, snapshot, retryReview }
    }

    for (const status of ['failed', 'pending'] as const) await t.test(`exhausted ${status} review cannot be replaced by a generic thread continuation`, async () => {
      const f = await fixture(4, false, status === 'pending')
      if (status === 'pending') await f.retryReview()
      const before = await f.snapshot()
      await assert.rejects(queueTaskRun(f.b.id, f.request, f.b.botId, undefined, status === 'pending' ? f.task.sourceEventId : undefined), { code: 'factoryRecoveryBudgetExceeded' })
      assert.deepEqual(await f.snapshot(), before, 'no dispatch source, task revision, candidate, attempt, receipt or run changes')
    })

    for (const status of ['failed', 'blocked', 'waiting'] as const) await t.test(`exhausted ${status} execution cannot be retried by generic thread dispatch`, async () => {
      const f = await fixture(4, true)
      const { rows: [attempt] } = await pool.query('SELECT id FROM factory_attempts WHERE "taskId"=$1 AND stage=\'execute\' ORDER BY position DESC LIMIT 1', [f.task.id])
      await pool.query('UPDATE factory_attempts SET status=$2 WHERE id=$1', [attempt.id, status])
      await pool.query(`UPDATE factory_tasks SET stage='execute',status=$2,"attemptId"=$3,"candidateId"=NULL,revision=revision+1 WHERE id=$1`, [f.task.id, status, attempt.id])
      const before = await f.snapshot()
      await assert.rejects(queueTaskRun(f.b.id, f.request, f.b.botId), { code: 'factoryRecoveryBudgetExceeded' })
      assert.deepEqual(await f.snapshot(), before, 'a retry cannot add a fifth execute attempt, source, receipt or run')
    })

    await t.test('direct Owner repair cannot replace a legacy pending review after the same-epoch cap', async () => {
      const f = await fixture(4, false, true)
      const current = await f.retryReview()
      const before = await f.snapshot()
      const { handleFactory } = await import('../lib/factory/http')
      const response = await handleFactory(factoryRuntimeForBot(f.b.botId).store, {
        userId: f.b.id, method: 'POST', taskId: f.task.id, origin: 'http://127.0.0.1', url: 'http://127.0.0.1/mikka/api/factory',
        body: { binding: { taskId: current.id, revision: current.revision }, eventId: randomUUID(), action: 'repair', reason: 'Repair the same candidate.' },
      })
      assert.deepEqual(response, { status: 409, body: { error: 'factoryRecoveryBudgetExceeded' } })
      assert.deepEqual(await f.snapshot(), before, 'the normal Owner API cannot create a fifth execution to dispatch later')
    })

    await t.test('direct Owner retry cannot create a fifth same-epoch execution', async () => {
      const f = await fixture(4, true)
      const before = await f.snapshot(), current = before.task
      const { handleFactory } = await import('../lib/factory/http')
      const response = await handleFactory(factoryRuntimeForBot(f.b.botId).store, {
        userId: f.b.id, method: 'POST', taskId: f.task.id, origin: 'http://127.0.0.1', url: 'http://127.0.0.1/mikka/api/factory',
        body: { binding: { taskId: current.id, revision: current.revision }, eventId: randomUUID(), action: 'retry', reason: 'Retry the same execution.' },
      })
      assert.deepEqual(response, { status: 409, body: { error: 'factoryRecoveryBudgetExceeded' } })
      assert.deepEqual(await f.snapshot(), before)
    })

    await t.test('same-epoch legacy continuation within budget queues the fourth execution once', async () => {
      const f = await fixture(3, false, true)
      await f.retryReview()
      const before = await f.snapshot()
      const result = await queueTaskRun(f.b.id, f.request, f.b.botId)
      const replay = await queueTaskRun(f.b.id, f.request, f.b.botId)
      assert.equal(replay.runId, result.runId)
      assert.notEqual(result.runId, f.producerRunId)
      const after = await f.snapshot()
      assert.equal(after.task.id, f.task.id)
      assert.equal(after.task.sourceEventId, f.task.sourceEventId)
      assert.equal(after.task.stage, 'execute')
      assert.equal(after.task.status, 'running')
      assert.equal(after.task.candidateId, null)
      assert.equal(after.attempts.filter((a: { stage: string }) => a.stage === 'execute').length, 4)
      assert.equal(after.runs.length, before.runs.length + 1)
      assert.deepEqual(after.candidates, before.candidates, 'a permitted repair preserves the historical candidate')
    })

    await t.test('an explicit Owner follow-up opens a new epoch after the old repair budget is exhausted', async () => {
      const f = await fixture(4)
      const before = await f.snapshot()
      const request = 'New owner request: keep the existing artifact and append a new result.'
      const result = await sendThreadMessage(f.b.id, f.producerRunId, request)
      assert.equal(result.continued, true)
      const after = await f.snapshot()
      assert.equal(after.task.id, f.task.id)
      assert.notEqual(after.task.sourceEventId, f.task.sourceEventId)
      assert.equal(after.task.stage, 'execute')
      assert.equal(after.task.status, 'running')
      assert.equal(after.task.candidateId, null)
      const executions = after.attempts.filter((a: { stage: string }) => a.stage === 'execute')
      assert.equal(executions.filter((a: { output: { requestEpoch: string } }) => a.output.requestEpoch === f.task.sourceEventId).length, 4)
      assert.equal(executions.filter((a: { output: { requestEpoch: string } }) => a.output.requestEpoch === after.task.sourceEventId).length, 1)
      assert.equal(after.runs.length, before.runs.length + 1)
      assert.deepEqual(after.candidates, before.candidates)
      const source = after.sources.find((e: { id: string }) => e.id === after.task.sourceEventId)
      assert.equal(source.payload.source, 'thread_continuation')
      assert.equal(source.payload.previousRunId, f.producerRunId)
      assert.equal(source.payload.text, request)
    })
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
    const accepted = async () => (await pool.query(`SELECT jsonb_build_object('source',to_jsonb(e),'candidate',to_jsonb(c),'acceptance',to_jsonb(a),'report',r.report,'issueContent',i.content) AS value FROM factory_tasks t JOIN issues i ON i.id=t."issueId" JOIN coordinator_events e ON e.id=$2 JOIN factory_candidates c ON c.id=$3 JOIN factory_deliverable_acceptances a ON a."taskId"=t.id AND a."candidateId"=c.id JOIN agent_runs r ON r.id=c."runId" WHERE t.id=$1`, [oldTask.id, oldTask.sourceEventId, oldCandidateId])).rows[0].value
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
    assert.equal(task.id, oldTask.id)
    assert.notEqual(task.sourceEventId, oldTask.sourceEventId)
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
    assert.deepEqual(counts, { tasks: 1, runs: 2 }, 'one owner turn creates one additional execute on the existing Task')
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
    await pool.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId","candidateId",reason) SELECT $1,$2,'review',1,COALESCE(max(position),0)+1,'pending',$3,$4,'synthetic review' FROM factory_attempts WHERE "taskId"=$2`, [reviewAttempt, task.id, reviewId, candidateId])
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
    await pool.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,reason,output) SELECT $1,$2,'execute',COALESCE(max(ordinal) FILTER(WHERE stage='execute'),0)+1,COALESCE(max(position),0)+1,'pending','synthetic automatic repair',$3 FROM factory_attempts WHERE "taskId"=$2`, [repairAttempt, task.id, JSON.stringify({ recovery: { choice: 'repair_code', failedAttemptId: reviewAttempt, failedRunId: reviewId, candidateId, rationale: 'Keep the new owner target.' } })])
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
    const dispatchRepair = () => withTaskWorkspace(b.id, b.ws.id, () =>
      dispatch(b.id, { binding: factoryBinding(repairingTask), agentId: execution.agentId, deviceRepoId: execution.deviceRepoId }))
    await dispatchRepair()
    assert.equal((await dispatchRepair()).runId, repairId)
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
    assert.equal(nextTask.id, task.id, 'explicit owner work after failed repair is another epoch in the same Task')
    assert.notEqual(nextTask.sourceEventId, event.id)
    assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [task.id])).rows[0].status, 'running')
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
