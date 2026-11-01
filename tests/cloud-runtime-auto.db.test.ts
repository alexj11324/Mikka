// A person's own E2B key is enough for cloud runs: a bot with no cloud runtime gets
// one when a run is dispatched, once. No key: never the cloud. MIKKA_CLOUD_COMPUTER_TASKS=0 turns it off. Real PostgreSQL;
// only the E2B calls (waking the computer, starting its worker) are replaced.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool as PgPool } from 'pg'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { recordPushGrant } from './support/github-app-stub'

const harnesses = [{ harness: 'codex', installed: true, subscriptionBroker: true, computerBroker: true }]

test('cloud runs: the bot runtime is created on dispatch, once; the kill switch falls back to the card', { skip: !dbUrl }, async t => {
  delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
  delete process.env.MIKKA_CLOUD_THREAD_MACHINES
  process.env.MIKKA_BYOS_ENABLED = '1'
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
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
    await appDb.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses) VALUES ($1,$2,'Cloud computer','cloud',true,$3)`, [deviceId, actor.userId, JSON.stringify(harnesses)])
    await appDb.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [actor.workspaceId, actor.userId, randomUUID(), sandboxId, deviceId])
    await appDb.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)`, [botId, actor.workspaceId, actor.userId])
    const sandbox = { sandboxId, commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) } }
    await ensureBotRuntime(appDb, actor, botId, sandbox as never, deviceId)
  }
  t.after(async () => {
    botRuntimeProvisioner.provision = realProvision
    delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
    await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM coordinator_bots WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM computer_run_bindings WHERE "ownerId" = ANY($1)', [users])
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

  // A new workspace: the person's own E2B key and a connected Codex subscription, no cloud runtime.
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
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") VALUES ($1,$2,$3,'codex','connected',1,$5,$4,'synthetic-subject')`, [connection, id, ws.id, 'a'.repeat(64), `synthetic-${connection}`])
    await pool.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)`, [id, ws.id])
    if (e2bKey) await pool.query(`INSERT INTO workspace_e2b_keys ("workspaceId",ciphertext,iv,"keyVersion",last4,"createdBy","updatedBy") VALUES ($1,'x','x',1,'abcd',$2,$2)`, [ws.id, id])
    await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,'cloud','codex','gpt-5',2147483647)`, [randomUUID(), id, ws.id])
    return { id, workspaceId: ws.id, issueId, botId }
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
    assert.equal(await count('SELECT count(*)::int AS n FROM byos_bindings WHERE "consumerId"=$1', [runtime[0].agentId]), 1, 'the owner\'s own Codex subscription is bound to the runtime')

    const second = await dispatch(a.id, await anotherTask(a.id, 8), a.botId) as unknown as { runId: string; status: string }
    assert.equal(second.status, 'queued')
    assert.notEqual(second.runId, first.runId)
    assert.equal(provisioned, 1, 'the computer is woken once')
    assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [a.botId]), 1, 'no duplicate runtime')
    assert.equal(await count('SELECT count(*)::int AS n FROM byos_bindings WHERE "consumerId"=$1', [runtime[0].agentId]), 1, 'no duplicate binding')
    assert.equal(await count('SELECT count(*)::int AS n FROM cloud_machines WHERE "ownerId"=$1', [a.id]), 1)
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

  await t.test('no E2B key of their own: no cloud runtime; the card, or the person\'s own auto-schedule device', async () => {
    const n = await person('no-key', false)
    const before = provisioned
    const result = await dispatch(n.id, n.issueId, n.botId) as unknown as { error: string; card: { title: string } }
    assert.equal(result.error, 'machineUnavailable')
    assert.equal(result.card.title, '没有可用的电脑')
    assert.equal(provisioned, before, 'no cloud computer is woken without a key')
    assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [n.botId]), 0)
    // Their own server comes online (允许自动调度 is on by default for servers): it takes the run.
    const server = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Server','local','server',true,now(),$3)`, [server, n.id, JSON.stringify([{ harness: 'codex', installed: true, models: ['gpt-5'], defaultModelSlot: 'default' }])])
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
      const result = await dispatch(b.id, b.issueId, b.botId) as unknown as { error: string; card: { title: string } }
      assert.equal(result.error, 'machineUnavailable')
      assert.equal(result.card.title, '没有可用的电脑')
      assert.equal(provisioned, before)
      assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [b.botId]), 0)
      assert.equal(await count('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [b.id]), 0)
    } finally { delete process.env.MIKKA_CLOUD_COMPUTER_TASKS }
  })

  await t.test('a workspace whose 电脑 policy is deny: no runtime, the card', async () => {
    const c = await person('policy-deny')
    await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'deny',1) ON CONFLICT ("workspaceId") DO UPDATE SET permission='deny'`, [c.workspaceId])
    const before = provisioned
    const result = await dispatch(c.id, c.issueId, c.botId) as unknown as { error: string }
    assert.equal(result.error, 'machineUnavailable')
    assert.equal(provisioned, before)
  })
})
