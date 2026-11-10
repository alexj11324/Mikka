// A person's own E2B key is enough for cloud runs: with 运行位置 云端 (decision 2026-11-02-1400), a bot with
// no cloud runtime gets one when a run is dispatched, once. No key: never the cloud. MIKKA_CLOUD_COMPUTER_TASKS=0 turns it off. Real PostgreSQL;
// only the E2B calls (waking the computer, starting its worker, creating each thread's own
// machine) and the start of the thread machine's lifecycle workflow are replaced;
// Coordinator wakes are observed without running a separate inbox consumer.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import type { Pool as PgPool } from 'pg'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedPersonalWorkspace } from './support/workspace-admin-db'
import { connectGitHub, githubAppStub, recordPushGrant } from './support/github-app-stub'
import { fakeThreadMachines } from './support/thread-machine-fake'
import { isolateCoordinatorWakes } from './support/coordinator-wake'

mock.module('next-intl/server',{namedExports:{getLocale:async()=> 'en',getTranslations:async()=> (key:string)=> key}})
mock.module('next/headers',{namedExports:{cookies:async()=>({get:()=>undefined}),headers:async()=>new Headers()}})
let httpOwner: string | null = null
mock.module(new URL('../lib/api-auth.ts',import.meta.url).href,{namedExports:{auth:{api:{getSession:async()=>httpOwner?{user:{id:httpOwner,email:`${httpOwner}@example.test`,name:"Fixture owner"}}:null}}}})

const harnesses = [{ harness: 'codex', installed: true, subscriptionBroker: true, computerBroker: true }]

