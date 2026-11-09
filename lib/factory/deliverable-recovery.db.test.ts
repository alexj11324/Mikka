import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace';
import { bindFixtureWorkspaceDatabase } from '../../tests/helpers/workspace-database';
import { createLegacyFactoryStore as createFactoryStore } from '../../tests/helpers/factory-legacy';
import { addFactoryVisualEvidence } from '../../tests/helpers/factory-visual-evidence';
import { createFactoryStore as createCurrentFactoryStore } from './store';
// Real isolated PostgreSQL contracts. The VM observation and Harness reports
// below are explicit synthetic fixtures, never live-provider acceptance.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readFile, readdir } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { applyApprovalMode, defaultRunPolicy } from '@mikka/protocol/agent-policy'

import { createFactoryDispatch, defaultFactoryDispatchAdapters, factoryBinding, type FactoryQueue } from './dispatch'
import { createFactoryHumanStore } from './human-store'
import { handleFactory } from './http'
import { createFactoryQuestions } from './questions/store'
import { humanQuestionAnswerSchema, questionFingerprint } from './questions/contract'
import { factoryCheckAssignment, factoryCheckGates } from './checks'
import { factoryCheckIndependent } from './check-independence'
import { sweepFactoryWatchdog } from './watchdog'
import { approvalEvidence } from './evidence'
import { factoryEventId } from './event-id'
import { retainedDeliverableForRecovery, type ObserveRetainedDeliverable, type RetainedDeliverableScope, type RetainedDeliverableSnapshot } from './deliverable-recovery'
import { readDeliverableSnapshotReceipt, resolveFactoryCandidateSha } from './deliverable-snapshot'
import { createRetainedDeliverableObserver, type RetainedDeliverableRuntime } from '../cloud-computer/retained-deliverable'
import { observePoolCommits } from '../db/commit-effects'

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

