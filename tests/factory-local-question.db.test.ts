// Real local PostgreSQL regression for an Owner answer continuing one Factory
// question. Provider credentials and CLI handoff are synthetic; no model runs.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import type { RunPolicy } from '@mikka/protocol/agent-policy'
import { dbUrl, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { connectGitHub, githubAppStub } from './support/github-app-stub'

mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, {
  namedExports: { invokeDecision: async () => null },
})

test('a local Factory question preserves the original worker definition and native session', { skip: !dbUrl }, async t => {
  const previous = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  t.after(() => { if (previous === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = previous })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { queueTaskRun } = await import('../lib/factory/queue-local')
  const { factoryQuestions } = await import('../lib/factory/server')
  const { questionReference } = await import('../lib/factory/questions/store')
  const { sendThreadMessage } = await import('../lib/thread-continue')
  const github = githubAppStub()
  github.install('octo/repo', { contents: 'write', pull_requests: 'write' })
  const owner = await seedUser(pool, 'local-question')
  t.after(async () => {
    github.restore()
    await pool.query('DELETE FROM factory_questions WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM factory_tasks WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM run_messages WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [owner])
    await pool.query('UPDATE agent_runs SET "continuesRunId"=NULL,"threadReplacedBy"=NULL WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM agents WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM repository_settings WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM github_repository_installations WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM account WHERE "userId"=$1', [owner])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const accountId = String(9_560_000 + Math.floor(Math.random() * 100_000))
  await pool.query(`INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt")
    VALUES ($1,$2,'github',$3,now(),now())`, [randomUUID(), accountId, owner])
  github.allowWriter('octo/repo', accountId)
  await connectGitHub(github, owner, accountId, ['octo/repo'])
  await pool.query('INSERT INTO repository_settings("userId","remoteKey",push) VALUES ($1,$2,$3)',
    [owner, normalizeRepository('octo/repo').key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: owner, approvedAt: new Date().toISOString() })])
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const connectionId = randomUUID(), bindingId = randomUUID(), deviceId = randomUUID(), agentId = randomUUID()
  const model = 'gpt-6-luna'
  const harnesses = [{ harness: 'codex', installed: true, subscriptionBroker: true,
    models: [model] }]
  await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses)
    VALUES ($1,$2,'Local question fixture','local','laptop',true,now(),$3)`, [deviceId, owner, JSON.stringify(harnesses)])
  await pool.query(`INSERT INTO agents(id,"userId","deviceId",harness,name)
    VALUES ($1,$2,$3,'codex','Local question worker')`, [agentId, owner, deviceId])
  await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota)
    VALUES ($1,$2,$3,'codex','connected',1,$4,$5,'synthetic-subject',$6,$7)`,
  [connectionId, owner, workspace.id, `synthetic-${connectionId}`, 'a'.repeat(64),
    JSON.stringify({ revision: '1', models: [model] }),
    JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: null }] })])
  await pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
    VALUES ($1,$2,$3,$4,$5,1,'codex_cli',$6)`, [bindingId, owner, workspace.id, agentId, connectionId, model])
  await pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
    VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa',$5)`, [randomUUID(), owner, workspace.id, connectionId, model])
  const issueId = await seedIssue(pool, owner)
  await pool.query('UPDATE issues SET content=$2::jsonb WHERE id=$1',
    [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1256 } } })])
  // Use the real null-Bot admission path, rather than rewriting a Bot run into
  // an incompatible historical identity. The original service supports it.
  const policyCeiling: RunPolicy = { permissions: { install_dependency: 'deny', write_outside_repo: 'deny',
    git_push: 'deny', network: 'ask', computer_use: 'deny' }, networkAllow: ['github.com'], networkCeiling: ['github.com'] }
  const initial = await queueTaskRun(owner, { issueId, agentId, repo: 'octo/repo',
    requestKey: `local-question:${randomUUID()}`, model, subscriptionBindingId: bindingId,
    modelDispatch: { mode: 'picked', location: 'local' }, policyCeiling }, null)
  const original = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [initial.runId])).rows[0]
  assert.equal(original.botId, null)
  assert.equal(original.agentDefinition.model, model)
  assert.equal(original.agentDefinition.subscription.bindingId, bindingId)
  const task = (await pool.query('SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1', [initial.runId])).rows[0]
  assert.equal(task.botId, null)
  const questionId = randomUUID(), webSessionId = randomUUID(), nativeSessionId = `native:${initial.runId}`
  await pool.query(`INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt")
    VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`, [webSessionId, owner, `synthetic-${randomUUID()}`])
  await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,
    "finishedAt"=now(),report=$3 WHERE id=$1`, [initial.runId, nativeSessionId,
    JSON.stringify({ summary: 'Synthetic CLI handoff', question: { questionId, kind: 'decision', question: 'Continue with the same worker?', options: [] } })])
  const question = await factoryQuestions.record(owner, initial.runId)
  await factoryQuestions.escalate(owner, { reference: questionReference(question), eventId: randomUUID(), reason: 'The Owner decides.' })
  const text = 'Continue once in the original native session with the original task constraints.'
  const human = { source: 'human' as const, sessionId: webSessionId }
  const snapshot = async () => (await pool.query(`SELECT to_jsonb(q) AS question,to_jsonb(t) AS task,
    (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1) AS runs,
    (SELECT count(*)::int FROM run_messages WHERE "userId"=$1) AS messages,
    (SELECT count(*)::int FROM factory_events WHERE "taskId"=t.id) AS receipts
    FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId" WHERE q.id=$2`, [owner, questionId])).rows[0]
  const before = await snapshot()
  const denied = async (label: string, mutate: () => Promise<unknown>, restore: () => Promise<unknown>) => {
    await t.test(label, async () => {
      await mutate()
      try {
        await assert.rejects(sendThreadMessage(owner, initial.runId, text, human, randomUUID()))
        assert.deepEqual(await snapshot(), before, 'denial rolls back the answer, task retry, run and receipt')
      } finally { await restore() }
    })
  }
  await denied('a disabled original local device cannot resume',
    () => pool.query('UPDATE devices SET enabled=false WHERE id=$1', [deviceId]),
    () => pool.query('UPDATE devices SET enabled=true WHERE id=$1', [deviceId]))
  await denied('a paused original subscription cannot resume',
    () => pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [connectionId]),
    () => pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [connectionId]))
  await denied('a removed original credential cannot resume',
    () => pool.query('DELETE FROM byos_bindings WHERE id=$1', [bindingId]),
    () => pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      VALUES ($1,$2,$3,$4,$5,1,'codex_cli',$6)`, [bindingId, owner, workspace.id, agentId, connectionId, model]))
  await denied('revoked membership in the frozen workspace cannot resume',
    () => pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, owner]),
    () => pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, owner]))
  const other = await seedUser(pool, 'local-question-other')
  await denied('another owner cannot supply the original repository',
    () => pool.query('UPDATE device_repos SET "userId"=$2 WHERE id=$1', [original.deviceRepoId, other]),
    () => pool.query('UPDATE device_repos SET "userId"=$2 WHERE id=$1', [original.deviceRepoId, owner]))
  const repository = (await pool.query('SELECT * FROM device_repos WHERE id=$1', [original.deviceRepoId])).rows[0]
  await denied('a changed repository cannot inherit the old publication',
    () => pool.query('UPDATE device_repos SET "remoteUrl"=$2 WHERE id=$1', [repository.id, 'https://github.com/octo/another.git']),
    () => pool.query('UPDATE device_repos SET "remoteUrl"=$2 WHERE id=$1', [repository.id, repository.remoteUrl]))
  await denied('a missing original native SID cannot create a fresh session',
    () => pool.query('UPDATE agent_runs SET "sessionId"=NULL WHERE id=$1', [initial.runId]),
    () => pool.query('UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [initial.runId, nativeSessionId]))
  await t.test('another owner cannot answer this question', async () => {
    await assert.rejects(sendThreadMessage(other, initial.runId, text, human, randomUUID()), { code: 'runNotFound' })
    assert.deepEqual(await snapshot(), before)
  })
  await t.test('a failure after queue insertion rolls the complete answer back', async () => {
    const trigger = `reject_local_answer_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${questionId}'::uuid AND NEW.status='resuming' THEN RAISE EXCEPTION 'fixture_continuation_commit_failure'; END IF;
      RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON factory_questions FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    try {
      await assert.rejects(sendThreadMessage(owner, initial.runId, text, human, randomUUID()), /fixture_continuation_commit_failure/)
      assert.deepEqual(await snapshot(), before)
    } finally {
      await pool.query(`DROP TRIGGER ${trigger} ON factory_questions`)
      await pool.query(`DROP FUNCTION ${trigger}()`)
    }
  })
  await pool.query('UPDATE agents SET instructions=$2 WHERE id=$1', [agentId, 'New guidance for future tasks only.'])
  const requestId = randomUUID()
  const [accepted, concurrent] = await Promise.all([
    sendThreadMessage(owner, initial.runId, text, human, requestId),
    sendThreadMessage(owner, initial.runId, text, human, randomUUID()),
  ])
  assert.deepEqual(concurrent, accepted)
  const answered = await factoryQuestions.read(owner, questionId)
  assert.equal(answered.status, 'resuming')
  assert.ok(answered.continuationRunId)
  const next = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [answered.continuationRunId])).rows[0]
  assert.equal(next.status, 'queued')
  for (const field of ['agentId', 'deviceId', 'deviceRepoId', 'baseBranch', 'botId'])
    assert.equal(next[field], original[field], field)
  assert.equal(next.agentDefinition.definitionDigest, original.agentDefinition.definitionDigest)
  assert.equal(next.agentDefinition.model, original.agentDefinition.model)
  assert.deepEqual(next.agentDefinition.subscription, original.agentDefinition.subscription)
  assert.deepEqual(next.agentDefinition.modelDispatch, original.agentDefinition.modelDispatch)
  assert.deepEqual(next.agentDefinition.policyCeiling, policyCeiling)
  assert.equal(next.agentDefinition.instructions, original.agentDefinition.instructions)
  assert.deepEqual(next.agentDefinition.executionIdentity, original.agentDefinition.executionIdentity)
  assert.equal(next.questionContinuation.originSessionId, nativeSessionId)
  assert.equal(next.questionContinuation.originRunId, initial.runId)
  assert.equal(next.questionContinuation.requireSessionResume, true)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [owner])).rows[0].n, 2)
  assert.deepEqual(await sendThreadMessage(owner, initial.runId, text, { source: 'human', sessionId: webSessionId }, requestId), accepted)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [owner])).rows[0].n, 2)

  await t.test('a normally admitted Bot-owned local task resumes through its scoped runtime', async () => {
    const { chatBotId } = await import('../lib/coordinator/coordinator-bot')
    const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
    const botId = await chatBotId(owner, null, workspace.id)
    const scopedIssueId = await seedIssue(pool, owner)
    await pool.query('UPDATE issues SET content=$2::jsonb WHERE id=$1',
      [scopedIssueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1256001 } } })])
    const admitted = await queueTaskRun(owner, { issueId: scopedIssueId, agentId, repo: 'octo/repo',
      requestKey: `bot-local-question:${randomUUID()}`, model, subscriptionBindingId: bindingId,
      modelDispatch: { mode: 'picked', location: 'local' }, policyCeiling }, botId)
    const source = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [admitted.runId])).rows[0]
    assert.equal(source.botId, botId, 'the normal admission owns the Bot scope from creation')
    const scopedTask = (await pool.query('SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1',
      [source.id])).rows[0]
    assert.equal(scopedTask.botId, botId)
    const questions = factoryRuntimeForBot(botId).questions
    const qid = randomUUID(), sid = `native:${source.id}`
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,
      "finishedAt"=now(),report=$3 WHERE id=$1`, [source.id, sid, JSON.stringify({
      summary: 'Synthetic Bot CLI handoff', question: { questionId: qid, kind: 'decision', question: 'Continue this Bot task?', options: [] },
    })])
    const recorded = await questions.record(owner, source.id)
    await questions.escalate(owner, { reference: questionReference(recorded), eventId: randomUUID(), reason: 'The Owner decides.' })
    await pool.query('UPDATE agents SET instructions=$2 WHERE id=$1', [agentId, 'Later Bot tasks receive different instructions.'])
    const submissionId = randomUUID()
    const accepted = await sendThreadMessage(owner, source.id, text, human, submissionId)
    const resumed = await questions.read(owner, qid)
    assert.equal(resumed.status, 'resuming')
    const child = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [resumed.continuationRunId])).rows[0]
    assert.equal(child.status, 'queued')
    for (const field of ['agentId', 'deviceId', 'deviceRepoId', 'baseBranch', 'botId'])
      assert.equal(child[field], source[field], field)
    for (const field of ['definitionDigest', 'model', 'subscription', 'modelDispatch', 'policyCeiling', 'instructions', 'executionIdentity'])
      assert.deepEqual(child.agentDefinition[field], source.agentDefinition[field], field)
    assert.equal(child.questionContinuation.originRunId, source.id)
    assert.equal(child.questionContinuation.originSessionId, sid)
    assert.equal(child.questionContinuation.requireSessionResume, true)
    assert.deepEqual(await sendThreadMessage(owner, source.id, text, human, submissionId), accepted)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1 AND "issueId"=$2',
      [owner, scopedIssueId])).rows[0].n, 2, 'one original and one continuation')
  })
})