test('cloud runs: the bot runtime is created on dispatch, once; the kill switch falls back to the card', { skip: !dbUrl }, async t => {
  delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
  process.env.MIKKA_BYOS_ENABLED = '1'
  const coordinator = await isolateCoordinatorWakes(t)
  // Every cloud thread runs on its own thread machine; its lifecycle workflow is not started here.
  let lifecycleStarts = 0
  const stageHandoffs: [{userId:string;workspaceId:string},string|null,string][] = []
  mock.module('workflow/api', { namedExports: { start: async (workflow: {name:string}, args: unknown[]) => { lifecycleStarts++; if (workflow.name === 'factoryCloudStageHandoff') stageHandoffs.push(args as typeof stageHandoffs[number]); return { runId: 'synthetic-workflow' } } } })
  // Only the external Decision transport is synthetic. Profile eligibility,
  // source authorization, transaction admission and frozen selections stay real.
  const profileForStage: Record<string, string> = {}
  const profileSelections: { stage: string; profileId: string }[] = []
  mock.module(new URL('../lib/coordinator/decide.ts', import.meta.url).href, { namedExports: {
    invokeDecision: async (purpose: string, raw: unknown) => {
      if (purpose !== 'factory-agent-profile') return null
      const input = typeof raw === 'string' ? JSON.parse(raw) : raw as { task: { stage: string }; candidates: { id: string }[] }
      const stage = input.task.stage, profileId = profileForStage[stage]
      assert.ok(profileId && input.candidates.some((candidate: { id: string }) => candidate.id === profileId), 'the current stage must select a real eligible fixture Profile')
      profileSelections.push({ stage, profileId })
      return { answers: new Map([['profile', { name: 'profile', type: 'choice', choice: `${profileId}:stage_fit`, confidence: .95 }]]),
        execution: { executionId: randomUUID(), modelId: 'synthetic-profile-decision', providerGenerationId: 'isolated-cloud-spec-test',
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' } }
    },
  } })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const threadMachines = await fakeThreadMachines(pool, [{ harness: 'codex', installed: true, subscriptionBroker: true, toolApproval: true }])
  // The person's live authorized repository list, as GitHub would answer their own token.
  const github = githubAppStub()
  let githubAccount = 9_500_000
  const steps = await import('../workflows/coordinator/steps')
  const { botRuntimeProvisioner } = await import('../lib/computer/auto-runtime')
  const { ensureBotRuntime } = await import('../lib/computer/bot-runtime')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { withFactoryBackgroundWorkspace } = await import('../lib/factory/background-workspace')
  const { withProjectResourceLease } = await import('../lib/project-resources/store')
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
    await coordinator.flush()
    github.restore()
    botRuntimeProvisioner.provision = realProvision
    threadMachines.restore()
    delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
    await pool.query('DELETE FROM model_order_entries WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM model_order_settings WHERE "ownerId" = ANY($1)', [users])
    await pool.query('DELETE FROM factory_tasks WHERE "userId" = ANY($1)', [users])
    await pool.query('DELETE FROM factory_agent_profiles WHERE "ownerId" = ANY($1)', [users])
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
  // Canonical identity freezes at INSERT. Chosen fixture numbers must be
  // present then; changing document metadata later cannot rename a Task.
  const numberedTask = async (userId: string, workspaceId: string, number: number) => {
    const issueId = randomUUID()
    await pool.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,"linearSyncPolicy","linearSyncBlocked",title,content,status,priority)
      VALUES($1,$2,$3,'bound','personal','disabled',true,'Task',$4,'todo','normal')`,
    [issueId, userId, workspaceId, JSON.stringify({ type: 'doc', attrs: { mikka: { number } }, content: [] })])
    return issueId
  }
  // A new workspace: the person's own E2B key and a connected Codex subscription whose account lists gpt-5,
  // 优先使用的模型 left as filled by default (that model) and 运行位置 云端; no cloud runtime.
  const person = async (label: string, e2bKey = true, taskNumber = 7) => {
    const id = await seedUser(pool, label)
    users.push(id)
    // Connected in 插件 › GitHub, with the App on octo/repo: dispatch checks the live list.
    await connectGitHub(github, id, String(++githubAccount), ['octo/repo'])
    // Push is what the GitHub App grants (lib/github/push-grant.ts); record that grant as a live check would.
    await recordPushGrant(pool, id, normalizeRepository('octo/repo').key)
    const ws = { id: await seedPersonalWorkspace(pool, id) }
    const issueId = await seedIssue(pool, id)
    await pool.query(`UPDATE issues SET content='{"type":"doc","attrs":{"mikka":{"number":7}}}' WHERE id=$1`, [issueId])
    const botId = await seedBot(pool, ws.id, id)
    const connection = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog") VALUES ($1,$2,$3,'codex','connected',1,$5,$4,'synthetic-subject',$6)`, [connection, id, ws.id, 'a'.repeat(64), `synthetic-${connection}`, JSON.stringify({ revision: '1', models: ['gpt-5'] })])
    await pool.query('UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1', [connection, JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5')`, [randomUUID(), id, ws.id, connection])
    await pool.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)`, [id, ws.id])
    if (e2bKey) await pool.query(`INSERT INTO workspace_e2b_keys ("workspaceId",ciphertext,iv,"keyVersion",last4,"createdBy","updatedBy") VALUES ($1,'x','x',1,'abcd',$2,$2)`, [ws.id, id])
    await order.changeOrder(pool, { ownerId: id, workspaceId: ws.id }, { kind: 'location', location: 'cloud' })
    return { id, workspaceId: ws.id, issueId, botId, connection }
  }
  const dispatch = (userId: string, issueId: string, botId: string) => steps.dispatchRun(userId, { issueId, repo: 'octo/repo', requestKey: `dispatch:${randomUUID()}` }, undefined, botId)
  const count = async (sql: string, values: unknown[]) => (await pool.query(sql, values)).rows[0].n as number
  // The fixture has no native process. Record the daemon's terminal exit
  // receipt explicitly; a status-only host transition must not authorize VM reuse.
  const recordNativeExit = async (runId: string) => {
    const result = await pool.query(`UPDATE agent_runs SET report=COALESCE(report,'{}'::jsonb)||$2::jsonb
      WHERE id=$1 AND status IN ('succeeded','failed','stopped','cancelled')`, [runId,
      JSON.stringify({ safePoint: { session: 'exited', checkpoint: 'unavailable', observedAt: new Date().toISOString() } })])
    assert.equal(result.rowCount, 1)
  }
  const machinePlacement = async (runId: string) => (await pool.query(`SELECT repo."remoteUrl",m."sandboxId",m."deviceId"
    FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId"
    JOIN thread_machines m ON m."runId"=r.id WHERE r.id=$1`, [runId])).rows[0]
  // Another numbered task of the same person: a task has one thread (lib/thread-dispatch.ts), so reuse is shown on a second task.
  const anotherTask = async (userId: string, number: number) => {
    return numberedTask(userId, await seedPersonalWorkspace(pool, userId), number)
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

  for (const [index, mode] of ['writable', 'readOnly', 'mcp'].entries()) await t.test(`the ${mode} cloud thread composer starts its next task machine and lifecycle on the same repository and model`, async () => {
    const a = await person(`cloud-composer-${mode}`)
    const issueId = await anotherTask(a.id, 34 + index)
    const first = await steps.dispatchRun(a.id, { issueId, repo: 'octo/repo', ...(mode === 'readOnly' ? { readOnly: true } : {}), requestKey: `dispatch:${randomUUID()}` }, undefined, a.botId) as unknown as { runId: string }
    if (mode === 'mcp') {
      await pool.query('UPDATE agent_runs SET "botId"=NULL,source=\'mcp\' WHERE id=$1', [first.runId])
      await pool.query('UPDATE coordinator_events SET "botId"=NULL WHERE id IN (SELECT t."sourceEventId" FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1)', [first.runId])
      await pool.query('UPDATE factory_tasks SET "botId"=NULL WHERE id IN (SELECT "taskId" FROM factory_attempts WHERE "runId"=$1)', [first.runId])
    }
    const original = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [first.runId])).rows[0]
    const originalPublication = (await pool.query('SELECT "issueId","userId",identifier,branch FROM run_publications WHERE "runId"=$1', [first.runId])).rows[0]
    if (mode === 'mcp') {
      assert.equal(original.botId, null)
      assert.equal(original.agentDefinition.repositoryAdmission.workspaceId, a.workspaceId, 'an MCP result destination does not remove the Task Workspace')
      assert.ok(originalPublication?.branch, 'the MCP continuation starts with actual publication authority')
    }
    const runtime = (await pool.query('SELECT * FROM bot_cloud_runtimes WHERE "botId"=$1', [a.botId])).rows[0]
    assert.notEqual(original.deviceRepoId, runtime.repoId, 'a task runs on its own machine, not the Bot computer')
    await pool.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now() WHERE id=$1`, [first.runId])
    await recordNativeExit(first.runId)
    const originalMachine = (await pool.query('SELECT "sandboxId","deviceId" FROM thread_machines WHERE "runId"=$1', [first.runId])).rows[0]
    const originalTokens = (await pool.query('SELECT id FROM device_tokens WHERE "boundDeviceId"=$1 AND "revokedAt" IS NULL', [originalMachine.deviceId])).rows.map(row => row.id)
    const before = lifecycleStarts
    const { sendThreadMessage } = await import('../lib/thread-continue')
    const next = await sendThreadMessage(a.id, first.runId, 'Continue with the missing edge case.')
    assert.equal(next.continued, true)
    const run = (await pool.query(`SELECT r.*,repo."remoteUrl",m.state AS machine FROM agent_runs r
      JOIN device_repos repo ON repo.id=r."deviceRepoId" JOIN thread_machines m ON m."runId"=r.id WHERE r.id=$1`, [next.runId])).rows[0]
    assert.deepEqual([run.status, run.continuesRunId, run.botId, run.remoteUrl, run.machine], ['queued', first.runId, mode === 'mcp' ? null : a.botId, 'https://github.com/octo/repo.git', 'running'])
    assert.deepEqual(run.agentDefinition.subscription, original.agentDefinition.subscription)
    assert.equal(run.agentDefinition.model, original.agentDefinition.model)
    assert.equal(run.agentDefinition.readOnly, original.agentDefinition.readOnly)
    if (mode === 'mcp') {
      assert.equal(run.agentDefinition.repositoryAdmission?.authority, 'owner_credential')
      assert.equal(run.agentDefinition.repositoryAdmission?.workspaceId, run.workspaceId, 'the new unbound Run retains its canonical Workspace receipt')
      assert.deepEqual((await pool.query('SELECT "issueId","userId",identifier,branch FROM run_publications WHERE "runId"=$1', [next.runId])).rows[0], originalPublication,
        'a new worker preserves the published Task identifier and branch')
      assert.deepEqual((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [first.runId])).rows[0].agentDefinition, original.agentDefinition,
        'host handoff does not rewrite the original frozen definition')
    }
    assert.match(run.prompt, /Continue with the missing edge case/)
    assert.equal(lifecycleStarts, before + 1)
    assert.deepEqual((await pool.query('SELECT "sandboxId","deviceId" FROM thread_machines WHERE "runId"=$1', [next.runId])).rows[0], originalMachine,
      'an immediate owner continuation reuses the still-running task VM before its idle timer')
    assert.equal(await count('SELECT count(*)::int AS n FROM device_tokens WHERE id=ANY($1::uuid[]) AND "revokedAt" IS NULL', [originalTokens]), 0,
      'the previous worker credential cannot operate after handoff')
  })

  await t.test('the public computer API continues a repository thread on its original repository and starts its task machine', async () => {
    const a = await person('public-composer');
    const issueId = await anotherTask(a.id,39);
    const first = await steps.dispatchRun(a.id,{issueId,repo:'octo/repo',readOnly:true,requestKey:`dispatch:${randomUUID()}`},undefined,a.botId) as unknown as {runId:string};
    await pool.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now() WHERE id=$1`,[first.runId]);
    await recordNativeExit(first.runId);
    const {POST} = await import('../app/api/bots/[botId]/computer/runs/route');
    httpOwner = a.id;
    try {
      const response = await POST(new Request(`https://mikka.example/mikka/api/bots/${a.botId}/computer/runs`,{method:'POST',headers:{origin:'https://mikka.example','content-type':'application/json'},body:JSON.stringify({issueId,harness:'codex',note:'Check the next edge case.'})}),{params:Promise.resolve({botId:a.botId})});
      const result = await response.json();assert.equal(response.status,202,JSON.stringify(result));
      const {rows:[run]} = await pool.query(`SELECT r."continuesRunId",r."agentDefinition",repo."remoteUrl",m.state FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" JOIN thread_machines m ON m."runId"=r.id WHERE r.id=$1`,[result.runId]);
      assert.equal(run.continuesRunId,first.runId);assert.equal(run.remoteUrl,'https://github.com/octo/repo.git');assert.equal(run.agentDefinition.readOnly,true);assert.equal(run.state,'running');
    } finally { httpOwner=null; }
  });

  await t.test('ordinary tasks use existing metadata without waking a sleeping or disconnected parent', async () => {
    const a = await person('sleeping-runtime')
    await dispatch(a.id, a.issueId, a.botId)
    const { ensureBotCloudRuntime } = await import('../lib/computer/auto-runtime')
    const parent = (await pool.query('SELECT "deviceId" FROM cloud_machines WHERE "ownerId"=$1 AND "workspaceId"=$2', [a.id, a.workspaceId])).rows[0]
    const wake = { provision: async () => assert.fail('an existing parent must not be woken') }
    const beforeProvisioned = provisioned
    for (const [index, state] of ['sleeping', 'running'].entries()) {
      await pool.query('UPDATE cloud_machines SET state=$2 WHERE "ownerId"=$1', [a.id, state])
      await pool.query(`UPDATE devices SET "lastSeenAt"=now()-interval '2 minutes' WHERE id=$1`, [parent.deviceId])
      const parentState = async () => (await pool.query(`SELECT row_to_json(m) AS machine,row_to_json(d) AS device FROM cloud_machines m JOIN devices d ON d.id=m."deviceId" WHERE m."ownerId"=$1 AND m."workspaceId"=$2`, [a.id, a.workspaceId])).rows[0]
      const before = await parentState()
      assert.ok(await ensureBotCloudRuntime(pool, { userId: a.id, workspaceId: a.workspaceId }, a.botId, { harness: 'codex' }, wake))
      const result = await dispatch(a.id, await anotherTask(a.id, 80 + index), a.botId) as unknown as { status: string }
      assert.equal(result.status, 'queued')
      assert.deepEqual(await parentState(), before, 'ordinary dispatch leaves the parent machine and device unchanged')
      assert.equal(provisioned, beforeProvisioned)
    }
    await pool.query(`UPDATE cloud_machines SET state='sleeping' WHERE "ownerId"=$1`, [a.id])
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [parent.deviceId])
    assert.equal(await ensureBotCloudRuntime(pool, { userId: a.id, workspaceId: a.workspaceId }, a.botId, { harness: 'codex' }, wake), null, 'invalid metadata refuses without waking the parent')
  })

  await t.test('concurrent dispatches of one task create only one thread', async () => {
    const a = await person('concurrent-runtime')
    const results = await Promise.all([dispatch(a.id, a.issueId, a.botId), dispatch(a.id, a.issueId, a.botId)]) as unknown as { runId: string; thread: string }[]
    assert.deepEqual(results.map(result => result.thread).sort(), ['message', 'new'])
    assert.equal(results[0].runId, results[1].runId)
    assert.equal(await count('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [a.issueId]), 1)
  })

  await t.test('a cloud run gets its task branch like a local run, with no grant; a read-only run gets none', async () => {
    const g = await person('cloud-grant')
    // No push grant is recorded or read (decision 2026-11-02-1600).
    await pool.query('DELETE FROM github_repository_installations WHERE "userId"=$1', [g.id])
    const queued = await dispatch(g.id, g.issueId, g.botId) as unknown as { runId: string; status: string }
    assert.equal(queued.status, 'queued', JSON.stringify(queued))
    const admitted = (await pool.query(`SELECT r."agentDefinition",p.branch FROM agent_runs r JOIN devices d ON d.id=r."deviceId" AND d.kind='cloud'
      LEFT JOIN run_publications p ON p."runId"=r.id WHERE r.id=$1`, [queued.runId])).rows[0]
    assert.equal(admitted.agentDefinition.repositoryAdmission.authority, 'owner_credential')
    assert.equal(admitted.agentDefinition.repositoryAdmission.targetBranch, admitted.branch)
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"finishedAt"=now() WHERE id=$1', [queued.runId])

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
    assert.equal((await definitionOf(writable.runId)).agentDefinition.repositoryAdmission?.authority, 'owner_credential', 'the thread starts writable')
    await pool.query('UPDATE agent_runs SET status=\'failed\',"finishedAt"=now() WHERE id=$1', [writable.runId])
    await recordNativeExit(writable.runId)
    const look = await steps.dispatchRun(r.id, { issueId: work, repo: 'octo/repo', readOnly: true, requestKey: `dispatch:${randomUUID()}` }, undefined, r.botId) as unknown as Continued
    assert.deepEqual([look.thread, look.threadId], ['continued', writable.runId])
    const looked = await definitionOf(look.runId)
    assert.deepEqual([looked.kind, looked.agentDefinition.readOnly, looked.agentDefinition.repositoryAdmission, looked.publications], ['cloud', true, undefined, 0])
    await pool.query('UPDATE agent_runs SET status=\'failed\',"finishedAt"=now() WHERE id=$1', [look.runId])
    await recordNativeExit(look.runId)
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
    await recordNativeExit(first.runId)
    const next = await steps.dispatchComputerThread(r.id, { botId: r.botId, issueId: task, harness: 'codex', note: 'Look further.' }, `call-${randomUUID()}`, undefined, undefined, r.botId) as unknown as Continued
    assert.deepEqual([next.thread, next.threadId], ['continued', first.runId])
    assert.deepEqual([(await definitionOf(next.runId)).agentDefinition.readOnly, (await definitionOf(next.runId)).agentDefinition.repositoryAdmission], [true, undefined])
  })

  await t.test('a cloud thread that stopped to ask continues on its own model and subscription; with none it says so and queues nothing', async () => {
    // Production (Acme): the first run ran on its subscription's model, the continuations were frozen with model null
    // and the hosted runner refused each one (subscription_hosted_runtime_unavailable).
    const m = await person('cloud-thread-model')
    type Result = { runId?: string; thread?: string; threadId?: string; error?: string; threadRunId?: string }
    const frozen = async (runId: string) => (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [runId])).rows[0].agentDefinition
    const work = await anotherTask(m.id, 41)
    const first = await dispatch(m.id, work, m.botId) as unknown as Result
    const firstDefinition = await frozen(first.runId!)
    assert.equal(firstDefinition.model, 'gpt-5')
    // The thread stops to ask the person; the Coordinator continues it.
    await pool.query('UPDATE agent_runs SET status=\'stopped\',"finishedAt"=now() WHERE id=$1', [first.runId])
    await recordNativeExit(first.runId!)
    const next = await steps.dispatchRun(m.id, { issueId: work, note: 'The person answered: use the mobile layout.', requestKey: `dispatch:${randomUUID()}` }, undefined, m.botId) as unknown as Result
    assert.deepEqual([next.thread, next.threadId], ['continued', first.runId], JSON.stringify(next))
    const nextDefinition = await frozen(next.runId!)
    assert.equal(nextDefinition.model, 'gpt-5', 'the continuation keeps the thread\'s model')
    assert.equal(nextDefinition.cliModelSelection, 'explicit')
    assert.equal(nextDefinition.subscription.bindingId, firstDefinition.subscription.bindingId, 'and its subscription')
    assert.equal(nextDefinition.subscription.modelId, nextDefinition.model, 'the hosted runner starts it: its model is the subscription context\'s')

    // A thread whose runs were all frozen without a model (before the fix): told, not filled in, nothing queued.
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"finishedAt"=now(),"agentDefinition"="agentDefinition"-\'model\' WHERE "issueId"=$1 AND "userId"=$2', [work, m.id])
    await recordNativeExit(next.runId!)
    const runs = async () => Number((await pool.query('SELECT count(*) FROM agent_runs WHERE "userId"=$1', [m.id])).rows[0].count)
    const before = await runs()
    const refused = await steps.dispatchRun(m.id, { issueId: work, note: 'Continue.', requestKey: `dispatch:${randomUUID()}` }, undefined, m.botId) as unknown as Result
    assert.equal(refused.error, 'threadModelUnavailable', JSON.stringify(refused))
    assert.equal(refused.threadRunId, next.runId)
    assert.equal(await runs(), before, 'no run is queued with another model')
    // The person names the model again: the thread continues on it.
    const named = await steps.dispatchRun(m.id, { issueId: work, note: 'Continue.', model: { harness: 'codex', model: 'gpt-5' }, requestKey: `dispatch:${randomUUID()}` }, undefined, m.botId) as unknown as Result
    assert.equal(named.thread, 'continued', JSON.stringify(named))
    assert.equal((await frozen(named.runId!)).model, 'gpt-5')
  })
  for (const entryPoint of ['coordinator', 'desktop'] as const) await t.test(`a default thread may explicitly select another authorized model through ${entryPoint} without claiming the old native Profile origin`, async () => {
    const who = await person(`default-explicit-model-${entryPoint}`, true, entryPoint === 'coordinator' ? 801 : 802)
    const { templateModelsFixture } = await import('./support/template-models')
    const models = templateModelsFixture(['gpt-5', 'gpt-5-next'])
    try {
      await pool.query('UPDATE byos_connections SET "modelCatalog"=$2::jsonb WHERE id=$1', [who.connection, JSON.stringify({ revision: '2', models: ['gpt-5', 'gpt-5-next'] })])
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5-next')`, [randomUUID(), who.id, who.workspaceId, who.connection])
      await order.changeOrder(pool, { ownerId: who.id, workspaceId: who.workspaceId }, { kind: 'add', entries: [{ harness: 'codex', model: 'gpt-5-next', source: { kind: 'subscription', connectionId: who.connection } }] })
      const first = await dispatch(who.id, who.issueId, who.botId) as { runId: string }
      const original = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [first.runId])).rows[0]
      const originalMachine = await machinePlacement(first.runId)
      assert.equal(originalMachine.remoteUrl, 'https://github.com/octo/repo.git')
      assert.equal(original.agentDefinition.agentProfile.source, 'default')
      assert.equal(original.agentDefinition.model, 'gpt-5')
      await pool.query(`UPDATE agent_runs SET status='succeeded',"startedAt"=now(),"finishedAt"=now(),"sessionId"='native-default-original' WHERE id=$1`, [first.runId])
      await recordNativeExit(first.runId)
      const next = await (entryPoint === 'coordinator'
        ? steps.dispatchRun(who.id, { issueId: who.issueId, model: { harness: 'codex', model: 'gpt-5-next' }, note: 'Continue with the explicitly chosen model.', requestKey: `default-model:${randomUUID()}` }, undefined, who.botId)
        : steps.dispatchComputerThread(who.id, { botId: who.botId, issueId: who.issueId, harness: 'codex', model: 'gpt-5-next', note: 'Continue with the explicitly chosen model.' }, `default-model:${randomUUID()}`, undefined, undefined, who.botId)) as unknown as { runId?: string; thread?: string; error?: string }
      assert.ok(next.runId, JSON.stringify(next)); assert.equal(next.thread, 'continued')
      assert.deepEqual(await machinePlacement(next.runId), originalMachine, 'changing the selected model keeps this task\'s repository and VM')
      const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [next.runId])).rows[0]
      assert.equal(run.agentDefinition.model, 'gpt-5-next')
      assert.equal(run.agentDefinition.agentProfile.source, 'default')
      assert.equal(run.agentDefinition.agentProfile.targetEntry.model, 'gpt-5-next')
      assert.deepEqual(run.agentDefinition.agentProfile.targetEntry, run.agentDefinition.modelDispatch.entry)
      assert.equal(run.agentDefinition.profileOriginRunId, undefined, 'a new model does not obtain the old native session exemption')
      assert.equal(run.sessionId, null)
      await (await import('../lib/factory/profile-admission')).assertRunProfileClaim(pool, run.id)
    } finally { models.restore() }
  })

  for (const [index, entryPoint, askedModel] of [[0, 'coordinator', 'gpt-5'], [1, 'desktop', 'gpt-5'], [2, 'desktop', 'gpt-5-next']] as const) await t.test(`a historical thread ${entryPoint} selection of ${askedModel} preserves native compatibility only for the exact old target`, async () => {
    const who = await person(`legacy-model-${entryPoint}-${index}`, true, 901 + index)
    const { templateModelsFixture } = await import('./support/template-models')
    const models = templateModelsFixture(['gpt-5', 'gpt-5-next'])
    try {
      await pool.query('UPDATE byos_connections SET "modelCatalog"=$2::jsonb WHERE id=$1', [who.connection, JSON.stringify({ revision: '2', models: ['gpt-5', 'gpt-5-next'] })])
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,'codex_cpa','gpt-5-next')`, [randomUUID(), who.id, who.workspaceId, who.connection])
      await order.changeOrder(pool, { ownerId: who.id, workspaceId: who.workspaceId }, { kind: 'add', entries: [{ harness: 'codex', model: 'gpt-5-next', source: { kind: 'subscription', connectionId: who.connection } }] })
      const first = await dispatch(who.id, who.issueId, who.botId) as { runId: string }
      const originalMachine = await machinePlacement(first.runId)
      assert.equal(originalMachine.remoteUrl, 'https://github.com/octo/repo.git')
      const legacy = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [first.runId])).rows[0].agentDefinition
      delete legacy.agentProfile; delete legacy.profileOriginRunId
      legacy.definitionDigest = (await import('../lib/agent-kit/worker-digest')).workerDefinitionDigest(legacy)
      await pool.query(`UPDATE agent_runs SET status='succeeded',"startedAt"=now(),"finishedAt"=now(),"sessionId"='pre-profile-native-session',"agentDefinition"=$2 WHERE id=$1`, [first.runId, JSON.stringify(legacy)])
      await recordNativeExit(first.runId)
      const next = await (entryPoint === 'coordinator'
        ? steps.dispatchRun(who.id, { issueId: who.issueId, model: { harness: 'codex', model: askedModel }, note: 'Continue with the named model.', requestKey: `legacy:${randomUUID()}` }, undefined, who.botId)
        : steps.dispatchComputerThread(who.id, { botId: who.botId, issueId: who.issueId, harness: 'codex', model: askedModel, note: 'Continue with the named model.' }, `legacy:${randomUUID()}`, undefined, undefined, who.botId)) as unknown as { runId?: string; error?: string }
      assert.ok(next.runId, JSON.stringify(next))
      assert.deepEqual(await machinePlacement(next.runId), originalMachine, 'either continuation entry preserves the historical thread\'s repository and VM')
      const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [next.runId])).rows[0]
      assert.equal(run.agentDefinition.model, askedModel)
      const same = askedModel === legacy.model
      assert.equal((await import('../lib/factory/profile-native-session')).profileNativeSessionMatches(legacy, run.agentDefinition), same)
      if (same) {
        assert.equal(run.agentDefinition.agentProfile, undefined, 'exact historical continuation retains absent metadata')
        assert.equal(run.agentDefinition.subscription.bindingId, legacy.subscription.bindingId)
      } else assert.equal(run.agentDefinition.agentProfile?.source, 'default', 'a new target gets its own current default receipt')
      assert.equal(run.agentDefinition.profileOriginRunId, undefined)
    } finally { models.restore() }
  })

  await t.test('no E2B key of their own: no cloud runtime; with no computer the card offers one or a key, and 云端 then runs on the person\'s own server', async () => {
    const n = await person('no-key', false)
    const before = provisioned
    const result = await dispatch(n.id, n.issueId, n.botId) as unknown as { error: string; reason: string; card: { title: string; options: { action: string }[] } }
    assert.equal(result.error, 'machineUnavailable')
    assert.deepEqual([result.reason, result.card.title, result.card.options.map(option => option.action)], ['noDevice', '没有能跑这个任务的模型', ['connectServer', 'e2bKey', 'modelSettings']])
    assert.equal(provisioned, before, 'no cloud computer is woken without a key')
    assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [n.botId]), 0)
    // 运行位置 云端 (the default) with no key, and their own server online (参与调度 on), its Codex reporting gpt-5: it takes the run.
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
      assert.deepEqual([result.reason, result.card.title], ['cloudTemporarilyUnavailable', '没有能跑这个任务的模型'])
      assert.equal(provisioned, before)
      assert.equal(await count('SELECT count(*)::int AS n FROM bot_cloud_runtimes WHERE "botId"=$1', [b.botId]), 0)
      assert.equal(await count('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [b.id]), 0)
    } finally { delete process.env.MIKKA_CLOUD_COMPUTER_TASKS }
  })

  await t.test('a cloud startup refusal with an existing E2B key does not say the key is missing', async () => {
    const a = await person('cloud-start-refused')
    const provision = botRuntimeProvisioner.provision
    botRuntimeProvisioner.provision = async () => { throw new Error('synthetic capacity refusal') }
    try {
      const result = await dispatch(a.id, a.issueId, a.botId) as unknown as { error: string; reason: string; card: { description: string; options: { action: string }[] } }
      assert.equal(result.reason, 'cloudTemporarilyUnavailable')
      assert.equal(result.card.description, '云端暂时无法启动')
      assert.deepEqual(result.card.options.map(option => option.action), ['modelSettings'], 'do not ask to fill a key that is already present')
      assert.equal(await count('SELECT count(*)::int AS n FROM agent_runs WHERE "userId"=$1', [a.id]), 0, 'a failed startup leaves no queued run')
    } finally { botRuntimeProvisioner.provision = provision }
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
  for (const parentState of ['running', 'sleeping']) await t.test(`ordinary queues and Factory checks share owned metadata admission with a ${parentState} parent`, async () => {
    const personState = await person('factory-stage-admission')
    await dispatch(personState.id, personState.issueId, personState.botId)
    const issueId = await seedIssue(pool, personState.id)
    const producer = await steps.dispatchComputerThread(personState.id, { botId: personState.botId, issueId, harness: 'codex' }, `admission:${randomUUID()}`) as { runId: string }
    const [{ factoryRuntimeForBot }, { factoryBinding }, { queueCloudRun }, { configureFactoryCheck }] = await Promise.all([
      import('../lib/factory/runtime'), import('../lib/factory/dispatch'), import('../lib/computer/queue-run'), import('../lib/factory/checks'),
    ])
    const runtime = factoryRuntimeForBot(personState.botId)
    const source = (await pool.query(`SELECT r.*,repo."repoPath" FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r.id=$1`, [producer.runId])).rows[0]
    const parent = (await pool.query('SELECT * FROM bot_cloud_runtimes WHERE "botId"=$1 AND harness=\'codex\'', [personState.botId])).rows[0]
    const task = (await pool.query('SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE a."runId"=$1', [producer.runId])).rows[0]
    const actor = { userId: personState.id, workspaceId: personState.workspaceId }
    const beforeProviderCalls = provisioned, beforeHandoffs = stageHandoffs.length
    await withProjectResourceLease(personState.id, personState.workspaceId, async () => {
      const client = await appPool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='producer-session',report=$2,"finishedAt"=clock_timestamp() WHERE id=$1`, [producer.runId, JSON.stringify({ sourceCommit:'a'.repeat(40), deliverableCommit:'b'.repeat(40), verify:{status:'not_run'} })])
        const candidate = await runtime.store.apply(personState.id, factoryBinding(task), randomUUID(), { action:'candidate',runId:producer.runId,
          candidate:{kind:'deliverable',sha:null,repository:source.repoPath,environment:`device:${source.deviceId}`,scope:`issue:${issueId}`} }, client)
        const finished = await runtime.store.apply(personState.id, factoryBinding(candidate.task), randomUUID(), { action:'finish',status:'passed',reason:'Synthetic completed delivery',output:{runId:producer.runId},
          evidence:[{artifact:`run-report:${producer.runId}`,kind:'report',runId:producer.runId,sessionId:'producer-session',candidateId:candidate.task.candidateId,sha:null,environment:`device:${source.deviceId}`,recordedAt:new Date().toISOString()}] }, client)
        const pending = await runtime.store.apply(personState.id, factoryBinding(finished.task), randomUUID(), {action:'advance',stage:'review',reason:'Independent inspection'}, client)
        const input = { botId:personState.botId,issueId,agentId:parent.agentId,deviceRepoId:parent.repoId,title:'Inspect delivery',body:'Read the existing result.',
          model:source.agentDefinition.model,subscriptionBindingId:source.agentDefinition.subscription.bindingId,readOnly:true,idempotencyKey:`factory:${pending.task.attemptId}` }
        await client.query(`UPDATE cloud_machines SET state=$3 WHERE "workspaceId"=$1 AND "ownerId"=$2`, [actor.workspaceId, actor.userId, parentState])
        const otherBot = randomUUID(), otherDevice = randomUUID(), unmappedRepo = randomUUID()
        await client.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") SELECT $1,"deviceId",$2,$3 FROM agents WHERE id=$4`, [unmappedRepo,actor.userId,`/fixture/unmapped/${unmappedRepo}`,parent.agentId])
        await client.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled) VALUES ($1,$2,'Other device','cloud',true)`, [otherDevice,actor.userId])
        await client.query('INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,$4)', [otherBot,actor.workspaceId,actor.userId,'Another Bot'])
        await client.query('INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,2)', [otherBot,actor.workspaceId,actor.userId])
        const before = (await client.query(`SELECT (SELECT count(*) FROM agent_runs WHERE "userId"=$1)::int AS runs,(SELECT count(*) FROM thread_machines WHERE "ownerId"=$1)::int AS machines`, [actor.userId])).rows[0]
        await assert.rejects(queueCloudRun(appPool, {...actor,userId:'foreign-owner'}, input, client), {status:409})
        await assert.rejects(queueCloudRun(appPool, {...actor,workspaceId:randomUUID()}, input, client), {status:409})
        await assert.rejects(queueCloudRun(appPool, actor, {...input,botId:otherBot}, client), {status:409}, 'a different Bot cannot borrow this runtime')
        for (const [label, sql, values] of [
          ['missing Bot runtime', 'DELETE FROM bot_cloud_runtimes WHERE "botId"=$1', [personState.botId]],
          ['unmapped private repository', 'UPDATE bot_cloud_runtimes SET "repoId"=$2 WHERE "botId"=$1', [personState.botId,unmappedRepo]],
          ['disabled device', 'UPDATE devices SET enabled=false WHERE id=(SELECT "deviceId" FROM agents WHERE id=$1)', [parent.agentId]],
          ['different repository device', 'UPDATE device_repos SET "deviceId"=$2 WHERE id=$1', [parent.repoId, otherDevice]],
          ['archived Bot', 'UPDATE bots SET "archivedAt"=now() WHERE id=$1', [personState.botId]],
          ['computer policy', `INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'deny',1) ON CONFLICT ("workspaceId") DO UPDATE SET permission='deny'`, [actor.workspaceId]],
        ] as const) {
          await client.query('SAVEPOINT unavailable_target')
          await client.query(sql, [...values])
          await assert.rejects(queueCloudRun(appPool, actor, input, client), {status:409}, label)
          await client.query('ROLLBACK TO SAVEPOINT unavailable_target')
        }
        assert.deepEqual((await client.query(`SELECT (SELECT count(*) FROM agent_runs WHERE "userId"=$1)::int AS runs,(SELECT count(*) FROM thread_machines WHERE "ownerId"=$1)::int AS machines`, [actor.userId])).rows[0], before)
        const parentBefore = (await client.query('SELECT row_to_json(m) AS value FROM cloud_machines m WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId,actor.userId])).rows[0].value
        const ordinary = await queueCloudRun(appPool, actor, {...input,idempotencyKey:`ordinary:${randomUUID()}`}, client)
        assert.equal((await client.query('SELECT status FROM agent_runs WHERE id=$1',[ordinary.runId])).rows[0].status,'queued')
        const queued = await queueCloudRun(appPool, actor, input, client)
        await client.query('SAVEPOINT mismatched_check')
        await client.query('UPDATE computer_run_bindings SET "botId"=$2 WHERE "runId"=$1', [queued.runId,otherBot])
        await assert.rejects(configureFactoryCheck(client, pending.task, queued.runId), /factoryCheckHarnessUnavailable/, 'Factory checks cannot borrow another Bot runtime')
        await client.query('ROLLBACK TO SAVEPOINT mismatched_check')
        await configureFactoryCheck(client, pending.task, queued.runId)
        const check = (await client.query('SELECT kind,"agentDefinition","sessionId" FROM agent_runs WHERE id=$1',[queued.runId])).rows[0]
        assert.equal(check.kind,'acceptance')
        assert.equal(check.sessionId,null,'the checker receives an independent native session')
        assert.deepEqual(check.agentDefinition.subscription,source.agentDefinition.subscription)
        assert.equal(check.agentDefinition.apiKey,undefined)
        assert.equal(check.agentDefinition.model,source.agentDefinition.model)
        assert.equal(check.agentDefinition.executionIdentity.requester,actor.userId)
        assert.deepEqual((await client.query('SELECT row_to_json(m) AS value FROM cloud_machines m WHERE "workspaceId"=$1 AND "ownerId"=$2',[actor.workspaceId,actor.userId])).rows[0].value,parentBefore)
        assert.equal(provisioned,beforeProviderCalls,'metadata staging cannot wake or replace the parent')
        assert.equal(stageHandoffs.length,beforeHandoffs,'only the existing after-commit callback may start the separate thread')
      } finally { try { await client.query('ROLLBACK') } finally { client.release() } }
    })
  })

  for (const parentState of ['running', 'sleeping'] as const) await t.test(`a no-repository desktop deliverable gets independent checks and human acceptance with its parent ${parentState}`, async () => {
    const personState = await person(`factory-desktop-${parentState}`)
    await dispatch(personState.id, personState.issueId, personState.botId)
    const issueId = await seedIssue(pool, personState.id)
    await pool.query('UPDATE cloud_machines SET state=$3 WHERE "workspaceId"=$1 AND "ownerId"=$2', [personState.workspaceId,personState.id,parentState])
    const executeParentBefore = (await pool.query('SELECT row_to_json(m) AS value FROM cloud_machines m WHERE "workspaceId"=$1 AND "ownerId"=$2', [personState.workspaceId,personState.id])).rows[0].value
    const beforeExecuteProvisioned = provisioned
    const result = await steps.dispatchComputerThread(personState.id, { botId: personState.botId, issueId, harness: 'codex' }, `desktop:${randomUUID()}`) as { runId?: string; error?: string }
    assert.ok(result.runId, JSON.stringify(result))
    assert.deepEqual((await pool.query('SELECT row_to_json(m) AS value FROM cloud_machines m WHERE "workspaceId"=$1 AND "ownerId"=$2', [personState.workspaceId,personState.id])).rows[0].value,executeParentBefore,'execute leaves the parent unchanged')
    assert.equal(provisioned,beforeExecuteProvisioned)
    const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
    const { factoryCheckAssignment } = await import('../lib/factory/checks')
    const { factoryBinding } = await import('../lib/factory/dispatch')
    const runtime = factoryRuntimeForBot(personState.botId)
    const sha = 'b'.repeat(40)
    const { isCurrentFactoryDeliverable } = await import('../lib/factory/execution-kind')
    assert.equal(await isCurrentFactoryDeliverable(pool, personState.id, result.runId!),true)
    assert.equal(await isCurrentFactoryDeliverable(pool, 'another-owner', result.runId!),false)
    const complete = async (runId: string, check = false) => {
      const assignment = check ? await factoryCheckAssignment(pool as never, personState.id, runId) : null
      if (assignment) { assert.equal(assignment.factoryCheck.reportOnly, true); assert.equal(assignment.baseBranch, sha, 'the checker inspects the actual delivery snapshot, not the original source commit') }
      await pool.query(`UPDATE agent_runs SET status='running',"sessionId"=$2,"startedAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [runId, `desktop-${runId}`])
      const { persistRunCompletion } = await import('../lib/run-publications')
      await persistRunCompletion(personState.id, runId, { stopReason:'submitted', report: {
        sourceCommit: assignment ? assignment.baseBranch : 'a'.repeat(40), ...(!check ? { deliverableCommit: sha } : {}), summary: 'Inspected the desktop delivery and its evidence.', filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null,
        criteria: [{ text: 'Requested desktop result exists', passed: true, evidence: 'Inspected the persisted delivery report.' }],
        ...(assignment ? { check: { sha: assignment.baseBranch, readOnly: true } } : {}),
      } })
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[runId])).rows[0].status,'succeeded','the real server completion path agrees with the daemon for a no-build delivery')
      await runtime.reconcile.run(personState.id, runId)
    }
    const current = async () => (await pool.query(`SELECT t.*,a."runId",c.kind AS "candidateKind",c.sha FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" LEFT JOIN factory_candidates c ON c.id=t."candidateId" WHERE t."issueId"=$1 AND t."userId"=$2 ORDER BY t."createdAt" DESC LIMIT 1`, [issueId, personState.id])).rows[0]
    const { withDeviceDatabaseAuthority, withDeviceUnitFence } = await import('../lib/db/device-scope')
    const { factoryAutomaticRuntime } = await import('../lib/factory/automatic-dispatch')
    const { handoffFactoryCloudStage } = await import('../lib/factory/cloud-stage-handoff')
    const parentProviderCalls = provisioned
    const completeFromDevice = async (sourceRunId: string, check: boolean, unit: boolean, expectsHandoff = true) => {
      if (parentState === 'sleeping') await pool.query(`UPDATE cloud_machines SET state='sleeping' WHERE "workspaceId"=$1 AND "ownerId"=$2`, [personState.workspaceId, personState.id])
      const parentBefore = (await pool.query('SELECT row_to_json(m) AS value FROM cloud_machines m WHERE "workspaceId"=$1 AND "ownerId"=$2', [personState.workspaceId,personState.id])).rows[0].value
      const sourceToken = (await pool.query(`SELECT token.id FROM device_tokens token JOIN agent_runs r ON r."deviceId"=token."boundDeviceId" WHERE r.id=$1 AND token."revokedAt" IS NULL`, [sourceRunId])).rows[0]
      assert.ok(sourceToken)
      const realEnqueue = factoryAutomaticRuntime.enqueue, beforeHandoffs = stageHandoffs.length
      factoryAutomaticRuntime.enqueue = threadMachines.enqueueDurable
      try {
        const fence = unit ? withDeviceUnitFence : withDeviceDatabaseAuthority
        await fence({ tokenId:sourceToken.id, userId:personState.id }, () => complete(sourceRunId,check))
      } finally { factoryAutomaticRuntime.enqueue = realEnqueue }
      assert.equal((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1',[sourceToken.id])).rows[0].revokedAt,null,'the device request only queues host work; it does not revoke itself')
      if (!expectsHandoff) {
        assert.equal(stageHandoffs.length, beforeHandoffs, 'v2 review enters approval without enqueueing a Verify run')
        assert.deepEqual((await pool.query('SELECT row_to_json(m) AS value FROM cloud_machines m WHERE "workspaceId"=$1 AND "ownerId"=$2', [personState.workspaceId, personState.id])).rows[0].value, parentBefore)
        assert.equal(provisioned, parentProviderCalls, 'finishing review performs no provider I/O inside the device unit fence')
        return
      }
      assert.equal(stageHandoffs.length,beforeHandoffs+1,'production enqueue registers durable host work rather than calling provider I/O in the device request')
      const [actor,previous,runId] = stageHandoffs.at(-1)!
      assert.equal(await handoffFactoryCloudStage(appPool,{...actor,userId:'foreign-owner'},previous,runId),false)
      assert.equal(await handoffFactoryCloudStage(appPool,actor,randomUUID(),runId),false,'a mismatched completed source cannot authorize the handoff')
      assert.equal(await handoffFactoryCloudStage(appPool,actor,previous,runId),true,'the separate host step starts the independent checker after revoking the source worker')
      assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1',[sourceToken.id])).rows[0].revokedAt)
      assert.deepEqual((await pool.query('SELECT row_to_json(m) AS value FROM cloud_machines m WHERE "workspaceId"=$1 AND "ownerId"=$2',[personState.workspaceId,personState.id])).rows[0].value,parentBefore,'the separate stage preserves the original parent machine')
      assert.equal(provisioned,parentProviderCalls)
    }
    await completeFromDevice(result.runId!, false, false)
    const review = await current()
    const reviewDevice = (await pool.query('SELECT "deviceId" FROM agent_runs WHERE id=$1',[review.runId])).rows[0].deviceId
    assert.equal(reviewDevice,(await pool.query('SELECT "deviceId" FROM thread_machines WHERE "runId"=$1',[review.runId])).rows[0].deviceId)

    assert.equal(review.stage, 'review', JSON.stringify(review))
    assert.equal(review.status, 'running')
    assert.equal(review.candidateKind, 'deliverable')
    assert.equal(review.sha, null, 'no invented Git commit')
    await completeFromDevice(review.runId, true, true, false)
    const pending = await current()
    assert.deepEqual([pending.stage, pending.status], ['approval', 'pending'])
    const checks = (await pool.query(`SELECT stage,count(*)::int AS count FROM factory_attempts WHERE "taskId"=$1 AND stage IN ('review','verify') GROUP BY stage ORDER BY stage`, [pending.id])).rows
    assert.deepEqual(checks, [{ stage: 'review', count: 1 }], 'new v2 deliveries use one independent review and no automatic Verify')
    const sessionId = randomUUID()
    await pool.query(`INSERT INTO "session" (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`, [sessionId, randomUUID(), personState.id])
    const { createFactoryMerges } = await import('../lib/factory/merge')
    const noGitHub = async () => { throw new Error('A deliverable must not call GitHub') }
    const { createFactoryHumanStore } = await import('../lib/factory/human-store')
    const { handleFactory, handleFactoryList } = await import('../lib/factory/http')
    const humanStore = createFactoryHumanStore(pool, id => factoryRuntimeForBot(id).store)
    const discovered = await handleFactoryList(humanStore, { userId: personState.id, issueId })
    assert.equal(discovered.status, 200)
    assert.ok((discovered.body as {tasks:{id:string}[]}).tasks.some(task => task.id === pending.id))
    const request = { userId: personState.id, method:'GET', taskId:pending.id, origin:null, url:`http://localhost/api/factory/tasks/${pending.id}` }
    assert.equal((await handleFactory(humanStore, request)).status, 200)
    assert.equal((await handleFactory(humanStore, {...request,userId:'another-owner'})).status, 404)
    assert.equal((await handleFactory(factoryRuntimeForBot(null).store, request)).status, 404, 'runtime scope stays fixed; only human APIs resolve the persisted Bot')
    const merges = createFactoryMerges(pool, async () => true, humanStore, { pullRequest: noGitHub, mergeMethods: noGitHub, merge: noGitHub })
    const accepted = await withFactoryBackgroundWorkspace(pool, personState.id, { kind: 'task', id: pending.id }, () =>
      merges.accept({ userId: personState.id, sessionId }, { binding: factoryBinding(pending), eventId: randomUUID() }, null))
    assert.equal(accepted.status, 'accepted')
    assert.deepEqual([(await current()).stage, (await current()).status], ['approval', 'passed'])
  })

  // These regressions drive the ordinary cloud entry points. The real PG
  // lifecycle is exercised with explicit synthetic native completions; they
  // do not claim that a provider executed a plan or a browser signed in.
  type SpecPerson = Awaited<ReturnType<typeof person>>
  const ownerSpecRequest = async (who: SpecPerson, text = 'Plan this small repository change and wait for human approval.') => {
    const { db } = await import('../lib/db')
    const { recordPersonalSubmission } = await import('../lib/coordinator-submission')
    return (await recordPersonalSubmission(db, who.id, text, { botId: who.botId, submissionId: randomUUID() })).eventId
  }
  const specState = async (who: SpecPerson) => {
    const { rows: [task] } = await pool.query(`SELECT t.*,a."runId",a.status AS "attemptStatus" FROM factory_tasks t
      JOIN factory_attempts a ON a.id=t."attemptId" WHERE t."userId"=$1 AND t."issueId"=$2 AND t."botId"=$3 ORDER BY t."createdAt" DESC,t.id DESC LIMIT 1`, [who.id, who.issueId, who.botId])
    const { rows: [counts] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2) AS tasks,
      (SELECT count(*)::int FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE t."userId"=$1 AND t."issueId"=$2) AS attempts,
      (SELECT count(*)::int FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE t."userId"=$1 AND t."issueId"=$2 AND a.stage='execute') AS executions,
      (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1 AND "issueId"=$2) AS runs,
      (SELECT count(*)::int FROM run_publications WHERE "userId"=$1 AND "runId" IN (SELECT id FROM agent_runs WHERE "issueId"=$2)) AS publications,
      (SELECT count(*)::int FROM factory_spec_approvals s JOIN factory_tasks t ON t.id=s."taskId" WHERE t."userId"=$1 AND t."issueId"=$2) AS approvals`, [who.id, who.issueId])
    const run = task?.runId ? (await pool.query(`SELECT r.*,d.kind AS "deviceKind",repo."remoteUrl",m.state AS "machineState"
      FROM agent_runs r JOIN devices d ON d.id=r."deviceId" JOIN device_repos repo ON repo.id=r."deviceRepoId"
      LEFT JOIN thread_machines m ON m."runId"=r.id WHERE r.id=$1`, [task.runId])).rows[0] : null
    return { task, counts, run }
  }
  const completeSpec = async (who: SpecPerson, runId: string) => {
    const { persistRunCompletion } = await import('../lib/run-publications')
    const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
    await pool.query(`UPDATE agent_runs SET status='running',"sessionId"=$2,"startedAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [runId, `isolated-planner-${runId}`])
    await persistRunCompletion(who.id, runId, { stopReason: 'submitted', report: {
      summary: 'APPROVED_SPEC_CONTEXT_1276: use the two-section document plan. Synthetic native specification result in an isolated PG regression.', filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null,
    } })
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status, 'succeeded')
    await factoryRuntimeForBot(who.botId).reconcile.run(who.id, runId)
    const ready = await specState(who)
    assert.deepEqual([ready.task.stage, ready.task.status, ready.counts.executions, ready.counts.publications, ready.counts.approvals], ['spec', 'passed', 0, 0, 0])
    return ready
  }
  for (const [index, entry] of ['coordinator', 'desktop', 'http'].entries()) await t.test(`normal ${entry} cloud needsSpec starts a genuine plan without publication authority`, async () => {
    // The writable executor must receive its own branch; changing document
    // metadata after creation cannot rename the already issued CLOU-7.
    const who = await person(`cloud-spec-${entry}`, true, 1201 + index)
    const { rows: [taskIdentity] } = await pool.query('SELECT "issuedIdentifier" FROM issues WHERE id=$1', [who.issueId])
    assert.equal(taskIdentity.issuedIdentifier, `CLOU-${1201 + index}`)
    const { AgentProfileStore } = await import('../lib/factory/agent-profile')
    const profiles = new AgentProfileStore(pool), profileScope = { ownerId: who.id, workspaceId: who.workspaceId }
    const definition = (role: string) => ({ name: role, description: `${role} for an isolated cloud spec regression`, roles: [role], enabled: true,
      harness: 'codex' as const, model: { mode: 'fixed' as const, harness: 'codex' as const, model: 'gpt-5', source: { kind: 'subscription' as const, connectionId: who.connection } },
      instructions: `FIXTURE_ROLE_${role}`, skills: [] })
    const planner = await profiles.create(profileScope, definition('spec'))
    const executor = await profiles.create(profileScope, definition('execute'))
    profileForStage.spec = planner.id; profileForStage.execute = executor.id
    const decisionsBefore = profileSelections.length
    try {
      let result: { runId?: string; error?: string }
      let sourceEventId: string | undefined
      if (entry === 'http') {
        const { POST } = await import('../app/api/bots/[botId]/computer/runs/route')
        httpOwner = who.id
        try {
          const response = await POST(new Request(`https://mikka.example/mikka/api/bots/${who.botId}/computer/runs`, {
            method: 'POST', headers: { origin: 'https://mikka.example', 'content-type': 'application/json' },
            body: JSON.stringify({ issueId: who.issueId, needsSpec: true, harness: 'codex', note: 'Plan before implementation; wait for the human spec approval.' }),
          }), { params: Promise.resolve({ botId: who.botId }) })
          result = await response.json(); assert.equal(response.status, 202, JSON.stringify(result))
        } finally { httpOwner = null }
      } else {
        sourceEventId = await ownerSpecRequest(who)
        result = await (entry === 'coordinator'
          ? steps.dispatchRun(who.id, { issueId: who.issueId, repo: 'octo/repo', needsSpec: true, sourceEventId, requestKey: `spec:${randomUUID()}` }, undefined, who.botId)
          : steps.dispatchComputerThread(who.id, { botId: who.botId, issueId: who.issueId, harness: 'codex', needsSpec: true, sourceEventId }, `spec:${randomUUID()}`, undefined, undefined, who.botId)) as typeof result
      }
      assert.ok(result.runId, JSON.stringify(result))
      const planned = await specState(who)
      assert.deepEqual([planned.task.stage, planned.task.status, planned.task.route.flowVersion, planned.task.route.needsSpec], ['spec', 'running', 2, true])
      if (sourceEventId) assert.equal(planned.task.sourceEventId, sourceEventId)
      assert.deepEqual(planned.counts, { tasks: 1, attempts: 1, executions: 0, runs: 1, publications: 0, approvals: 0 })
      assert.deepEqual([planned.run.id, planned.run.kind, planned.run.deviceKind, planned.run.machineState], [result.runId, 'plan', 'cloud', 'running'])
      assert.equal(planned.run.agentDefinition.readOnly, true)
      assert.equal(planned.run.agentDefinition.repositoryAdmission, undefined, 'a spec cannot acquire implementation publication authority')
      assert.equal(planned.run.agentDefinition.agentProfile.profileId, planner.id)
      assert.equal(planned.run.agentDefinition.model, 'gpt-5')
      assert.equal(planned.run.agentDefinition.apiKey, undefined)
      assert.equal(planned.run.agentDefinition.subscription.route, 'codex_cli')
      assert.equal(planned.run.agentDefinition.executionIdentity.requester, who.id)
      assert.equal(planned.run.agentDefinition.executionIdentity.billingAccount.model.kind, 'subscription')
      assert.equal(planned.run.agentDefinition.executionIdentity.billingAccount.model.ownerId, who.id)
      assert.ok(profileSelections.slice(decisionsBefore).some(choice => choice.stage === 'spec' && choice.profileId === planner.id), 'normal profile selection receives the actual spec stage')
      if (entry !== 'coordinator') return

      const { rows: [plannerMachine] } = await pool.query(`SELECT m."sandboxId",m."deviceId",m."repoId",token.id AS "tokenId"
        FROM thread_machines m JOIN device_tokens token ON token."boundDeviceId"=m."deviceId" AND token."revokedAt" IS NULL
        WHERE m."runId"=$1`, [result.runId])
      assert.ok(plannerMachine?.sandboxId && plannerMachine.tokenId)
      const { sendThreadMessage } = await import('../lib/thread-continue')
      const clarification = 'OWNER_PLAN_CONTEXT_1276: keep the original acceptance criteria and the exact final newline in the plan.'
      const ownerNote = await sendThreadMessage(who.id, result.runId!, clarification)
      assert.deepEqual(ownerNote, { runId: result.runId, continued: false })
      const messages = (await pool.query('SELECT id,origin,"deliveredAt" FROM run_messages WHERE "runId"=$1 AND "userId"=$2 AND text=$3', [result.runId, who.id, clarification])).rows
      assert.equal(messages.length, 1)
      assert.equal(messages[0].origin, 'owner')
      assert.equal(messages[0].deliveredAt, null, 'a newly queued clarification must remain deliverable to the running planner')
      // The fixture now acknowledges native consumption before its synthetic
      // completion, as the real worker does when it reads a queued message.
      await pool.query('UPDATE run_messages SET "deliveredAt"=clock_timestamp() WHERE id=$1', [messages[0].id])
      const afterNote = await specState(who)
      assert.deepEqual([afterNote.task.id, afterNote.task.attemptId, afterNote.task.sourceEventId, afterNote.task.stage], [planned.task.id, planned.task.attemptId, planned.task.sourceEventId, 'spec'])
      assert.equal(afterNote.counts.executions, 0)
      assert.equal(afterNote.run.stopRequestedAt, null, 'an Owner plan clarification does not cancel its planner or start execution')

      const ready = await completeSpec(who, result.runId!)
      const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
      const { factoryBinding } = await import('../lib/factory/dispatch')
      const runtime = factoryRuntimeForBot(who.botId)
      await assert.rejects(runtime.store.apply(who.id, factoryBinding(ready.task), randomUUID(), { action: 'advance', stage: 'execute', reason: 'A model may not approve the plan' }), { code: 'factory_spec_approval_required' })
      const bypass = await steps.dispatchRun(who.id, { issueId: who.issueId, repo: 'octo/repo', sourceEventId, needsSpec: false, note: 'Continue without clicking spec approval.', requestKey: `bypass:${randomUUID()}` }, undefined, who.botId) as { error?: string; runId?: string }
      assert.ok(bypass.error, JSON.stringify(bypass))
      assert.equal(bypass.runId, undefined)
      await assert.rejects(sendThreadMessage(who.id, result.runId!, 'Begin implementation now.'), { code: 'runInvalid' })
      const stillWaiting = await specState(who)
      assert.deepEqual([stillWaiting.task.id, stillWaiting.task.attemptId, stillWaiting.task.sourceEventId, stillWaiting.task.stage, stillWaiting.task.status], [ready.task.id, ready.task.attemptId, ready.task.sourceEventId, 'spec', 'passed'])
      assert.deepEqual(stillWaiting.counts, ready.counts, 'a generic retry or Owner follow-up cannot manufacture approval or an executor')

      const { createFactorySpecApproval } = await import('../lib/factory/spec-approval')
      const { automaticFactoryDispatch, factoryAutomaticRuntime } = await import('../lib/factory/automatic-dispatch')
      const approve = createFactorySpecApproval(appPool, runtime.store, automaticFactoryDispatch(appPool))
      const sessionId = randomUUID()
      await pool.query(`INSERT INTO "session" (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`, [sessionId, randomUUID(), who.id])
      const approval = { binding: { taskId: ready.task.id, revision: ready.task.revision }, eventId: randomUUID() }
      const beforeHandoffs = stageHandoffs.length, previousEnqueue = factoryAutomaticRuntime.enqueue
      factoryAutomaticRuntime.enqueue = threadMachines.enqueueDurable
      let replies: Awaited<ReturnType<typeof approve>>[]
      try { replies = await Promise.all([
        withFactoryBackgroundWorkspace(pool, who.id, { kind: 'task', id: ready.task.id }, () => approve({ userId: who.id, sessionId }, approval)),
        withFactoryBackgroundWorkspace(pool, who.id, { kind: 'task', id: ready.task.id }, () => approve({ userId: who.id, sessionId }, approval)),
      ]) }
      finally { factoryAutomaticRuntime.enqueue = previousEnqueue }
      assert.equal(replies.filter(reply => reply.replayed).length, 1)
      assert.equal(stageHandoffs.length, beforeHandoffs + 1, 'approval queues one durable host handoff, including concurrent replay')
      const [handoffActor, previousRunId, implementationRunId] = stageHandoffs.at(-1)!
      assert.equal(previousRunId, result.runId)
      const { handoffFactoryCloudStage } = await import('../lib/factory/cloud-stage-handoff')
      assert.equal(await handoffFactoryCloudStage(appPool, handoffActor, previousRunId, implementationRunId), true, 'the normal host handoff starts the fresh executor after approval commits')
      const implementation = await specState(who)
      assert.equal(implementation.task.id, ready.task.id)
      assert.equal(implementation.task.sourceEventId, ready.task.sourceEventId)
      assert.deepEqual([implementation.task.stage, implementation.task.status, implementation.counts.approvals, implementation.counts.executions, implementation.counts.runs], ['execute', 'running', 1, 1, 2])
      assert.notEqual(implementation.task.attemptId, ready.task.attemptId)
      assert.notEqual(implementation.run.id, planned.run.id)
      assert.equal(implementation.run.kind, 'implement')
      assert.equal(implementation.run.agentDefinition.readOnly, undefined, 'real human approval removes the planner read-only grant for a fresh writable executor')
      assert.equal(implementation.run.agentDefinition.agentProfile.profileId, executor.id, 'implementation selects its own current Profile')
      assert.equal(implementation.run.agentDefinition.profileOriginRunId, undefined)
      assert.equal(implementation.run.continuesRunId, null)
      assert.equal(implementation.run.sessionId, null, 'implementation cannot inherit the planner native session')
      // One task retains its VM; the independent executor takes custody with
      // new credentials, without inheriting the planner's native session.
      assert.equal(implementation.run.deviceId, plannerMachine.deviceId)
      assert.deepEqual((await pool.query('SELECT state,"sandboxId" FROM thread_machines WHERE "runId"=$1', [planned.run.id])).rows[0], { state: 'ended', sandboxId: null }, 'the completed planner gives up the task machine')
      assert.deepEqual((await pool.query('SELECT "ownerId","workspaceId","botId","issueId","deviceId","repoId","sandboxId",state FROM thread_machines WHERE "runId"=$1', [implementation.run.id])).rows[0], {
        ownerId: who.id, workspaceId: who.workspaceId, botId: who.botId, issueId: who.issueId,
        deviceId: plannerMachine.deviceId, repoId: plannerMachine.repoId, sandboxId: plannerMachine.sandboxId, state: 'running',
      }, 'the executor owns this same task runtime after the real handoff')
      const tokens = (await pool.query('SELECT id,"revokedAt" FROM device_tokens WHERE "boundDeviceId"=$1', [plannerMachine.deviceId])).rows
      assert.ok(tokens.find(token => token.id === plannerMachine.tokenId)?.revokedAt, 'the planner worker credential is revoked')
      const activeTokens = tokens.filter(token => token.revokedAt === null)
      assert.equal(activeTokens.length, 1)
      assert.notEqual(activeTokens[0].id, plannerMachine.tokenId, 'the executor receives a new worker credential')
      assert.equal(implementation.run.machineState, 'running')
      assert.equal(implementation.run.agentDefinition.repositoryAdmission?.authority, 'owner_credential')
      assert.equal(implementation.counts.publications, 1)
      const { rows: [publication] } = await pool.query('SELECT "issueId","userId",identifier,branch FROM run_publications WHERE "runId"=$1', [implementation.run.id])
      assert.deepEqual(publication, { issueId: who.issueId, userId: who.id, identifier: taskIdentity.issuedIdentifier,
        branch: `mikka/${taskIdentity.issuedIdentifier.toLowerCase()}` })
      assert.equal(implementation.run.agentDefinition.repositoryAdmission.targetBranch, publication.branch)
      assert.equal((await pool.query('SELECT "issuedIdentifier" FROM issues WHERE id=$1', [who.issueId])).rows[0].issuedIdentifier, taskIdentity.issuedIdentifier,
        'planning, human approval and execution preserve the issued Task identifier')
      assert.match(implementation.run.prompt, /Factory implementation owns validation/)
      assert.match(implementation.run.prompt, /APPROVED_SPEC_CONTEXT_1276/, 'the fresh executor receives the actual approved plan content')
      assert.match(implementation.run.prompt, /OWNER_PLAN_CONTEXT_1276/, 'the fresh executor retains the Owner clarification consumed during planning')
      assert.ok(profileSelections.slice(decisionsBefore).some(choice => choice.stage === 'execute' && choice.profileId === executor.id))
    } finally { delete profileForStage.spec; delete profileForStage.execute }
  })

  await t.test('an intake-created pending cloud spec is dispatched in place, and a different source cannot replace it', async () => {
    const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
    const who = await person('cloud-pending-spec')
    const sourceEventId = await ownerSpecRequest(who)
    const runtime = factoryRuntimeForBot(who.botId)
    const routed = await runtime.store.route(who.id, { issueId: who.issueId, sourceEventId, eventId: randomUUID(), rationale: 'An intake requested a real specification.', needsSpec: true })
    const otherSource = await ownerSpecRequest(who, 'A distinct Owner request is not the existing spec source.')
    const refused = await steps.dispatchRun(who.id, { issueId: who.issueId, repo: 'octo/repo', sourceEventId: otherSource, requestKey: `wrong-source:${randomUUID()}` }, undefined, who.botId) as { error?: string; runId?: string }
    assert.ok(refused.error, JSON.stringify(refused))
    assert.equal(refused.runId, undefined)
    const pending = await specState(who)
    assert.deepEqual([pending.task.id, pending.task.attemptId, pending.task.sourceEventId, pending.task.stage, pending.task.status], [routed.task.id, routed.task.attemptId, sourceEventId, 'spec', 'pending'])
    assert.deepEqual(pending.counts, { tasks: 1, attempts: 1, executions: 0, runs: 0, publications: 0, approvals: 0 })
    const key = `existing-spec:${randomUUID()}`
    // The existing task, rather than the caller's omitted flag, owns its stage.
    const input = { issueId: who.issueId, repo: 'octo/repo', sourceEventId, requestKey: key }
    const result = await steps.dispatchRun(who.id, input, undefined, who.botId) as { runId?: string; error?: string }
    assert.ok(result.runId, JSON.stringify(result))
    const started = await specState(who)
    assert.deepEqual([started.task.id, started.task.attemptId, started.task.sourceEventId, started.task.stage, started.task.status], [routed.task.id, routed.task.attemptId, sourceEventId, 'spec', 'running'])
    assert.deepEqual([started.run.kind, started.run.agentDefinition.readOnly], ['plan', true])
    assert.deepEqual(started.counts, { tasks: 1, attempts: 1, executions: 0, runs: 1, publications: 0, approvals: 0 })
    const replay = await steps.dispatchRun(who.id, input, undefined, who.botId) as { runId?: string }
    assert.equal(replay.runId, result.runId)
    assert.deepEqual((await specState(who)).counts, started.counts, 'a resend cannot create a second plan or replace the pending task')
  })
})
