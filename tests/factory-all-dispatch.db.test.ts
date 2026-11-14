// Every dispatch is a Factory task (docs/design/decisions/2026-11-03-0415-all-dispatch-through-factory.md),
// against a real PostgreSQL with synthetic Acme-like data: one Coordinator dispatch_run creates a Factory task
// and its execute attempt bound to the run it queued.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { connectGitHub, githubAppStub } from './support/github-app-stub'

mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: { invokeDecision: async () => null } })

const REPO = 'acme-corp/storefront'
const codex = [{ harness: 'codex', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'gpt-5', model: 'gpt-5', name: 'gpt-5' }] }]

test('a Coordinator dispatch_run goes through the Factory', { skip: !dbUrl, timeout: 180_000 }, async t => {
  const prior = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  const { overrideDeploymentSwitch } = await import('../lib/deployment-switches')
  overrideDeploymentSwitch('factoryRouting', true)
  overrideDeploymentSwitch('factoryLifecycle', true)
  // Exercise the real daemon format without typechecking its separate package under the web tsconfig.
  const { codexItemChunks } = await import(new URL('../packages/daemon/src/adapters/codex.ts', import.meta.url).href)
  const { claudeChunks } = await import(new URL('../packages/daemon/src/adapters/claude.ts', import.meta.url).href)
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { chatBotId } = await import('../lib/coordinator/coordinator-bot')
  const github = githubAppStub()
  github.install(REPO, { contents: 'write', pull_requests: 'write' })
  t.after(async () => {
    github.restore()
    overrideDeploymentSwitch('factoryRouting', undefined)
    overrideDeploymentSwitch('factoryLifecycle', undefined)
    if (prior === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = prior
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  // Acme's operations lead, their Acme workspace, a ChatGPT subscription listing gpt-5 (优先使用的模型),
  // Acme's always-on build server with Codex, and one storefront task.
  const userId = await seedUser(pool, 'acme-ops')
  const githubAccountId = String(9_700_000 + Math.floor(Math.random() * 100_000))
  await pool.query(`INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'github',$3,now(),now())`, [randomUUID(), githubAccountId, userId])
  github.allowWriter(REPO, githubAccountId)
  await connectGitHub(github, userId, githubAccountId, [REPO])
  await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [userId, normalizeRepository(REPO).key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: userId, approvedAt: new Date().toISOString() })])
  const ws = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }], 'Acme')
  const connection = randomUUID()
  await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,'codex','connected',1,$4,$5,'acme-subject',$6,$7)`,
    [connection, userId, ws.id, `acme-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models: ['gpt-5'] }), JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .1, resetsAt: null }] })])
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5')`, [randomUUID(), userId, ws.id, connection])
  const deviceId = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'acme-build-01','local','server',true,now(),$3)`, [deviceId, userId, JSON.stringify(codex)])
  await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex','Codex on acme-build-01')`, [randomUUID(), userId, deviceId])
  const issueId = randomUUID()
  await pool.query(`INSERT INTO issues (id,"userId","workspaceId","ownershipState",scope,title,content,status,priority) VALUES ($1,$2,$4,'bound','workspace','Checkout rounds sales tax down on multi-item carts',$3,'todo','high')`,
    [issueId, userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: Math.floor(Math.random() * 1000000000) } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Acme storefront: a cart of 3 x $19.99 in CA shows $5.24 tax instead of $5.25.' }] }] }), ws.id])
  const botId = await chatBotId(userId, null, ws.id)
  const sourceEventId = randomUUID()
  await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,'user_message',$4,$5)`,
    [sourceEventId, userId, botId, `acme:${sourceEventId}`, JSON.stringify({ text: `Please fix the checkout tax rounding in ${REPO}.` })])

  const dispatched = await steps.dispatchRun(userId, { issueId, repo: REPO, requestKey: `acme:${randomUUID()}`, sourceEventId }, undefined, botId) as unknown as { runId?: string; error?: string }
  assert.equal((await pool.query(`SELECT i.content->'attrs'->'mikka'->'delegate'->>'id'=r."agentId"::text AS assigned
    FROM issues i JOIN agent_runs r ON r."issueId"=i.id WHERE r.id=$1 AND i.id=$2`,[dispatched.runId,issueId])).rows[0]?.assigned,true)

  const counts = (await pool.query(`SELECT
      (SELECT count(*)::int FROM factory_tasks WHERE "userId"=$1) AS tasks,
      (SELECT count(*)::int FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE t."userId"=$1) AS attempts,
      (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1) AS runs`, [userId])).rows[0]
  console.log(`factory-all-dispatch: dispatch=${JSON.stringify(dispatched)} factory_tasks=${counts.tasks} factory_attempts=${counts.attempts} agent_runs=${counts.runs}`)
  assert.ok(dispatched.runId, `dispatch_run queued a run: ${JSON.stringify(dispatched)}`)
  assert.equal(counts.tasks, 1, 'one Factory task for the dispatch')
  assert.equal(counts.attempts, 1, 'its execute attempt')
  const { rows: [bound] } = await pool.query(`SELECT t.stage,t.status,a."runId" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE t."userId"=$1`, [userId])
  assert.deepEqual({ stage: bound.stage, status: bound.status, runId: bound.runId }, { stage: 'execute', status: 'running', runId: dispatched.runId })
  const command = 'node --test'
  await pool.query('UPDATE device_repos SET "verifyCommand"=$2 WHERE "userId"=$1', [userId, command])
  const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
  const runtime = factoryRuntimeForBot(botId)
  const sha = 'a'.repeat(40)
  const finish = async (id: string, check: boolean) => {
    await pool.query(`UPDATE agent_runs SET status='running',"sessionId"=$2,"startedAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [id, `independent-${id}`])
    if (check) {
      const call = { id: `check-${id}`, type: 'mcpToolCall' as const, server: 'mikka', tool: 'verify_command', arguments: { command }, status: 'completed' as const,
        result: { content: [{ type: 'text', text: JSON.stringify({ exitCode: 0 }) }], structuredContent: null }, error: null };
      const chunks = [...codexItemChunks('started', call, new Set(), '/tmp'), ...codexItemChunks('completed', call, new Set(), '/tmp')];
      for (const [seq, chunk] of chunks.entries()) await pool.query('INSERT INTO run_chunks (id,"runId",seq,chunk) VALUES ($1,$2,$3,$4)', [randomUUID(), id, seq + 1, JSON.stringify(chunk)])
      const { verifierCommandEvidence } = await import('../lib/factory/checks');
      // A failed or malformed MCP response cannot attest a passing command.
      for (const text of [JSON.stringify({ exitCode: 1 }), 'not-json']) {
        await pool.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output}', $2::jsonb) WHERE "runId"=$1 AND seq=2`, [id, JSON.stringify([{ type: 'text', text }])]);
        await pool.query(`UPDATE agent_runs SET "finishedAt"=clock_timestamp() WHERE id=$1`, [id]);
        assert.deepEqual(await verifierCommandEvidence(pool, id, command), []);
      }
      await pool.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output}', $2::jsonb) WHERE "runId"=$1 AND seq=2`, [id, JSON.stringify(call.result.content)]);
      assert.equal((await verifierCommandEvidence(pool, id, command)).length, 2, 'actual Codex content blocks');
      const [claude] = claudeChunks({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: call.id, content: call.result.content }] } });
      await pool.query('UPDATE run_chunks SET chunk=$2 WHERE "runId"=$1 AND seq=2', [id, JSON.stringify(claude)]);
      assert.equal((await verifierCommandEvidence(pool, id, command)).length, 2, 'actual Claude flattened JSON text');
    }
    await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"finishedAt"=clock_timestamp(),report=$2 WHERE id=$1`, [id, JSON.stringify({
      summary: 'Checked tax rounding with concrete evidence.', filesChanged: [], openQuestions: [], nextStep: null, sourceCommit: sha,
      verify: check ? { status: 'passed', command, exitCode: 0, signal: null, timedOut: false, output: 'passed' } : { status: 'not_run' },
      ...(check ? { check: { sha, readOnly: true }, criteria: [{ text: 'Tax rounds to the cent', passed: true, evidence: 'The fixture command passed.', command, exitCode: 0 }] } : { publish: { commit: sha, pushed: true, branch: 'mikka/fixture', remote: 'origin' } }),
    })])
    await runtime.reconcile.run(userId, id)
  }
  await finish(dispatched.runId!, false)
  const current = async () => (await pool.query(`SELECT t.id,t.route,t.stage,t.status,a."runId",r.kind,r."baseBranch",r."agentDefinition" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" LEFT JOIN agent_runs r ON r.id=a."runId" WHERE t."userId"=$1`, [userId])).rows[0]
  const review = await current()
  assert.equal(review.stage, 'review')
  assert.equal(review.status, 'running')
  assert.equal(review.baseBranch, sha)
  assert.equal(review.agentDefinition.readOnly, true)
  assert.notEqual(review.runId, dispatched.runId)
  await finish(review.runId, true)
  const acceptance = await current()
  assert.equal(acceptance.route.flowVersion, 2, 'new dispatches retain the host-frozen single-review flow')
  assert.equal(acceptance.stage, 'approval')
  assert.equal(acceptance.status, 'pending', 'only the person may accept')
  const attempts = (await pool.query('SELECT stage,"runId" FROM factory_attempts WHERE "taskId"=$1 ORDER BY position', [acceptance.id])).rows
  assert.deepEqual(attempts.map(attempt => attempt.stage), ['execute', 'review', 'approval'])
  assert.equal(attempts.filter(attempt => attempt.stage === 'review').length, 1)
  assert.equal(attempts.filter(attempt => attempt.stage === 'verify').length, 0)
  assert.equal(new Set(attempts.slice(0, 2).map(attempt => attempt.runId)).size, 2)
  assert.equal(attempts.at(-1)?.runId, null, 'human acceptance does not dispatch another worker')

  // An online but unproductive A is stopped, then the actual watchdog consumer
  // chooses B through normal model selection, repository and credential admission.
  const nextRequest = randomUUID()
  await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload)
    VALUES($1,$2,$3,$4,'user_message',$5,$6)`, [nextRequest, userId, botId, issueId, `continuity:${nextRequest}`, JSON.stringify({ text: 'Add a null-input regression while preserving the accepted tax fix.' })])
  const continued = await steps.dispatchRun(userId, { issueId, note: 'Add the null-input regression.', sourceEventId: nextRequest, requestKey: `continue:${nextRequest}` }, undefined, botId) as unknown as { runId: string }
  assert.ok(continued.runId)
  const continuedTask = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [acceptance.id])).rows[0]
  assert.equal(continuedTask.id, acceptance.id)
  const epoch = continuedTask.sourceEventId
  const deviceB = randomUUID(), agentB = randomUUID()
  const { DAEMON_PROTOCOL_VERSION } = await import('@mikka/protocol/daemon')
  await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses,"protocolVersion")
    VALUES($1,$2,'acme-build-02','local','server',true,now(),$3,$4)`, [deviceB, userId, JSON.stringify(codex), DAEMON_PROTOCOL_VERSION])
  await pool.query(`INSERT INTO agents(id,"userId","deviceId",harness,name) VALUES($1,$2,$3,'codex','Codex on acme-build-02')`, [agentB, userId, deviceB])
  await pool.query(`UPDATE devices SET "lastSeenAt"=now() WHERE id=$1`, [deviceId])
  await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now()-interval '2 hours',"updatedAt"=now(),"leaseExpiresAt"=now()+interval '1 hour' WHERE id=$1`, [continued.runId])
  await pool.query(`UPDATE factory_tasks SET "updatedAt"='2000-01-01' WHERE id=$1`, [acceptance.id])
  await pool.query(`UPDATE factory_attempts SET "createdAt"='2000-01-01' WHERE id=$1`, [continuedTask.attemptId])
  const { sweepFactoryWatchdog } = await import('../lib/factory/watchdog')
  const { automaticFactoryDispatch } = await import('../lib/factory/automatic-dispatch')
  let interruptions = 0
  const recovery = { runtime: factoryRuntimeForBot, dispatch: automaticFactoryDispatch(pool), wake: async () => { interruptions++ } }
  await sweepFactoryWatchdog(pool, recovery)
  const stopped = (await pool.query('SELECT "stopRequestedAt",status FROM agent_runs WHERE id=$1', [continued.runId])).rows[0]
  assert.ok(stopped.stopRequestedAt)
  assert.equal(stopped.status, 'running', 'the host must wait for the actual worker stop acknowledgement')
  assert.equal(interruptions, 0, 'automatic recovery is quiet')
  await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='cancelled',"finishedAt"=now() WHERE id=$1`, [continued.runId])
  const { afterRunEnded } = await import('../lib/run-completion-effects')
  await afterRunEnded(userId, continued.runId)
  const recoveryTime = new Date(Date.now() + 2 * 60_000)
  const recovered = await sweepFactoryWatchdog(pool, recovery, recoveryTime)
  assert.equal(recovered.failed, 0)
  const resumed = (await pool.query(`SELECT t.id,t."sourceEventId",t.status,r.id AS "runId",r."deviceId",r."agentId",r."retryOf",r."agentDefinition",r."sessionId",r.prompt,a.output
    FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" JOIN agent_runs r ON r.id=a."runId" WHERE t.id=$1`, [acceptance.id])).rows[0]
  assert.equal(resumed.id, acceptance.id)
  assert.equal(resumed.sourceEventId, epoch)
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.deviceId, deviceB)
  assert.equal(resumed.agentId, agentB)
  assert.equal(resumed.retryOf, continued.runId, 'the existing checkpoint restore path follows the original executor')
  assert.equal(resumed.sessionId, null, 'a different device starts an independent native session')
  assert.equal(resumed.agentDefinition.agentProfile.source, 'default')
  assert.deepEqual(resumed.agentDefinition.agentProfile.targetEntry, resumed.agentDefinition.modelDispatch.entry,
    'the recovery receipt records the actual newly admitted target')
  assert.equal(resumed.agentDefinition.model, 'gpt-5')
  assert.deepEqual(resumed.agentDefinition.agentProfile.targetEntry.source, { kind: 'subscription', connectionId: connection })
  const recoveredBinding = (await pool.query(`SELECT "ownerId","workspaceId","consumerId","connectionId","modelId"
    FROM byos_bindings WHERE id=$1`, [resumed.agentDefinition.subscription.bindingId])).rows[0]
  assert.deepEqual(recoveredBinding, { ownerId: userId, workspaceId: ws.id, consumerId: agentB, connectionId: connection, modelId: 'gpt-5' })
  assert.equal(resumed.output.handoff.requestEpoch, epoch)
  assert.match(resumed.prompt, /null-input regression/)
  assert.match(resumed.prompt, /externalEffects/)
  await sweepFactoryWatchdog(pool, recovery, recoveryTime)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [continued.runId])).rows[0].n, 1)
  assert.equal(interruptions, 0)

  await t.test('initial spec dispatch is atomic, idempotent and cannot replace a locked stage', async () => {
    const { queueFactoryTask } = await import('../lib/factory/task-dispatch')
    const { queueFactoryRun } = await import('../lib/agent-runs')
    const { resolveAgentProfileDispatch } = await import('../lib/factory/agent-profile')
    const { rows: [agent] } = await pool.query('SELECT id FROM agents WHERE "userId"=$1 AND "deviceId"=$2', [userId, deviceId])
    const { rows: [repo] } = await pool.query('SELECT id FROM device_repos WHERE "userId"=$1 AND "deviceId"=$2', [userId, deviceId])
    await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [deviceId])
    let number = 1276000
    const request = async () => {
      const issue = randomUUID(), source = randomUUID()
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState",scope) VALUES($1,$2,'Plan the tax fix',$3,'todo','normal',$4,'bound','workspace')`,
        [issue, userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: ++number } } }), ws.id])
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload)
        VALUES($1,$2,$3,$4,'user_message',$5,$6)`, [source, userId, botId, issue, `spec-source:${source}`, JSON.stringify({ text: 'Write a specification before implementing the tax fix.' })])
      // Like the normal host entry, finish Profile/model placement before the
      // queue owns its transaction; this callback receives that real selection.
      const { target, agentProfile, selectionMode } = await resolveAgentProfileDispatch(pool, { ownerId: userId, workspaceId: ws.id, botId },
        { issueId: issue, stage: 'spec', agentId: agent.id, deviceId, location: 'local', asked: { harness: 'codex' } })
      assert.equal(target.kind, 'device')
      if (target.kind !== 'device') throw new Error('fixtureDeviceUnavailable')
      const selection = { model: target.model, agentProfile,
        modelDispatch: { mode: selectionMode ?? 'preference' as const, location: 'local' as const, entry: target.entry, ...(target.routing ? { routing: target.routing } : {}) },
        ...(target.subscriptionBindingId ? { subscriptionBindingId: target.subscriptionBindingId } : {}),
        ...(target.entry.source.kind === 'api_key' ? { apiKeyId: target.entry.source.keyId } : {}) }
      return { issueId: issue, botId, ownerRequested:true, agentId: agent.id as string, deviceRepoId: repo.id as string,
        sourceEventId: source, key: `spec:${randomUUID()}`, needsSpec: true, note: 'Plan first.', selection,
        queue: (...args: Parameters<import('../lib/factory/dispatch').FactoryQueue>) => queueFactoryRun(...args, undefined, selection) }
    }
    const observed = async (issue: string) => (await pool.query(`SELECT
      (SELECT count(*)::int FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2) AS tasks,
      (SELECT count(*)::int FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE t."userId"=$1 AND t."issueId"=$2) AS attempts,
      (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1 AND "issueId"=$2) AS runs,
      (SELECT count(*)::int FROM run_publications WHERE "userId"=$1 AND "issueId"=$2) AS publications`, [userId, issue])).rows[0]

    const input = await request()
    const [first, replay] = await Promise.all([queueFactoryTask(pool, userId, input), queueFactoryTask(pool, userId, input)])
    assert.equal(replay.runId, first.runId)
    const delegate = await pool.query(`SELECT i.content->'attrs'->'mikka'->'delegate'->>'id' AS id,
      (SELECT count(*)::int FROM issue_versions v WHERE v."issueId"=i.id AND v.actor_id=$2) AS assignments
      FROM issues i WHERE i.id=$1`,[input.issueId,agent.id])
    assert.deepEqual(delegate.rows,[{id:agent.id,assignments:1}])
    const { rows: [plan] } = await pool.query(`SELECT r.kind,r."agentDefinition",t.stage,t.status,t."sourceEventId"
      FROM agent_runs r JOIN factory_attempts a ON a."runId"=r.id JOIN factory_tasks t ON t.id=a."taskId" WHERE r.id=$1`, [first.runId])
    assert.deepEqual([plan.kind, plan.stage, plan.status, plan.sourceEventId, plan.agentDefinition.readOnly], ['plan', 'spec', 'running', input.sourceEventId, true])
    const onePlan = { tasks: 1, attempts: 1, runs: 1, publications: 0 }
    assert.deepEqual(await observed(input.issueId), onePlan)
    for (const change of [{ needsSpec: false }, { note: 'Changed plan.' }, { sourceEventId: randomUUID() }, { selection: ['different-profile'] }])
      await assert.rejects(queueFactoryTask(pool, userId, { ...input, ...change }), { code: 'factoryReplayMismatch' })
    for (const needsSpec of [undefined, false, true])
      await assert.rejects(queueFactoryTask(pool, userId, { ...input, key: randomUUID(), needsSpec }), { code: 'factoryRunStillActive' })
    assert.deepEqual(await observed(input.issueId), onePlan)

    // A Profile decision made before another request routed a plan must fail
    // closed instead of changing that now-locked route to implementation.
    const raced = await request()
    const pending = await runtime.store.route(userId, { issueId: raced.issueId, eventId: randomUUID(), sourceEventId: raced.sourceEventId, rationale: 'The owner requested a specification.', needsSpec: true })
    await assert.rejects(queueFactoryTask(pool, userId, { ...raced, needsSpec: false }), { code: 'factoryStale' })
    await assert.rejects(queueFactoryTask(pool, userId, { ...raced, sourceEventId: randomUUID() }), { code: 'factorySourceMismatch' })
    assert.deepEqual(await observed(raced.issueId), { tasks: 1, attempts: 1, runs: 0, publications: 0 })
    assert.deepEqual((await pool.query('SELECT id,"attemptId",stage,status FROM factory_tasks WHERE id=$1', [pending.task.id])).rows[0],
      { id: pending.task.id, attemptId: pending.task.attemptId, stage: 'spec', status: 'pending' })

    const advanced = await request()
    const execution = await runtime.store.route(userId, { issueId: advanced.issueId, eventId: randomUUID(), sourceEventId: advanced.sourceEventId, rationale: 'Current implementation route.', needsSpec: false })
    await assert.rejects(queueFactoryTask(pool, userId, advanced), { code: 'factoryStale' })
    assert.deepEqual((await pool.query('SELECT id,stage,status FROM factory_tasks WHERE id=$1', [execution.task.id])).rows[0], { id: execution.task.id, stage: 'execute', status: 'pending' })

    const aborted = await request()
    await assert.rejects(queueFactoryTask(pool, userId, { ...aborted, queue: async (...args) => {
      await aborted.queue(...args)
      throw new Error('fixtureQueueAborted')
    } }), /fixtureQueueAborted/)
    assert.deepEqual(await observed(aborted.issueId), { tasks: 0, attempts: 0, runs: 0, publications: 0 }, 'a queue failure rolls back the route, run, attempt and publication together')
  })
})
