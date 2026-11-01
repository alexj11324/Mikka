// Where a thread runs when a person has no cloud, no device, or a full cloud
// (decision 2026-10-31-2200-run-machine-fallback), against a real PostgreSQL.
// Only devices with 允许自动调度 on are picked; otherwise the bot gets an error card.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

const mac = [{ harness: 'codex', installed: true, models: ['gpt-5'], defaultModelSlot: 'default' }]

test('run machine fallback: own E2B, own auto-schedule device, else an actionable error', { skip: !dbUrl }, async t => {
  process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1'
  process.env.MIKKA_BYOS_ENABLED = '1'
  process.env.MIKKA_CLOUD_THREAD_MACHINES = '1'
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const users: string[] = []
  t.after(async () => {
    await pool.query('DELETE FROM thread_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM cloud_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM workspace_subscription_shares WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const person = async (label: string) => {
    const id = await seedUser(pool, label)
    users.push(id)
    // A synthetic persisted push grant; the ordinary admission transaction still runs.
    await pool.query('INSERT INTO repository_settings ("userId","remoteKey",push) VALUES ($1,$2,$3)', [id, normalizeRepository('octo/repo').key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: id, approvedAt: new Date().toISOString() })])
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    const issueId = await seedIssue(pool, id)
    // A numbered task, so its thread gets a publication branch.
    await pool.query(`UPDATE issues SET content='{"type":"doc","attrs":{"mikka":{"number":7}}}' WHERE id=$1`, [issueId])
    return { id, workspaceId: ws.id, issueId }
  }
  const onlineMac = async (userId: string, autoSchedule: boolean | null = true, deviceType = 'laptop') => {
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses,"autoSchedule") VALUES ($1,$2,'MacBook','local',$4,true,now(),$3,$5)`, [deviceId, userId, JSON.stringify(mac), deviceType, autoSchedule])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [randomUUID(), userId, deviceId, `codex-${deviceId.slice(0, 8)}`])
    return deviceId
  }
  const dispatch = (userId: string, issueId: string) => steps.dispatchRun(userId, { issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` })
  type NoMachine = { error: string; card: { title: string; options: { value: string; action: string }[] } }
  const actions = (result: NoMachine) => result.card.options.map(option => option.action)
  const runOf = async (runId: string) => (await pool.query('SELECT "deviceId",status FROM agent_runs WHERE id=$1', [runId])).rows[0]

  await t.test('(a) no card, no E2B, no device: an error card, then a Mac is picked once 允许自动调度 is on', async () => {
    const a = await person('fresh')
    const result = await dispatch(a.id, a.issueId) as unknown as NoMachine
    assert.equal(result.error, 'machineUnavailable')
    assert.equal(result.card.title, '这个任务需要一台电脑来跑')
    assert.deepEqual(actions(result), ['enableThisMac', 'e2bKey', 'connectServer'])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [a.id])).rows[0].n, 0, 'nothing is queued')

    // A personal computer comes online: off by default, so it is offered, not picked.
    const deviceId = await onlineMac(a.id, null)
    const offered = await dispatch(a.id, a.issueId) as unknown as NoMachine
    assert.equal(offered.error, 'machineUnavailable')
    assert.deepEqual(offered.card.options[0], { value: deviceId, label: '允许这台电脑自动调度', action: 'allowAutoSchedule' })
    await pool.query('UPDATE devices SET "autoSchedule"=true WHERE id=$1', [deviceId])
    const queued = await dispatch(a.id, a.issueId) as unknown as { runId: string; status: string }
    assert.equal(queued.status, 'queued')
    assert.equal((await runOf(queued.runId)).deviceId, deviceId)
  })

  await t.test('(b) no E2B and an online Mac with 允许自动调度 on: a cloud rule runs on the Mac', async () => {
    const b = await person('mac')
    const deviceId = await onlineMac(b.id)
    await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,'cloud','codex','gpt-5',2147483647)`, [randomUUID(), b.id, b.workspaceId])
    const result = await dispatch(b.id, b.issueId) as unknown as { runId: string; status: string }
    assert.equal(result.status, 'queued')
    assert.deepEqual(await runOf(result.runId), { deviceId, status: 'queued' })
  })

  await t.test('(c) own E2B refuses at its concurrency cap: the cloud run is ended, a server takes it, else an error card', async () => {
    const c = await person('cloud')
    const botId = await seedBot(pool, c.workspaceId, c.id)
    const cloudDevice = randomUUID(), cloudAgent = randomUUID(), repoId = randomUUID(), connection = randomUUID()
    // The bot's own cloud computer is awake, with its runtime and a bound Codex subscription.
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled) VALUES ($1,$2,'Cloud computer','cloud',true)`, [cloudDevice, c.id])
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [c.workspaceId, c.id, randomUUID(), `sbx-${randomUUID()}`, cloudDevice])
    await pool.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)`, [botId, c.workspaceId, c.id])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [cloudAgent, c.id, cloudDevice, `cloud-${cloudAgent.slice(0, 8)}`])
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch") VALUES ($1,$2,$3,'/home/mikka-runner/w','main')`, [repoId, cloudDevice, c.id])
    await pool.query(`INSERT INTO bot_cloud_runtimes ("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES ($1,$2,$3,'codex',$4,$5)`, [botId, c.workspaceId, c.id, cloudAgent, repoId])
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") VALUES ($1,$2,$3,'codex','connected',1,'synthetic',$4,'synthetic-subject')`, [connection, c.id, c.workspaceId, 'a'.repeat(64)])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,1,'codex_cli','gpt-5')`, [randomUUID(), c.id, c.workspaceId, cloudAgent, connection])
    // A team workspace uses a member's subscription once they share it there (decision 2026-10-31-2225).
    await pool.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)`, [c.id, c.workspaceId])
    await pool.query(`INSERT INTO workspace_e2b_keys ("workspaceId",ciphertext,iv,"keyVersion",last4,"createdBy","updatedBy") VALUES ($1,'x','x',1,'abcd',$2,$2)`, [c.workspaceId, c.id])
    await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,'cloud','codex','gpt-5',2147483647)`, [randomUUID(), c.id, c.workspaceId])
    // A teammate's twenty running thread machines fill the workspace (E2B concurrency 20).
    const teammate = await seedUser(pool, 'teammate')
    users.push(teammate)
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,'member','active')`, [c.workspaceId, teammate, `${teammate}@example.invalid`])
    const teammateAgent = randomUUID()
    await pool.query(`INSERT INTO agents (id,"userId",harness,name) VALUES ($1,$2,'codex',$3)`, [teammateAgent, teammate, `t-${teammateAgent.slice(0, 8)}`])
    for (let i = 0; i < 20; i++) {
      const runId = randomUUID()
      await pool.query(`INSERT INTO agent_runs (id,"userId","agentId",status) VALUES ($1,$2,$3,'running')`, [runId, teammate, teammateAgent])
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state) VALUES ($1,$2,$3,$4,'snap',$5,'running')`, [runId, c.workspaceId, teammate, botId, randomUUID()])
    }

    const refused = await dispatch(c.id, c.issueId) as unknown as NoMachine
    assert.equal(refused.error, 'machineUnavailable', 'no device: an error the person can act on')
    assert.deepEqual(actions(refused), ['enableThisMac', 'e2bKey', 'connectServer'])
    const cloudRuns = (await pool.query(`SELECT r.status,m.state FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r."userId"=$1`, [c.id])).rows
    assert.deepEqual(cloudRuns, [{ status: 'stopped', state: 'ended' }], 'the refused cloud run was queued, then ended instead of left stuck')
    // A server comes online: on by default, so it takes the run.
    const deviceId = await onlineMac(c.id, null, 'server')
    const result = await dispatch(c.id, c.issueId) as unknown as { runId: string; status: string }
    assert.equal(result.status, 'queued')
    assert.equal((await runOf(result.runId)).deviceId, deviceId)
  })

  await t.test('own devices: a server goes ahead of a Mac; a Mac with 允许自动调度 off is never picked', async () => {
    const d = await person('devices')
    await onlineMac(d.id)
    const server = await onlineMac(d.id, null, 'server')
    await pool.query(`UPDATE devices SET "lastSeenAt"=now()-interval '20 seconds' WHERE id=$1`, [server])
    await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,'cloud','codex','gpt-5',2147483647)`, [randomUUID(), d.id, d.workspaceId])
    const result = await dispatch(d.id, d.issueId) as unknown as { runId: string }
    assert.equal((await runOf(result.runId)).deviceId, server)
    const e = await person('manual')
    const mac = await onlineMac(e.id, false)
    await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,'cloud','codex','gpt-5',2147483647)`, [randomUUID(), e.id, e.workspaceId])
    const off = await dispatch(e.id, e.issueId) as unknown as NoMachine
    assert.deepEqual(actions(off), ['allowAutoSchedule', 'e2bKey', 'connectServer'])
    assert.equal(off.card.options[0].value, mac)
    // A rule that names the Mac still runs there: a device the person picks is used as asked.
    await pool.query('UPDATE execution_rules SET place=$2 WHERE "ownerId"=$1', [e.id, mac])
    const asked = await dispatch(e.id, e.issueId) as unknown as { runId: string }
    assert.equal((await runOf(asked.runId)).deviceId, mac)
  })
})
