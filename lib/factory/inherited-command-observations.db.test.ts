import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace';
import { bindFixtureWorkspaceDatabase } from '../../tests/helpers/workspace-database';
import { createLegacyFactoryStore as createFactoryStore } from '../../tests/helpers/factory-legacy';
// Real isolated PostgreSQL contracts. The VM observation and Harness reports
// below are explicit synthetic fixtures, never live-provider acceptance.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readFile, readdir } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { applyApprovalMode, defaultRunPolicy } from '@mikka/protocol/agent-policy'

import { createFactoryDispatch, defaultFactoryDispatchAdapters, factoryBinding, type FactoryQueue } from './dispatch'
import { createFactoryHumanStore } from './human-store'
import { handleFactory } from './http'
import { createFactoryQuestions } from './questions/store'
import { humanQuestionAnswerSchema, questionFingerprint } from './questions/contract'
import { configureFactoryCheck, factoryCheckGates, producerCommandObservations } from './checks'
import { factoryCheckIndependent } from './check-independence'
import { sweepFactoryWatchdog } from './watchdog'
import { factoryEventId } from './event-id'
import { type ObserveRetainedDeliverable, type RetainedDeliverableScope, type RetainedDeliverableSnapshot } from './deliverable-recovery'
import { readDeliverableSnapshotReceipt } from './deliverable-snapshot'

const url = process.env.E2E_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'loopback only')
  assert.match(parsed.pathname, /^\/[a-z0-9_]+_e2e$/, 'database name must end in _e2e')
} else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs E2E_DATABASE_URL')

const base = 'a'.repeat(40), head = 'b'.repeat(40), tree = 'c'.repeat(40)
const targetText = 'factory-1146-codex-d8f3d3f2 resume-1146-recheck-6a265954\n7 - 4 = 3\nverified artifact\n'
const targetHash = createHash('sha256').update(targetText).digest('hex')
const patch = Buffer.from(`diff --git a/DELIVERY.txt b/DELIVERY.txt\nnew file mode 100644\nindex 0000000..1f68b7b\n--- /dev/null\n+++ b/DELIVERY.txt\n@@ -0,0 +1,3 @@\n${targetText.split('\n').filter(Boolean).map(line => '+' + line).join('\n')}\n`)

