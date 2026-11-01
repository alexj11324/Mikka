// Cloud runs are on by default: a bot with no cloud runtime gets one when a run
// is dispatched, once, and MIKKA_CLOUD_COMPUTER_TASKS=0 turns it off. Real PostgreSQL;
// only the E2B calls (waking the computer, starting its worker) are replaced.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool as PgPool } from 'pg'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

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
    await pool.query('DELETE FROM computer_run_bindings WHERE "ownerId" = ANY($1)', [users])
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
  const person = async (label: string) => {
    const id = await seedUser(pool, label)
    users.push(id)
    await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [id, normalizeRepository('octo/repo').key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: id, approvedAt: new Date().toISOString() })])
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    const issueId = await seedIssue(pool, id)
    await pool.query(`UPDATE issues SET content='{"type":"doc","attrs":{"mikka":{"number":7}}}' WHERE id=$1`, [issueId])
    const botId = await seedBot(pool, ws.id, id)
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") VALUES ($1,$2,$3,'codex','connected',1,$5,$4,'synthetic-subject')`, [connection, id, ws.id, 'a'.repeat(64), `synthetic-${connection}`])
    await pool.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)`, [id, ws.id])
    await pool.query(`INSERT INTO workspace_e2b_keys ("workspaceId",ciphertext,iv,"keyVersion",last4,"createdBy","updatedBy") VALUES ($1,'x','x',1,'abcd',$2,$2)`, [ws.id, id])
    await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,'cloud','codex','gpt-5',2147483647)`, [randomUUID(), id, ws.id])
    return { id, workspaceId: ws.id, issueId, botId }
  }
  const dispatch = (userId: string, issueId: string, botId: string) => steps.dispatchRun(userId, { issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` }, undefined, botId)
  const count = async (sql: string, values: unknown[]) => (await pool.query(sql, values)).rows[0].n as number

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

    const second = await dispatch(a.id, a.issueId, a.botId) as unknown as { runId: string; status: string }
    assert.equal(second.status, 'queued')
    assert.notEqual(second.runId, first.runId)
    assert.equal(provisioned, 1, 'the computer is woken once')
    assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [a.botId]), 1, 'no duplicate runtime')
    assert.equal(await count('SELECT count(*)::int AS n FROM byos_bindings WHERE "consumerId"=$1', [runtime[0].agentId]), 1, 'no duplicate binding')
    assert.equal(await count('SELECT count(*)::int AS n FROM cloud_machines WHERE "ownerId"=$1', [a.id]), 1)
  })

  await t.test('MIKKA_CLOUD_COMPUTER_TASKS=0: no runtime is created and the bot shows the card', async () => {
    const b = await person('kill-switch')
    process.env.MIKKA_CLOUD_COMPUTER_TASKS = '0'
    try {
      const before = provisioned
      const result = await dispatch(b.id, b.issueId, b.botId) as unknown as { error: string; card: { title: string } }
      assert.equal(result.error, 'machineUnavailable')
      assert.equal(result.card.title, '这个任务需要一台电脑来跑')
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
