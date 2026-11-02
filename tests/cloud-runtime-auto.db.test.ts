// A person's own E2B key is enough for cloud runs: with 运行位置 云端 (decision 2026-11-02-1400), a bot with
// no cloud runtime gets one when a run is dispatched, once. No key: never the cloud. MIKKA_CLOUD_COMPUTER_TASKS=0 turns it off. Real PostgreSQL;
// only the E2B calls (waking the computer, starting its worker, creating each thread's own
// machine) and the start of the thread machine's lifecycle workflow are replaced.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import type { Pool as PgPool } from 'pg'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { recordPushGrant } from './support/github-app-stub'
import { fakeThreadMachines } from './support/thread-machine-fake'

const harnesses = [{ harness: 'codex', installed: true, subscriptionBroker: true, computerBroker: true }]

test('cloud runs: the bot runtime is created on dispatch, once; the kill switch falls back to the card', { skip: !dbUrl }, async t => {
  delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
  process.env.MIKKA_BYOS_ENABLED = '1'
  // Every cloud thread runs on its own thread machine; its lifecycle workflow is not started here.
  mock.module('workflow/api', { namedExports: { start: async () => ({ runId: 'synthetic-workflow' }) } })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const threadMachines = await fakeThreadMachines(pool, [{ harness: 'codex', installed: true, subscriptionBroker: true, toolApproval: true }])
  const steps = await import('../workflows/coordinator/steps')
  const { botRuntimeProvisioner } = await import('../lib/computer/auto-runtime')
  const { ensureBotRuntime } = await import('../lib/computer/bot-runtime')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const users: string[] = []
  const realProvision = botRuntimeProvisioner.provision
  let provisioned = 0
  // What waking the bot's computer leaves behind: a running cloud machine with its
  // worker device and the bot's desktop. The real ensureBotRuntime records the runtime.
  botRuntimeProvisioner.provision = async (appDb: PgPool, actor: { userId: string; workspaceId: string }, botId: string) => {
    provisioned++
    const deviceId = randomUUID(), sandboxId = `sbx-${randomUUID()}`
    await appDb.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses,"lastSeenAt") VALUES ($1,$2,'Cloud computer','cloud',true,$3,now())`, [deviceId, actor.userId, JSON.stringify(harnesses)])
    await appDb.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [actor.workspaceId, actor.userId, randomUUID(), sandboxId, deviceId])
    await appDb.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)`, [botId, actor.workspaceId, actor.userId])
    const sandbox = { sandboxId, commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } }
    await ensureBotRuntime(appDb, actor, botId, sandbox as never, deviceId)
  }
  t.after(async () => {
    botRuntimeProvisioner.provision = realProvision
    threadMachines.restore()
    delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
    await pool.query('DELETE FROM model_order_entries WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_order_settings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM coordinator_bots WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM computer_run_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM thread_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM run_publications WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM workspace_subscription_shares WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM bot_desktops WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM cloud_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM device_repos WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM devices WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  const order = await import('../lib/model-order')
  // A new workspace: the person's own E2B key and a connected Codex subscription whose account lists gpt-5,
  // 允许使用的模型 left as filled by default (that model) and 运行位置 云端; no cloud runtime.
  const person = async (label: string, e2bKey = true) => {
    const id = await seedUser(pool, label)
    users.push(id)
    // Push is what the GitHub App grants (lib/github/push-grant.ts); record that grant as a live check would.
    await recordPushGrant(pool, id, normalizeRepository('octo/repo').key)
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    // Their own workspace: the personal one, where work with no workspace of its own goes.
    await pool.query(`UPDATE mikka_workspaces SET kind='personal' WHERE id=$1`, [ws.id])
    const issueId = await seedIssue(pool, id)
    await pool.query(`UPDATE issues SET content='{"type":"doc","attrs":{"mikka":{"number":7}}}' WHERE id=$1`, [issueId])
    const botId = await seedBot(pool, ws.id, id)
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog") VALUES ($1,$2,$3,'codex','connected',1,$5,$4,'synthetic-subject',$6)`, [connection, id, ws.id, 'a'.repeat(64), `synthetic-${connection}`, JSON.stringify({ revision: '1', models: ['gpt-5'] })])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5')`, [randomUUID(), id, ws.id, connection])
    await pool.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)`, [id, ws.id])
    if (e2bKey) await pool.query(`INSERT INTO workspace_e2b_keys ("workspaceId",ciphertext,iv,"keyVersion",last4,"createdBy","updatedBy") VALUES ($1,'x','x',1,'abcd',$2,$2)`, [ws.id, id])
    await order.changeOrder(pool, { ownerId: id, workspaceId: ws.id }, { kind: 'location', location: 'cloud' })
    return { id, workspaceId: ws.id, issueId, botId, connection }
  }
  const dispatch = (userId: string, issueId: string, botId: string) => steps.dispatchRun(userId, { issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` }, undefined, botId)
  const count = async (sql: string, values: unknown[]) => (await pool.query(sql, values)).rows[0].n as number
  // Another numbered task of the same person: a task has one thread (lib/thread-dispatch.ts), so reuse is shown on a second task.
  const anotherTask = async (userId: string, number: number) => {
    const issueId = await seedIssue(pool, userId)
    await pool.query(`UPDATE issues SET content=$2::jsonb WHERE id=$1`, [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number } } })])
    return issueId
  }

  await t.test('no runtime yet: the run goes to the cloud and the runtime is created; a second dispatch reuses it', async () => {
    const a = await person('auto-runtime')
    assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [a.botId]), 0)
    const first = await dispatch(a.id, a.issueId, a.botId) as unknown as { runId: string; status: string; botId: string }
    assert.equal(first.status, 'queued', JSON.stringify(first))
    assert.equal(first.botId, a.botId)
    const runtime = (await pool.query('SELECT "agentId",harness FROM bot_cloud_runtimes WHERE "botId"=$1', [a.botId])).rows
    assert.equal(runtime.length, 1, 'the runtime was created with no manual step')
    assert.equal(runtime[0].harness, 'codex')
    const run = (await pool.query(`SELECT r."agentId",r.status,d.kind,b."botId" FROM agent_runs r JOIN devices d ON d.id=r."deviceId" JOIN computer_run_bindings b ON b."runId"=r.id WHERE r.id=$1`, [first.runId])).rows[0]
    assert.deepEqual(run, { agentId: runtime[0].agentId, status: 'queued', kind: 'cloud', botId: a.botId }, 'queued on the bot cloud computer')
    const bound = (await pool.query('SELECT "connectionId"::text AS c,"modelId" FROM byos_bindings WHERE "consumerId"=$1', [runtime[0].agentId])).rows
    assert.deepEqual(bound, [{ c: a.connection, modelId: 'gpt-5' }], 'the entry\'s own Codex subscription and model are bound to the runtime')

    const second = await dispatch(a.id, await anotherTask(a.id, 8), a.botId) as unknown as { runId: string; status: string }
    assert.equal(second.status, 'queued')
    assert.notEqual(second.runId, first.runId)
    assert.equal(provisioned, 1, 'the computer is woken once')
    assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [a.botId]), 1, 'no duplicate runtime')
    assert.equal(await count('SELECT count(*)::int AS n FROM byos_bindings WHERE "consumerId"=$1', [runtime[0].agentId]), 1, 'no duplicate binding')
    assert.equal(await count('SELECT count(*)::int AS n FROM cloud_machines WHERE "ownerId"=$1', [a.id]), 1)
  })

  await t.test('an existing sleeping or disconnected worker is woken before dispatch', async () => {
    const a = await person('sleeping-runtime')
    await dispatch(a.id, a.issueId, a.botId)
    const { ensureBotCloudRuntime } = await import('../lib/computer/auto-runtime')
    let wakes = 0
    const wake = { provision: async () => {
      wakes++
      await pool.query(`UPDATE cloud_machines SET state='running' WHERE "ownerId"=$1`, [a.id])
      await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE "ownerId"=$1', [a.id])
    } }
    for (const state of ['sleeping', 'running']) {
      await pool.query('UPDATE cloud_machines SET state=$2 WHERE "ownerId"=$1', [a.id, state])
      await pool.query(`UPDATE devices SET "lastSeenAt"=now()-interval '2 minutes' WHERE "ownerId"=$1`, [a.id])
      assert.ok(await ensureBotCloudRuntime(pool, { userId: a.id, workspaceId: a.workspaceId }, a.botId, { harness: 'codex' }, wake))
    }
    assert.equal(wakes, 2)
    const result = await dispatch(a.id, await anotherTask(a.id, 8), a.botId) as unknown as { status: string }
    assert.equal(result.status, 'queued')
  })

  await t.test('concurrent dispatches of one task create only one thread', async () => {
    const a = await person('concurrent-runtime')
    const results = await Promise.all([dispatch(a.id, a.issueId, a.botId), dispatch(a.id, a.issueId, a.botId)]) as unknown as { runId: string; thread: string }[]
    assert.deepEqual(results.map(result => result.thread).sort(), ['message', 'new'])
    assert.equal(results[0].runId, results[1].runId)
    assert.equal(await count('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [a.issueId]), 1)
  })

  await t.test('a cloud run pushes on the GitHub App grant like a local run; without it, or read-only, it cannot push', async () => {
    const g = await person('cloud-grant')
    const granted = await dispatch(g.id, g.issueId, g.botId) as unknown as { runId: string; status: string }
    assert.equal(granted.status, 'queued', JSON.stringify(granted))
    const admitted = (await pool.query(`SELECT r."agentDefinition",p.branch,p."pushApproved" FROM agent_runs r JOIN devices d ON d.id=r."deviceId" AND d.kind='cloud'
      LEFT JOIN run_publications p ON p."runId"=r.id WHERE r.id=$1`, [granted.runId])).rows[0]
    assert.equal(admitted.agentDefinition.repositoryAdmission.authority, 'github_app')
    assert.equal(admitted.agentDefinition.repositoryAdmission.targetBranch, admitted.branch)
    assert.equal(admitted.pushApproved, true)
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"finishedAt"=now() WHERE id=$1', [granted.runId])

    await pool.query('UPDATE github_repository_installations SET "pushGrantedAt"=null WHERE "userId"=$1', [g.id])
    // Each case on its own task of the same person: dispatching the same task again continues its thread (lib/thread-dispatch.ts).
    const ungranted = await dispatch(g.id, await anotherTask(g.id, 8), g.botId) as unknown as { runId: string; status: string }
    assert.equal(ungranted.status, 'queued', 'a cloud run without the grant still runs; it just cannot push')
    const plain = (await pool.query('SELECT r."agentDefinition",(SELECT count(*)::int FROM run_publications p WHERE p."runId"=r.id) AS publications FROM agent_runs r WHERE r.id=$1', [ungranted.runId])).rows[0]
    assert.equal(plain.agentDefinition.repositoryAdmission, undefined)
    assert.equal(plain.publications, 0)
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"finishedAt"=now() WHERE id=$1', [ungranted.runId])

    const readOnly = await steps.dispatchRun(g.id, { issueId: await anotherTask(g.id, 9), repo: 'octo/repo', readOnly: true, requestKey: `dispatch:${randomUUID()}` }, undefined, g.botId) as unknown as { runId: string; status: string }
    assert.equal(readOnly.status, 'queued')
    const definition = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [readOnly.runId])).rows[0].agentDefinition
    assert.equal(definition.readOnly, true)
    assert.equal(definition.repositoryAdmission, undefined)
    assert.equal(await count('SELECT count(*)::int AS n FROM pending_actions WHERE "userId"=$1', [g.id]), 0, 'no approval card')
  })

  await t.test('read-only sticks when a cloud thread continues: a read-only ask on a writable thread, and a read-only thread asked again', async () => {
    const r = await person('cloud-readonly-thread')
    const definitionOf = async (runId: string) => (await pool.query(`SELECT r."agentDefinition",d.kind,(SELECT count(*)::int FROM run_publications p WHERE p."runId"=r.id) AS publications
      FROM agent_runs r JOIN devices d ON d.id=r."deviceId" WHERE r.id=$1`, [runId])).rows[0]
    type Continued = { runId: string; thread: string; threadId: string }
    // Its own task numbers: another person's task 7 on octo/repo already holds that publication branch.
    const work = await anotherTask(r.id, 31)
    const writable = await dispatch(r.id, work, r.botId) as unknown as Continued
    assert.equal((await definitionOf(writable.runId)).agentDefinition.repositoryAdmission?.authority, 'github_app', 'the thread starts writable')
    await pool.query('UPDATE agent_runs SET status=\'failed\',"finishedAt"=now() WHERE id=$1', [writable.runId])
    const look = await steps.dispatchRun(r.id, { issueId: work, repo: 'octo/repo', readOnly: true, requestKey: `dispatch:${randomUUID()}` }, undefined, r.botId) as unknown as Continued
    assert.deepEqual([look.thread, look.threadId], ['continued', writable.runId])
    const looked = await definitionOf(look.runId)
    assert.deepEqual([looked.kind, looked.agentDefinition.readOnly, looked.agentDefinition.repositoryAdmission, looked.publications], ['cloud', true, undefined, 0])
    await pool.query('UPDATE agent_runs SET status=\'failed\',"finishedAt"=now() WHERE id=$1', [look.runId])
    const again = await dispatch(r.id, work, r.botId) as unknown as Continued
    assert.deepEqual([again.thread, again.threadId], ['continued', writable.runId])
    const kept = await definitionOf(again.runId)
    assert.deepEqual([kept.kind, kept.agentDefinition.readOnly, kept.agentDefinition.repositoryAdmission, kept.publications], ['cloud', true, undefined, 0], 'a read-only thread stays read-only')

    // dispatch_bot_computer: a read-only first run, and its continuation, stay read-only.
    const task = await anotherTask(r.id, 32)
    const first = await steps.dispatchComputerThread(r.id, { botId: r.botId, issueId: task, harness: 'codex', readOnly: true }, `call-${randomUUID()}`, undefined, undefined, r.botId) as unknown as Continued
    assert.equal(first.thread, 'new', JSON.stringify(first))
    assert.deepEqual([(await definitionOf(first.runId)).agentDefinition.readOnly, (await definitionOf(first.runId)).agentDefinition.repositoryAdmission], [true, undefined])
    await pool.query('UPDATE agent_runs SET status=\'failed\',"finishedAt"=now() WHERE id=$1', [first.runId])
    const next = await steps.dispatchComputerThread(r.id, { botId: r.botId, issueId: task, harness: 'codex', note: 'Look further.' }, `call-${randomUUID()}`, undefined, undefined, r.botId) as unknown as Continued
    assert.deepEqual([next.thread, next.threadId], ['continued', first.runId])
    assert.deepEqual([(await definitionOf(next.runId)).agentDefinition.readOnly, (await definitionOf(next.runId)).agentDefinition.repositoryAdmission], [true, undefined])
  })

  await t.test('no E2B key of their own: no cloud runtime; the card says so, and 本地 runs on the person\'s own computer', async () => {
    const n = await person('no-key', false)
    const before = provisioned
    const result = await dispatch(n.id, n.issueId, n.botId) as unknown as { error: string; reason: string; card: { title: string; options: { action: string }[] } }
    assert.equal(result.error, 'machineUnavailable')
    assert.deepEqual([result.reason, result.card.title, result.card.options.map(option => option.action)], ['cloudNotConfigured', '没有能跑这个任务的模型', ['e2bKey', 'modelSettings']])
    assert.equal(provisioned, before, 'no cloud computer is woken without a key')
    assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [n.botId]), 0)
    // 运行位置 本地 and their own server online (参与调度 on), its Codex reporting gpt-5: it takes the run.
    await order.changeOrder(pool, { ownerId: n.id, workspaceId: n.workspaceId }, { kind: 'location', location: 'local' })
    const server = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Server','local','server',true,now(),$3)`, [server, n.id, JSON.stringify([{ harness: 'codex', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'gpt-5', model: 'gpt-5', name: 'gpt-5' }] }])])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [randomUUID(), n.id, server, `codex-${server.slice(0, 8)}`])
    const queued = await dispatch(n.id, n.issueId, n.botId) as unknown as { runId: string; status: string }
    assert.equal(queued.status, 'queued')
    assert.equal((await pool.query('SELECT "deviceId" FROM agent_runs WHERE id=$1', [queued.runId])).rows[0].deviceId, server)
    assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [n.botId]), 0)
  })

  await t.test('the Coordinator: its own bot row gets the runtime, once, and never borrows a bot\'s', async () => {
    const c = await person('coordinator')
    // The person already has a bot named Coordinator: it keeps its name and stays theirs.
    const theirs = randomUUID()
    await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'Coordinator')`, [theirs, c.workspaceId, c.id])
    const before = provisioned
    const { coordinatorBot } = await import('../lib/coordinator/coordinator-bot')
    // Dispatched from the web in c's workspace: that workspace's Coordinator.
    const coordinator = (await coordinatorBot(c.id, c.workspaceId)).botId
    const dispatchAsCoordinator = (issueId = c.issueId) => steps.dispatchRun(c.id, { issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` }, undefined, coordinator)
    const first = await dispatchAsCoordinator() as unknown as { runId: string; status: string }
    assert.equal(first.status, 'queued', JSON.stringify(first))
    const mapped = (await pool.query(`SELECT cb."botId",b.name FROM coordinator_bots cb JOIN bots b ON b.id=cb."botId" WHERE cb."ownerId"=$1 AND cb."workspaceId"=$2`, [c.id, c.workspaceId])).rows
    assert.equal(mapped.length, 1, 'one Coordinator bot row')
    assert.equal(mapped[0].name, 'Coordinator 2')
    assert.notEqual(mapped[0].botId, theirs)
    const run = (await pool.query(`SELECT r."botId" AS "runBotId",b."botId" FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id WHERE r.id=$1`, [first.runId])).rows[0]
    assert.equal(mapped[0].botId, coordinator)
    assert.deepEqual(run, { runBotId: coordinator, botId: coordinator }, 'the runtime and the run are the Coordinator bot\'s, so the run reports to its chat')
    assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId" = ANY($1)', [[c.botId, theirs]]), 0, 'no other bot\'s runtime is created or borrowed')
    const second = await dispatchAsCoordinator(await anotherTask(c.id, 8)) as unknown as { status: string }
    assert.equal(second.status, 'queued')
    assert.equal(provisioned, before + 1, 'woken once')
    assert.equal(await count('SELECT count(*)::int AS n FROM coordinator_bots WHERE "ownerId"=$1', [c.id]), 1, 'no duplicate Coordinator bot')
    assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [mapped[0].botId]), 1, 'no duplicate runtime')
    // An ordinary bot row: it is listed with the workspace's bots.
    const { workspaceBots } = await import('../lib/workspace-admin/bots')
    assert.ok((await workspaceBots(c.workspaceId)).some(bot => bot.id === mapped[0].botId))
    const { agentRuns, agents } = await import('../lib/db/schema')
    const { runBotId } = await import('../lib/run-bot-name')
    const { db } = await import('../lib/db')
    const { eq } = await import('drizzle-orm')
    const [row] = await db.select({ botId: runBotId }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).where(eq(agentRuns.id, first.runId))
    assert.equal(row.botId, coordinator, 'the thread belongs to the Coordinator bot row, which the left column opens as the Coordinator chat')
  })

  await t.test('MIKKA_CLOUD_COMPUTER_TASKS=0: no runtime is created and the bot shows the card', async () => {
    const b = await person('kill-switch')
    process.env.MIKKA_CLOUD_COMPUTER_TASKS = '0'
    try {
      const before = provisioned
      const result = await dispatch(b.id, b.issueId, b.botId) as unknown as { error: string; reason: string; card: { title: string } }
      assert.equal(result.error, 'machineUnavailable')
      assert.deepEqual([result.reason, result.card.title], ['cloudNotConfigured', '没有能跑这个任务的模型'])
      assert.equal(provisioned, before)
      assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [b.botId]), 0)
      assert.equal(await count('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [b.id]), 0)
    } finally { delete process.env.MIKKA_CLOUD_COMPUTER_TASKS }
  })

  // The 电脑 policy governs computer use only: a repository task (octo/repo has a remote) runs on a task machine without a desktop.
  await t.test('a workspace whose 电脑 policy is deny still runs a repository task in the cloud', async () => {
    const c = await person('policy-deny')
    await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'deny',1) ON CONFLICT ("workspaceId") DO UPDATE SET permission='deny'`, [c.workspaceId])
    const result = await dispatch(c.id, c.issueId, c.botId) as unknown as { runId: string; status: string; botId: string }
    assert.equal(result.status, 'queued', JSON.stringify(result))
    assert.equal(result.botId, c.botId)
    const run = (await pool.query(`SELECT r.status,d.kind,repo."remoteUrl" FROM agent_runs r JOIN devices d ON d.id=r."deviceId" JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r.id=$1`, [result.runId])).rows[0]
    assert.equal(run.status, 'queued')
    assert.equal(run.kind, 'cloud')
    assert.ok(run.remoteUrl, 'the queued run is a repository task')
  })
})
