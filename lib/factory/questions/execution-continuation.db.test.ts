import { seedFixtureWorkspace } from '../../../tests/helpers/task-workspace';
import { addFactoryVisualEvidence } from '../../../tests/helpers/factory-visual-evidence';
import { bindFixtureWorkspaceDatabase } from '../../../tests/helpers/workspace-database';
// Isolated PostgreSQL fixtures model immutable host receipts, not live model acceptance.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'
import { orderMigrations } from '../../../scripts/migration-order.mjs'
import { dropTestDatabase } from '../../../tests/support/drop-test-database'
import { createFactoryStore } from '../store'
import { observePoolCommits } from '../../db/commit-effects'
import { createFactoryDispatch, factoryBinding } from '../dispatch'
import { factoryEventId } from '../event-id'
import { questionFingerprint } from './contract'
import { questionExecutionContinuation } from './execution-continuation'
import { checkFactoryRepairBudget } from '../check-recovery-evidence'
import { appendFactoryCheckContinuationContext, producerCommandObservations } from '../checks'
import { questionExecutionObservations, questionExecutionObservationPrompt } from '../question-execution-observations'
import { freezeWorkerDefinition } from '../../agent-kit/worker'
import { digest } from '../evidence'

const url = process.env.E2E_DATABASE_URL
if (url) {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  assert.match(target.pathname, /^\/[a-z0-9_]+_e2e$/)
} else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')