test('legacy delivery snapshot recovery binds a fresh live observation without rewriting the successful producer or failed review', { skip: !url, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `factory_snapshot_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!)
  target.pathname = '/' + database
  const pool = new Pool({ connectionString: target.toString(), max: 8 })
  observePoolCommits(pool)
  const closeWorkspace = await bindFixtureWorkspaceDatabase(pool)
  const flags = { routing: process.env.MIKKA_FACTORY_ROUTING_ENABLED, lifecycle: process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED }
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const file of orderMigrations((await readdir(dir)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(file, dir), 'utf8'))
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','snapshot@example.invalid',true,now(),now())`)
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '1'
    const authorize = async (userId: string, issueId: string, tx: PoolClient) => (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issueId, userId])).rowCount === 1

    const fixture = async (singleReview = false) => {
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
      const store = (singleReview ? createCurrentFactoryStore : createFactoryStore)(pool, authorize, botId, { independent: factoryCheckIndependent, gates: factoryCheckGates })
      const queue: FactoryQueue = async (tx, userId, input, runtimeBot) => {
        const runId = randomUUID()
        await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES($1,$2,$3,$4,$5,$6,$7,'queued','Historical original target was 56 bytes.')`, [runId, userId, input.issueId, input.agentId, deviceId, input.deviceRepoId, runtimeBot])
        await tx.query(`INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)`, [runId, botId, workspaceId, userId])
        return { runId }
      }
      const executeDispatch = createFactoryDispatch(pool, store, queue, { configure: { execute: async () => {} }, freeze: async (tx, _task, runId) => {
        await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [runId, JSON.stringify({ schemaVersion: 1, harness: 'codex', model: 'gpt-5.6-luna', modelSource: 'subscription', definitionDigest: 'synthetic-fixture' })])
      } })
      const routed = await store.route('owner', { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Synthetic completed native continuation', missingInformation: [], missingPermissions: [], needsSpec: false })
      const producer = await executeDispatch('owner', { binding: factoryBinding(routed.task), agentId, deviceRepoId: repoId })
      const producerRunId = producer.runId, producerAttemptId = producer.task.attemptId
      const captureId = await addFactoryVisualEvidence(pool, producerRunId)
      await pool.query(`UPDATE run_captures SET "createdAt"=now()-interval '119 minutes',"updatedAt"=now()-interval '119 minutes' WHERE id=$1`, [captureId])
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
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,"stopReason","sessionId","agentDefinition",prompt)
        SELECT $2,"userId","issueId","agentId","deviceId","deviceRepoId","botId",'stopped','asked_human','original-native-session',"agentDefinition",'Original question' FROM agent_runs WHERE id=$1`, [producerRunId, originId])
      // The persisted parent exists before the continuation references it.
      await pool.query(`UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1`, [producerRunId, JSON.stringify({ questionId: originalQuestionId, originRunId: originId, originSessionId: 'original-native-session', requireSessionResume: true, requiredSandboxId: sandboxId })])
      await pool.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [producerRunId, originId])
      await pool.query('UPDATE factory_attempts SET position=2,ordinal=2 WHERE id=$1', [producerAttemptId])
      await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId","sessionId",reason) VALUES($1,$2,'execute',1,1,'waiting',$3,'original-native-session','Original question')`, [originAttemptId, blocked.id, originId])
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1::uuid,'owner',$2,'run_question',$1::text,'{}')`, [originalQuestionEventId, botId])
      const waiting = { taskId: blocked.id, issueId, attemptId: originAttemptId, candidateId: null, revision: 2 }
      const answerInput = humanQuestionAnswerSchema.parse({ answerId, text: `Exact target is 85 UTF-8 bytes, SHA256 ${targetHash}.\n${targetText}`, reference: { questionId: originalQuestionId, questionRevision: 1, binding: waiting, originRunId: originId, originSessionId: 'original-native-session' } })
      const answer = { source: 'human', userId: 'owner', input: answerInput }
      await pool.query(`INSERT INTO factory_questions(id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,context,request,status,revision,reason,"sourceEventId","answerId","answerSource",answer,"answerFingerprint","answeredAt","continuationRunId",result)
        VALUES($1,'owner',$2,$3,$4,'execute',$5,'original-native-session',1,$6,'external','Which exact target?','Historical context','{}','resolved',3,'Answered',$7,$8,'human',$9,$10,now()-interval '121 minutes',$11,'{"legacyResult":"preserved"}')`,
      [originalQuestionId, issueId, blocked.id, originAttemptId, originId, JSON.stringify(waiting), originalQuestionEventId, answerId, JSON.stringify(answer), questionFingerprint(answer), producerRunId])
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
        runs: (await pool.query('SELECT to_jsonb(r) AS row FROM agent_runs r WHERE id=ANY($1::uuid[]) ORDER BY id', [[producerRunId, originId, oldReviewId]])).rows,
        attempts: (await pool.query('SELECT to_jsonb(a) AS row FROM factory_attempts a WHERE id=ANY($1::uuid[]) ORDER BY id', [[producerAttemptId, originAttemptId, pending.attemptId]])).rows,
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
      return { store, questions, checkDispatch, producerRunId, producerAttemptId, originId, originalQuestionId, oldReviewId, oldReviewAttemptId: pending.attemptId, oldCandidateId,
        question, task: state.task, deviceId, agentId, repoId, botId, workspaceId, sandboxId, request, completionEventId, historical, observer, human,
        counts: () => ({ observedCount, releaseCount, dispatchCount, startCount }) }
    }

    for (const pauseConfirmed of [true, false]) await t.test(`real observer records maintenance intervals without changing paused custody (${pauseConfirmed ? 'pause confirmed' : 'pause unconfirmed'})`, async () => {
      const f = await fixture(true), before = await f.historical()
      await pool.query(`INSERT INTO workspace_computer_policies("workspaceId",permission,version) VALUES($1,'allow',1)`, [f.workspaceId])
      const client = await pool.connect()
      let scope: RetainedDeliverableScope
      try {
        const eligible = await retainedDeliverableForRecovery(client,f.task)
        assert.ok(eligible)
        scope = eligible.scope
      } finally { client.release() }
      let providerState = 'paused'
      const runtime: RetainedDeliverableRuntime = {
        state: async () => providerState,
        connect: async () => {
          providerState = 'running'
          return { sandboxId:scope.sandboxId, commands:{ run:async () => ({ exitCode:0, stdout:JSON.stringify({ ok:true,value:{
            head,tree,diffSha256:scope.checkpoint.patchSha256,diffBytes:scope.checkpoint.patchBytes,clean:true,
            observedAt:new Date().toISOString(),journalUpdatedAt:scope.checkpoint.takenAt,
            producerRunId:scope.producerRunId,sessionId:scope.producerSessionId,worktreePath:scope.worktreePath,
          } }) }) } }
        },
        pause: async () => { if (!pauseConfirmed) throw new Error('Synthetic pause unacknowledged'); providerState='paused' },
        script: async () => '// synthetic provider executes no host command', now:Date.now, log:() => {},
      }
      const human = f.human()
      const observe = createRetainedDeliverableObserver(pool,(tx,received) => human.lockTask(tx,received.ownerId,received.taskId),runtime)
      if (pauseConfirmed) {
        for (let count=0;count<2;count++) {
          const observed = await observe(scope)
          const machine = (await pool.query('SELECT state,"runningSince","workerLeaseId" FROM thread_machines WHERE "runId"=$1', [scope.machineRunId])).rows[0]
          assert.equal(machine.state,'paused')
          assert.equal(machine.runningSince,null)
          assert.equal(machine.workerLeaseId,observed.leaseId)
          await observed.release()
        }
      } else {
        await assert.rejects(observe(scope),{ code:'factoryDeliverableSnapshotUnavailable' })
        const machine = (await pool.query('SELECT state,"workerLeaseId" FROM thread_machines WHERE "runId"=$1', [scope.machineRunId])).rows[0]
        assert.equal(machine.state,'error')
        assert.ok(machine.workerLeaseId)
      }
      const sessions = (await pool.query('SELECT source,reason,"startedAt","endedAt" FROM thread_machine_sessions WHERE "runId"=$1 ORDER BY "startedAt",id', [scope.machineRunId])).rows
      assert.equal(sessions.length,pauseConfirmed ? 2 : 1)
      for (const session of sessions) {
        assert.equal(session.source,'observed')
        assert.equal(session.reason,pauseConfirmed ? 'paused' : null)
        assert.equal(session.endedAt === null,!pauseConfirmed)
        if (session.endedAt) assert.ok(session.endedAt >= session.startedAt)
      }
      assert.deepEqual(await f.historical(),before,'session evidence does not rewrite the producer, check or question')
    })

    await t.test('single-review retained delivery on an additive image hands off the observed snapshot without rewriting old evidence', async () => {
      const f = await fixture(true)
      await pool.query('UPDATE thread_machines SET "snapshotId"=$2,"templateKind"=$3 WHERE "runId"=$1', [f.oldReviewId, 'retired-derived-desktop', 'desktop'])
      const before = await f.historical()
      assert.equal(f.task.route.flowVersion, 2)
      const response = await handleFactory(f.human(), f.request)
      assert.equal(response.status, 200)
      const result = response.body as Awaited<ReturnType<typeof f.store.read>>
      assert.equal(result.task.stage, 'approval')
      assert.equal(result.task.status, 'pending')
      assert.equal(result.attempts.filter(a => a.stage === 'review').length, 1)
      assert.equal(result.attempts.filter(a => a.stage === 'verify').length, 0)
      assert.notEqual(result.task.candidateId, f.oldCandidateId)
      assert.deepEqual(f.counts(), { observedCount: 1, releaseCount: 1, dispatchCount: 0, startCount: 0 })
      const candidate = result.candidates.find(c => c.id === result.task.candidateId)!
      assert.equal(await resolveFactoryCandidateSha(pool, result.task, candidate, null), head)
      const client = await pool.connect()
      try {
        const accepted = await approvalEvidence(client, result.task)
        assert.deepEqual(accepted.manifest.artifacts.map(a => a.stage), ['execute'])
        assert.deepEqual(accepted.captures.map(a => a.runId), [f.producerRunId])
        assert.equal(accepted.manifest.artifacts[0].deliverableSnapshotSha, head)
        assert.equal(accepted.manifest.reviewHistory?.length, 1)
        assert.equal(accepted.manifest.reviewHistory![0].candidateId, f.oldCandidateId)
        assert.equal(accepted.manifest.reviewHistory![0].status, 'waiting')
        assert.equal(accepted.manifest.reviewHistory![0].appliesToCurrentCandidate, false)
        assert.ok(accepted.evidence.every(a => a.candidateId === candidate.id))
      } finally { client.release() }
      assert.deepEqual(await f.historical(), before)
    })

    await t.test('Owner Retry uses the original producer, makes one immutable receipt and independent candidate, and reaches real approval gates', async () => {
      const f = await fixture(), before = await f.historical()
      assert.equal(await resolveFactoryCandidateSha(pool, f.task, { id: f.oldCandidateId, kind: 'deliverable' }, null), null, 'an old baseline/checkpoint alone supplies no delivery SHA')
      const service = f.human()
      const recovered = await handleFactory(service, f.request)
      assert.equal(recovered.status, 200)
      const result = recovered.body as Awaited<ReturnType<typeof f.store.read>>
      assert.notEqual(result.task.candidateId, f.oldCandidateId)
      assert.equal(result.task.stage, 'review')
      assert.equal(result.task.status, 'running')
      assert.deepEqual(await f.historical(), before)
      assert.deepEqual(f.counts(), { observedCount: 1, releaseCount: 1, dispatchCount: 1, startCount: 1 })
      assert.deepEqual(await handleFactory(service, f.request), recovered, 'receipt replay performs no VM read or dispatch')
      assert.deepEqual(f.counts(), { observedCount: 1, releaseCount: 1, dispatchCount: 1, startCount: 1 })
      assert.equal((await handleFactory(service, { ...f.request, body: { ...f.request.body, reason: 'different intent' } })).status, 409)
      const candidate = result.candidates.find(c => c.id === result.task.candidateId)!
      assert.equal(candidate.runId, f.producerRunId)
      assert.equal(candidate.sha, null)
      assert.equal(candidate.kind, 'deliverable')
      assert.equal((await f.questions.read('owner', f.question.id)).status, 'superseded')
      assert.deepEqual(await f.historical(), before, 'GET derives superseded without updating the old question')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_attempts WHERE "taskId"=$1 AND stage=\'execute\'', [f.task.id])).rows[0].n, 2, 'only the historical origin and producer execute attempts exist')
      for (const stage of ['review', 'verify'] as const) {
        const task = (await f.store.read('owner', f.task.id)).task
        assert.equal(task.stage, stage)
        const run = (await pool.query('SELECT r.* FROM agent_runs r JOIN factory_attempts a ON a."runId"=r.id WHERE a.id=$1', [task.attemptId])).rows[0]
        const assignment = await factoryCheckAssignment(pool, 'owner', run.id)
        assert.equal(assignment.baseBranch, head)
        assert.equal(assignment.policy.readOnly, true)
        assert.equal(run.continuesRunId, null)
        assert.equal(run.questionContinuation, null)
        assert.ok(run.prompt.includes(targetText), 'the exact saved Owner answer reaches the new independent check')
        assert.ok(run.prompt.indexOf('85 UTF-8 bytes') < run.prompt.indexOf('Historical original target was 56 bytes.'))
        const sessionId = `fresh-${stage}-${run.id}`
        await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp(),report=$3 WHERE id=$1`, [run.id, sessionId, JSON.stringify({ check: { sha: head, readOnly: true }, verify: { status: 'not_run' }, filesChanged: [], criteria: [{ text: '85-byte exact target', passed: true, evidence: 'Synthetic isolated database check observation' }] })])
        const finishedAt = (await pool.query('SELECT "finishedAt" FROM agent_runs WHERE id=$1', [run.id])).rows[0].finishedAt
        const done = await f.store.apply('owner', factoryBinding(task), randomUUID(), { action: 'finish', status: 'passed', reason: 'Synthetic independent check', output: {}, evidence: [{ artifact: `run-report:${run.id}`, kind: 'report', runId: run.id, sessionId, candidateId: candidate.id, sha: null, environment: candidate.environment, recordedAt: finishedAt.toISOString() }] })
        const next = await f.store.apply('owner', factoryBinding(done.task), randomUUID(), { action: 'advance', stage: stage === 'review' ? 'verify' : 'approval', reason: 'Independent checks complete' })
        if (stage === 'review') await f.checkDispatch('owner', { binding: factoryBinding(next.task), agentId: f.agentId, deviceRepoId: f.repoId })
      }
      const ready = (await f.store.read('owner', f.task.id)).task, client = await pool.connect()
      try {
        const accepted = await approvalEvidence(client, ready)
        assert.deepEqual(accepted.manifest.artifacts.map(entry => entry.stage), ['execute', 'review', 'verify'])
        assert.deepEqual(accepted.captures.map(entry => entry.runId), [f.producerRunId])
        const producerEvidence = accepted.manifest.artifacts[0]
        assert.equal(producerEvidence.runId, f.producerRunId)
        assert.equal(producerEvidence.completionRecoveryEventId, f.completionEventId)
        assert.equal(producerEvidence.completionEventId, factoryEventId('run-completion', f.producerRunId))
        assert.equal(producerEvidence.deliverableSnapshotRecoveryEventId, f.request.body.eventId)
        assert.equal(producerEvidence.originalEvidenceCandidateId, f.oldCandidateId)
        assert.equal(producerEvidence.deliverableSnapshotSha, head)
        assert.match(producerEvidence.deliverableSnapshotReceiptDigest!, /^[a-f0-9]{64}$/)
        assert.equal(new Set(accepted.manifest.artifacts.map(entry => entry.sessionId)).size, 3)
        assert.deepEqual(await f.historical(), before)
        // A normal later write-path status projection must not invalidate the
        // immutable snapshot proof or mutate the original answered question.
        await f.questions.record('owner', f.oldReviewId)
        assert.equal((await pool.query('SELECT status FROM factory_questions WHERE id=$1', [f.question.id])).rows[0].status, 'superseded')
        assert.equal((await readDeliverableSnapshotReceipt(client, ready, candidate.id))?.snapshot.head, head)
        await approvalEvidence(client, ready)
        const original = (await f.historical()).questions.find(row => row.row.id === f.originalQuestionId)
        assert.deepEqual(original, before.questions.find(row => row.row.id === f.originalQuestionId))
        const corruptions: [string, unknown[]][] = [
          ['DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.completionEventId]],
          [`UPDATE factory_events SET request=jsonb_set(request,'{scope,producerRunId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, f.request.body.eventId, randomUUID()]],
          [`UPDATE factory_events SET request=jsonb_set(request,'{scope,sourceEventId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, f.request.body.eventId, randomUUID()]],
          [`UPDATE factory_events SET result=jsonb_set(result,'{snapshotRecovery,snapshot,diffSha256}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, f.request.body.eventId, 'd'.repeat(64)]],
          [`UPDATE factory_questions SET context='changed immutable original question' WHERE id=$1`, [f.question.id]],
          [`UPDATE agent_runs SET report=jsonb_set(report,'{summary}','"rewritten report"') WHERE id=$1`, [f.producerRunId]],
        ]
        for (const [sql, args] of corruptions) {
          await client.query('BEGIN')
          try { await client.query(sql, args); await assert.rejects(approvalEvidence(client, ready), /factoryDeliverableSnapshotUnavailable|factoryIndependentEvidenceRequired/) }
          finally { await client.query('ROLLBACK') }
        }
      } finally { client.release() }
    })

    await t.test('a concurrent duplicate never observes or dispatches twice, and replays the committed result afterward', async () => {
      const f = await fixture()
      let enter!: () => void, proceed!: () => void
      const entered = new Promise<void>(resolve => { enter = resolve })
      const released = new Promise<void>(resolve => { proceed = resolve })
      const service = f.human(f.observer({ duringObservation: async () => { enter(); await released } }))
      const first = handleFactory(service, f.request)
      try {
        await Promise.race([entered, first.then(() => { throw new Error('First request ended before reaching the observer') })])
        const concurrent = await handleFactory(service, f.request)
        assert.equal(concurrent.status, 409)
        assert.equal(f.counts().observedCount, 1)
      } finally { proceed() }
      const finished = await first
      assert.equal(finished.status, 200)
      assert.deepEqual(await handleFactory(service, f.request), finished)
      assert.deepEqual(f.counts(), { observedCount: 1, releaseCount: 1, dispatchCount: 1, startCount: 1 })
    })

    await t.test('only the successful unverified question producer receives the exact legacy journal allowance', async () => {
      const f = await fixture(), client = await pool.connect()
      try {
        const eligible = await retainedDeliverableForRecovery(client, f.task)
        assert.deepEqual(eligible?.scope.legacyQuestionSubmission, { questionId: f.originalQuestionId, continuesRunId: f.originId })
        const changes: [string, unknown[]][] = [
          [`UPDATE agent_runs SET kind='plan' WHERE id=$1`, [f.producerRunId]],
          [`UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{readOnly}','true') WHERE id=$1`, [f.producerRunId]],
          [`UPDATE agent_runs SET report=jsonb_set(report,'{verify,status}','"passed"') WHERE id=$1`, [f.producerRunId]],
          [`UPDATE agent_runs SET report=report||'{"publish":{"pushed":true}}'::jsonb WHERE id=$1`, [f.producerRunId]],
          [`UPDATE agent_runs SET "continuesRunId"=NULL WHERE id=$1`, [f.producerRunId]],
          [`UPDATE agent_runs SET "continuesRunId"=id WHERE id=$1`, [f.producerRunId]],
          [`UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{questionId}','"invalid"') WHERE id=$1`, [f.producerRunId]],
          [`UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{requireSessionResume}','false') WHERE id=$1`, [f.producerRunId]],
          [`UPDATE agent_runs SET status='stopped' WHERE id=$1`, [f.producerRunId]],
        ]
        for (const [sql, args] of changes) {
          await client.query('BEGIN')
          try {
            await client.query(sql, args)
            assert.equal((await retainedDeliverableForRecovery(client, f.task))?.scope.legacyQuestionSubmission, undefined, sql)
          } finally { await client.query('ROLLBACK') }
        }
        assert.equal(f.counts().observedCount, 0)
      } finally { client.release() }
    })

    for (const fault of ['owner', 'revision', 'answered', 'active', 'lease', 'passed', 'accepted', 'uncertain_operation', 'existing_snapshot'] as const) await t.test(`eligibility refuses ${fault} before VM observation`, async () => {
      const f = await fixture()
      if (fault === 'answered') await pool.query('UPDATE factory_questions SET "answerId"=$2 WHERE id=$1', [f.question.id, randomUUID()])
      if (fault === 'active') await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt) VALUES($1,'owner',$2,$3,$4,$5,'queued','Competing fixture run')`, [randomUUID(), f.task.issueId, f.agentId, f.deviceId, f.repoId])
      if (fault === 'lease') await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '1 minute' WHERE "runId"=$1`, [f.oldReviewId, randomUUID()])
      if (fault === 'passed') await pool.query(`UPDATE factory_attempts SET status='passed' WHERE id=$1`, [f.oldReviewAttemptId])
      if (fault === 'accepted') await pool.query(`INSERT INTO factory_deliverable_acceptances(id,"taskId","candidateId","userId","sessionId","eventId") VALUES($1,$2,$3,'owner','fixture-human',$4)`, [randomUUID(), f.task.id, f.oldCandidateId, randomUUID()])
      if (fault === 'uncertain_operation') await pool.query(`INSERT INTO operation_ledger("operationId","ownerId","workspaceId",binding,"idempotencyKey",status,"attemptToken","runId") VALUES($1,'owner',$2,$3,$4,'uncertain',$5,$6)`, [randomUUID(), f.workspaceId, JSON.stringify({ executionRunId: f.producerRunId, action: 'fixture_external_write' }), `snapshot-uncertain:${randomUUID()}`, randomUUID(), f.producerRunId])
      if (fault === 'existing_snapshot') await pool.query(`UPDATE agent_runs SET report=report||jsonb_build_object('deliverableCommit',$2::text) WHERE id=$1`, [f.producerRunId, head])
      const before = await f.historical()
      const request = fault === 'owner' ? { ...f.request, userId: 'foreign' } : fault === 'revision' ? { ...f.request, body: { ...f.request.body, binding: { taskId: f.task.id, revision: f.task.revision + 1 } } } : f.request
      const result = await handleFactory(f.human(), request)
      assert.ok([404, 409].includes(result.status), fault)
      assert.equal(f.counts().observedCount, 0)
      assert.deepEqual(await f.historical(), before)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_candidates WHERE "taskId"=$1', [f.task.id])).rows[0].n, 1)
    })

    for (const fault of ['hash', 'baseline', 'session', 'vm', 'dirty', 'stale_time'] as const) await t.test(`an invalid fresh observation (${fault}) rolls back and releases only its lease`, async () => {
      const f = await fixture(), before = await f.historical()
      const observe = f.observer({ changeSnapshot: snapshot => {
        if (fault === 'hash') snapshot.diffSha256 = 'd'.repeat(64)
        if (fault === 'baseline') snapshot.head = base
        if (fault === 'session') snapshot.sessionId = 'substituted-session'
        if (fault === 'vm') snapshot.sandboxId = 'another-machine'
        if (fault === 'dirty') Object.assign(snapshot, { clean: false })
        if (fault === 'stale_time') snapshot.observedAt = new Date(Date.now() - 10 * 60_000).toISOString()
      } })
      const result = await handleFactory(f.human(observe), f.request)
      assert.equal(result.status, 409)
      assert.deepEqual(await f.historical(), before)
      assert.equal(f.counts().releaseCount, 1)
      assert.equal(f.counts().dispatchCount, 0)
      assert.equal((await pool.query('SELECT "workerLeaseId" FROM thread_machines WHERE "runId"=$1', [f.oldReviewId])).rows[0].workerLeaseId, null)
    })

    for (const fault of ['task_revision', 'question_revision', 'checkpoint', 'producer_predecessor', 'producer_question', 'lease_transfer'] as const) await t.test(`final CAS refuses ${fault} drift after provider I/O`, async () => {
      const f = await fixture()
      const replacement = randomUUID()
      const observe = f.observer({ duringObservation: async () => {
        if (fault === 'task_revision') await pool.query('UPDATE factory_tasks SET revision=revision+1 WHERE id=$1', [f.task.id])
        if (fault === 'question_revision') await pool.query('UPDATE factory_questions SET revision=revision+1 WHERE id=$1', [f.question.id])
        if (fault === 'checkpoint') await pool.query('UPDATE run_checkpoints SET "updatedAt"=now() WHERE "runId"=$1', [f.producerRunId])
        if (fault === 'producer_predecessor') await pool.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1', [f.producerRunId, f.oldReviewId])
        if (fault === 'producer_question') await pool.query(`UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{questionId}',to_jsonb($2::text)) WHERE id=$1`, [f.producerRunId, randomUUID()])
        if (fault === 'lease_transfer') await pool.query('UPDATE thread_machines SET "workerLeaseId"=$2 WHERE "runId"=$1', [f.oldReviewId, replacement])
      } })
      const result = await handleFactory(f.human(observe), f.request)
      assert.equal(result.status, 409)
      assert.equal(f.counts().dispatchCount, 0)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_candidates WHERE "taskId"=$1', [f.task.id])).rows[0].n, 1)
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='owner_deliverable_snapshot_recovery'`, [f.task.id])).rows[0].n, 0)
      if (fault === 'lease_transfer') assert.equal((await pool.query('SELECT "workerLeaseId" FROM thread_machines WHERE "runId"=$1', [f.oldReviewId])).rows[0].workerLeaseId, replacement, 'cleanup cannot clear a replacement owner lease')
    })

    await t.test('failed normal review admission rolls back candidate, receipt and attempt; the same Owner retry can recover later', async () => {
      const f = await fixture(), before = await f.historical()
      await assert.rejects(handleFactory(f.human(f.observer(), true), f.request), /Synthetic check admission unavailable/)
      assert.deepEqual(await f.historical(), before)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_candidates WHERE "taskId"=$1', [f.task.id])).rows[0].n, 1)
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='owner_deliverable_snapshot_recovery'`, [f.task.id])).rows[0].n, 0)
      assert.equal((await handleFactory(f.human(), f.request)).status, 200)
      assert.equal(f.counts().observedCount, 2)
      assert.equal(f.counts().startCount, 1)
      assert.deepEqual(await f.historical(), before)
    })

    await t.test('browser JSON cannot provide a candidate SHA or host snapshot', async () => {
      const f = await fixture(), before = await f.historical()
      assert.equal((await handleFactory(f.human(), { ...f.request, body: { ...f.request.body, snapshot: { head } } })).status, 422)
      assert.equal(f.counts().observedCount, 0)
      assert.deepEqual(await f.historical(), before)
    })
  } finally {
    if (flags.routing === undefined) delete process.env.MIKKA_FACTORY_ROUTING_ENABLED; else process.env.MIKKA_FACTORY_ROUTING_ENABLED = flags.routing
    if (flags.lifecycle === undefined) delete process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED; else process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = flags.lifecycle
    await closeWorkspace()
    await dropTestDatabase(admin, database, pool)
    await admin.end()
  }
})
