// Where a thread runs when a person has no cloud, no device, or a full cloud
// (decision 2026-10-31-2200-run-machine-fallback), against a real PostgreSQL.
// Only devices with 允许自动调度 on are picked; otherwise the bot gets an error card.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { githubAppStub } from './support/github-app-stub'

const mac = [{ harness: 'codex', installed: true, models: ['gpt-5'], defaultModelSlot: 'default' }]

test('run machine fallback: own E2B, own auto-schedule device, else an actionable error', { skip: !dbUrl }, async t => {
  process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1'
  process.env.MIKKA_BYOS_ENABLED = '1'
  process.env.MIKKA_CLOUD_THREAD_MACHINES = '1'
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
    await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
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
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    const issueId = await seedIssue(pool, id)
    // A numbered task, so its thread gets a publication branch.
    await pool.query(`UPDATE issues SET content='{"type":"doc","attrs":{"mikka":{"number":7}}}' WHERE id=$1`, [issueId])
    seeded.set(id, ws.id)
    return { id, workspaceId: ws.id, issueId }
  }
  const onlineMac = async (userId: string, autoSchedule: boolean | null = true, deviceType = 'laptop') => {
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses,"autoSchedule") VALUES ($1,$2,'MacBook','local',$4,true,now(),$3,$5)`, [deviceId, userId, JSON.stringify(mac), deviceType, autoSchedule])
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
  type NoMachine = { error: string; card: { title: string; description: string; options: { value: string; action: string }[] } }
  const actions = (result: NoMachine) => result.card.options.map(option => option.action)
  const runOf = async (runId: string) => (await pool.query('SELECT "deviceId",status FROM agent_runs WHERE id=$1', [runId])).rows[0]

  await t.test('(a) no card, no E2B, no device: an error card, then a Mac is picked once 允许自动调度 is on', async () => {
    const a = await person('fresh')
    const result = await dispatch(a.id, a.issueId) as unknown as NoMachine
    assert.equal(result.error, 'machineUnavailable')
    assert.equal(result.card.title, '没有可用的电脑')
    assert.equal(result.card.description, '先连接或开启一台电脑，或者填入你的 E2B API Key 用云端运行。')
    // Two rows only (Alex): 连接电脑 opens Settings › 电脑, 填入 E2B Key the person's own key; never Mikka's cloud.
    assert.deepEqual(result.card.options, [
      { value: 'computer', label: '连接电脑', action: 'connectServer' },
      { value: 'e2b', label: '填入 E2B Key', action: 'e2bKey' },
    ])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [a.id])).rows[0].n, 0, 'nothing is queued')

    // A personal computer comes online: off by default, so it is not picked; the card is the same two rows.
    const deviceId = await onlineMac(a.id, null)
    const offered = await dispatch(a.id, a.issueId) as unknown as NoMachine
    assert.equal(offered.error, 'machineUnavailable')
    assert.deepEqual(actions(offered), ['connectServer', 'e2bKey'])
    await pool.query('UPDATE devices SET "autoSchedule"=true WHERE id=$1', [deviceId])
    const queued = await dispatch(a.id, a.issueId) as unknown as { runId: string; status: string }
    assert.equal(queued.status, 'queued')
    assert.equal((await runOf(queued.runId)).deviceId, deviceId)
  })

  await t.test('a read-only task runs without a repository push approval; a committing one says why it cannot', async () => {
    const r = await person('readonly')
    const deviceId = await onlineMac(r.id)
    const botId = await chatBotId(r.id, null, await ownWorkspace(r.id))
    // The App is not installed on octo/elsewhere.
    const refused = await steps.dispatchRun(r.id, { issueId: r.issueId, repo: 'octo/elsewhere', requestKey: `dispatch:${randomUUID()}` }, undefined, botId) as unknown as { error: string; reason: string; detail: string }
    assert.equal(refused.error, 'runInvalid')
    assert.equal(refused.reason, 'githubAppNotInstalled', 'the Coordinator is told the real cause, not left to guess one')
    assert.match(refused.detail, /readOnly run can go ahead/)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [r.id])).rows[0].n, 0)
    const queued = await steps.dispatchRun(r.id, { issueId: r.issueId, repo: 'octo/elsewhere', readOnly: true, requestKey: `dispatch:${randomUUID()}` }, undefined, botId) as unknown as { runId: string; status: string }
    assert.equal(queued.status, 'queued')
    const run = (await pool.query('SELECT "deviceId","agentDefinition" FROM agent_runs WHERE id=$1', [queued.runId])).rows[0]
    assert.equal(run.deviceId, deviceId)
    assert.equal(run.agentDefinition.readOnly, true)
    assert.equal(run.agentDefinition.repositoryAdmission, undefined, 'a read-only run carries no push authority')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_publications WHERE "runId"=$1', [queued.runId])).rows[0].n, 0, 'no push branch is reserved')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_actions WHERE "userId"=$1', [r.id])).rows[0].n, 0, 'nothing asked the person for an approval')
    const { persistRunCompletion } = await import('../lib/run-publications')
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [queued.runId])
    await persistRunCompletion(r.id, queued.runId, { stopReason: 'submitted', report: { summary: 'Findings reported.', filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null } })
    assert.equal((await runOf(queued.runId)).status, 'succeeded', 'a read-only report has nothing to publish, so it is not blocked on a push')
  })

  await t.test('push follows the GitHub App grant: allowed without a card when granted, a clear reason when not', async () => {
    const g = await person('github-grant')
    await onlineMac(g.id)
    const botId = await chatBotId(g.id, null, await ownWorkspace(g.id))
    const dispatchTo = (repo: string) => steps.dispatchRun(g.id, { issueId: g.issueId, repo, requestKey: `dispatch:${randomUUID()}` }, undefined, botId) as unknown as Promise<{ error?: string; reason?: string; detail?: string; runId?: string; status?: string }>
    const runs = async () => (await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [g.id])).rows[0].n
    github.install('octo/read-only-app', { contents: 'read', pull_requests: 'write' })
    const narrow = await dispatchTo('octo/read-only-app')
    assert.equal(narrow.reason, 'githubAppPermissionRequired')
    assert.match(narrow.detail!, /contents: write/)
    assert.match(narrow.detail!, /https:\/\/github\.com\/apps\/mikka-github\/installations\/new/, 'the person is sent to GitHub, not to an approval in Mikka')
    github.install('octo/suspended', { contents: 'write', suspended: true })
    assert.equal((await dispatchTo('octo/suspended')).reason, 'githubAppSuspended')
    github.install('octo/not-mine', { contents: 'write', pull_requests: 'write' })
    assert.equal((await dispatchTo('octo/not-mine')).reason, 'githubAccessDenied', 'the App grant never lends one person\'s push to another')
    assert.equal(await runs(), 0)
    const queued = await dispatchTo('octo/repo')
    assert.equal(queued.status, 'queued')
    const run = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [queued.runId])).rows[0]
    assert.equal(run.agentDefinition.repositoryAdmission.authority, 'github_app')
    assert.equal((await pool.query('SELECT "pushApproved" FROM run_publications WHERE "runId"=$1', [queued.runId])).rows[0].pushApproved, true)
    assert.ok((await pool.query('SELECT "pushGrantedAt" FROM github_repository_installations WHERE "userId"=$1 AND "remoteKey"=$2', [g.id, normalizeRepository('octo/repo').key])).rows[0].pushGrantedAt)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM pending_actions WHERE "userId"=$1', [g.id])).rows[0].n, 0, 'no approval card')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM repository_settings WHERE "userId"=$1 AND push IS NOT NULL', [g.id])).rows[0].n, 0, 'no Mikka-side push approval is involved')
  })

  await t.test('(b) no E2B and an online Mac with 允许自动调度 on: a cloud rule runs on the Mac', async () => {
    const b = await person('mac')
    const deviceId = await onlineMac(b.id)
    await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,'cloud','codex','gpt-5',2147483647)`, [randomUUID(), b.id, b.workspaceId])
    const result = await dispatch(b.id, b.issueId) as unknown as { runId: string; status: string }
    assert.equal(result.status, 'queued')
    assert.deepEqual(await runOf(result.runId), { deviceId, status: 'queued' })
  })

  // The bot's own cloud computer is awake, with its runtime, a bound Codex subscription and the
  // person's own E2B key. The key is not a real one, so E2B refuses to start a thread machine,
  // which is what its concurrency cap or quota does too.
  const cloudReady = async (c: { id: string; workspaceId: string }) => {
    const botId = await seedBot(pool, c.workspaceId, c.id)
    const cloudDevice = randomUUID(), cloudAgent = randomUUID(), repoId = randomUUID(), connection = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled) VALUES ($1,$2,'Cloud computer','cloud',true)`, [cloudDevice, c.id])
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [c.workspaceId, c.id, randomUUID(), `sbx-${randomUUID()}`, cloudDevice])
    await pool.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)`, [botId, c.workspaceId, c.id])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [cloudAgent, c.id, cloudDevice, `cloud-${cloudAgent.slice(0, 8)}`])
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch") VALUES ($1,$2,$3,'/home/mikka-runner/w','main')`, [repoId, cloudDevice, c.id])
    await pool.query(`INSERT INTO bot_cloud_runtimes ("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES ($1,$2,$3,'codex',$4,$5)`, [botId, c.workspaceId, c.id, cloudAgent, repoId])
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") VALUES ($1,$2,$3,'codex','connected',1,$5,$4,'synthetic-subject')`, [connection, c.id, c.workspaceId, 'a'.repeat(64), `synthetic-${connection}`])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,1,'codex_cli','gpt-5')`, [randomUUID(), c.id, c.workspaceId, cloudAgent, connection])
    // A team workspace uses a member's subscription once they share it there (decision 2026-10-31-2225).
    await pool.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)`, [c.id, c.workspaceId])
    await pool.query(`INSERT INTO workspace_e2b_keys ("workspaceId",ciphertext,iv,"keyVersion",last4,"createdBy","updatedBy") VALUES ($1,'x','x',1,'abcd',$2,$2)`, [c.workspaceId, c.id])
    return { botId, cloudDevice }
  }

  await t.test('(c) own E2B refuses (cap, quota, key): the cloud run is ended, a server takes it, else an error card', async () => {
    const c = await person('cloud')
    const { botId } = await cloudReady(c)
    await pool.query(`INSERT INTO execution_rules (id,"ownerId","workspaceId",label,place,harness,model,position) VALUES ($1,$2,$3,NULL,'cloud','codex','gpt-5',2147483647)`, [randomUUID(), c.id, c.workspaceId])
    // The Coordinator uses its own hidden bot's runtime and never borrows a bot's. Here E2B
    // refuses to wake that hidden bot's desktop, so it gets the card.
    const { botRuntimeProvisioner } = await import('../lib/computer/auto-runtime')
    const provision = botRuntimeProvisioner.provision
    botRuntimeProvisioner.provision = async () => { throw new Error('E2B refused') }
    const coordinator = await dispatch(c.id, c.issueId).finally(() => { botRuntimeProvisioner.provision = provision }) as unknown as NoMachine
    assert.equal(coordinator.error, 'machineUnavailable')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [c.id])).rows[0].n, 0, 'no cloud run on the bot computer')
    const refused = await dispatch(c.id, c.issueId, botId) as unknown as NoMachine
    assert.equal(refused.error, 'machineUnavailable', 'no device: an error the person can act on')
    assert.deepEqual(actions(refused), ['connectServer', 'e2bKey'])
    const cloudRuns = (await pool.query(`SELECT r.status,m.state FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r."userId"=$1`, [c.id])).rows
    assert.deepEqual(cloudRuns, [{ status: 'stopped', state: 'ended' }], 'the refused cloud run was queued, then ended instead of left stuck')
    const frozen = (await pool.query(`SELECT r."agentDefinition"->>'harness' AS harness FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r."userId"=$1`, [c.id])).rows[0]
    assert.equal(frozen.harness, 'codex', 'every cloud run freezes its definition when it is created')
    // A server comes online: on by default, so it takes the run.
    const deviceId = await onlineMac(c.id, null, 'server')
    const result = await dispatch(c.id, c.issueId, botId) as unknown as { runId: string; status: string }
    assert.equal(result.status, 'queued')
    assert.equal((await runOf(result.runId)).deviceId, deviceId)
  })

  await t.test('a server goes offline mid-run: the run moves to the own E2B cloud, which ends it with the card when E2B refuses', async () => {
    const c = await person('offline')
    const { botId, cloudDevice } = await cloudReady(c)
    const server = await onlineMac(c.id, null, 'server')
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
    assert.deepEqual(actions(off), ['connectServer', 'e2bKey'])
    // A rule that names the Mac still runs there: a device the person picks is used as asked.
    await pool.query('UPDATE execution_rules SET place=$2 WHERE "ownerId"=$1', [e.id, mac])
    const asked = await dispatch(e.id, e.issueId) as unknown as { runId: string }
    assert.equal((await runOf(asked.runId)).deviceId, mac)
  })
})