test('real PG: question receipts preserve one execution without opening a repair-cap bypass', { skip: !url, timeout: 120_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `question_cap_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = '/' + database
  const pool = new Pool({ connectionString: target.toString(), max: 8 })
  observePoolCommits(pool)
  let closeWorkspaceDatabase: (() => Promise<void>) | undefined
  const previousByos = process.env.MIKKA_BYOS_ENABLED, previousRoutes = process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES
  process.env.MIKKA_BYOS_ENABLED = '1'; process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
  try {
    closeWorkspaceDatabase = await bindFixtureWorkspaceDatabase(pool)
    const dir = new URL('../../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql')))) await pool.query(await readFile(new URL(file, dir), 'utf8'))
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Owner','question-cap@example.invalid',true,now(),now()),('other','Other','question-cap-other@example.invalid',true,now(),now())`)
    const authorize = async (userId: string, issueId: string, tx: PoolClient) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issueId, userId])).rowCount === 1
    const transaction = async <T,>(work: (tx: PoolClient) => Promise<T>, rollback = false) => {
      const tx = await pool.connect()
      try { await tx.query('BEGIN'); const result = await work(tx); await tx.query(rollback ? 'ROLLBACK' : 'COMMIT'); return result }
      catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    }

    async function fixture(options: { native?: boolean; withoutBot?: boolean; separateChat?: boolean; local?: boolean; harness?: 'codex' | 'claude_code'; legacy?: boolean } = {}) {
      const harness = options.harness ?? 'codex', model = options.native ? (harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5') : 'deepseek-flash'
      const route = harness === 'codex' ? 'codex_cli' : 'claude_code_cli'
      const workspaceId = randomUUID(), runtimeBotId = randomUUID(), issueId = randomUUID(), sourceEventId = randomUUID()
      const botId = options.withoutBot ? null : options.separateChat ? randomUUID() : runtimeBotId
      const runBotId = options.withoutBot ? null : runtimeBotId
      const deviceId = randomUUID(), repoId = randomUUID(), agentId = randomUUID(), bindingId = randomUUID(), connectionId = randomUUID()
      await seedFixtureWorkspace(pool, 'owner', 'team', workspaceId)
      for (const id of new Set([runtimeBotId, ...(botId ? [botId] : [])])) await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,$3)`, [id, workspaceId, `Fixture ${id}`])
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState",scope) VALUES($1,'owner','Question cap','{}','todo','normal',$2,'bound','workspace')`, [issueId, workspaceId])
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,'owner',$2,$3,'user_message',$1::text,'{"text":"Original owner request"}')`, [sourceEventId, botId, issueId])
      await pool.query(`INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,'owner',$2,$3)`, [deviceId, `Device ${deviceId}`, options.local ? 'local' : 'cloud'])
      await pool.query(`INSERT INTO agents(id,"userId","deviceId",harness,name) VALUES($1,'owner',$2,$3,$4)`, [agentId, deviceId, harness, `Agent ${agentId}`])
      await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,'owner','/tmp/fixture')`, [repoId, deviceId])
      if (options.native) {
        await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject") VALUES($1,'owner',$2,$3,'connected',2,$4,$5,'synthetic-subject')`, [connectionId, workspaceId, harness === 'codex' ? 'codex' : 'claude', `synthetic-no-secret-${connectionId}`, 'a'.repeat(64)])
        await pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,'owner',$2,$3,$4,2,$5,$6)`, [bindingId, workspaceId, agentId, connectionId, route, model])
      }
      const definition = { schemaVersion: 1, harness, definitionDigest: 'd'.repeat(64), model,
        ...(options.native ? { subscription: { bindingId, route, modelId: model } } : { apiKey: { credentialId: 'synthetic-reference' }, subscription: null }) }
      const store = createFactoryStore(pool, authorize, botId, {})
      let task = (await store.route('owner', { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Synthetic execution history' })).task
      if (options.legacy) {
        await pool.query(`UPDATE factory_tasks SET route=route-'flowVersion' WHERE id=$1`, [task.id])
        task = (await store.read('owner', task.id)).task
      }
      const run = async (tx: Pick<PoolClient, 'query'>, parent: string | null = null) => {
        const id = randomUUID()
        await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",kind,status,prompt,"baseBranch","agentDefinition","continuesRunId") VALUES($1,'owner',$2,$3,$4,$5,$6,'implement','queued','Synthetic task','main',$7,$8)`, [id, issueId, agentId, deviceId, repoId, runBotId, JSON.stringify(definition), parent])
        if (!options.local) await tx.query(`INSERT INTO computer_run_bindings("runId","ownerId","workspaceId","botId") VALUES($1,'owner',$2,$3)`, [id, workspaceId, runtimeBotId])
        return id
      }
      let originRunId = ''
      // Two real store retries precede the question. The normal repair cap has
      // one remaining retry; extra question segments must not consume it.
      for (let i = 0; i < 3; i++) {
        originRunId = await run(pool)
        task = (await store.apply('owner', factoryBinding(task), randomUUID(), { action: 'bind_run', runId: originRunId })).task
        if (i < 2) {
          await pool.query(`UPDATE agent_runs SET status='failed',"sessionId"=$2,"finishedAt"=now() WHERE id=$1`, [originRunId, `old-${originRunId}`])
          task = (await store.apply('owner', factoryBinding(task), randomUUID(), { action: 'finish', status: 'failed', reason: 'Synthetic failure', evidence: [], output: {} })).task
          task = (await store.apply('owner', factoryBinding(task), randomUUID(), { action: 'retry', reason: 'Synthetic repair' })).task
        }
      }
      const questionId = randomUUID(), answerId = randomUUID(), sessionId = `native-${originRunId}`
      await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,"finishedAt"=now() WHERE id=$1`, [originRunId, sessionId])
      task = (await store.apply('owner', factoryBinding(task), randomUUID(), { action: 'finish', status: 'waiting', reason: 'Question', evidence: [], output: {} })).task
      const waiting = factoryBinding(task), reference = { questionId, questionRevision: 1, binding: waiting, originRunId, originSessionId: sessionId }
      const input = { reference, answerId, text: 'The owner answered the original task question.' }, answer = { source: 'human', userId: 'owner', input }
      const questionEvent = randomUUID()
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,'owner',$2,$3,'run_question',$1::text,'{}')`, [questionEvent, botId, issueId])
      await pool.query(`INSERT INTO factory_questions(id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,context,request,status,revision,reason,"sourceEventId","answerId","answerSource",answer,"answerFingerprint","answeredAt") VALUES($1,'owner',$2,$3,$4,'execute',$5,$6,$7,$8,'external','Question','Fixture','{}','answered',2,'Answered',$9,$10,'human',$11,$12,now())`,
      [questionId, issueId, task.id, task.attemptId, originRunId, sessionId, task.revision - 1, JSON.stringify(waiting), questionEvent, answerId, JSON.stringify(answer), questionFingerprint(answer)])
      const originAttemptId = task.attemptId
      const createContinuation = async () => transaction(async tx => {
        const current = await store.lockTask(tx, 'owner', task.id)
        const next = await store.retryQuestion('owner', factoryBinding(current), factoryEventId('question-next-attempt', questionId), 'Continue the original execution.', questionId, tx)
        const childRunId = await run(tx, originRunId)
        await tx.query('UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1', [childRunId, JSON.stringify({ questionId, originRunId, originSessionId: sessionId, requireSessionResume: true })])
        const bound = (await store.apply('owner', factoryBinding(next.task), randomUUID(), { action: 'bind_run', runId: childRunId }, tx)).task
        const eventId = factoryEventId('question-resume', answerId)
        await tx.query(`INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)`, [task.id, eventId,
          JSON.stringify({ kind: 'question_resume', source: 'human', userId: 'owner', input }),
          JSON.stringify({ questionId, answerId, answerFingerprint: questionFingerprint(answer), originRunId, originSessionId: sessionId, originAttemptId, continuationRunId: childRunId, task: bound })])
        await tx.query(`UPDATE factory_questions SET status='resuming',"continuationRunId"=$2 WHERE id=$1`, [questionId, childRunId])
        task = bound
        return { task: bound, runId: childRunId, eventId }
      })
      return { store, task, run, createContinuation, questionId, answerId, reference, answer, originAttemptId, originRunId, sessionId, workspaceId, runtimeBotId, deviceId, agentId, repoId, connectionId, definition, bindingId }
    }

    for (const options of [{ native: true }, { native: true, withoutBot: true }, { native: true, separateChat: true }, {}, { withoutBot: true }, { local: true }])
      await t.test(`queued question resume uses the same execution: ${JSON.stringify(options)}`, async () => {
        const f = await fixture(options), child = await f.createContinuation()
        assert.equal((await pool.query('SELECT "sessionId" FROM agent_runs WHERE id=$1', [child.runId])).rows[0].sessionId, null)
        const edge = await questionExecutionContinuation(pool, child.task, child.task.attemptId)
        assert.equal(edge?.sourceRunId, f.originRunId)
        assert.equal(edge?.questionOriginAttemptId, f.originAttemptId)
        await transaction(tx => checkFactoryRepairBudget(tx, child.task))
        // Removing the immutable host receipt changes the cap outcome even
        // though all mutable question/SID/continuation fields still match.
        await transaction(async tx => {
          await tx.query('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [child.task.id, child.eventId])
          assert.equal(await questionExecutionContinuation(tx, child.task, child.task.attemptId), null)
          await assert.rejects(checkFactoryRepairBudget(tx, child.task), { code: 'factoryRecoveryBudgetExceeded' })
        }, true)
      })

    for (const kind of ['question_resume', 'question_recover'] as const) await t.test(`${kind}: the real cloud claim retains the original started Profile after edit without changing its digest`, async () => {
      const [{ AgentProfileStore, parseAgentProfile, agentProfileInstructions, assertProfileSelection }, { resolveAgentProfileSkills },
        { freezeWorkerDefinition }, { freezeExecutionIdentity }, { workspacePool }, { claimCloudRun }, { assertRunProfileClaim }] = await Promise.all([
        import('../agent-profile'), import('../agent-profile-skills'), import('../../agent-kit/worker'), import('../../execution-identity'),
        import('../../workspace-db'), import('../../computer/claim'), import('../profile-admission'),
      ])
      const f = await fixture({ native: true, separateChat: true }), scope = { ownerId: 'owner', workspaceId: f.workspaceId }
      // The independent production Workspace pool reads this same isolated
      // database. fixture() already persisted its real membership once.
      assert.equal(workspacePool.options.connectionString, target.toString())
      await pool.query(`INSERT INTO user_e2b_keys("userId",ciphertext,iv,"keyVersion",last4) VALUES('owner','synthetic-unopened','synthetic-unopened',1,'test') ON CONFLICT("userId") DO NOTHING`)
      await pool.query(`UPDATE byos_connections SET "modelCatalog"=$2,quota=$3 WHERE id=$1`, [f.connectionId,
        JSON.stringify({ revision: '1', models: ['gpt-6-luna'] }),
        JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .1, resetsAt: null }] })])
      await pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,'owner',$2,'catalogue',$3,2,'codex_cpa','gpt-6-luna')`, [randomUUID(),f.workspaceId,f.connectionId])
      const profiles = new AgentProfileStore(pool)
      const definition = parseAgentProfile({ name: 'Frozen question role', roles: ['implementation'], harness: 'codex', effort: 'high',
        instructions: 'Keep the original role throughout this native question.', skills: ['systematic-debugging'],
        model: { mode: 'fixed', harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: f.connectionId } } })
      const profile = await profiles.create(scope,definition), skills = resolveAgentProfileSkills(definition.skills)
      const entry = { id: `question-profile:${profile.id}`, harness: 'codex' as const, model: 'gpt-6-luna', source: { kind: 'subscription' as const, connectionId: f.connectionId } }
      const selection: import('../agent-profile').AgentProfileSelection = { profileId: profile.id, version: profile.version, digest: profile.digest,
        name: profile.name, source: 'explicit', reason: 'Owner-selected native question fixture', scope, definition, skills,
        instructions: agentProfileInstructions(definition,skills), effort: definition.effort, targetEntry: entry }
      await assertProfileSelection(pool,scope,selection)
      const worker = freezeWorkerDefinition({ harness: 'codex', model: 'gpt-6-luna', instructions: selection.instructions, prompt: 'Synthetic task',
        parent: null, executionId: null, subscription: { id: f.bindingId, route: 'codex_cli', modelId: 'gpt-6-luna' },
        modelDispatch: { mode: 'picked', location: 'cloud', entry }, agentProfile: selection })
      worker.executionIdentity = await freezeExecutionIdentity(pool,{ userId: 'owner', botId: f.runtimeBotId, deviceId: f.deviceId, agentDefinition: worker })
      Object.assign(f.definition,worker)
      await pool.query(`UPDATE agent_runs SET "agentDefinition"=$2,"startedAt"=now()-interval '1 minute' WHERE id=$1`, [f.originRunId,JSON.stringify(worker)])
      let child = await f.createContinuation()
      if (kind === 'question_recover') {
        // A failed queued launch is history, not a new native origin. Only
        // the already-started original session grants its frozen role.
        await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',"sessionId"=$2,"startedAt"=NULL,"finishedAt"=now() WHERE id=$1`, [child.runId,f.sessionId])
        await pool.query('INSERT INTO byos_native_runs("runId","bindingId") VALUES($1,$2)', [child.runId,f.bindingId])
        const failed = (await f.store.apply('owner',factoryBinding(child.task),randomUUID(),{ action: 'finish', status: 'blocked', reason: 'Failed queued native launch', evidence: [], output: {} })).task
        const first = child
        child = await transaction(async tx => {
          await tx.query(`UPDATE factory_questions SET status='answered' WHERE id=$1`, [f.questionId])
          const requestId = randomUUID(), eventId = factoryEventId('question-recover',requestId)
          const reference = { ...f.reference, questionRevision: 2, binding: factoryBinding(failed) }
          const next = await f.store.retryQuestion('owner',factoryBinding(failed),factoryEventId('question-recover-attempt',requestId),'Recover the original session.',f.questionId,tx)
          const runId = await f.run(tx,first.runId)
          await tx.query('UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1', [runId,JSON.stringify({ questionId: f.questionId, originRunId: f.originRunId, originSessionId: f.sessionId, requireSessionResume: true })])
          const bound = (await f.store.apply('owner',factoryBinding(next.task),randomUUID(),{ action: 'bind_run', runId },tx)).task
          await tx.query(`UPDATE factory_questions SET status='resuming',"continuationRunId"=$2,revision=revision+1 WHERE id=$1`, [f.questionId,runId])
          await tx.query('INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)', [bound.id,eventId,
            JSON.stringify({ kind: 'question_recover', userId: 'owner', input: { requestId, expectedFailedRunId: first.runId, reference } }),
            JSON.stringify({ questionId: f.questionId, continuationRunId: runId, historyRunId: first.runId, originRunId: f.originRunId, originSessionId: f.sessionId, task: bound, replayed: false })])
          return { task: bound, runId, eventId }
        })
        assert.equal((await pool.query('SELECT "startedAt" FROM agent_runs WHERE id=$1', [first.runId])).rows[0].startedAt,null)
      }
      await profiles.update(scope,profile.id,profile.version,{ ...definition, enabled: false, instructions: 'New guidance applies to future tasks only.' })
      await assert.rejects(assertProfileSelection(pool,scope,selection), { code: 'agentProfileDisabled' })
      const sandboxId = `profile-native-${child.runId}`
      await pool.query(`UPDATE agent_runs SET "questionContinuation"="questionContinuation" || jsonb_build_object('requiredSandboxId',$2::text) WHERE id=$1`, [child.runId,sandboxId])
      await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId")
        SELECT id,$2,'owner',$3,"issueId",$4,'synthetic-snapshot',$5,'running',"deviceId","deviceRepoId" FROM agent_runs WHERE id=$1`, [child.runId,f.workspaceId,f.runtimeBotId,sandboxId,randomUUID()])
      const claim = () => claimCloudRun(pool,{ userId: 'owner', workspaceId: f.workspaceId },child.runId,f.deviceId,new Date(Date.now()+60_000),f.bindingId,undefined,undefined,false)
      const saved = (await pool.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [child.task.id,child.eventId])).rows[0]
      for (const fault of ['receipt', 'owner', 'epoch', 'expired', 'unstarted'] as const) {
        if (fault === 'receipt') await pool.query('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [child.task.id,child.eventId])
        if (fault === 'owner') await pool.query(`UPDATE factory_events SET request=jsonb_set(request,'{userId}','"other"') WHERE "taskId"=$1 AND "eventId"=$2`, [child.task.id,child.eventId])
        if (fault === 'epoch') await pool.query(`UPDATE factory_events SET result=jsonb_set(result,'{task,sourceEventId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [child.task.id,child.eventId,randomUUID()])
        if (fault === 'expired') await pool.query(`UPDATE factory_questions SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [f.questionId])
        if (fault === 'unstarted') await pool.query('UPDATE agent_runs SET "startedAt"=NULL WHERE id=$1', [f.originRunId])
        try {
          await assert.rejects(claim(), { message: 'agentProfileUnavailable' },fault)
          assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [child.runId])).rows[0].status,'queued')
        } finally {
          await pool.query(`INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4) ON CONFLICT("taskId","eventId") DO UPDATE SET request=EXCLUDED.request,result=EXCLUDED.result`, [child.task.id,child.eventId,JSON.stringify(saved.request),JSON.stringify(saved.result)])
          await pool.query('UPDATE factory_questions SET "expiresAt"=NULL WHERE id=$1', [f.questionId])
          await pool.query(`UPDATE agent_runs SET "startedAt"=now()-interval '1 minute' WHERE id=$1`, [f.originRunId])
        }
      }
      await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [f.connectionId])
      assert.equal(await claim(),null,'frozen role cannot override credential revocation')
      await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [f.connectionId])
      await assertRunProfileClaim(pool,child.runId)
      assert.equal((await claim())?.ownerId,'owner')
      const claimed = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [child.runId])).rows[0]
      assert.equal(claimed.status,'preparing'); assert.equal(claimed.sessionId,null)
      assert.equal(claimed.agentDefinition.definitionDigest,worker.definitionDigest)
      assert.equal(claimed.agentDefinition.profileOriginRunId,undefined)
      assert.deepEqual(claimed.agentDefinition.agentProfile,selection)
      assert.equal(claimed.questionContinuation.originSessionId,f.sessionId)
      assert.equal((await pool.query('SELECT "bindingId" FROM byos_native_runs WHERE "runId"=$1', [child.runId])).rows[0].bindingId,f.bindingId)
    })

    await t.test('watchdog recovers the same unclaimed native question instead of leaving it queued until the generic stop window', async () => {
      const f = await fixture({ native: true, separateChat: true }), child = await f.createContinuation()
      const { sweepFactoryWatchdog } = await import('../watchdog')
      const wakes: string[] = []
      const result = await sweepFactoryWatchdog(pool, {
        runtime: () => ({ store: f.store, reconcile: { run: async () => assert.fail('no run completed') } }),
        dispatch: async () => { assert.fail('must not create another run or attempt') }, wake: async () => undefined,
        recoverQuestion: async (_userId: string, runId: string) => { wakes.push(runId); return { handled: true, launched: true } },
      }, new Date(), Date.now() + 20_000, { userId: 'owner', runId: child.runId })
      assert.deepEqual(wakes, [child.runId], 'the committed answer is an independent durable wake intent')
      assert.equal(result.recovered, 1)
      assert.equal((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [child.runId])).rows[0].stopRequestedAt, null)
    })

    await t.test('native question wake generations are bounded, single-winner and preserve the unclaimed child and original session', async t => {
      const wake = await import('./wake')
      const f = await fixture({ native: true, separateChat: true }), child = await f.createContinuation()
      const sandboxId = `original-${child.runId}`
      await pool.query(`UPDATE agent_runs SET "questionContinuation"="questionContinuation" || jsonb_build_object('requiredSandboxId',$2::text) WHERE id=$1`, [child.runId, sandboxId])
      await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId")
        SELECT id,$2,'owner',$3,"issueId",$4,'synthetic-snapshot',$5,'paused',"deviceId","deviceRepoId" FROM agent_runs WHERE id=$1`,
      [child.runId, f.workspaceId, f.runtimeBotId, sandboxId, randomUUID()])
      const humanSession = randomUUID()
      await pool.query(`INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,'owner',$1,now()+interval '1 hour',now(),now())`, [humanSession])
      const actor = { userId: 'owner', workspaceId: f.workspaceId }
      const originals = { ...wake.questionWakeRuntime }
      const enqueued: { runId: string; wake: import('./wake').QuestionWake; workflowRunId: string }[] = []
      const statuses = new Map<string, string>()
      wake.questionWakeRuntime.store = async () => f.store
      wake.questionWakeRuntime.enqueue = async (_actor, runId, intent) => {
        const workflowRunId = `workflow-${enqueued.length}`
        enqueued.push({ runId, wake: intent, workflowRunId }); statuses.set(workflowRunId, 'pending')
        return workflowRunId
      }
      wake.questionWakeRuntime.status = async id => statuses.get(id) ?? 'failed'
      const snapshot = async () => (await pool.query(`SELECT to_jsonb(r) AS run,to_jsonb(q) AS question,to_jsonb(m) AS machine,
        to_jsonb(t) AS task,to_jsonb(a) AS attempt FROM agent_runs r JOIN factory_questions q ON q."continuationRunId"=r.id
        JOIN thread_machines m ON m."runId"=r.id JOIN factory_tasks t ON t.id=q."taskId" JOIN factory_attempts a ON a.id=t."attemptId" WHERE r.id=$1`, [child.runId])).rows[0]
      const before = await snapshot(), clock = new Date()
      try {
        const attempts = await Promise.all([wake.wakeQueuedQuestionContinuation(pool, 'owner', child.runId, clock), wake.wakeQueuedQuestionContinuation(pool, 'owner', child.runId, clock)])
        assert.equal(attempts.filter(a => a.launched).length, 1)
        assert.equal(enqueued.length, 1)
        const first = enqueued[0]
        assert.equal(await wake.claimQuestionWake(pool, { ...actor, workspaceId: randomUUID() }, child.runId, first.wake, first.workflowRunId), false)
        assert.equal(await wake.claimQuestionWake(pool, actor, child.runId, first.wake, first.workflowRunId), true)
        assert.equal(await wake.claimQuestionWake(pool, actor, child.runId, first.wake, 'duplicate-workflow'), false)
        await wake.finishQuestionWake(pool, actor, child.runId, first.wake, first.workflowRunId, true)
        assert.equal((await wake.questionWakeFailure(pool, 'owner', child.runId))?.generation, first.wake.generation)
        await t.test('owner wake projection remains readable while a claim holds the child run', async () => {
          const reader = new Pool({ connectionString: target.toString(), max: 1,
            options: '-c statement_timeout=2000 -c lock_timeout=250' })
          const claiming = await pool.connect()
          try {
            await claiming.query('BEGIN')
            // The real claim acquires this run lock before asking the question store.
            await claiming.query('SELECT * FROM agent_runs WHERE id=$1 FOR UPDATE', [child.runId])
            assert.equal(await wake.questionWakeFailure(reader, 'other', child.runId), null)
            assert.deepEqual(await wake.questionWakeFailure(reader, 'owner', child.runId), {
              generation: first.wake.generation, error: 'Original session could not start',
            }, 'a read-only projection does not contend with the claim transaction')
          } finally {
            await claiming.query('ROLLBACK')
            claiming.release()
            await reader.end()
          }
        })

        assert.equal((await snapshot()).run.sessionId, null, 'a launch failure is not an actual native SID claim')
        assert.equal((await snapshot()).run.status, 'queued')
        await assert.rejects(wake.retryQueuedQuestionWake(pool, { userId: 'owner', sessionId: humanSession }, child.runId, first.wake.generation), { code: 'factoryQuestionContinuationUnavailable' }, 'the original workflow must be terminal before replacement')
        assert.equal((await wake.wakeQueuedQuestionContinuation(pool, 'owner', child.runId, new Date(clock.getTime() + 10 * 60_000))).launched, false)
        statuses.set(first.workflowRunId, 'failed')
        await pool.query(`UPDATE thread_machines SET "workerLeaseUntil"=now()+interval '1 minute' WHERE "runId"=$1`, [child.runId])
        await assert.rejects(wake.retryQueuedQuestionWake(pool, { userId: 'owner', sessionId: humanSession }, child.runId, first.wake.generation), { code: 'factoryQuestionContinuationUnavailable' })
        await pool.query('UPDATE thread_machines SET "workerLeaseUntil"=NULL WHERE "runId"=$1', [child.runId])
        const retries = await Promise.all([1, 2].map(() => wake.retryQueuedQuestionWake(pool, { userId: 'owner', sessionId: humanSession }, child.runId, first.wake.generation)))
        assert.deepEqual(retries, [{ runId: child.runId, continued: false }, { runId: child.runId, continued: false }])
        assert.equal(enqueued.length, 2)
        const second = enqueued[1]
        assert.equal(await wake.claimQuestionWake(pool, actor, child.runId, first.wake, first.workflowRunId), false, 'the old winner cannot regain its machine')
        await wake.finishQuestionWake(pool, actor, child.runId, first.wake, first.workflowRunId, true)
        assert.equal(await wake.questionWakeFailure(pool, 'owner', child.runId), null, 'late failure cannot block the successor')
        assert.equal(await wake.claimQuestionWake(pool, actor, child.runId, second.wake, second.workflowRunId), true)
        await wake.finishQuestionWake(pool, actor, child.runId, second.wake, second.workflowRunId, true)
        statuses.set(second.workflowRunId, 'failed')
        assert.equal((await wake.wakeQueuedQuestionContinuation(pool, 'owner', child.runId, new Date(clock.getTime() + 20 * 60_000))).launched, true)
        const third = enqueued[2]
        assert.equal(await wake.claimQuestionWake(pool, actor, child.runId, third.wake, third.workflowRunId), true)
        await wake.finishQuestionWake(pool, actor, child.runId, third.wake, third.workflowRunId, true)
        statuses.set(third.workflowRunId, 'failed')
        for (const minutes of [30, 40, 60]) assert.equal((await wake.wakeQueuedQuestionContinuation(pool, 'owner', child.runId, new Date(clock.getTime() + minutes * 60_000))).launched, false)
        assert.equal(enqueued.length, wake.QUESTION_WAKE_MAX_TRIES)
        assert.deepEqual(await snapshot(), before, 'wake attempts cannot rewrite the answer, run, attempt, task, VM or session')
        await assert.rejects(wake.retryQueuedQuestionWake(pool, { userId: 'owner', sessionId: 'invalid' }, child.runId, third.wake.generation), { code: 'factoryHumanRequired' })
        assert.equal(await wake.questionWakeFailure(pool, 'other', child.runId), null)
        for (const [column, value] of [['stopRequestedAt', new Date()], ['startedAt', new Date()], ['sessionId', f.sessionId], ['status', 'failed']] as const) {
          await pool.query(`UPDATE agent_runs SET "${column}"=$2 WHERE id=$1`, [child.runId, value])
          assert.equal(await wake.questionWakeFailure(pool, 'owner', child.runId), null, column)
          assert.equal((await wake.wakeQueuedQuestionContinuation(pool, 'owner', child.runId, new Date(clock.getTime() + 60 * 60_000))).launched, false)
          await assert.rejects(wake.retryQueuedQuestionWake(pool, { userId: 'owner', sessionId: humanSession }, child.runId, third.wake.generation), { code: 'factoryQuestionContinuationUnavailable' }, column)
          await pool.query(`UPDATE agent_runs SET "${column}"=$2 WHERE id=$1`, [child.runId, column === 'status' ? 'queued' : null])
        }
        for (const [column, path, replacement, original] of [
          ['agentDefinition', 'definitionDigest', 'wrong-digest', f.definition.definitionDigest],
          ['questionContinuation', 'originSessionId', 'wrong-session', f.sessionId],
          ['questionContinuation', 'requiredSandboxId', 'different-machine', sandboxId],
        ] as const) {
          await pool.query(`UPDATE agent_runs SET "${column}"=jsonb_set("${column}",$2::text[],to_jsonb($3::text)) WHERE id=$1`, [child.runId, [path], replacement])
          await assert.rejects(wake.retryQueuedQuestionWake(pool, { userId: 'owner', sessionId: humanSession }, child.runId, third.wake.generation), { code: 'factoryQuestionContinuationUnavailable' }, path)
          await pool.query(`UPDATE agent_runs SET "${column}"=jsonb_set("${column}",$2::text[],to_jsonb($3::text)) WHERE id=$1`, [child.runId, [path], original])
        }
        const originalReceipt = (await pool.query('SELECT result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [child.task.id, child.eventId])).rows[0].result
        await pool.query(`UPDATE factory_events SET result=jsonb_set(result,'{task,sourceEventId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [child.task.id, child.eventId, randomUUID()])
        await assert.rejects(wake.retryQueuedQuestionWake(pool, { userId: 'owner', sessionId: humanSession }, child.runId, third.wake.generation), { code: 'factoryQuestionContinuationUnavailable' }, 'the original receipt must bind this current request epoch')
        await pool.query('UPDATE factory_events SET result=$3 WHERE "taskId"=$1 AND "eventId"=$2', [child.task.id, child.eventId, originalReceipt])
        await pool.query(`UPDATE factory_questions SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [f.questionId])
        assert.equal(await wake.questionWakeFailure(pool, 'owner', child.runId), null)
        await assert.rejects(wake.retryQueuedQuestionWake(pool, { userId: 'owner', sessionId: humanSession }, child.runId, third.wake.generation), { code: 'factoryQuestionContinuationUnavailable' })
        await pool.query(`UPDATE factory_questions SET "expiresAt"=NULL WHERE id=$1`, [f.questionId])
        wake.questionWakeRuntime.enqueue = async (_actor, runId, intent) => {
          enqueued.push({ runId, wake: intent, workflowRunId: 'response-lost' })
          throw new Error('synthetic enqueue acknowledgement lost')
        }
        await wake.retryQueuedQuestionWake(pool, { userId: 'owner', sessionId: humanSession }, child.runId, third.wake.generation)
        const unknown = enqueued.at(-1)!
        assert.equal((await wake.wakeQueuedQuestionContinuation(pool, 'owner', child.runId)).launched, false, 'an unknown enqueue keeps its deadline')
        assert.equal(await wake.claimQuestionWake(pool, actor, child.runId, unknown.wake, unknown.workflowRunId), true, 'a late callback can claim the same still-current generation')
        assert.equal(await wake.claimQuestionWake(pool, actor, child.runId, unknown.wake, 'duplicate-late-callback'), false)
        assert.equal(await wake.questionWakeClaimed(pool, actor, child.runId, unknown.wake, unknown.workflowRunId), false)
        // The worker can finish before the workflow persists successful wake.
        // Its lifecycle must still park this exact run after Factory advances.
        await pool.query(`UPDATE agent_runs SET status='succeeded',"sessionId"=$2,"startedAt"=now(),"finishedAt"=now() WHERE id=$1`, [child.runId, f.sessionId])
        await pool.query(`UPDATE factory_tasks SET status='passed' WHERE id=$1`, [child.task.id])
        await pool.query(`UPDATE factory_attempts SET status='passed',"finishedAt"=now() WHERE id=$1`, [child.task.attemptId])
        assert.equal(await wake.questionWakeClaimed(pool, actor, child.runId, unknown.wake, unknown.workflowRunId), true, 'lost handoff responses re-enter maintenance after actual claim, even after completion')
        assert.equal(await wake.questionWakeClaimed(pool, actor, child.runId, first.wake, first.workflowRunId), false)
        await wake.finishQuestionWake(pool, actor, child.runId, unknown.wake, unknown.workflowRunId, false)
        assert.equal(await wake.questionWakeOwnsWorkflow(pool, actor, child.runId, unknown.wake, unknown.workflowRunId), true)
        assert.equal(await wake.questionWakeOwnsWorkflow(pool, actor, child.runId, first.wake, first.workflowRunId), false)
        await wake.finishQuestionWake(pool, actor, child.runId, unknown.wake, unknown.workflowRunId, true)
        assert.equal(await wake.questionWakeOwnsWorkflow(pool, actor, child.runId, unknown.wake, unknown.workflowRunId), true, 'late failure cannot rewrite already completed work')
        await pool.query(`UPDATE factory_tasks SET status='cancelled' WHERE id=$1`, [child.task.id])
        assert.equal((await wake.wakeQueuedQuestionContinuation(pool, 'owner', child.runId)).launched, false)
      } finally { Object.assign(wake.questionWakeRuntime, originals) }
    })

    await t.test('missing or ended original machines and expired scope remain in the normal watchdog failure path', async () => {
      const wake = await import('./wake'), { sweepFactoryWatchdog } = await import('../watchdog')
      const originals = { ...wake.questionWakeRuntime }
      try {
        for (const fault of ['missing', 'ended', 'expired'] as const) {
          const f = await fixture({ native: true }), child = await f.createContinuation(), sandboxId = `lost-${child.runId}`
          wake.questionWakeRuntime.store = async () => f.store
          wake.questionWakeRuntime.enqueue = async () => assert.fail('invalid custody must never enqueue')
          await pool.query(`UPDATE agent_runs SET "questionContinuation"="questionContinuation" || jsonb_build_object('requiredSandboxId',$2::text) WHERE id=$1`, [child.runId, sandboxId])
          if (fault !== 'missing') await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId")
            SELECT id,$2,'owner',$3,"issueId",$4,'synthetic-snapshot',$5,$6,"deviceId","deviceRepoId" FROM agent_runs WHERE id=$1`,
          [child.runId, f.workspaceId, f.runtimeBotId, sandboxId, randomUUID(), fault === 'ended' ? 'ended' : 'paused'])
          if (fault === 'expired') await pool.query(`UPDATE factory_questions SET "expiresAt"=now()-interval '1 second' WHERE id=$1`, [f.questionId])
          assert.equal((await wake.wakeQueuedQuestionContinuation(pool, 'owner', child.runId)).handled, false, fault)
          const result = await sweepFactoryWatchdog(pool, {
            runtime: () => ({ store: f.store, reconcile: { run: async () => assert.fail('no run completed') } }),
            dispatch: async () => { assert.fail('no new execution') }, wake: async () => undefined,
            recoverQuestion: (userId, runId, now) => wake.wakeQueuedQuestionContinuation(pool, userId, runId, now),
          }, new Date(Date.now() + 60 * 60_000), Date.now() + 20_000, { userId: 'owner', runId: child.runId })
          assert.equal(result.blocked, 1, fault)
          assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [child.task.id])).rows[0].status, 'blocked', fault)
          assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [child.runId])).rows[0].stopRequestedAt, fault)
          assert.equal(await wake.questionWakeFailure(pool, 'owner', child.runId), null, 'no fake recoverable wake receipt')
        }
      } finally { Object.assign(wake.questionWakeRuntime, originals) }
    })

    await t.test('receipt, task, owner, answer, epoch, adjacency and cloud scope mutations fail closed', async () => {
      const f = await fixture({ native: true }), child = await f.createContinuation()
      const otherWorkspace = randomUUID(), otherBot = randomUUID()
      await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,'owner','Different workspace')`, [otherWorkspace])
      await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,'Different runtime')`, [otherBot, otherWorkspace])
      const changes: [string, string, unknown[]][] = [
        ['owner', `UPDATE factory_events SET request=jsonb_set(request,'{userId}','"other"') WHERE "taskId"=$1 AND "eventId"=$2`, [child.task.id, child.eventId]],
        ['answer', `UPDATE factory_questions SET "answerFingerprint"='wrong' WHERE id=$1`, [f.questionId]],
        ['question', `UPDATE factory_events SET result=jsonb_set(result,'{questionId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [child.task.id, child.eventId, randomUUID()]],
        ['epoch', `UPDATE factory_attempts SET output=jsonb_set(output,'{requestEpoch}',to_jsonb($2::text)) WHERE id=$1`, [child.task.attemptId, randomUUID()]],
        ['adjacency', `UPDATE factory_attempts SET position=position+10 WHERE id=$1`, [child.task.attemptId]],
        ['conflicting parent', `UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1`, [child.runId, child.runId]],
        ['workspace', `UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1`, [child.runId, otherWorkspace, otherBot]],
        ['missing cloud binding', `DELETE FROM computer_run_bindings WHERE "runId"=$1`, [child.runId]],
        ['definition', `UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{definitionDigest}','"changed"') WHERE id=$1`, [child.runId]],
      ]
      for (const [label, sql, args] of changes) await transaction(async tx => {
        await tx.query(sql, args)
        assert.equal(await questionExecutionContinuation(tx, child.task, child.task.attemptId), null, label)
      }, true)
      assert.equal(await questionExecutionContinuation(pool, { ...child.task, userId: 'other' }, child.task.attemptId), null)
      assert.equal(await questionExecutionContinuation(pool, { ...child.task, id: randomUUID() }, child.task.attemptId), null)
    })

    await t.test('one legacy recovery receipt joins its original, failed source and queued child without admitting another repair', async () => {
      const f = await fixture({ native: true, withoutBot: true }), first = await f.createContinuation()
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',"sessionId"=$2,"finishedAt"=now() WHERE id=$1`, [first.runId, f.sessionId])
      await pool.query('INSERT INTO byos_native_runs("runId","bindingId") VALUES($1,$2)', [first.runId, f.bindingId])
      let failed = (await f.store.apply('owner', factoryBinding(first.task), randomUUID(), { action: 'finish', status: 'blocked', reason: 'Synthetic failed resume', evidence: [], output: {} })).task
      const recovered = await transaction(async tx => {
        await tx.query(`UPDATE factory_questions SET status='answered' WHERE id=$1`, [f.questionId])
        const requestId = randomUUID(), eventId = factoryEventId('question-recover', requestId)
        const reference = { ...f.reference, questionRevision: 2, binding: factoryBinding(failed) }
        const next = await f.store.retryQuestion('owner', factoryBinding(failed), factoryEventId('question-recover-attempt', requestId), 'Recover the original session.', f.questionId, tx)
        const runId = await f.run(tx, first.runId)
        await tx.query('UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1', [runId, JSON.stringify({ questionId: f.questionId, originRunId: f.originRunId, originSessionId: f.sessionId, requireSessionResume: true })])
        const bound = (await f.store.apply('owner', factoryBinding(next.task), randomUUID(), { action: 'bind_run', runId }, tx)).task
        await tx.query(`UPDATE factory_questions SET status='resuming',"continuationRunId"=$2,revision=revision+1 WHERE id=$1`, [f.questionId, runId])
        await tx.query(`INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)`, [bound.id, eventId,
          JSON.stringify({ kind: 'question_recover', userId: 'owner', input: { requestId, expectedFailedRunId: first.runId, reference } }),
          JSON.stringify({ questionId: f.questionId, continuationRunId: runId, historyRunId: first.runId, originRunId: f.originRunId, originSessionId: f.sessionId, task: bound, replayed: false })])
        // Legacy answer() had no dedicated question_resume receipt. Its later
        // immutable recover receipt still binds all three execution segments.
        await tx.query('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [bound.id, first.eventId])
        return { task: bound, runId, eventId }
      })
      const edge = await questionExecutionContinuation(pool, recovered.task, recovered.task.attemptId)
      assert.deepEqual(edge && [edge.questionOriginAttemptId, edge.originAttemptId, edge.continuationAttemptId], [f.originAttemptId, first.task.attemptId, recovered.task.attemptId])
      assert.equal(edge?.sourceRunId, first.runId, 'command attribution remains the direct predecessor, never recursive origin')
      await transaction(tx => checkFactoryRepairBudget(tx, recovered.task))
      for (const [sql, args] of [
        ['UPDATE agent_runs SET "continuesRunId"=NULL WHERE id=$1', [recovered.runId]],
        [`DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2`, [recovered.task.id, recovered.eventId]],
        [`UPDATE factory_events SET request=jsonb_set(request,'{input,expectedFailedRunId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [recovered.task.id, recovered.eventId, f.originRunId]],
        [`UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{originSessionId}','"wrong"') WHERE id=$1`, [first.runId]],
      ] as [string, unknown[]][]) await transaction(async tx => {
        await tx.query(sql, args)
        assert.equal(await questionExecutionContinuation(tx, recovered.task, recovered.task.attemptId), null)
        await assert.rejects(checkFactoryRepairBudget(tx, recovered.task), { code: 'factoryRecoveryBudgetExceeded' })
      }, true)
      await pool.query(`UPDATE agent_runs SET status='failed',"sessionId"=$2,"finishedAt"=now() WHERE id=$1`, [recovered.runId, f.sessionId])
      await pool.query(`UPDATE factory_questions SET status='resolved' WHERE id=$1`, [f.questionId])
      failed = (await f.store.apply('owner', factoryBinding(recovered.task), randomUUID(), { action: 'finish', status: 'failed', reason: 'Requires a real repair', evidence: [], output: {} })).task
      const lastRepair = (await f.store.apply('owner', factoryBinding(failed), randomUUID(), { action: 'retry', reason: 'Last permitted repair' })).task
      const exhausted = (await f.store.apply('owner', factoryBinding(lastRepair), randomUUID(), { action: 'finish', status: 'failed', reason: 'No more repair budget', evidence: [], output: {} })).task
      const before = await f.store.read('owner', exhausted.id)
      await assert.rejects(f.store.apply('owner', factoryBinding(exhausted), randomUUID(), { action: 'retry', reason: 'A fifth execution is forbidden' }), { code: 'factoryRecoveryBudgetExceeded' })
      assert.deepEqual(await f.store.read('owner', exhausted.id), before)
    })

    for (const harness of ['codex', 'claude_code'] as const) await t.test(`${harness}: legacy v1 completed command provenance requires actual native resume, fixed SHA and a complete source record set`, async () => {
      const f = await fixture({ native: true, harness, legacy: true }), child = await f.createContinuation()
      const head = 'b'.repeat(40), base = 'a'.repeat(40), worktree = `/tmp/fixture-${child.runId}`
      const epoch = Date.now() - 600_000, at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString()
      await pool.query(`UPDATE agent_runs SET "startedAt"=$2,"finishedAt"=$3,"worktreePath"=$4 WHERE id=$1`, [f.originRunId, at(0), at(120), worktree])
      await pool.query(`UPDATE factory_questions SET status='resolved',"answeredAt"=$2 WHERE id=$1`, [f.questionId, at(180)])
      await pool.query('UPDATE factory_events SET "createdAt"=$3 WHERE "taskId"=$1 AND "eventId"=$2', [child.task.id, child.eventId, at(240)])
      await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"worktreePath"=$3,"startedAt"=$4,"finishedAt"=$5,report=$6 WHERE id=$1`,
        [child.runId, f.sessionId, worktree, at(300), at(540), JSON.stringify({ sourceCommit: base, deliverableCommit: head, summary: 'Synthetic complete report', verify: { status: 'not_run' } })])
      await addFactoryVisualEvidence(pool,child.runId)
      for (const id of [f.originRunId, child.runId]) await pool.query('INSERT INTO byos_native_runs("runId","bindingId") VALUES($1,$2)', [id, f.bindingId])
      const inputId = randomUUID(), outputId = randomUUID()
      await pool.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,2,$3,$4),($5,$2,3,$6,$7)`,
        [inputId, f.originRunId, JSON.stringify({ type: 'tool-input-available', toolName: harness === 'codex' ? 'shell' : 'Bash', toolCallId: 'source-command', input: { command: 'wc -c REPORT.md && sha256sum REPORT.md' } }), at(10), outputId,
          JSON.stringify({ type: 'tool-output-available', toolCallId: 'source-command', output: { exitCode: 0, output: '85 REPORT.md; secret=fixture-value' } }), at(20)])
      const exactQuestion = 'Submit the exact checked artifact for independent review?'
      const exactSummary = 'Pre-question recap:\nRead the original task and checked REPORT.md.\nThe artifact is ready; the next step is independent review after your answer.\n'
      const sourceEventId = factoryEventId('execution-question', f.questionId), waitEventId = factoryEventId('question-wait', f.questionId)
      const handoff = { questionId: f.questionId, kind: 'decision', question: exactQuestion, context: '', options: [] }
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId","runId",kind,"dedupeKey",payload,"createdAt") VALUES($1::uuid,'owner',$2,$3,$4,'run_question',$1::text,$5,$6)`,
        [sourceEventId, f.task.botId, f.task.issueId, f.originRunId, JSON.stringify({ ...handoff, taskId: f.task.id, originRunId: f.originRunId, originSessionId: f.sessionId }), at(120)])
      await pool.query(`UPDATE factory_questions SET kind='decision',question=$2,request=$3,"sourceEventId"=$4,"createdAt"=$5 WHERE id=$1`,
        [f.questionId, exactQuestion, JSON.stringify({ handoff, originRunId: f.originRunId, originSessionId: f.sessionId }), sourceEventId, at(120)])
      await pool.query(`INSERT INTO factory_events("taskId","eventId",request,result,"createdAt")
        SELECT "taskId",$2,request,result,$4 FROM factory_events WHERE "taskId"=$1 AND request->'change'->>'status'='waiting' AND result->'task'->>'attemptId'=$3`,
        [f.task.id, waitEventId, f.originAttemptId, at(120)])
      const askInputId = randomUUID(), askOutputId = randomUUID(), submitOutputId = randomUUID(), producerTerminalId = randomUUID()
      const addChunk = async (runId: string, seq: number, chunk: Record<string, unknown>, seconds: number, id = randomUUID()) => {
        await pool.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,$3,$4,$5)`, [id, runId, seq, JSON.stringify(chunk), at(seconds)])
        return id
      }
      await addChunk(f.originRunId, 1, { type: 'start' }, 1)
      await addChunk(f.originRunId, 4, { type: 'tool-input-available', toolCallId: 'real-question', toolName: 'mcp__mikka__ask_human', input: { kind: 'decision', question: exactQuestion, summary: exactSummary } }, 80, askInputId)
      await addChunk(f.originRunId, 5, { type: 'tool-output-available', toolCallId: 'real-question',
        output: harness === 'codex' ? [{ type: 'text', text: 'Recorded. End your turn now.' }] : 'Recorded. End your turn now.' }, 90, askOutputId)
      await addChunk(f.originRunId, 6, { type: 'finish' }, 115)
      await addChunk(f.originRunId, 7, { type: 'data-run-state', transient: true, data: { state: 'stopped', stopReason: 'asked_human' } }, 119)
      await addChunk(child.runId, 1, { type: 'start' }, 301)
      await addChunk(child.runId, 2, { type: 'tool-input-available', toolName: 'ToolSearch', toolCallId: 'find-submit', input: { query: 'select:mcp__mikka__submit' } }, 480)
      await addChunk(child.runId, 3, { type: 'tool-output-available', toolCallId: 'find-submit', output: 'Submission tool schema' }, 481)
      await addChunk(child.runId, 4, { type: 'tool-input-available', toolName: 'mcp__mikka__submit', toolCallId: 'submit-only', input: { summary: 'This untrusted summary is not lifecycle evidence.' } }, 500)
      await addChunk(child.runId, 5, { type: 'tool-output-available', toolCallId: 'submit-only', output: 'Recorded.' }, 510, submitOutputId)
      await addChunk(child.runId, 6, { type: 'finish' }, 530)
      await addChunk(child.runId, 7, { type: 'data-run-state', transient: true, data: { state: 'succeeded', stopReason: 'submitted' } }, 539, producerTerminalId)
      let task = (await f.store.apply('owner', factoryBinding(child.task), randomUUID(), { action: 'candidate', runId: child.runId,
        candidate: { kind: 'deliverable', sha: null, repository: '/tmp/fixture', environment: `device:${f.deviceId}`, scope: 'Synthetic artifact' } })).task
      const candidate = { id: task.candidateId!, executionSha: head, producerExecution: { runId: child.runId, sessionId: f.sessionId } }
      task = (await f.store.apply('owner', factoryBinding(task), randomUUID(), { action: 'finish', status: 'passed', reason: 'Synthetic producer submission', output: { runId: child.runId },
        evidence: [{ artifact: `run-report:${child.runId}`, kind: 'report', runId: child.runId, sessionId: f.sessionId, candidateId: candidate.id, sha: null, environment: `device:${f.deviceId}`, recordedAt: at(540) }] })).task
      task = (await f.store.apply('owner', factoryBinding(task), randomUUID(), { action: 'advance', stage: 'review', reason: 'Independent review remains required' })).task
      const snapshot = async () => (await pool.query(`SELECT jsonb_build_object(
        'runs',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM agent_runs r WHERE r.id=ANY($1::uuid[])),
        'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.position) FROM factory_attempts a WHERE a."taskId"=$2),
        'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e."eventId") FROM factory_events e WHERE e."taskId"=$2)) AS value`, [[f.originRunId, child.runId], task.id])).rows[0].value
      const before = await snapshot()
      const observations = JSON.parse(await producerCommandObservations(pool, task, candidate))
      assert.deepEqual(observations.records, [], 'the current segment has submit only')
      assert.equal(observations.inheritedRecordsOmitted, false)
      assert.equal(observations.inheritedRecords.length, 1)
      assert.equal(observations.inheritedRecords[0].sourceRunId, f.originRunId)
      assert.equal(observations.inheritedRecords[0].sourceStatus, 'stopped')
      assert.equal(observations.inheritedRecords[0].sourceSessionId, f.sessionId)
      assert.equal(observations.inheritedRecords[0].outputChunkId, outputId)
      assert.equal(observations.inheritedRecords[0].observedAt, at(20))
      assert.equal(observations.inheritedRecords[0].candidateSha, head)
      assert.doesNotMatch(JSON.stringify(observations), /fixture-value/)
      assert.deepEqual(await snapshot(), before, 'reading evidence never rewrites an attempt, report, receipt or verdict')
      const execution = await questionExecutionObservations(pool, task, candidate)
      assert.ok(execution.data && 'question' in execution.data)
      assert.equal(execution.data.lifecycleComplete, true)
      assert.equal(execution.data.question.text, exactQuestion)
      assert.equal(execution.data.question.nativeQuestion?.inputChunkId, askInputId)
      assert.equal(execution.data.question.nativeQuestion?.outputChunkId, askOutputId)
      assert.equal(execution.data.schemaVersion, 2)
      assert.equal(execution.data.question.nativeQuestion?.summary, exactSummary, 'the exact paired ask_human input preserves every newline')
      assert.equal(execution.data.question.nativeQuestion?.summaryStatus, 'complete')
      assert.equal(execution.data.question.waitEventId, waitEventId)
      assert.deepEqual([execution.data.answer.id, execution.data.answer.source, execution.data.answer.text], [f.answerId, 'human', f.answer.input.text])
      assert.deepEqual([execution.data.resume.kind, execution.data.resume.eventId], ['question_resume', child.eventId])
      assert.equal(execution.data.producerToolActivity.enumerationComplete, true)
      assert.deepEqual(execution.data.producerToolActivity.tools.map(tool => tool.toolName), ['ToolSearch', 'mcp__mikka__submit'])
      assert.doesNotMatch(JSON.stringify(execution), /untrusted summary|fixture-value/)
      assert.deepEqual(await snapshot(), before)
      const legacy = await questionExecutionObservations(pool, task, candidate, undefined, undefined, 1)
      assert.ok(legacy.data && 'question' in legacy.data)
      const expectedLegacy = { ...execution.data, schemaVersion: 1, question: { ...execution.data.question, nativeQuestion: {
        ...execution.data.sourceToolActivity.tools.find(tool => tool.inputChunkId === askInputId),
        kind: 'decision', question: exactQuestion, output: harness === 'codex' ? [{ type: 'text', text: 'Recorded. End your turn now.' }] : 'Recorded. End your turn now.',
      } } }
      assert.deepEqual(legacy.data, expectedLegacy, 'v1 must preserve the pre-summary fields and content, without new keys; JSONB may reorder object keys')
      assert.equal(legacy.digest, digest(expectedLegacy))
      assert.notEqual(execution.digest, legacy.digest, 'the new projection must not reuse a v1 digest')
      for (const [version, recorded] of [[1, legacy], [2, execution]] as const) {
        const replay = await questionExecutionObservations(pool, task, candidate, recorded.watermark ?? undefined, undefined, version)
        assert.deepEqual(replay, recorded, 'each version reproduces its own frozen data, watermark and digest')
      }
      const summaryCases: [string, unknown, string][] = [
        ['missing optional summary', undefined, 'missing'],
        ['empty summary', '', 'missing'],
        ['blank summary', ' \n ', 'missing'],
        ['non-string summary', { text: 'Not a native summary string.' }, 'missing'],
        ['exact length bound', 'x'.repeat(4000), 'complete'],
        ['overlong summary', 'A plausible recap must not survive as a sliced proof.\n' + 'x'.repeat(4000), 'truncated'],
        ['redacted summary', 'Checked the artifact; secret=synthetic-summary-secret; waiting for the owner.', 'redacted'],
        ['already redacted summary', 'Checked [REDACTED] before asking.', 'redacted'],
        ['secret reference summary', 'Checked [secret:fixture-summary] before asking.', 'redacted'],
      ]
      for (const [label, summary, status] of summaryCases) await transaction(async tx => {
        if (summary === undefined) await tx.query("UPDATE run_chunks SET chunk=jsonb_set(chunk,'{input}',(chunk->'input')-'summary') WHERE id=$1", [askInputId])
        else await tx.query("UPDATE run_chunks SET chunk=jsonb_set(chunk,'{input,summary}',$2::jsonb) WHERE id=$1", [askInputId, JSON.stringify(summary)])
        const actual = await questionExecutionObservations(tx, task, candidate, execution.watermark ?? undefined)
        assert.ok(actual.data && 'question' in actual.data, label)
        assert.equal(actual.data.question.nativeQuestion?.summaryStatus, status, label)
        assert.equal(actual.data.question.nativeQuestion?.summary, status === 'complete' ? summary : null, label)
        assert.equal(actual.data.lifecycleComplete, true, 'an optional summary cannot invalidate the independently verified question lifecycle: ' + label)
        assert.deepEqual(actual.data.lifecycleIncompleteReasons, [], label)
        assert.notEqual(actual.digest, execution.digest, 'v2 binds the summary observation: ' + label)
        assert.equal((await questionExecutionObservations(tx, task, candidate, legacy.watermark ?? undefined, undefined, 1)).digest, legacy.digest,
          'v1 does not acquire summary fields after dispatch: ' + label)
        assert.doesNotMatch(JSON.stringify(actual), /synthetic-summary-secret|untrusted summary|Synthetic complete report|plausible recap/, label)
      }, true)
      const summaryPrompt = questionExecutionObservationPrompt(execution.data)
      assert.match(summaryPrompt, /summaryStatus=complete/)
      assert.match(summaryPrompt, /summary is optional/)
      assert.match(summaryPrompt, /original criterion requires/)
      const omitted = await questionExecutionObservations(pool, task, candidate, undefined, 0)
      assert.ok(omitted.data)
      assert.equal(omitted.data.lifecycleComplete, false)
      assert.deepEqual(omitted.data.lifecycleIncompleteReasons, ['execution_observations_omitted'])
      if (harness === 'claude_code') await transaction(async tx => {
        // Production CC uses object inputs and string outputs for these two
        // tools. The fixture preserves those shapes, not the production text.
        const decisionResultId = randomUUID()
        const stateChangingTools = [
          { toolName: 'mcp__mikka__record_decision', toolCallId: 'record-choice', input: {
            kind: 'choose', title: 'Choose an evidence route', summary: 'Use the recorded evidence.',
            reason: 'synthetic-decision-reason-must-stay-in-chunk',
            options: [{ id: 'evidence', title: 'Evidence route', disposition: 'selected' }], selectedOptionId: 'evidence',
            sources: [{ role: 'evidence', source: { type: 'run_chunk', id: inputId, runId: f.originRunId } }],
            idempotencyKey: `fixture-choice-${f.questionId}`,
          }, output: JSON.stringify({ decisionId: decisionResultId, recordedAt: at(41), duplicate: false }) },
          { toolName: 'Write', toolCallId: 'write-artifact', input: {
            file_path: '/tmp/fixture/PRIVATE-DETAIL.md', content: 'synthetic-file-content-must-stay-in-chunk',
          }, output: 'File created successfully at: /tmp/fixture/PRIVATE-DETAIL.md' },
        ]
        await tx.query('UPDATE run_chunks SET seq=seq+4 WHERE "runId"=$1 AND seq>=4', [f.originRunId])
        const pairIds: { input: string; output: string }[] = []
        for (const [index, tool] of stateChangingTools.entries()) {
          const ids = { input: randomUUID(), output: randomUUID() }; pairIds.push(ids)
          await tx.query('INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$9)',
            [ids.input, f.originRunId, 4 + index * 2, JSON.stringify({ type: 'tool-input-available', toolName: tool.toolName, toolCallId: tool.toolCallId, input: tool.input }), at(40 + index * 10),
              ids.output, 5 + index * 2, JSON.stringify({ type: 'tool-output-available', toolCallId: tool.toolCallId, output: tool.output }), at(41 + index * 10)])
        }
        const actual = await questionExecutionObservations(tx, task, candidate)
        assert.ok(actual.data && 'sourceToolActivity' in actual.data)
        assert.equal(actual.data.sourceToolActivity.enumerationComplete, true, 'known state-changing tools remain explicitly enumerated')
        assert.equal(actual.data.lifecycleComplete, true)
        assert.deepEqual(actual.data.sourceToolActivity.unclassifiedTools, [])
        assert.deepEqual(actual.data.sourceToolActivity.tools.map(tool => tool.toolName), ['Bash', 'mcp__mikka__record_decision', 'Write', 'mcp__mikka__ask_human'])
        assert.deepEqual(actual.data.sourceToolActivity.tools.slice(1, 3).map(tool => [tool.inputChunkId, tool.outputChunkId]), pairIds.map(ids => [ids.input, ids.output]))
        const prompt = questionExecutionObservationPrompt(actual.data)
        assert.match(prompt, /does not establish read-only execution/)
        assert.match(prompt, /Write can modify files and mcp__mikka__record_decision writes Mikka records/)
        assert.doesNotMatch(prompt, /synthetic-decision-reason|synthetic-file-content|PRIVATE-DETAIL\.md/)
        assert.ok(!prompt.includes(decisionResultId), 'a paired tool result is not promoted into verified decision evidence')
        await tx.query('DELETE FROM run_chunks WHERE id=$1', [pairIds[1].output])
        const missing = await questionExecutionObservations(tx, task, candidate)
        assert.ok(missing.data && 'sourceToolActivity' in missing.data)
        assert.equal(missing.data.sourceToolActivity.enumerationComplete, false)
        assert.equal(missing.data.lifecycleComplete, false)
        assert.ok(missing.data.sourceToolActivity.incompleteReasons.includes('tool_pair_incomplete'), 'recognizing Write cannot excuse its missing output')
      }, true)
      await transaction(async tx => {
        // A daemon without assignment.computer writes transient preparing
        // before the first message; the cloud computer path already has start.
        for (const [runId, start] of [[f.originRunId, 0], [child.runId, 300]] as const) {
          const { rows } = await tx.query('DELETE FROM run_chunks WHERE "runId"=$1 RETURNING *', [runId])
          for (const chunk of rows) await tx.query('INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,$3,$4,$5)',
            [chunk.id, chunk.runId, chunk.seq + 1, JSON.stringify(chunk.chunk), chunk.createdAt])
          await tx.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,1,'{"type":"data-run-state","transient":true,"data":{"state":"preparing"}}',$3)`,
            [randomUUID(), runId, at(start)])
        }
        const actual = await questionExecutionObservations(tx, task, candidate)
        assert.ok(actual.data && 'producerToolActivity' in actual.data)
        assert.equal(actual.data.lifecycleComplete, true)
        assert.equal(actual.data.producerToolActivity.enumerationComplete, true)
        assert.equal(actual.data.producerToolActivity.start.seq, 2)
        await tx.query(`UPDATE run_chunks SET chunk=chunk-'transient' WHERE "runId"=$1 AND seq=1`, [child.runId])
        const invalid = await questionExecutionObservations(tx, task, candidate)
        assert.ok(invalid.data && 'producerToolActivity' in invalid.data)
        assert.equal(invalid.data.producerToolActivity.enumerationComplete, false)
        assert.ok(invalid.data.producerToolActivity.incompleteReasons.includes('message_boundary_incomplete'))
        await tx.query(`UPDATE run_chunks SET chunk='{"type":"tool-input-available","toolName":"Bash","toolCallId":"outside-message"}' WHERE "runId"=$1 AND seq=1`, [child.runId])
        const outside = await questionExecutionObservations(tx, task, candidate)
        assert.ok(outside.data && 'producerToolActivity' in outside.data)
        assert.equal(outside.data.producerToolActivity.enumerationComplete, false)
        assert.ok(outside.data.producerToolActivity.incompleteReasons.includes('message_boundary_incomplete'))
      }, true)
      await transaction(async tx => {
        await tx.query('UPDATE run_chunks SET seq=10 WHERE "runId"=$1 AND seq=7', [f.originRunId])
        for (const [seq, chunk] of [[7, { type: 'start' }], [8, { type: 'text-delta', delta: 'Waiting for the owner' }], [9, { type: 'finish' }]] as const)
          await tx.query('INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,$3,$4,$5)', [randomUUID(), f.originRunId, seq, JSON.stringify(chunk), at(109 + seq)])
        const actual = await questionExecutionObservations(tx, task, candidate)
        assert.ok(actual.data && 'sourceToolActivity' in actual.data)
        assert.equal(actual.data.lifecycleComplete, true, 'multiple closed messages remain a complete native stream')
        await tx.query('DELETE FROM run_chunks WHERE "runId"=$1 AND seq=9', [f.originRunId])
        const invalid = await questionExecutionObservations(tx, task, candidate)
        assert.ok(invalid.data && 'sourceToolActivity' in invalid.data)
        assert.equal(invalid.data.sourceToolActivity.enumerationComplete, false, 'an unclosed later message cannot become complete')
      }, true)
      for (const [label, sql, args, reason] of [
        ['missing question tool output', 'DELETE FROM run_chunks WHERE id=$1', [askOutputId], 'native_question_unavailable_in_direct_source'],
        ['different exact question', `UPDATE run_chunks SET chunk=jsonb_set(chunk,'{input,question}','"Different question"') WHERE id=$1`, [askInputId], 'native_question_mismatch_or_incomplete'],
        ['missing immutable waiting receipt', 'DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, waitEventId], 'question_wait_provenance_unavailable'],
        ['waiting receipt after answer', 'UPDATE factory_events SET "createdAt"=$3 WHERE "taskId"=$1 AND "eventId"=$2', [task.id, waitEventId, at(190)], 'question_timeline_incomplete'],
        ['oversized native question output', `UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output}',to_jsonb($2::text)) WHERE id=$1`, [askOutputId, 'x'.repeat(2100)], 'native_question_mismatch_or_incomplete'],
      ] as [string, string, unknown[], string][]) await transaction(async tx => {
        await tx.query(sql, args)
        const actual = await questionExecutionObservations(tx, task, candidate)
        assert.ok(actual.data && 'question' in actual.data, label)
        assert.equal(actual.data.lifecycleComplete, false, label)
        assert.ok(actual.data.lifecycleIncompleteReasons.includes(reason), label)
      }, true)
      for (const [label, sql, args, reason] of [
        ['missing result', 'DELETE FROM run_chunks WHERE id=$1', [submitOutputId], 'tool_pair_incomplete'],
        ['unknown stream format', `UPDATE run_chunks SET chunk='{"type":"unknown-native-activity"}' WHERE id=$1`, [submitOutputId], 'unclassified_chunk_type'],
        ['Read is never hidden by the command whitelist', `UPDATE run_chunks SET chunk=jsonb_set(chunk,'{toolName}','"Read"') WHERE "runId"=$1 AND seq=2`, [child.runId], 'unclassified_tool'],
        ['stream without terminal state', 'DELETE FROM run_chunks WHERE id=$1', [producerTerminalId], 'stream_not_closed'],
      ] as [string, string, unknown[], string][]) await transaction(async tx => {
        await tx.query(sql, args)
        const actual = await questionExecutionObservations(tx, task, candidate)
        assert.ok(actual.data && 'producerToolActivity' in actual.data, label)
        assert.equal(actual.data.producerToolActivity.enumerationComplete, false, label)
        assert.ok(actual.data.producerToolActivity.incompleteReasons.includes(reason), label)
        if (label.startsWith('Read')) assert.ok(actual.data.producerToolActivity.tools.some(tool => tool.toolName === 'Read'))
      }, true)
      await transaction(async tx => {
        const text = 'Approve secret=synthetic-question-secret only?'
        await tx.query(`UPDATE factory_questions SET question=$2,request=jsonb_set(request,'{handoff,question}',to_jsonb($2::text)) WHERE id=$1`, [f.questionId, text])
        await tx.query(`UPDATE coordinator_events SET payload=jsonb_set(payload,'{question}',to_jsonb($2::text)) WHERE id=$1`, [sourceEventId, text])
        await tx.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{input,question}',to_jsonb($2::text)) WHERE id=$1`, [askInputId, text])
        await tx.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{type}','"secret=synthetic-chunk-secret"') WHERE id=$1`, [producerTerminalId])
        const actual = await questionExecutionObservations(tx, task, candidate)
        assert.ok(actual.data && 'question' in actual.data)
        assert.equal(actual.data.lifecycleComplete, false, 'a redacted exact question cannot prove exact wording')
        assert.ok(actual.data.lifecycleIncompleteReasons.includes('question_or_answer_text_incomplete'))
        assert.equal(actual.data.producerToolActivity.enumerationComplete, false)
        assert.doesNotMatch(JSON.stringify(actual), /synthetic-question-secret|synthetic-chunk-secret/)
      }, true)
      await transaction(async tx => {
        await tx.query('UPDATE run_chunks SET seq=seq+66 WHERE "runId"=$1 AND seq>=6', [child.runId])
        await tx.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt")
          SELECT gen_random_uuid(),$1,g+6,CASE WHEN g%2=0
            THEN jsonb_build_object('type','tool-input-available','toolName','ToolSearch','toolCallId','bounded-'||(g/2)::text)
            ELSE jsonb_build_object('type','tool-output-available','toolCallId','bounded-'||(g/2)::text) END,$2::timestamptz
          FROM generate_series(0,65) g`, [child.runId, at(520)])
        const actual = await questionExecutionObservations(tx, task, candidate)
        assert.ok(actual.data && 'producerToolActivity' in actual.data)
        assert.equal(actual.data.producerToolActivity.enumerationComplete, false)
        assert.ok(actual.data.producerToolActivity.incompleteReasons.includes('tool_index_omitted'))
        assert.ok(actual.data.producerToolActivity.tools.length <= 32)
      }, true)
      const corrupted: [string, string, unknown[], boolean][] = [
        ['missing native claim', 'DELETE FROM byos_native_runs WHERE "runId"=$1', [child.runId], false],
        ['different actual SID', 'UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [f.originRunId, 'different-native-session'], false],
        ['wrong fixed candidate SHA', `UPDATE agent_runs SET report=jsonb_set(report,'{deliverableCommit}',to_jsonb($2::text)) WHERE id=$1`, [child.runId, 'c'.repeat(40)], false],
        ['resume before receipt', 'UPDATE agent_runs SET "startedAt"=$2 WHERE id=$1', [child.runId, at(200)], false],
        ['source after answer', 'UPDATE agent_runs SET "finishedAt"=$2 WHERE id=$1', [f.originRunId, at(200)], false],
        ['missing output', 'DELETE FROM run_chunks WHERE id=$1', [outputId], true],
        ['oversized input', `UPDATE run_chunks SET chunk=jsonb_set(chunk,'{input}',to_jsonb($2::text)) WHERE id=$1`, [inputId, 'x'.repeat(5000)], true],
      ]
      for (const [label, sql, args, omitted] of corrupted) await transaction(async tx => {
        await tx.query(sql, args)
        const result = JSON.parse(await producerCommandObservations(tx, task, candidate))
        assert.deepEqual(result.inheritedRecords, [], label)
        assert.equal(result.inheritedRecordsOmitted, omitted, label)
        if (!omitted) assert.equal((await questionExecutionObservations(tx, task, candidate)).data, null, label)
      }, true)

      // The continuation message uses this same receipt-bound reader and the
      // citation sources frozen by real check dispatch, not the old empty prompt.
      const checkDevice = randomUUID(), checkAgent = randomUUID(), checkRepo = randomUUID()
      await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,"lastSeenAt",harnesses) VALUES($1,'owner','Independent check','cloud',now(),$2)`,
        [checkDevice, JSON.stringify([{ harness, installed: true }])])
      await pool.query(`INSERT INTO agents(id,"userId","deviceId",harness,name) VALUES($1,'owner',$2,$3,$4)`, [checkAgent, checkDevice, harness, `Independent checker ${checkAgent}`])
      await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,'owner','/tmp/fixture')`, [checkRepo, checkDevice])
      const dispatch = createFactoryDispatch(pool, f.store, async (tx, owner, input, botId) => {
        const runId = randomUUID(), prompt = 'Original criteria stay frozen; no new command permission.'
        const definition = freezeWorkerDefinition({ harness, model: f.definition.model, readOnly: true,
          instructions: 'Independent read-only check', prompt, parent: null, executionId: null })
        await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt,"agentDefinition")
          VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9)`,
          [runId, owner, input.issueId, checkAgent, checkDevice, checkRepo, botId, prompt, JSON.stringify(definition)])
        await tx.query(`INSERT INTO computer_run_bindings("runId","ownerId","workspaceId","botId") VALUES($1,$2,$3,$4)`,
          [runId, owner, f.workspaceId, f.runtimeBotId])
        await tx.query(`INSERT INTO thread_machines("runId","ownerId","workspaceId","botId","issueId","deviceId","repoId",state,"sandboxId","snapshotId","operationId")
          VALUES($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10)`,
          [runId, owner, f.workspaceId, f.runtimeBotId, input.issueId, checkDevice, checkRepo, `independent-${runId}`, harness === 'codex' ? 'codex' : 'claude', randomUUID()])
        return { runId }
      })
      await transaction(async tx => {
        const { rows: tail } = await tx.query('DELETE FROM run_chunks WHERE "runId"=$1 AND seq>=5 RETURNING *', [child.runId])
        const input = { binding: factoryBinding(task), agentId: checkAgent, deviceRepoId: checkRepo }
        const incomplete = await dispatch('owner', input, tx)
        const first = await appendFactoryCheckContinuationContext(tx, incomplete.task, incomplete.runId, 'Continue the same check.')
        assert.match(first, /stream_not_closed/, 'an incomplete stream does not prevent an ordinary artifact check')
        const frozen = (await tx.query('SELECT output FROM factory_attempts WHERE id=$1', [incomplete.task.attemptId])).rows[0].output.check.questionExecutionObservation
        assert.deepEqual(frozen.watermark, { source: 7, producer: 4 })
        assert.equal(frozen.projectionVersion, 2)
        for (const chunk of tail) await tx.query('INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,$3,$4,$5)',
          [chunk.id, chunk.runId, chunk.seq, JSON.stringify(chunk.chunk), chunk.createdAt])
        assert.equal(await appendFactoryCheckContinuationContext(tx, incomplete.task, incomplete.runId, 'Continue the same check.'), first,
          'late output and terminal chunks cannot rewrite this attempt’s incomplete prefix')
        assert.equal((await dispatch('owner', input, tx)).replayed, true, 'dispatch replay retains its saved evidence descriptor')
        assert.deepEqual((await tx.query('SELECT output FROM factory_attempts WHERE id=$1', [incomplete.task.attemptId])).rows[0].output.check.questionExecutionObservation, frozen)
        const refreshed = await questionExecutionObservations(tx, incomplete.task, candidate)
        assert.ok(refreshed.data && 'producerToolActivity' in refreshed.data)
        assert.equal(refreshed.data.producerToolActivity.enumerationComplete, true, 'a new configuration can observe the now-closed stream')
        assert.notEqual(refreshed.digest, frozen.digest)
      }, true)
      const checking = await dispatch('owner', { binding: factoryBinding(task), agentId: checkAgent, deviceRepoId: checkRepo })
      const originalFollowUp = 'Continue only this original independent check.'
      const beforeFollowUp = await snapshot()
      const followUp = await appendFactoryCheckContinuationContext(pool, checking.task, checking.runId, originalFollowUp)
      assert.ok(followUp.startsWith(originalFollowUp + '\n\n'))
      const delivered = JSON.parse(followUp.split('\n').at(-1)!)
      assert.deepEqual(delivered, observations, 'the delivered evidence retains the original stopped source and immutable resume receipt')
      assert.match(followUp, /run-chunk:<outputChunkId>/)
      assert.ok(followUp.includes(JSON.stringify(execution.data)), 'actual native follow-up carries frozen question/wait/answer/receipt and full activity index')
      assert.match(followUp, /empty command whitelist is not an empty activity stream/)
      assert.doesNotMatch(followUp, /fixture-value|Original issue and standing instructions/)
      assert.deepEqual(await snapshot(), beforeFollowUp, 'building the native message cannot rewrite frozen evidence or verdicts')
      const currentDescriptor = (await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [checking.task.attemptId])).rows[0].output.check.questionExecutionObservation
      assert.equal(currentDescriptor.projectionVersion, 2)
      await transaction(async tx => {
        // An actual pre-upgrade descriptor carries the v1 digest and has no
        // version key. Merely removing the key from a v2 descriptor is invalid.
        const descriptor = { watermark: legacy.watermark, digest: legacy.digest }
        await tx.query("UPDATE factory_attempts SET output=jsonb_set(output,'{check,questionExecutionObservation}',$2::jsonb) WHERE id=$1",
          [checking.task.attemptId, JSON.stringify(descriptor)])
        const resumed = await appendFactoryCheckContinuationContext(tx, checking.task, checking.runId, originalFollowUp)
        assert.ok(resumed.includes(JSON.stringify(legacy.data)), 'an existing waiting check receives its exact admitted v1 evidence')
        assert.ok(!resumed.includes(JSON.stringify(execution.data)), 'legacy continuation cannot silently adopt the new projection')
        await tx.query("UPDATE run_chunks SET chunk=jsonb_set(chunk,'{input,summary}',to_jsonb($2::text)) WHERE id=$1", [askInputId, 'Summary changed after an old v1 check.'])
        assert.equal(await appendFactoryCheckContinuationContext(tx, checking.task, checking.runId, originalFollowUp), resumed,
          'a field absent from v1 cannot invalidate that version’s historical digest')
      }, true)
      for (const [label, sql, args] of [
        ['missing immutable receipt', 'DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, child.eventId]],
        ['different original SID', 'UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [f.originRunId, 'different-native-session']],
        ['changed fixed candidate', `UPDATE agent_runs SET report=jsonb_set(report,'{deliverableCommit}',to_jsonb($2::text)) WHERE id=$1`, [child.runId, 'c'.repeat(40)]],
        ['changed admitted question', `UPDATE run_chunks SET chunk=jsonb_set(chunk,'{input,question}','"Changed after dispatch"') WHERE id=$1`, [askInputId]],
        ['changed admitted summary', "UPDATE run_chunks SET chunk=jsonb_set(chunk,'{input,summary}',to_jsonb($2::text)) WHERE id=$1", [askInputId, 'Changed after dispatch']],
        ['unknown projection version', "UPDATE factory_attempts SET output=jsonb_set(output,'{check,questionExecutionObservation,projectionVersion}','3'::jsonb) WHERE id=$1", [checking.task.attemptId]],
        ['changed frozen digest', `UPDATE factory_attempts SET output=jsonb_set(output,'{check,questionExecutionObservation,digest}',to_jsonb($2::text)) WHERE id=$1`, [checking.task.attemptId, '0'.repeat(64)]],
        ['records after a closed snapshot', `INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,8,'{"type":"text-delta","delta":"Late activity"}',$3)`, [randomUUID(), child.runId, at(539)]],
      ] as [string, string, unknown[]][]) await transaction(async tx => {
        await tx.query(sql, args)
        await assert.rejects(appendFactoryCheckContinuationContext(tx, checking.task, checking.runId, originalFollowUp),
          { code: 'factoryCheckBindingMismatch' }, label)
      }, true)
    })

    await t.test('only the verified transient answered transaction may bypass the repair cap', async () => {
      const f = await fixture({ native: true })
      const wrongRun = await f.run(pool), otherWorkspace = randomUUID(), otherBot = randomUUID()
      await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,'owner','Different workspace')`, [otherWorkspace])
      await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,'Different runtime')`, [otherBot, otherWorkspace])
      for (const [sql, args] of [
        [`UPDATE factory_questions SET status='waiting_user' WHERE id=$1`, [f.questionId]],
        [`UPDATE factory_questions SET "answerFingerprint"='wrong' WHERE id=$1`, [f.questionId]],
        [`UPDATE factory_questions SET "originRunId"=$2 WHERE id=$1`, [f.questionId, wrongRun]],
        [`UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1`, [f.originRunId, otherWorkspace, otherBot]],
      ] as [string, unknown[]][]) await transaction(async tx => {
        await tx.query(sql, args)
        await assert.rejects(f.store.retryQuestion('owner', factoryBinding(f.task), randomUUID(), 'Same reason is not authority.', f.questionId, tx), { code: 'factoryQuestionContinuationUnavailable' })
      }, true)
      const before = (await f.store.read('owner', f.task.id)).attempts.length
      await transaction(async tx => {
        await assert.rejects(f.store.retryQuestion('other', factoryBinding(f.task), randomUUID(), 'Foreign owner.', f.questionId, tx), { code: 'factoryNotFound' })
      }, true)
      assert.equal((await f.store.read('owner', f.task.id)).attempts.length, before)
      await f.createContinuation()
    })
  } finally {
    if (previousByos === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = previousByos
    if (previousRoutes === undefined) delete process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES; else process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = previousRoutes
    await closeWorkspaceDatabase?.()
    await (await import('../../db')).pool.end()
    await pool.end()
    await dropTestDatabase(admin, database)
    await admin.end()
  }
})
