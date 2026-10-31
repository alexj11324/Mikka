// Where a thread runs when a person has no cloud, no device, or a full cloud
// (decision 2026-10-31-2200-run-machine-fallback), against a real PostgreSQL.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

const mac = [{ harness: 'codex', installed: true, models: ['gpt-5'], defaultModelSlot: 'default' }]

test('run machine fallback: cloud, own device, else wait and wake', { skip: !dbUrl }, async t => {
  process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1'
  process.env.MIKKA_BYOS_ENABLED = '1'
  process.env.MIKKA_CLOUD_THREAD_MACHINES = '1'
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const steps = await import('../workflows/coordinator/steps')
  const { wakeMachineWaits, wakeMachineWaitsForDevice } = await import('../lib/machine-waits')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const users: string[] = []
  t.after(async () => {
    await pool.query('DELETE FROM thread_machines WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM cloud_machines WHERE "ownerId" = ANY($1)', [users])
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
  const onlineMac = async (userId: string) => {
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'MacBook','local','laptop',true,now(),$3)`, [deviceId, userId, JSON.stringify(mac)])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [randomUUID(), userId, deviceId, `codex-${deviceId.slice(0, 8)}`])
    return deviceId
  }
  const dispatch = (userId: string, issueId: string) => steps.dispatchRun(userId, { issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` })
  const waits = async (userId: string) => (await pool.query(`SELECT id,tier,"deliveredAt" FROM coordinator_events WHERE "userId"=$1 AND kind='machine_needed'`, [userId])).rows
  const runOf = async (runId: string) => (await pool.query('SELECT "deviceId",status FROM agent_runs WHERE id=$1', [runId])).rows[0]

  await t.test('(a) no card, no E2B, no device: the task waits with the card, nothing fails', async () => {
    const a = await person('fresh')
    const result = await dispatch(a.id, a.issueId) as unknown as { status: string; card: { title: string; options: { action: string }[] } }
    assert.equal(result.status, 'waiting_machine')
    assert.equal(result.card.title, '这个任务需要一台电脑来跑')
    assert.deepEqual(result.card.options.map(option => option.action), ['enableThisMac', 'connectServer', 'e2bKey'])
    const [wait] = await waits(a.id)
    assert.equal(wait.tier, 'background')
    assert.ok(wait.deliveredAt, 'the wait itself never wakes the chat')
    await dispatch(a.id, a.issueId)
    assert.equal((await waits(a.id)).length, 1, 'a second dispatch reuses the open wait')

    // A device comes online: the bot is woken once to dispatch again.
    const deviceId = await onlineMac(a.id)
    assert.deepEqual(await wakeMachineWaitsForDevice(pool, a.id, deviceId, false), [], 'a device that was already online wakes nothing')
    assert.deepEqual(await wakeMachineWaitsForDevice(pool, a.id, deviceId, true), [wait.id])
    assert.deepEqual(await wakeMachineWaitsForDevice(pool, a.id, deviceId, true), [], 'each wait is woken once')
    const woken = (await pool.query(`SELECT tier,"deliveredAt",payload FROM coordinator_events WHERE "dedupeKey"=$1`, [`machine_available:${wait.id}`])).rows[0]
    assert.equal(woken.tier, 'attention')
    assert.equal(woken.deliveredAt, null)
    assert.equal(woken.payload.request.repo, 'octo/repo')
    const again = await dispatch(a.id, a.issueId) as unknown as { runId: string; status: string }
    assert.equal(again.status, 'queued')
    assert.equal((await runOf(again.runId)).deviceId, deviceId)
  })

  await t.test('(b) no E2B and an online Mac: a cloud rule runs on the Mac', async () => {
    const b = await person('mac')
    const deviceId = await onlineMac(b.id)
    await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,'cloud','codex','gpt-5',2147483647)`, [randomUUID(), b.id, b.workspaceId])
    const result = await dispatch(b.id, b.issueId) as unknown as { runId: string; status: string }
    assert.equal(result.status, 'queued')
    assert.deepEqual(await runOf(result.runId), { deviceId, status: 'queued' })
    assert.equal((await waits(b.id)).length, 0)
  })

  await t.test('(c) own E2B refuses at its concurrency cap: the cloud run is ended, the Mac takes it, else it waits', async () => {
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

    const waiting = await dispatch(c.id, c.issueId) as unknown as { status: string }
    assert.equal(waiting.status, 'waiting_machine', 'no device: the task waits instead of failing')
    const cloudRuns = (await pool.query(`SELECT r.status,m.state FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r."userId"=$1`, [c.id])).rows
    assert.deepEqual(cloudRuns, [{ status: 'stopped', state: 'ended' }], 'the refused cloud run was queued, then ended instead of left stuck')
    const [wait] = await waits(c.id)
    assert.deepEqual(await wakeMachineWaits(pool, null, { workspaceId: randomUUID() }), [], 'another workspace freeing a slot wakes nothing here')
    assert.deepEqual(await wakeMachineWaits(pool, null, { workspaceId: c.workspaceId }), [wait.id])

    const deviceId = await onlineMac(c.id)
    const result = await dispatch(c.id, c.issueId) as unknown as { runId: string; status: string }
    assert.equal(result.status, 'queued')
    assert.equal((await runOf(result.runId)).deviceId, deviceId)
  })

  await t.test('own devices: a server goes ahead of a Mac', async () => {
    const d = await person('devices')
    await onlineMac(d.id)
    const server = await onlineMac(d.id)
    await pool.query(`UPDATE devices SET "deviceType"='server',"lastSeenAt"=now()-interval '20 seconds' WHERE id=$1`, [server])
    await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,'cloud','codex','gpt-5',2147483647)`, [randomUUID(), d.id, d.workspaceId])
    const result = await dispatch(d.id, d.issueId) as unknown as { runId: string }
    assert.equal((await runOf(result.runId)).deviceId, server)
  })
})