test('isolated PG: direct question recovery exposes historical native observations without rewriting or passing the producer', { skip: !url, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `factory_history_${randomUUID().replaceAll('-', '')}_e2e`
  await createTestDatabase(admin, database, 'template0')
  const target = new URL(url!)
  target.pathname = '/' + database
  const pool = new Pool({ connectionString: target.toString(), max: 8 })
  let closeWorkspaceDatabase: (() => Promise<void>) | undefined
  const flags = { routing: process.env.MIKKA_FACTORY_ROUTING_ENABLED, lifecycle: process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED }
  try {
    closeWorkspaceDatabase = await bindFixtureWorkspaceDatabase(pool)
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(file, dir), 'utf8'))
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','snapshot@example.invalid',true,now(),now())`)
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '1'
    const authorize = async (userId: string, issueId: string, tx: PoolClient) => (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issueId, userId])).rowCount === 1

    const fixture = async () => {
      const issueId = randomUUID(), sourceEventId = randomUUID(), workspaceId = randomUUID(), botId = randomUUID()
      const deviceId = randomUUID(), repoId = randomUUID(), agentId = randomUUID(), sandboxId = `retained-${randomUUID()}`
      const repoPath = `/home/user/.mikka/bot-workspaces/${botId}`, worktreePath = `/home/user/.mikka/worker/worktrees/${randomUUID()}`
      await seedFixtureWorkspace(pool, 'owner', 'team', workspaceId)
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState",scope) VALUES ($1,'owner','Synthetic legacy delivery','{"type":"doc","content":[]}','todo','normal',$2,'bound','workspace')`, [issueId, workspaceId])
      await pool.query(`INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,'owner','Fixture Bot')`, [botId, workspaceId])
      await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,"lastSeenAt",harnesses) VALUES($1,'owner','Fixture cloud','cloud',now(),'[{"harness":"codex","installed":true}]')`, [deviceId])
      await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,'owner',$3,'codex',$2)`, [agentId, deviceId, `Fixture Codex ${agentId}`])
      await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,'owner',$3)`, [repoId, deviceId, repoPath])
      // The database suite exercises check admission, not provider startup.
      await pool.query(`INSERT INTO cloud_machines("workspaceId","ownerId","sandboxId","operationId","runtimeReady",state,"deviceId") VALUES($1,'owner',$2,$3,true,'running',$4)`, [workspaceId, `fixture-bot-${botId}`, randomUUID(), deviceId])
      await pool.query(`INSERT INTO bot_desktops("botId","workspaceId","ownerId",display) VALUES($1,$2,'owner',1)`, [botId,workspaceId])
      await pool.query(`INSERT INTO bot_cloud_runtimes("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES($1,$2,'owner','codex',$3,$4)`, [botId,workspaceId,agentId,repoId])
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,'owner',$2,$3,'user_message',$1::text,'{"text":"Original 56-byte historical request"}')`, [sourceEventId, botId, issueId])
      const bindingId = randomUUID(), connectionId = randomUUID(), alternateBindingId = randomUUID()
      // A person's connection custody workspace can differ from the execution
      // workspace; both actual native claims must pin the same execution binding.
      await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch,"credentialVersion","secretName","secretDigest","providerSubject") VALUES($1,'owner',$2,'codex','connected',2,1,$3,$4,'synthetic-subject')`, [connectionId, randomUUID(), `synthetic-credential-name-${connectionId}`, 'a'.repeat(64)])
      for (const id of [bindingId, alternateBindingId]) await pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,'owner',$2,$3,$4,2,'codex_cli','gpt-5.6-luna')`, [id, workspaceId, agentId, connectionId])
      const store = createFactoryStore(pool, authorize, botId, { independent: factoryCheckIndependent, gates: factoryCheckGates })
      const queue: FactoryQueue = async (tx, userId, input, runtimeBot) => {
        const runId = randomUUID()
        await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES($1,$2,$3,$4,$5,$6,$7,'queued','Historical original target was 56 bytes.')`, [runId, userId, input.issueId, input.agentId, deviceId, input.deviceRepoId, runtimeBot])
        await tx.query(`INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)`, [runId, botId, workspaceId, userId])
        return { runId }
      }
      const executeDispatch = createFactoryDispatch(pool, store, queue, { configure: { execute: async () => {} }, freeze: async (tx, _task, runId) => {
        await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [runId, JSON.stringify({ schemaVersion: 1, harness: 'codex', model: 'gpt-5.6-luna', modelSource: 'subscription', definitionDigest: 'synthetic-fixture', subscription: { bindingId, route: 'codex_cli', modelId: 'gpt-5.6-luna' } })])
      } })
      const routed = await store.route('owner', { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Synthetic completed native continuation', missingInformation: [], missingPermissions: [], needsSpec: false })
      const producer = await executeDispatch('owner', { binding: factoryBinding(routed.task), agentId, deviceRepoId: repoId })
      const producerRunId = producer.runId, producerAttemptId = producer.task.attemptId
      await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='original-native-session',"startedAt"=now()-interval '2 hours',"finishedAt"=now()-interval '118 minutes',"worktreePath"=$2,report=$3 WHERE id=$1`,
        [producerRunId, worktreePath, JSON.stringify({ sourceCommit: base, summary: 'Original completed report remains unchanged.', verify: { status: 'not_run' } })])
      const clock = Date.now()
      for (const minutes of [0, 3, 8, 17]) await sweepFactoryWatchdog(pool, {
        runtime: () => ({ store, reconcile: { run: async () => { throw new Error('Synthetic historical dispatch failure') } } }),
        dispatch: async () => { throw new Error('Must not dispatch a producer') }, wake: async () => {},
      }, new Date(clock + minutes * 60_000), Date.now() + 20_000, { userId: 'owner', runId: producerRunId })
      const blocked = (await store.read('owner', routed.task.id)).task
      assert.equal(blocked.status, 'blocked')
      const originId = randomUUID(), originAttemptId = randomUUID(), originalQuestionId = randomUUID(), originalQuestionEventId = randomUUID(), answerId = randomUUID()
      const historyRunId = randomUUID(), historyAttemptId = randomUUID(), recoveryRequestId = randomUUID()
      const recoveryEventId = factoryEventId('question-recover', recoveryRequestId)
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,"stopReason","sessionId","agentDefinition",prompt)
        SELECT $2,"userId","issueId","agentId","deviceId","deviceRepoId","botId",'stopped','asked_human','original-native-session',"agentDefinition",'Original question' FROM agent_runs WHERE id=$1`, [producerRunId, originId])
      // The persisted parent exists before the continuation references it.
      await pool.query(`UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1`, [producerRunId, JSON.stringify({ questionId: originalQuestionId, originRunId: originId, originSessionId: 'original-native-session', requireSessionResume: true, requiredSandboxId: sandboxId })])
      await pool.query(`UPDATE agent_runs SET "worktreePath"=$2,"baseBranch"='main',"startedAt"=now()-interval '126 minutes',"finishedAt"=now()-interval '124 minutes' WHERE id=$1`, [originId, worktreePath])
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",kind,status,"stopReason","sessionId","agentDefinition",prompt,"baseBranch","worktreePath","questionContinuation","startedAt","finishedAt")
        SELECT $2,"userId","issueId","agentId","deviceId","deviceRepoId","botId",'implement','failed','error',"sessionId","agentDefinition",'Synthetic historical command turn',"baseBranch","worktreePath","questionContinuation",now()-interval '122 minutes',now()-interval '121 minutes' FROM agent_runs WHERE id=$1`, [producerRunId, historyRunId])
      await pool.query(`INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,'owner')`, [historyRunId, botId, workspaceId])
      for (const runId of [historyRunId, producerRunId]) await pool.query('INSERT INTO byos_native_runs("runId","bindingId") VALUES($1,$2)', [runId, bindingId])
      await pool.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [producerRunId, historyRunId])
      await pool.query('UPDATE factory_attempts SET position=3,ordinal=3,output=output-\'requestEpoch\' WHERE id=$1', [producerAttemptId])
      await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId","sessionId",reason) VALUES($1,$2,'execute',1,1,'waiting',$3,'original-native-session','Original question')`, [originAttemptId, blocked.id, originId])
      await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId","sessionId",reason,output) VALUES($1,$2,'execute',2,2,'blocked',$3,'original-native-session','Historical failed continuation','{}')`, [historyAttemptId, blocked.id, historyRunId])
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1::uuid,'owner',$2,'run_question',$1::text,'{}')`, [originalQuestionEventId, botId])
      const waiting = { taskId: blocked.id, issueId, attemptId: originAttemptId, candidateId: null, revision: 2 }
      const answerInput = humanQuestionAnswerSchema.parse({ answerId, text: `Exact target is 85 UTF-8 bytes, SHA256 ${targetHash}.\n${targetText}`, reference: { questionId: originalQuestionId, questionRevision: 1, binding: waiting, originRunId: originId, originSessionId: 'original-native-session' } })
      const answer = { source: 'human', userId: 'owner', input: answerInput }
      await pool.query(`INSERT INTO factory_questions(id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,context,request,status,revision,reason,"sourceEventId","answerId","answerSource",answer,"answerFingerprint","answeredAt","continuationRunId",result)
        VALUES($1,'owner',$2,$3,$4,'execute',$5,'original-native-session',1,$6,'external','Which exact target?','Historical context','{}','resolved',3,'Answered',$7,$8,'human',$9,$10,now()-interval '123 minutes',$11,'{"legacyResult":"preserved"}')`,
      [originalQuestionId, issueId, blocked.id, originAttemptId, originId, JSON.stringify(waiting), originalQuestionEventId, answerId, JSON.stringify(answer), questionFingerprint(answer), producerRunId])
      const recoveryReference = { questionId: originalQuestionId, questionRevision: 2, originRunId: originId, originSessionId: 'original-native-session', binding: { taskId: blocked.id, issueId, attemptId: historyAttemptId, candidateId: null, revision: blocked.revision } }
      const recoveryRequest = { kind: 'question_recover', userId: 'owner', input: { requestId: recoveryRequestId, expectedFailedRunId: historyRunId, reference: recoveryReference } }
      const recoveryResult = { questionId: originalQuestionId, continuationRunId: producerRunId, historyRunId, originRunId: originId, originSessionId: 'original-native-session', replayed: false,
        task: { ...blocked, attemptId: producerAttemptId, sourceEventId, candidateId: null, stage: 'execute', status: 'running', revision: blocked.revision + 2 } }
      await pool.query(`INSERT INTO factory_events("taskId","eventId",request,result,"createdAt") VALUES($1,$2,$3,$4,now()-interval '120 minutes 30 seconds')`, [blocked.id, recoveryEventId, JSON.stringify(recoveryRequest), JSON.stringify(recoveryResult)])
      const inputId = randomUUID(), outputId = randomUUID()
      await pool.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,79,$3,now()-interval '121 minutes 40 seconds'),($4,$2,80,$5,now()-interval '121 minutes 30 seconds')`, [
        inputId, historyRunId, JSON.stringify({ type: 'tool-input-available', toolName: 'bash', toolCallId: 'historical-check', input: { command: 'wc -c DELIVERY.txt && sha256sum DELIVERY.txt && git rev-parse HEAD' } }), outputId,
        JSON.stringify({ type: 'tool-output-available', toolCallId: 'historical-check', output: { exitCode: 0, output: `85 DELIVERY.txt\n${targetHash} DELIVERY.txt\n${head}\npassword=fixture-secret-must-not-leak` } }),
      ])
      await pool.query(`INSERT INTO run_checkpoints("runId","userId","baseCommit",patch,files,"takenAt","updatedAt") VALUES($1,'owner',$2,$3,1,now()-interval '119 minutes',now()-interval '119 minutes')`, [producerRunId, base, gzipSync(patch)])
      const completionEventId = randomUUID()
      const recovered = await store.retryCompletion('owner', { taskId: blocked.id, revision: blocked.revision }, completionEventId, 'Synthetic historical completion recovery')
      assert.ok(recovered)
      const pending = recovered.result.task, oldCandidateId = pending.candidateId!
      // This is the historical defect being recovered: the past reviewer was
      // assigned the diff baseline before the new no-fallback check existed.
      const oldReviewId = (await queue(pool as unknown as PoolClient, 'owner', { issueId, agentId, deviceRepoId: repoId }, botId, { sourceEventId, attemptId: pending.attemptId })).runId
      await pool.query(`UPDATE agent_runs SET kind='acceptance',"baseBranch"=$2 WHERE id=$1`, [oldReviewId, base])
      await pool.query('UPDATE factory_attempts SET output=output||$2::jsonb WHERE id=$1', [pending.attemptId, JSON.stringify({ check: { stage: 'review', requestEpoch: sourceEventId, candidateId: oldCandidateId, sha: base, repository: repoPath, environment: `device:${deviceId}`, deviceRepoId: repoId, command: null, reportOnly: true, policy: applyApprovalMode(defaultRunPolicy(), 'read_only') } })])
      await store.apply('owner', factoryBinding(pending), randomUUID(), { action: 'bind_run', runId: oldReviewId })
      await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='blocked',"sessionId"='old-independent-review',"startedAt"=now()-interval '5 minutes',"finishedAt"=now()-interval '3 minutes',report=$2 WHERE id=$1`,
      [oldReviewId, JSON.stringify({ summary: 'Artifact inspection refused or unavailable.', blockedOn: 'mikka.inspect_artifact_unavailable', check: { sha: base, readOnly: true }, verify: { status: 'not_run' }, filesChanged: [] })])
      const checkDispatch = createFactoryDispatch(pool, store, queue, defaultFactoryDispatchAdapters)
      const questions = createFactoryQuestions(pool, authorize, store, checkDispatch)
      const question = await questions.record('owner', oldReviewId)
      await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId") VALUES($1,$2,'owner',$3,$4,$5,'desktop',$6,'paused',$7,$8)`, [oldReviewId, workspaceId, botId, issueId, sandboxId, randomUUID(), deviceId, repoId])
      const state = await store.read('owner', pending.id)
      assert.equal(state.task.stage, 'review')
      assert.equal(state.task.status, 'waiting')
      assert.ok(state.completionRecovery)
      const oldEvents = (await pool.query('SELECT "eventId" FROM factory_events WHERE "taskId"=$1', [state.task.id])).rows.map(row => row.eventId)
      const historical = async () => ({
        runs: (await pool.query('SELECT to_jsonb(r) AS row FROM agent_runs r WHERE id=ANY($1::uuid[]) ORDER BY id', [[producerRunId, originId, historyRunId, oldReviewId]])).rows,
        attempts: (await pool.query('SELECT to_jsonb(a) AS row FROM factory_attempts a WHERE id=ANY($1::uuid[]) ORDER BY id', [[producerAttemptId, originAttemptId, historyAttemptId, pending.attemptId]])).rows,
        questions: (await pool.query('SELECT to_jsonb(q) AS row FROM factory_questions q WHERE id=ANY($1::uuid[]) ORDER BY id', [[originalQuestionId, question.id]])).rows,
        candidate: (await pool.query('SELECT to_jsonb(c) AS row FROM factory_candidates c WHERE id=$1', [oldCandidateId])).rows,
        receipts: (await pool.query('SELECT to_jsonb(e) AS row FROM factory_events e WHERE "taskId"=$1 AND "eventId"=ANY($2::uuid[]) ORDER BY "eventId"', [state.task.id, oldEvents])).rows,
      })
      const request = { userId: 'owner', method: 'POST', taskId: state.task.id, origin: 'https://fixture.invalid', url: `https://fixture.invalid/api/factory/tasks/${state.task.id}`,
        body: { binding: { taskId: state.task.id, revision: state.task.revision }, eventId: randomUUID(), action: 'retry', reason: 'Inspect the original retained delivery and retry review' } }
      let observedCount = 0, releaseCount = 0, dispatchCount = 0, startCount = 0
      const observer = (options: { changeSnapshot?: (snapshot: RetainedDeliverableSnapshot) => void; duringObservation?: (scope: RetainedDeliverableScope) => Promise<void> } = {}): ObserveRetainedDeliverable => async scope => {
        observedCount++
        const probe = await pool.connect()
        try { await probe.query('BEGIN'); await probe.query('SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE NOWAIT', [scope.taskId]); await probe.query('ROLLBACK') }
        finally { probe.release() }
        const leaseId = randomUUID()
        const leased = await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '3 minutes' WHERE "runId"=$1 AND state='paused' AND ("workerLeaseUntil" IS NULL OR "workerLeaseUntil"<=now())`, [scope.machineRunId, leaseId])
        assert.equal(leased.rowCount, 1)
        const snapshot: RetainedDeliverableSnapshot = { head, tree, diffSha256: scope.checkpoint.patchSha256, diffBytes: scope.checkpoint.patchBytes, clean: true, observedAt: new Date().toISOString(), journalUpdatedAt: scope.checkpoint.takenAt, producerRunId: scope.producerRunId, sessionId: scope.producerSessionId, worktreePath: scope.worktreePath, sandboxId: scope.sandboxId, machineRunId: scope.machineRunId }
        options.changeSnapshot?.(snapshot)
        await options.duringObservation?.(scope)
        return { leaseId, snapshot, release: async () => {
          releaseCount++
          await pool.query('UPDATE thread_machines SET "workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "runId"=$1 AND "workerLeaseId"=$2', [scope.machineRunId, leaseId])
        } }
      }
      const human = (observe = observer(), failDispatch = false) => createFactoryHumanStore(pool, () => store, async (tx, _store, task, previousRun) => {
        dispatchCount++
        assert.equal(previousRun.id, oldReviewId, 'the durable handoff starts from the current paused check VM')
        if (failDispatch) throw new Error('Synthetic check admission unavailable')
        await checkDispatch('owner', { binding: factoryBinding(task), agentId, deviceRepoId: repoId }, tx)
        return async () => { startCount++ }
      }, observe)
      return { sourceEventId, answerId, recoveryEventId, historyRunId, historyAttemptId, bindingId, connectionId, alternateBindingId, worktreePath, inputId, outputId, store, questions, checkDispatch, producerRunId, producerAttemptId, originId, originalQuestionId, oldReviewId, oldReviewAttemptId: pending.attemptId, oldCandidateId,
        question, task: state.task, deviceId, agentId, repoId, botId, workspaceId, sandboxId, request, completionEventId, historical, observer, human,
        counts: () => ({ observedCount, releaseCount, dispatchCount, startCount }) }
    }


    const f = await fixture()
    const recovered = await handleFactory(f.human(), f.request)
    assert.equal(recovered.status, 200)
    const result = recovered.body as Awaited<ReturnType<typeof f.store.read>>
    const candidate = { id: result.task.candidateId!, executionSha: head, producerExecution: { runId: f.producerRunId, sessionId: 'original-native-session' } }
    const read = async (tx: Pick<PoolClient, 'query'> = pool, selected = candidate) => JSON.parse(await producerCommandObservations(tx, result.task, selected))
    const history = async (tx: Pick<PoolClient, 'query'> = pool) => ({
      original: await f.historical(),
      task: (await tx.query('SELECT to_jsonb(t) AS row FROM factory_tasks t WHERE id=$1', [f.task.id])).rows,
      attempts: (await tx.query('SELECT to_jsonb(a) AS row FROM factory_attempts a WHERE "taskId"=$1 ORDER BY id', [f.task.id])).rows,
      candidates: (await tx.query('SELECT to_jsonb(c) AS row FROM factory_candidates c WHERE "taskId"=$1 ORDER BY id', [f.task.id])).rows,
      chunks: (await tx.query('SELECT to_jsonb(c) AS row FROM run_chunks c WHERE "runId"=ANY($1::uuid[]) ORDER BY id', [[f.historyRunId, f.producerRunId]])).rows,
    })
    assert.ok(await readDeliverableSnapshotReceipt(pool, result.task, candidate.id))
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_attempts WHERE "taskId"=$1 AND stage=\'execute\' AND output->>\'requestEpoch\' IS NULL', [f.task.id])).rows[0].n, 3, 'legacy attempts really have no epoch field; the host recovery receipt is the explicit proof')

    await t.test('an independent check may use the receipt-bound predecessor as the same execution, with frozen source provenance', async () => {
      const { rows: [attempt] } = await pool.query('SELECT output,"runId" FROM factory_attempts WHERE id=$1', [result.task.attemptId]);
      const { rows: [review] } = await pool.query('SELECT prompt FROM agent_runs WHERE id=$1', [attempt.runId]);
      assert.match(review.prompt, /earlier segment of this same execution/);
      assert.doesNotMatch(review.prompt, /cannot satisfy a requirement for fresh execution/);
      assert.deepEqual(attempt.output.check.questionCommandSources.map((source: { runId: string; outputChunkId: string }) =>
        [source.runId, source.outputChunkId]), [[f.historyRunId, f.outputId]]);
    });

    const executionAssignment = (prompt: string) => {
      const lines = prompt.split('\n')
      const index = lines.findIndex(line => line.startsWith('Host-recorded producer execution assignment ('))
      assert.ok(index >= 0)
      return JSON.parse(lines[index + 1])
    }

    await t.test('the check receives the real native claim separately from the frozen selection and unknown provider model', async () => {
      const { rows: [attempt] } = await pool.query('SELECT "runId" FROM factory_attempts WHERE id=$1', [result.task.attemptId])
      const { rows: [review] } = await pool.query('SELECT prompt FROM agent_runs WHERE id=$1', [attempt.runId])
      const observed = executionAssignment(review.prompt)
      assert.equal(observed.runId, f.producerRunId)
      assert.equal(observed.sessionId, 'original-native-session')
      assert.equal(observed.observedModel, null, 'requested model must never fill a missing provider observation')
      assert.deepEqual(observed.subscription, { bindingId: f.bindingId, route: 'codex_cli', modelId: 'gpt-5.6-luna' })
      assert.deepEqual(observed.nativeClaim, { bindingId: f.bindingId, connectionId: f.connectionId,
        connectionRevision: 2, route: 'codex_cli', modelId: 'gpt-5.6-luna' })
      assert.equal(observed.apiClaim, false)
      assert.doesNotMatch(review.prompt, /synthetic-credential-name|synthetic-subject|secretDigest|accessSecretName/)
      assert.match(review.prompt, /A null observedModel remains unknown/)
      assert.match(review.prompt, /Missing or conflicting required routing evidence remains unverified/)
    })

    await t.test('a frozen subscription cannot invent a native claim and actual API use remains visible', async () => {
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        const { rows: [attempt] } = await tx.query('SELECT "runId" FROM factory_attempts WHERE id=$1', [result.task.attemptId])
        await tx.query('DELETE FROM byos_native_runs WHERE "runId"=$1', [f.producerRunId])
        await tx.query('INSERT INTO model_api_key_runs("runId","keyId") VALUES($1,$2)', [f.producerRunId, randomUUID()])
        await configureFactoryCheck(tx, { ...result.task, status: 'pending' }, attempt.runId)
        const { rows: [review] } = await tx.query('SELECT prompt FROM agent_runs WHERE id=$1', [attempt.runId])
        const observed = executionAssignment(review.prompt)
        assert.equal(observed.subscription.bindingId, f.bindingId)
        assert.equal(observed.nativeClaim, null, 'only a persisted receipt may supply native claim evidence')
        assert.equal(observed.apiClaim, true, 'do not infer no API use from the frozen subscription')
        assert.equal(observed.observedModel, null)
      } finally {
        await tx.query('ROLLBACK')
        tx.release()
      }
    })

    await t.test('a real migrated legacy graph exposes only the direct inherited pair with explicit failed-source attribution', async () => {
      const before = await history(), observed = await read()
      assert.deepEqual(observed.records, [], '390 has no new persisted command; inherited observations never fill that array')
      assert.ok(Array.isArray(observed.inheritedRecords), 'direct recovery history must be a separate typed collection')
      assert.equal(observed.inheritedRecords.length, 1)
      const inherited = observed.inheritedRecords[0]
      assert.equal(inherited.inherited, true)
      assert.equal(inherited.sourceRunId, f.historyRunId)
      assert.equal(inherited.sourceSessionId, 'original-native-session')
      assert.equal(inherited.sourceStatus, 'failed')
      assert.equal(inherited.sourceStopReason, 'error')
      assert.equal(inherited.recoveryEventId, f.recoveryEventId)
      assert.equal(inherited.questionId, f.originalQuestionId)
      assert.equal(inherited.answerId, f.answerId)
      assert.equal(inherited.requestEpoch, f.sourceEventId)
      assert.equal(inherited.candidateSha, head)
      assert.equal(inherited.inputChunkId, f.inputId)
      assert.equal(inherited.outputChunkId, f.outputId)
      assert.equal(inherited.seq, 79)
      assert.equal(inherited.output.exitCode, 0)
      assert.ok(Date.parse(inherited.observedAt) >= Date.parse(inherited.inputObservedAt))
      assert.doesNotMatch(JSON.stringify(observed), /fixture-secret-must-not-leak/)
      assert.equal(Object.hasOwn(inherited, 'passed'), false)
      assert.deepEqual(await history(), before, 'the read leaves old rows and the current task unchanged')
      assert.deepEqual(f.counts(), { observedCount: 1, releaseCount: 1, dispatchCount: 1, startCount: 1 }, 'reading history performs no observer or worker work')
    })

    const corruptions: [string, string, unknown[]][] = [
      ['missing receipt', 'DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.recoveryEventId]],
      ['duplicate receipt', 'INSERT INTO factory_events("taskId","eventId",request,result,"createdAt") SELECT "taskId",$3,request,result,"createdAt" FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.recoveryEventId, randomUUID()]],
      ['wrong history run', `UPDATE factory_events SET result=jsonb_set(result,'{historyRunId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, f.recoveryEventId, f.originId]],
      ['wrong original execute attempt', `UPDATE factory_events SET result=jsonb_set(result,'{task,attemptId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, f.recoveryEventId, result.task.attemptId]],
      ['wrong explicit epoch', `UPDATE factory_events SET result=jsonb_set(result,'{task,sourceEventId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, f.recoveryEventId, randomUUID()]],
      ['wrong source attempt stage', `UPDATE factory_attempts SET stage='spec' WHERE id=$1`, [f.historyAttemptId]],
      ['wrong source attempt status', `UPDATE factory_attempts SET status='passed' WHERE id=$1`, [f.historyAttemptId]],
      ['wrong source attempt session', 'UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1', [f.historyAttemptId, 'different-native-session']],
      ['wrong producer attempt session', 'UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1', [f.producerAttemptId, 'different-native-session']],
      ['wrong source run session', 'UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [f.historyRunId, 'different-native-session']],
      ['wrong canonical answer', `UPDATE factory_questions SET answer=jsonb_set(answer,'{input,text}','"changed without an authenticated fingerprint"') WHERE id=$1`, [f.originalQuestionId]],
      ['missing source actual claim', 'DELETE FROM byos_native_runs WHERE "runId"=$1', [f.historyRunId]],
      ['missing producer actual claim', 'DELETE FROM byos_native_runs WHERE "runId"=$1', [f.producerRunId]],
      ['wrong actual source binding', 'UPDATE byos_native_runs SET "bindingId"=$2 WHERE "runId"=$1', [f.historyRunId, f.alternateBindingId]],
      ['wrong frozen source binding', `UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{subscription,bindingId}',to_jsonb($2::text)) WHERE id=$1`, [f.historyRunId, f.alternateBindingId]],
      ['wrong execution binding owner', 'UPDATE byos_bindings SET "ownerId"=$2 WHERE id=$1', [f.bindingId, 'different-owner']],
      ['wrong execution binding workspace', 'UPDATE byos_bindings SET "workspaceId"=$2 WHERE id=$1', [f.bindingId, randomUUID()]],
      ['wrong execution binding consumer', 'UPDATE byos_bindings SET "consumerId"=$2 WHERE id=$1', [f.bindingId, randomUUID()]],
      ['wrong actual bound model', 'UPDATE byos_bindings SET "modelId"=$2 WHERE id=$1', [f.bindingId, 'different-model']],
      ['wrong connection owner', 'UPDATE byos_connections SET "ownerId"=$2 WHERE id=$1', [f.connectionId, 'different-owner']],
      ['wrong connection revision', 'UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1', [f.connectionId]],
      ['wrong source device', 'UPDATE agent_runs SET "deviceId"=NULL WHERE id=$1', [f.historyRunId]],
      ['wrong source repository', 'UPDATE agent_runs SET "deviceRepoId"=NULL WHERE id=$1', [f.historyRunId]],
      ['wrong source base', 'UPDATE agent_runs SET "baseBranch"=$2 WHERE id=$1', [f.historyRunId, 'different-base']],
      ['wrong source worktree', 'UPDATE agent_runs SET "worktreePath"=$2 WHERE id=$1', [f.historyRunId, '/different-worktree']],
      ['source cancellation', 'UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [f.historyRunId]],
      ['different current candidate', 'UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [f.task.id, f.oldCandidateId]],
      ['command predates answer', `UPDATE run_chunks SET "createdAt"=now()-interval '124 minutes' WHERE id=$1`, [f.inputId]],
      ['output follows source finish', `UPDATE run_chunks SET "createdAt"=now()-interval '120 minutes' WHERE id=$1`, [f.outputId]],
      ['unpaired tool result', `UPDATE run_chunks SET chunk=jsonb_set(chunk,'{toolCallId}','"another-call"') WHERE id=$1`, [f.outputId]],
    ]
    for (const [name, sql, args] of corruptions) await t.test(name + ' provides no inherited evidence', async () => {
      const tx = await pool.connect()
      await tx.query('BEGIN')
      try {
        await tx.query(sql, args)
        const before = (await tx.query('SELECT to_jsonb(t) AS row FROM factory_tasks t WHERE id=$1', [f.task.id])).rows
        assert.deepEqual((await read(tx)).inheritedRecords, [])
        assert.deepEqual((await tx.query('SELECT to_jsonb(t) AS row FROM factory_tasks t WHERE id=$1', [f.task.id])).rows, before, 'the refusal is read-only before rollback')
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })

    for (const malformed of ['missing output', 'duplicate output']) await t.test(malformed + ' makes the whole predecessor command collection incomplete', async () => {
      const tx = await pool.connect()
      await tx.query('BEGIN')
      try {
        const id = malformed === 'missing output' ? f.inputId : f.outputId
        await tx.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt")
          SELECT $2,"runId",1000,CASE WHEN $3 THEN jsonb_set(chunk,'{toolCallId}','"unfinished-command"') ELSE chunk END,"createdAt"
          FROM run_chunks WHERE id=$1`, [id, randomUUID(), malformed === 'missing output'])
        const observed = await read(tx)
        assert.deepEqual(observed.inheritedRecords, [])
        assert.equal(observed.inheritedRecordsOmitted, true, 'a remaining complete command cannot disguise an incomplete set')
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })

    await t.test('truncated native payloads never become usable inherited evidence or disclose their tail', async () => {
      const tx = await pool.connect()
      await tx.query('BEGIN')
      try {
        await tx.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output,output}',to_jsonb($2::text)) WHERE id=$1`, [f.outputId, 'x'.repeat(6100) + 'password=truncated-fixture-secret'])
        const observed = await read(tx)
        assert.deepEqual(observed.records, [])
        assert.deepEqual(observed.inheritedRecords, [])
        assert.equal(observed.inheritedRecordsOmitted, true)
        assert.doesNotMatch(JSON.stringify(observed), /truncated-fixture-secret/)
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })

    for (const budget of [
      { name: 'more than 32 complete pairs', added: 32, outputCharacters: 0 },
      { name: 'complete pairs whose aggregate exceeds 12k', added: 2, outputCharacters: 4000 },
    ]) await t.test(budget.name + ' omit the entire inherited collection', async () => {
      const tx = await pool.connect()
      await tx.query('BEGIN')
      try {
        if (budget.outputCharacters) await tx.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output,output}',to_jsonb($2::text)) WHERE id=$1`, [f.outputId, 'x'.repeat(budget.outputCharacters)])
        for (let index = 0; index < budget.added; index++) {
          for (const [id, offset] of [[f.inputId, 0], [f.outputId, 1]] as const) await tx.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt")
            SELECT $2,"runId",$3,jsonb_set(chunk,'{toolCallId}',to_jsonb($4::text)),"createdAt" FROM run_chunks WHERE id=$1`,
          [id, randomUUID(), 1000 + index * 2 + offset, 'historical-budget-' + index])
        }
        const { rows: [size] } = await tx.query(`SELECT count(*)::int AS pairs,
            max(length((chunk->'output')::text))::int AS "largestOutput"
          FROM run_chunks WHERE "runId"=$1 AND chunk->>'type'='tool-output-available'`, [f.historyRunId])
        assert.equal(size.pairs, budget.added + 1)
        assert.ok(size.largestOutput < 6000, 'every individual payload is complete and below the truncation limit')
        if (budget.outputCharacters) assert.ok(size.pairs <= 32, 'the aggregate limit is exercised without reaching the pair-count limit')
        const observed = await read(tx)
        assert.deepEqual(observed.records, [])
        assert.deepEqual(observed.inheritedRecords, [])
        assert.equal(observed.inheritedRecordsOmitted, true)
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })

    await t.test('a reported failed command stays failed data, never a synthesized pass', async () => {
      const tx = await pool.connect()
      await tx.query('BEGIN')
      try {
        await tx.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output,exitCode}','7') WHERE id=$1`, [f.outputId])
        const observed = await read(tx)
        assert.deepEqual(observed.records, [])
        assert.equal(observed.inheritedRecords[0].output.exitCode, 7)
        assert.equal(Object.hasOwn(observed.inheritedRecords[0], 'passed'), false)
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })

    await t.test('a changed original producer attempt status invalidates the canonical snapshot evidence', async () => {
      const tx = await pool.connect()
      await tx.query('BEGIN')
      try {
        await tx.query(`UPDATE factory_attempts SET status='passed' WHERE id=$1`, [f.producerAttemptId])
        await assert.rejects(read(tx), /factoryDeliverableSnapshotUnavailable/)
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })

    await t.test('a corrupted current snapshot is refused before any historical evidence can be relied on', async () => {
      const tx = await pool.connect()
      await tx.query('BEGIN')
      try {
        await tx.query(`UPDATE factory_events SET result=jsonb_set(result,'{snapshotRecovery,snapshot,diffSha256}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, f.request.body.eventId, 'd'.repeat(64)])
        await assert.rejects(read(tx), /factoryDeliverableSnapshotUnavailable/)
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })
  } finally {
    if (flags.routing === undefined) delete process.env.MIKKA_FACTORY_ROUTING_ENABLED; else process.env.MIKKA_FACTORY_ROUTING_ENABLED = flags.routing
    if (flags.lifecycle === undefined) delete process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED; else process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = flags.lifecycle
    await closeWorkspaceDatabase?.()
    await dropTestDatabase(admin, database, pool)
    await admin.end()
  }
})
