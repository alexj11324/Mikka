import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace';
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { createFactoryStore } from './store'
import { createFactoryDispatch, factoryBinding } from './dispatch'
import { createFactoryReconciler } from './reconcile'
import { freezeWorkerDefinition } from '../agent-kit/worker'
import { repositorySelectionRuntime } from './repository-selection'
import { factoryCheckIndependent } from './check-independence'
import { sealSecret, userE2bKeyAad } from '../secrets/crypto'

const url = process.env.E2E_DATABASE_URL
if (url) {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  assert.match(target.pathname, /^\/[a-z0-9_]+_e2e$/)
} else if (process.env.REQUIRE_DB === '1') assert.fail('An isolated *_e2e database is required')

test('Agent repository selection creates an authorized new execution, retaining history, model and Factory fences', { skip: !url, timeout: 180000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `repository_selection_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 5 })
  const { workspacePool } = await import('../workspace-db')
  const previousWorkspaceURL = workspacePool.options.connectionString
  workspacePool.options.connectionString = target.toString()
  const previous = { ...repositorySelectionRuntime }
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await pool.query(await readFile(new URL(file, dir), 'utf8'))
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','repository-selection@example.invalid',true,now(),now())`)
    const personalWorkspace = await seedFixtureWorkspace(pool, 'owner')
    const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID()
    await pool.query(`INSERT INTO devices(id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Fixture',now(),'[{"harness":"codex","installed":true}]')`, [deviceId])
    await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture','codex',$2)`, [agentId, deviceId])
    await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,'owner','v2/github.com/example/wrong','https://github.com/example/wrong.git')`, [repoId, deviceId])
    const subscription = { id: randomUUID(), modelId: 'fixture-subscription-model', route: 'codex_cli' }
    const authorize = async (userId: string, issueId: string, tx: PoolClient) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issueId, userId])).rowCount === 1
    const store = createFactoryStore(pool, authorize, null, { independent: factoryCheckIndependent })
    const frozen = (prompt: string, readOnly = true) => freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt, parent: null, executionId: null, model: subscription.modelId, subscription, readOnly })
    const queue = async (tx: PoolClient, owner: string, input: { issueId: string; agentId: string; deviceRepoId: string; note?: string }, _bot: string | null, _context: unknown, _source?: string, selection?: { model?: string; subscriptionBindingId?: string; readOnly?: boolean }) => {
      if (selection) assert.deepEqual(selection, { model: subscription.modelId, subscriptionBindingId: subscription.id, readOnly: true })
      const id = randomUUID(), prompt = input.note ?? 'Task names example/correct'
      await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"agentDefinition") VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8)`, [id, owner, input.issueId, input.agentId, deviceId, input.deviceRepoId, prompt, JSON.stringify(frozen(prompt))])
      return { runId: id }
    }
    // Native provider I/O is outside this database test. The actual host
    // selection, store, retry, repository registration and dispatch all run.
    repositorySelectionRuntime.queueLocal = queue as typeof repositorySelectionRuntime.queueLocal
    repositorySelectionRuntime.list = async user => {
      assert.equal(user, 'owner')
      return { repositories: [{ fullName: 'example/correct', id: '2', installationId: '1', htmlUrl: 'https://github.com/example/correct', private: true }] } as Awaited<ReturnType<typeof repositorySelectionRuntime.list>>
    }
    const dispatch = createFactoryDispatch(pool, store, queue)
    const sweep = createFactoryReconciler(pool, store)
    async function fixture(repository = 'example/correct', workspaceId = personalWorkspace) {
      const issueId = randomUUID(), sourceEventId = randomUUID()
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState",scope) VALUES ($1,'owner','Task names example/correct','{"type":"doc","content":[]}','todo','normal',$2,'bound',$3)`, [issueId, workspaceId, workspaceId === personalWorkspace ? 'personal' : 'workspace'])
      await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"Inspect example/correct"}')`, [sourceEventId, sourceEventId])
      const route = await store.route('owner', { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Explicit request' })
      const queued = await dispatch('owner', { binding: factoryBinding(route.task), agentId, deviceRepoId: repoId })
      await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='blocked',"sessionId"=$2,"finishedAt"=now(),report=$3 WHERE id=$1`, [queued.runId, randomUUID(), JSON.stringify({ summary: 'Wrong checkout', verify: { status: 'not_run' }, repositorySelection: { repository, reason: 'The task names correct; origin and files identify wrong.', observedRemote: 'https://github.com/example/wrong.git', observedHead: 'a'.repeat(40) } })])
      return { taskId: route.task.id, runId: queued.runId, issueId }
    }
    await t.test('switches the current execution once and preserves original repository, report and credential', async () => {
      const f = await fixture()
      const old = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.runId])).rows[0]
      await sweep.run('owner', f.runId)
      const state = await store.read('owner', f.taskId)
      assert.equal(state.task.stage, 'execute'); assert.equal(state.task.status, 'running')
      assert.equal(state.attempts.length, 2)
      const next = (await pool.query('SELECT r.*,repo."remoteUrl" FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r.id=$1', [state.attempts[1].runId])).rows[0]
      assert.equal(next.remoteUrl, 'https://github.com/example/correct.git')
      assert.notEqual(next.deviceRepoId, repoId); assert.equal(next.continuesRunId, f.runId)
      assert.equal(next.agentDefinition.subscription.bindingId, subscription.id)
      assert.equal(next.agentDefinition.model, subscription.modelId); assert.equal(next.agentDefinition.readOnly, true)
      assert.equal(next.agentDefinition.apiKey, undefined)
      assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.runId])).rows[0], old)
      await sweep.run('owner', f.runId)
      assert.equal((await store.read('owner', f.taskId)).attempts.length, 2, 'completion replay cannot switch again')
      assert.equal((await pool.query('SELECT "remoteUrl" FROM device_repos WHERE id=$1', [repoId])).rows[0].remoteUrl, 'https://github.com/example/wrong.git')
    })
    await t.test('unauthorized and invalid targets stay blocked without a new execution', async () => {
      for (const repository of ['foreign/private', 'file:///tmp/unauthorized', 'example/wrong']) {
        const f = await fixture(repository)
        await sweep.run('owner', f.runId)
        const state = await store.read('owner', f.taskId)
        assert.equal(state.task.status, 'blocked'); assert.equal(state.attempts.length, 1)
      }
    })
    await t.test('revoked issue access prevents repository authorization and dispatch', async () => {
      const f = await fixture()
      await pool.query('UPDATE issues SET "userId"=\'someone-else\' WHERE id=$1', [f.issueId])
      await sweep.run('owner', f.runId)
      assert.equal((await pool.query('SELECT count(*) FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rows[0].count, '1')
    })
    await t.test('independent checks retain their candidate and cannot select another repository', async () => {
      const f = await fixture()
      await pool.query(`UPDATE factory_tasks SET stage='review' WHERE id=$1`, [f.taskId])
      await pool.query(`UPDATE factory_attempts SET stage='review' WHERE "taskId"=$1`, [f.taskId])
      await sweep.run('owner', f.runId)
      const state = await store.read('owner', f.taskId)
      assert.equal(state.task.status, 'blocked'); assert.equal(state.task.stage, 'review')
      assert.equal(state.task.candidateId, null); assert.equal(state.attempts.length, 1)
    })
    await t.test('a real stop request wins over the Agent repository handoff', async () => {
      const f = await fixture()
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [f.runId])
      await sweep.run('owner', f.runId)
      const state = await store.read('owner', f.taskId)
      assert.equal(state.task.status, 'cancelled'); assert.equal(state.attempts.length, 1)
    })
    await t.test('a credential fallback rolls back the entire switch and visibly blocks the task', async () => {
      const f = await fixture()
      const originalQueue = repositorySelectionRuntime.queueLocal
      repositorySelectionRuntime.queueLocal = async (...args) => {
        const result = await originalQueue(...args)
        await args[0].query(`UPDATE agent_runs SET "agentDefinition"="agentDefinition" || $2::jsonb WHERE id=$1`, [result.runId, JSON.stringify({ subscription: null, apiKey: { keyId: randomUUID(), model: subscription.modelId } })])
        return result
      }
      try {
        await sweep.run('owner', f.runId)
        const state = await store.read('owner', f.taskId)
        assert.equal(state.task.status, 'blocked'); assert.equal(state.attempts.length, 1)
        assert.equal((await pool.query('SELECT count(*) FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rows[0].count, '1')
      } finally { repositorySelectionRuntime.queueLocal = originalQueue }
    })
    await t.test('the real cloud queue reauthorizes the same subscription and defers machine handoff until commit', async () => {
      const workspaceId = randomUUID(), botId = randomUUID(), connectionId = randomUUID()
      await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,'owner','Repository selection fixture')`, [workspaceId])
      await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,'owner','Fixture','repository-selection@example.invalid','admin','active')`, [workspaceId])
      const key = sealSecret('synthetic-e2b-fixture', userE2bKeyAad('owner'), { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
      await pool.query(`INSERT INTO user_e2b_keys("userId",ciphertext,iv,"keyVersion",last4) VALUES('owner',$1,$2,$3,'test')`, [key.ciphertext, key.iv, key.keyVersion])
      await pool.query(`UPDATE devices SET kind='cloud' WHERE id=$1`, [deviceId])
      await pool.query(`INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES ($1,$2,'owner','Repository test runtime')`, [botId, workspaceId])
      await pool.query(`INSERT INTO cloud_machines("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,'owner',$2,'synthetic-no-provider',$3,'running',true)`, [workspaceId, randomUUID(), deviceId])
      await pool.query(`INSERT INTO bot_desktops("botId","workspaceId","ownerId",display) VALUES ($1,$2,'owner',1)`, [botId, workspaceId])
      await pool.query(`INSERT INTO bot_cloud_runtimes("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES ($1,$2,'owner','codex',$3,$4)`, [botId, workspaceId, agentId, repoId])
      await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") VALUES ($1,'owner',$2,'codex','connected',1,'synthetic-no-credential',$3,'fixture-provider-subject')`, [connectionId, workspaceId, 'a'.repeat(64)])
      await pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,'owner',$2,$3,$4,1,'codex_cli',$5)`, [subscription.id, workspaceId, agentId, connectionId, subscription.modelId])
      const f = await fixture('example/correct', workspaceId)
      await pool.query(`INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,'owner')`, [f.runId, botId, workspaceId])
      const handoffs: string[] = []
      repositorySelectionRuntime.enqueue = async (_pool, actor, previousRun, nextRun) => {
        assert.deepEqual(actor, { userId: 'owner', workspaceId }); assert.equal(previousRun, f.runId)
        const row = (await pool.query('SELECT status FROM agent_runs WHERE id=$1', [nextRun])).rows[0]
        assert.equal(row.status, 'queued', 'another connection sees the committed new execution')
        handoffs.push(nextRun)
      }
      await sweep.run('owner', f.runId)
      const state = await store.read('owner', f.taskId)
      assert.equal(state.task.status, 'running'); assert.equal(state.attempts.length, 2)
      const next = (await pool.query('SELECT r.*,repo."remoteUrl" FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r.id=$1', [state.attempts[1].runId])).rows[0]
      assert.equal(next.remoteUrl, 'https://github.com/example/correct.git')
      assert.equal(next.agentDefinition.subscription.bindingId, subscription.id)
      assert.equal(next.agentDefinition.model, subscription.modelId); assert.equal(next.agentDefinition.readOnly, true)
      assert.deepEqual(handoffs, [next.id]); assert.equal(next.botId, null)
      await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"finishedAt"=now(),report=$3 WHERE id=$1`, [next.id, randomUUID(), JSON.stringify({ summary: 'Read the selected checkout', sourceCommit: 'b'.repeat(40), verify: { status: 'passed' } })])
      await sweep.run('owner', next.id)
      const checked = await store.read('owner', f.taskId)
      assert.equal(checked.task.stage, 'review'); assert.equal(checked.task.status, 'pending')
      assert.equal(checked.candidates[0].repository, 'https://github.com/example/correct.git')
      assert.equal(checked.candidates[0].runId, next.id); assert.equal(checked.candidates[0].sha, 'b'.repeat(40))
    })
  } finally {
    Object.assign(repositorySelectionRuntime, previous)
    workspacePool.options.connectionString = previousWorkspaceURL
    await workspacePool.end()
    await dropTestDatabase(admin, database, pool)
    await admin.end()
  }
})
