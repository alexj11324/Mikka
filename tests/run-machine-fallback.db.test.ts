// Where a thread runs when a person has no cloud, no device, or a full cloud, against a real PostgreSQL.
// 运行位置 decides (decision 2026-11-02-1400, which replaced 2026-10-31-2200's fallback): 本地 picks one of
// the computers that take part (参与调度) and run the model, 云端 the person's own E2B; neither falls back to
// the other, and nothing that can run gives the bot the 没有能跑这个任务的模型 card with the reason.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { templateModelsFixture } from './support/template-models'
import { connectGitHub, githubAppStub } from './support/github-app-stub'

// The computer's Codex reported gpt-5, the model the person's ChatGPT account lists.
const mac = [{ harness: 'codex', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'gpt-5', model: 'gpt-5', name: 'gpt-5' }] }]

test('run machine fallback: 本地 a computer that takes part, 云端 own E2B, else an actionable error', { skip: !dbUrl }, async t => {
  process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1'
  process.env.MIKKA_BYOS_ENABLED = '1'
  const restoreModels = templateModelsFixture()
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { reclaimLostRuns } = await import('../lib/run-leases')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const users: string[] = []
  // Push is what the person granted on GitHub: the synthetic App is installed on octo/repo with contents: write.
  const github = githubAppStub()
  github.install('octo/repo', { contents: 'write', pull_requests: 'write' })
  let githubAccount = 9_200_000
  t.after(async () => {
    github.restore()
    restoreModels.restore()
    await pool.query('DELETE FROM factory_agent_profiles WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM factory_tasks WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_order_entries WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_order_settings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM thread_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM cloud_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM workspace_subscription_shares WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM github_repository_installations WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM account WHERE "userId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const seeded = new Map<string, string>()
  const person = async (label: string) => {
    const id = await seedUser(pool, label)
    users.push(id)
    // Their own GitHub account, which may write to octo/repo; the ordinary admission transaction still runs.
    const githubAccountId = String(++githubAccount)
    await pool.query(`INSERT INTO account (id,"accountId","providerId","userId","createdAt","updatedAt") VALUES ($1,$2,'github',$3,now(),now())`, [randomUUID(), githubAccountId, id])
    github.allowWriter('octo/repo', githubAccountId)
    // Connected in 插件 › GitHub, with the App on the repositories these tasks name: dispatch checks the live list.
    await connectGitHub(github, id, githubAccountId, ['octo/repo', 'octo/read-only-app', 'octo/elsewhere'])
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    // A connected ChatGPT subscription whose account lists gpt-5: 优先使用的模型 is that model by default, 运行位置 云端.
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,'codex','connected',1,$4,$5,'synthetic-subject',$6,$7)`,
      [connection, id, ws.id, `synthetic-${connection}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models: ['gpt-5'] }), JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: null }] })])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5')`, [randomUUID(), id, ws.id, connection])
    const issueId = await seedIssue(pool, id, ws.id)
    // A numbered task, so its thread gets a publication branch.
    await pool.query(`UPDATE issues SET content='{"type":"doc","attrs":{"mikka":{"number":7}}}' WHERE id=$1`, [issueId])
    seeded.set(id, ws.id)
    return { id, workspaceId: ws.id, issueId }
  }
  /** An online computer whose Codex reported gpt-5; `takesPart: false` is 参与调度 off. */
  const onlineMac = async (userId: string, takesPart = true, deviceType = 'laptop') => {
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'MacBook','local',$4,$5,now(),$3)`, [deviceId, userId, JSON.stringify(mac), deviceType, takesPart])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [randomUUID(), userId, deviceId, `codex-${deviceId.slice(0, 8)}`])
    return deviceId
  }
  // No bot named: the Coordinator of the person's own workspace (each person here has one), as the app resolves it.
  const { chatBotId } = await import('../lib/coordinator/coordinator-bot')
  // The workspace the person was seeded with: the first Coordinator lookup also creates their personal workspace, so "any membership" is not it.
  const ownWorkspace = async (userId: string) => {
    const workspaceId = seeded.get(userId)
    assert.ok(workspaceId, 'a person seeded by this test')
    return workspaceId
  }
  const dispatch = async (userId: string, issueId: string, botId: string | null = null) => steps.dispatchRun(userId, { issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` }, undefined, botId ?? await chatBotId(userId, null, await ownWorkspace(userId)))
  type NoMachine = { error: string; reason: string; card: { title: string; description: string; options: { value: string; action: string }[] } }
  const order = await import('../lib/model-order')
  const runAt = (who: { id: string; workspaceId: string }, location: 'cloud' | 'local') => order.changeOrder(pool, { ownerId: who.id, workspaceId: who.workspaceId }, { kind: 'location', location })
  const actions = (result: NoMachine) => result.card.options.map(option => option.action)
  // Another numbered task of theirs, so its thread gets a publication branch.
  let taskNumber = 100
  const anotherTask = async (userId: string) => {
    const issueId = await seedIssue(pool, userId, await ownWorkspace(userId))
    await pool.query('UPDATE issues SET content=$2::jsonb WHERE id=$1', [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: ++taskNumber } } })])
    return issueId
  }
  const runOf = async (runId: string) => (await pool.query('SELECT "deviceId",status FROM agent_runs WHERE id=$1', [runId])).rows[0]

  for (const named of [false, true]) await t.test(`${named ? 'an explicitly selected' : 'an automatically placed'} device keeps its placement authority through normal Factory admission and recovery`, async () => {
    const who = await person(named ? 'named-handoff' : 'automatic-handoff')
    await runAt(who, 'local')
    const deviceA = await onlineMac(who.id, true, 'server')
    const botId = await chatBotId(who.id, null, who.workspaceId)
    const sourceEventId = randomUUID()
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,"deliveredAt")
      VALUES($1,$2,$3,'user_message',$4,$5,now())`, [sourceEventId, who.id, botId, `placement:${sourceEventId}`,
      JSON.stringify({ text: named ? `Use device ${deviceA} for this task.` : 'Choose an available computer automatically for this task.' })])
    const dispatched = await steps.dispatchRun(who.id, { issueId: who.issueId, repo: 'octo/repo', sourceEventId,
      requestKey: `placement:${randomUUID()}`, ...(named ? { target: { deviceId: deviceA } } : {}) }, undefined, botId) as unknown as { runId?: string; error?: string }
    assert.ok(dispatched.runId, JSON.stringify(dispatched))
    const original = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [dispatched.runId])).rows[0]
    assert.equal(original.deviceId, deviceA)
    assert.equal(original.agentDefinition.pinnedDeviceId, named ? deviceA : undefined,
      'an automatic host choice must not acquire the authority of an explicit device selection')
    assert.equal(original.agentDefinition.repositoryAdmission.deviceId, deviceA)
    const before = (await pool.query(`SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId"
      WHERE a."runId"=$1 AND t."userId"=$2`, [original.id, who.id])).rows[0]
    assert.equal(before.sourceEventId, sourceEventId)

    // B is available only after ordinary dispatch picked A. No admission or
    // frozen identity is removed to make the recovery test pass.
    const deviceB = await onlineMac(who.id, true, 'server')
    const now = new Date()
    const { DAEMON_PROTOCOL_VERSION } = await import('@mikka/protocol/daemon')
    await pool.query('UPDATE devices SET "protocolVersion"=$2 WHERE id=ANY($1::uuid[])', [[deviceA, deviceB], DAEMON_PROTOCOL_VERSION])
    await pool.query('UPDATE devices SET "lastSeenAt"=$2 WHERE id=$1', [deviceA, new Date(now.getTime() - 120_000)])
    await pool.query(`UPDATE agent_runs SET status='running',"sessionId"='placement-A',"startedAt"=$2,"leaseExpiresAt"=$3 WHERE id=$1`,
      [original.id, new Date(now.getTime() - 180_000), new Date(now.getTime() - 1_000)])
    await pool.query(`INSERT INTO run_checkpoints("runId","baseCommit",patch,files,"updatedAt","userId","takenAt")
      VALUES($1,$2,$3,1,$4,$5,$4)`, [original.id, 'a'.repeat(40), gzipSync('diff --git a/target.txt b/target.txt\n'), now, who.id])
    const reclaim = async () => {
      try { await reclaimLostRuns(who.id, now) }
      catch (error) {
        // The real completion/reconciler already ran. This Node test has no
        // Next response on which to schedule its optional Coordinator wake.
        if (!(error instanceof Error) || !error.message.includes('`after` was called outside a request scope')) throw error
      }
    }
    await reclaim()
    const { rows: children } = await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [original.id])
    const current = (await pool.query(`SELECT t.id,t."sourceEventId",t.status,a."runId",a.output FROM factory_tasks t
      JOIN factory_attempts a ON a.id=t."attemptId" WHERE t.id=$1`, [before.id])).rows[0]
    assert.equal(current.id, before.id)
    assert.equal(current.sourceEventId, sourceEventId)
    if (named) {
      assert.equal(children.length, 0, 'an explicitly selected A must never silently become B')
      assert.equal(current.status, 'blocked')
      const ended = (await pool.query('SELECT status,error,"agentDefinition" FROM agent_runs WHERE id=$1', [original.id])).rows[0]
      assert.equal(ended.status, 'failed')
      assert.match(ended.error, /taskDestinationMismatch/)
      assert.equal(ended.agentDefinition.pinnedDeviceId, deviceA)
      return
    }
    assert.equal(children.length, 1, 'ordinary automatic dispatch must produce one actual re-admitted B run')
    const child = children[0]
    assert.equal(child.deviceId, deviceB)
    assert.equal(child.botId, botId)
    assert.equal(child.agentDefinition.pinnedDeviceId, undefined)
    assert.equal(child.agentDefinition.model, original.agentDefinition.model)
    assert.deepEqual(child.agentDefinition.subscription, original.agentDefinition.subscription)
    const identity = child.agentDefinition.executionIdentity, priorIdentity = original.agentDefinition.executionIdentity
    for (const field of ['requester', 'executionPrincipal', 'outputOwner', 'botId', 'botOwner', 'workspaceId']) assert.equal(identity[field], priorIdentity[field])
    assert.deepEqual(identity.billingAccount.model, priorIdentity.billingAccount.model)
    assert.deepEqual(identity.resourceBindings.filter((entry: { kind: string }) => entry.kind !== 'device'),
      priorIdentity.resourceBindings.filter((entry: { kind: string }) => entry.kind !== 'device'))
    assert.equal(identity.billingAccount.runtime.resourceId, deviceB)
    assert.equal(child.agentDefinition.repositoryAdmission.deviceId, deviceB)
    assert.equal(child.agentDefinition.repositoryAdmission.targetBranch, original.agentDefinition.repositoryAdmission.targetBranch)
    assert.equal(current.runId, child.id)
    assert.equal(current.output.requestEpoch, sourceEventId)
    const { claimExecutionRun } = await import('../lib/factory/server')
    assert.equal((await claimExecutionRun(who.id, deviceB, child.id, new Date(now.getTime() + 90_000).toISOString())).length, 1)
    await reclaim()
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [original.id])).rows[0].n, 1)
  })

  await t.test('(a) no computer: the card says so, then a computer is picked once it takes part', async () => {
    const a = await person('fresh')
    const result = await dispatch(a.id, a.issueId) as unknown as NoMachine
    assert.equal(result.error, 'machineUnavailable')
    assert.deepEqual([result.reason, result.card.title], ['noDevice', '没有能跑这个任务的模型'])
    // 云端 (the default) with no E2B key and no computer: 连接电脑 opens 设备, 填入 E2B Key their own cloud, 打开模型与订阅 the list; never Mikka's cloud.
    assert.deepEqual(actions(result), ['connectServer', 'e2bKey', 'modelSettings'])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [a.id])).rows[0].n, 0, 'nothing is queued')

    // A computer comes online with 参与调度 off: it is not picked; the card is the same.
    const deviceId = await onlineMac(a.id, false)
    const offered = await dispatch(a.id, a.issueId) as unknown as NoMachine
    assert.equal(offered.error, 'machineUnavailable')
    assert.deepEqual([offered.reason, actions(offered)], ['noDevice', ['connectServer', 'e2bKey', 'modelSettings']])
    await pool.query('UPDATE devices SET enabled=true WHERE id=$1', [deviceId])
    const queued = await dispatch(a.id, a.issueId) as unknown as { runId: string; status: string }
    assert.equal(queued.status, 'queued')
    assert.equal((await runOf(queued.runId)).deviceId, deviceId)
  })

  await t.test('a read-only task and a committing one both run with no push approval or GitHub App check', async () => {
    const r = await person('readonly')
    const deviceId = await onlineMac(r.id)
    const botId = await chatBotId(r.id, null, await ownWorkspace(r.id))
    // The App is not installed on octo/elsewhere: nothing in Mikka checks that any more (decision 2026-11-02-1600).
    const queued = await steps.dispatchRun(r.id, { issueId: r.issueId, repo: 'octo/elsewhere', readOnly: true, requestKey: `dispatch:${randomUUID()}` }, undefined, botId) as unknown as { runId: string; status: string }
    assert.equal(queued.status, 'queued')
    const run = (await pool.query('SELECT "deviceId","agentDefinition" FROM agent_runs WHERE id=$1', [queued.runId])).rows[0]
    assert.equal(run.deviceId, deviceId)
    assert.equal(run.agentDefinition.readOnly, true)
    assert.equal(run.agentDefinition.repositoryAdmission, undefined, 'a read-only run has no task branch')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_publications WHERE "runId"=$1', [queued.runId])).rows[0].n, 0, 'no push branch is reserved')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_actions WHERE "userId"=$1', [r.id])).rows[0].n, 0, 'nothing asked the person for an approval')
    const { persistRunCompletion } = await import('../lib/run-publications')
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [queued.runId])
    await persistRunCompletion(r.id, queued.runId, { stopReason: 'submitted', report: { summary: 'Findings reported.', filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null } })
    assert.equal((await runOf(queued.runId)).status, 'succeeded', 'a read-only report has nothing to publish, so it is not blocked on a push')
  })

  await t.test('a committing run is admitted with its task branch whatever the GitHub App says, with no card', async () => {
    const g = await person('github-grant')
    await onlineMac(g.id)
    const botId = await chatBotId(g.id, null, await ownWorkspace(g.id))
    const dispatchTo = (repo: string, issueId: string) => steps.dispatchRun(g.id, { issueId, repo, requestKey: `dispatch:${randomUUID()}` }, undefined, botId) as unknown as Promise<{ error?: string; runId?: string; status?: string }>
    github.install('octo/read-only-app', { contents: 'read', pull_requests: 'write' })
    const queued = await dispatchTo('octo/read-only-app', g.issueId)
    assert.equal(queued.status, 'queued', JSON.stringify(queued))
    const run = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [queued.runId])).rows[0]
    assert.equal(run.agentDefinition.repositoryAdmission.authority, 'owner_credential')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_publications WHERE "runId"=$1 AND branch IS NOT NULL', [queued.runId])).rows[0].n, 1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_actions WHERE "userId"=$1', [g.id])).rows[0].n, 0, 'no approval card')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM repository_settings WHERE "userId"=$1 AND push IS NOT NULL', [g.id])).rows[0].n, 0, 'no Mikka-side push approval is involved')
  })

  await t.test('(b) 云端 with no E2B key: the online computer takes the run; 本地 too', async () => {
    const b = await person('mac')
    const deviceId = await onlineMac(b.id)
    await runAt(b, 'cloud')
    const result = await dispatch(b.id, b.issueId) as unknown as { runId: string; status: string }
    assert.equal(result.status, 'queued')
    assert.deepEqual(await runOf(result.runId), { deviceId, status: 'queued' })
    await runAt(b, 'local')
    const again = await dispatch(b.id, await anotherTask(b.id)) as unknown as { runId: string; status: string }
    assert.deepEqual(await runOf(again.runId), { deviceId, status: 'queued' })
  })

  // The bot's own cloud computer is awake, with its runtime, a bound Codex subscription and the
  // person's own E2B key. The key is not a real one, so E2B refuses to start a thread machine,
  // which is what its concurrency cap or quota does too.
  const cloudReady = async (c: { id: string; workspaceId: string }) => {
    const botId = await seedBot(pool, c.workspaceId, c.id)
    const cloudDevice = randomUUID(), cloudAgent = randomUUID(), repoId = randomUUID(), connection = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt") VALUES ($1,$2,'Cloud computer','cloud',true,now())`, [cloudDevice, c.id])
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [c.workspaceId, c.id, randomUUID(), `sbx-${randomUUID()}`, cloudDevice])
    await pool.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)`, [botId, c.workspaceId, c.id])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [cloudAgent, c.id, cloudDevice, `cloud-${cloudAgent.slice(0, 8)}`])
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch") VALUES ($1,$2,$3,'/home/user/w','main')`, [repoId, cloudDevice, c.id])
    await pool.query(`INSERT INTO bot_cloud_runtimes ("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES ($1,$2,$3,'codex',$4,$5)`, [botId, c.workspaceId, c.id, cloudAgent, repoId])
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject",quota,"modelCatalog") VALUES ($1,$2,$3,'codex','connected',1,$5,$4,'synthetic-subject',$6,$7)`, [connection, c.id, c.workspaceId, 'a'.repeat(64), `synthetic-${connection}`, JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: null }] }), JSON.stringify({ revision: '1', models: ['gpt-5'] })])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,1,'codex_cli','gpt-5')`, [randomUUID(), c.id, c.workspaceId, cloudAgent, connection])
    // A team workspace uses a member's subscription once they share it there (decision 2026-10-31-2225).
    await pool.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)`, [c.id, c.workspaceId])
    await pool.query(`INSERT INTO workspace_e2b_keys ("workspaceId",ciphertext,iv,"keyVersion",last4,"createdBy","updatedBy") VALUES ($1,'x','x',1,'abcd',$2,$2)`, [c.workspaceId, c.id])
    return { botId, cloudDevice }
  }

  for (const profileMode of ['default', 'inherit', 'fixed'] as const) await t.test(`${profileMode} startup recovery keeps its role and credential model despite a different local shortcut report`, async () => {
    const who = await person(`profile-startup-${profileMode}`)
    await pool.query('UPDATE issues SET content=$2::jsonb WHERE id=$1', [who.issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 701 + ['default', 'inherit', 'fixed'].indexOf(profileMode) } } })])
    const { botId } = await cloudReady(who)
    await runAt(who, 'cloud')
    const connection = (await pool.query('SELECT id FROM byos_connections WHERE "ownerId"=$1 ORDER BY "createdAt",id LIMIT 1', [who.id])).rows[0].id
    await pool.query('UPDATE byos_connections SET "modelCatalog"=$2::jsonb WHERE id=$1', [connection, JSON.stringify({ revision: '2', models: ['gpt-5', 'gpt-5-local'] })])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5-local')`, [randomUUID(), who.id, who.workspaceId, connection])
    await pool.query('DELETE FROM model_order_entries WHERE "ownerId"=$1', [who.id])
    for (const [position, model] of ['gpt-5', 'gpt-5-local'].entries()) await pool.query(`INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId") VALUES ($1,$2,$3,$4,'codex',$5,'subscription',$6)`, [randomUUID(), who.id, who.workspaceId, position, model, connection])
    await pool.query('UPDATE model_order_settings SET customized=true WHERE "ownerId"=$1 AND "workspaceId"=$2', [who.id, who.workspaceId])
    const deviceId = await onlineMac(who.id, true, 'server')
    await pool.query('UPDATE devices SET harnesses=$2::jsonb WHERE id=$1', [deviceId, JSON.stringify([{ harness: 'codex', installed: true, subscriptionBroker: true, models: ['gpt-5-local'] }])])
    const { resolveModelDispatch } = await import('../lib/model-dispatch')
    const dispatchScope = { ownerId: who.id, workspaceId: who.workspaceId, botId }
    const original = await resolveModelDispatch(pool, dispatchScope, null, 'cloud', undefined, { bindSubscription: false, skipCatalogueRefresh: true, probeQuota: false })
    assert.equal(original.kind, 'cloud'); if (original.kind !== 'cloud') assert.fail('fixture cloud target')
    const exact = await resolveModelDispatch(pool, dispatchScope, null, undefined, undefined, { withoutCloud: true, exactEntry: original.entry, bindSubscription: false, skipCatalogueRefresh: true, probeQuota: false })
    assert.equal(exact.kind === 'device' && exact.model, 'gpt-5', 'an eligible local Agent can run the exact authorized cloud model')
    const preferred = await resolveModelDispatch(pool, dispatchScope, null, undefined, undefined, { withoutCloud: true, bindSubscription: false, skipCatalogueRefresh: true, probeQuota: false })
    assert.equal(preferred.kind === 'device' && preferred.model, 'gpt-5', 'the first credential model remains preferred locally')
    const profiles = await import('../lib/factory/agent-profile')
    let profileId: string | undefined
    if (profileMode !== 'default') {
      const profile = await new profiles.AgentProfileStore(pool).create({ ownerId: who.id, workspaceId: who.workspaceId }, {
        name: 'Recovery role', harness: 'codex', instructions: 'Keep this frozen responsibility through startup recovery.',
        model: profileMode === 'fixed' ? { mode: 'fixed', harness: 'codex', model: 'gpt-5', source: { kind: 'subscription', connectionId: connection } } : { mode: 'inherit' },
      })
      profileId = profile.id
    }
    const sourceEventId = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,"deliveredAt") VALUES ($1::uuid,$2,$3,'user_message',$1::text,$4,now())`, [sourceEventId, who.id, botId, JSON.stringify({ text: 'Run the recovery role.', ...(profileId ? { profileId } : {}) })])
    const result = await steps.dispatchRun(who.id, { issueId: who.issueId, repo: 'octo/repo', profileId, sourceEventId, requestKey: `startup:${randomUUID()}` }, undefined, botId) as unknown as { runId?: string; error?: string; fallback?: string }
    {
      assert.ok(result.runId, JSON.stringify(result)); assert.equal(result.fallback, 'cloudUnavailable')
      const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [result.runId])).rows[0]
      assert.equal(run.deviceId, deviceId); assert.equal(run.agentDefinition.model, 'gpt-5')
      assert.equal(run.agentDefinition.agentProfile.profileId, profileId ?? 'default')
      assert.equal(run.agentDefinition.agentProfile.targetEntry.model, 'gpt-5')
      assert.deepEqual(run.agentDefinition.agentProfile.targetEntry, run.agentDefinition.modelDispatch.entry)
      assert.equal(run.agentDefinition.profileOriginRunId, undefined)
      const source = await pool.query('SELECT "connectionId" FROM byos_bindings WHERE id=$1', [run.agentDefinition.subscription.bindingId])
      assert.equal(source.rows[0].connectionId, connection)
      if (profileId) assert.match(run.agentDefinition.instructions, /Keep this frozen responsibility/)
      await (await import('../lib/factory/profile-admission')).assertRunProfileClaim(pool, run.id)
    }
    const cloudRuns = (await pool.query(`SELECT r.status,m.state FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r."userId"=$1`, [who.id])).rows
    assert.deepEqual(cloudRuns, [{ status: 'failed', state: 'ended' }], 'startup recovery records an infrastructure failure before local admission')
    const tasks = (await pool.query(`SELECT t.id,t."sourceEventId",t.status,a."runId" FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE t."userId"=$1 AND t."issueId"=$2`, [who.id, who.issueId])).rows
    assert.equal(tasks.length, 1, 'startup recovery keeps the original Factory task')
    assert.equal(tasks[0].sourceEventId, sourceEventId, 'it never manufactures a replacement user request')
    assert.equal(tasks[0].status, 'running')
    {
      assert.equal(tasks[0].runId, result.runId)
      const ancestry = (await pool.query('SELECT "continuesRunId","sessionId" FROM agent_runs WHERE id=$1', [result.runId])).rows[0]
      const failedCloud = (await pool.query(`SELECT r.id FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r."userId"=$1`, [who.id])).rows[0]
      assert.deepEqual(ancestry, { continuesRunId: failedCloud.id, sessionId: null }, 'only the failed startup ancestry survives, not a native session')
    }
  })

  await t.test('(c) own E2B refuses (cap, quota, key): the cloud run is ended; with no server or computer the card, else 云端 falls back to the server', async () => {
    const c = await person('cloud')
    const { botId } = await cloudReady(c)
    await runAt(c, 'cloud')
    // The Coordinator uses its own hidden bot's runtime and never borrows a bot's. Here E2B
    // refuses to wake that hidden bot's desktop, so it gets the card.
    const { botRuntimeProvisioner } = await import('../lib/computer/auto-runtime')
    const provision = botRuntimeProvisioner.provision
    botRuntimeProvisioner.provision = async () => { throw new Error('E2B refused') }
    const coordinator = await dispatch(c.id, c.issueId).finally(() => { botRuntimeProvisioner.provision = provision }) as unknown as NoMachine
    assert.equal(coordinator.error, 'machineUnavailable')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [c.id])).rows[0].n, 0, 'no cloud run on the bot computer')
    const refused = await dispatch(c.id, c.issueId, botId) as unknown as NoMachine
    assert.equal(refused.error, 'machineUnavailable', 'an error the person can act on')
    assert.deepEqual([refused.reason, actions(refused)], ['cloudTemporarilyUnavailable', ['modelSettings']])
    const cloudRuns = (await pool.query(`SELECT r.status,r."stopReason",r."stopRequestedAt",m.state FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r."userId"=$1`, [c.id])).rows
    assert.deepEqual(cloudRuns, [{ status: 'failed', stopReason: 'device_lost', stopRequestedAt: null, state: 'ended' }],
      'a refused startup ends as an infrastructure failure, never a forged Owner stop')
    const frozen = (await pool.query(`SELECT r."agentDefinition"->>'harness' AS harness FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r."userId"=$1`, [c.id])).rows[0]
    assert.equal(frozen.harness, 'codex', 'every cloud run freezes its definition when it is created')
    // A server comes online: 云端 tries the cloud, which refuses again, then the server takes it and the result says so.
    const deviceId = await onlineMac(c.id, true, 'server')
    const fallback = await dispatch(c.id, await anotherTask(c.id), botId) as unknown as { runId: string; status: string; fallback?: string }
    assert.deepEqual([fallback.status, fallback.fallback, (await runOf(fallback.runId)).deviceId], ['queued', 'cloudUnavailable', deviceId])
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r."userId"=$1 AND r.status='failed' AND r."stopReason"='device_lost' AND r."stopRequestedAt" IS NULL AND m.state='ended'`, [c.id])).rows[0].n, 2, 'the second refused cloud run is ended too')
    // A run the person put in the cloud goes nowhere else.
    const pinned = await steps.dispatchRun(c.id, { issueId: await anotherTask(c.id), repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}`, target: 'cloud' }, undefined, botId) as unknown as NoMachine
    assert.equal(pinned.error, 'machineUnavailable')
    // 本地 goes straight to the server.
    await runAt(c, 'local')
    const result = await dispatch(c.id, await anotherTask(c.id), botId) as unknown as { runId: string; status: string; fallback?: string }
    assert.deepEqual([result.status, result.fallback, (await runOf(result.runId)).deviceId], ['queued', undefined, deviceId])
  })

  await t.test('a server goes offline mid-run: the run moves to the own E2B cloud, which ends it with the card when E2B refuses', async () => {
    const c = await person('offline')
    const { botId, cloudDevice } = await cloudReady(c)
    const server = await onlineMac(c.id, true, 'server')
    await pool.query(`UPDATE devices SET "lastSeenAt"=now()-interval '10 minutes' WHERE id=$1`, [server])
    const agentId = (await pool.query('SELECT id FROM agents WHERE "deviceId"=$1', [server])).rows[0].id
    const repoId = (await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5) RETURNING id`, [randomUUID(), server, c.id, normalizeRepository('octo/repo').key, normalizeRepository('octo/repo').remoteUrl])).rows[0].id
    const lost = randomUUID()
    // The bot's run: it moves to that bot's own cloud runtime.
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"leaseExpiresAt","agentDefinition","botId") VALUES ($1,$2,$3,$4,$5,$6,'running','Lost run',now()-interval '1 minute',$7,$8)`,
      [lost, c.id, c.issueId, agentId, server, repoId, JSON.stringify({ harness: 'codex' }), botId])
    await reclaimLostRuns(c.id, new Date())
    assert.equal((await runOf(lost)).status, 'failed')
    const moved = (await pool.query(`SELECT r.id,r.attempt,r.status,r."deviceId",b."botId" FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id WHERE r."retryOf"=$1`, [lost])).rows
    assert.equal(moved.length, 1, 'the retry was queued on the cloud through the normal cloud queue')
    assert.equal(moved[0].attempt, 2)
    assert.equal(moved[0].deviceId, cloudDevice, 'queued on the bot cloud computer, not the offline server')
    const retried = (await pool.query(`SELECT payload FROM coordinator_events WHERE "runId"=$1 AND kind='run_retried'`, [lost])).rows[0]
    assert.deepEqual(retried.payload.movedTo, { kind: 'cloud' })
    // E2B refuses the new sandbox: the retry ends with the card instead of waiting.
    assert.equal(moved[0].status, 'failed')
    assert.deepEqual((await pool.query('SELECT "stopReason","stopRequestedAt" FROM agent_runs WHERE id=$1', [moved[0].id])).rows[0],
      { stopReason: 'device_lost', stopRequestedAt: null })
    const card = (await pool.query(`SELECT payload FROM coordinator_events WHERE "runId"=$1 AND kind='run_finished'`, [moved[0].id])).rows[0]
    assert.ok(card.payload.noMachine)
  })

  await t.test('a cloud thread whose sandbox is gone continues on a new sandbox of the same thread', async () => {
    const c = await person('sandbox')
    const { botId, cloudDevice } = await cloudReady(c)
    const cloudAgent = (await pool.query('SELECT "agentId" FROM bot_cloud_runtimes WHERE "botId"=$1', [botId])).rows[0].agentId
    const repoId = (await pool.query('SELECT "repoId" FROM bot_cloud_runtimes WHERE "botId"=$1', [botId])).rows[0].repoId
    const lost = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"leaseExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,'running','Cloud run',now()-interval '1 minute')`, [lost, c.id, c.issueId, cloudAgent, cloudDevice, repoId])
    await pool.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [lost, botId, c.workspaceId, c.id])
    await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state) VALUES ($1,$2,$3,$4,'snap',$5,'running')`, [lost, c.workspaceId, c.id, botId, randomUUID()])
    await reclaimLostRuns(c.id, new Date())
    const [retry] = (await pool.query(`SELECT r.id,b."botId",m.state FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id JOIN thread_machines m ON m."runId"=r.id WHERE r."retryOf"=$1`, [lost])).rows
    assert.equal(retry.botId, botId, 'same bot, same thread')
    assert.ok(retry.state, 'the retry has its own thread machine')
    const retried = (await pool.query(`SELECT payload FROM coordinator_events WHERE "runId"=$1 AND kind='run_retried'`, [lost])).rows[0]
    assert.deepEqual(retried.payload.movedTo, { kind: 'cloud' })
  })

  await t.test('own devices: 本地 picks the server that takes part; a computer with 参与调度 off is never picked, even when named', async () => {
    const d = await person('devices')
    const mac = await onlineMac(d.id)
    const server = await onlineMac(d.id, true, 'server')
    const off = await onlineMac(d.id, false)
    const used = new Set<string>()
    for (const number of [11, 12, 13, 14]) {
      const issueId = await seedIssue(pool, d.id, d.workspaceId)
      await pool.query(`UPDATE issues SET content=$2::jsonb WHERE id=$1`, [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number } } })])
      const result = await dispatch(d.id, issueId) as unknown as { runId: string }
      used.add((await runOf(result.runId)).deviceId)
    }
    // The server goes first, every time (decision 2026-11-02-1530); the computer and the one with 参与调度 off are not used.
    assert.deepEqual([...used], [server])
    assert.ok(!used.has(off) && !used.has(mac))
    const e = await person('manual')
    const kept = await onlineMac(e.id, false)
    const none = await dispatch(e.id, e.issueId) as unknown as NoMachine
    assert.deepEqual([none.reason, actions(none)], ['noDevice', ['connectServer', 'e2bKey', 'modelSettings']])
    const named = await steps.dispatchRun(e.id, { issueId: e.issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}`, target: { deviceId: kept } }, undefined, await chatBotId(e.id, null, await ownWorkspace(e.id))) as unknown as NoMachine
    assert.equal(named.error, 'machineUnavailable')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [e.id])).rows[0].n, 0)
  })
})
