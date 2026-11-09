import { measured, readMetrics } from '../../../tests/helpers/read-metrics';
import type { ModelMessage } from 'ai';
import { completeAttentionQuestions } from '../../coordinator/question-attention';
import { factoryTestLifecycle } from "../../../tests/helpers/factory-test-authority";
import { seedFixtureWorkspace } from '../../../tests/helpers/task-workspace';
import { isolatedPostgresURL } from "../../../tests/helpers/isolated-postgres.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../../scripts/migration-order.mjs";
import { FactoryError } from "../contract";
import { factoryEventId } from "../event-id";
import { questionFingerprint } from "./contract";
import { ActionFailureError } from "../../action-error";
import { createFactoryStore } from "../store";
import { observePoolCommits } from "../../db/commit-effects";
import { createFactoryDispatch } from "../dispatch";
import { createFactoryClaim } from "../claim";
import { advanceFactoryRequest } from "../request-epoch";
import { factoryDispatchDatabase } from "../transaction";
import { insertRunOnce } from "../../run-dispatch";
import { createFactoryQuestions, questionReference } from "./store";
import { threadQuestionStates } from "../../issue-thread-questions";
import { readRunChain } from "../../run-chain";
import { createFactoryReconciler } from "../reconcile";
import { lostRunOutcome } from "../../run-retry";
import { queueCloudQuestionContinuation } from "./queue-continuation";
import { questionExecutionContinuation } from "./execution-continuation";
import { freezeWorkerDefinition } from "../../agent-kit/worker";
import { blockQuestionRetry } from "./retry";
import { createSkillAssignments } from "../../self-improvement/assignments";
import { ImprovementError } from "../../self-improvement/contract";
import {
  BASELINE_ARTIFACT,
  BASELINE_MARKDOWN,
} from "../../self-improvement/builtin-skill";
import { disposableDatabase } from '../../../tests/helpers/e2e-target.mjs'

const local = process.env.FACTORY_QUESTION_TEST_URL;
const dbURL =
  local ??
  (disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined);
if (dbURL) {
  const u = new URL(dbURL);
  assert.equal(u.hostname, "127.0.0.1");
  assert.ok(disposableDatabase(process.env, dbURL), "loopback *_e2e only");
  if (local) assert.equal(u.username, "factoryquestions192");
}
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(
    fn,
    (e: unknown) => e instanceof FactoryError && e.code === code,
  );
test(
  "PG17 execution questions: durable waiting, exact facts/human source, one continuation, rollback and stop fences",
  { skip: !dbURL, timeout: 120000 },
  async (t) => {
    const fixtureURL = await isolatedPostgresURL(dbURL!);
    const schema = `questions_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: fixtureURL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: fixtureURL,
      max: 12,
      options: `-c search_path=${schema}`,
    });
    const userId = "owner",
      sessionId = randomUUID(),
      deviceId = randomUUID(),
      repoId = randomUUID(),
      agentId = randomUUID();
    const authorize = async (owner: string, issue: string, tx: PoolClient) =>
      (
        await tx.query(
          `SELECT id FROM issues WHERE id=$1 AND "userId"=$2 AND content #>> '{attrs,mikka,deletedAt}' IS NULL FOR SHARE`,
          [issue, owner],
        )
      ).rowCount === 1;
    const evaluationRuns = new Map<string, string>();
    const originRuns = new Map<string, string>();
    const make = (p: Pool, withSkills = true) => {
      observePoolCommits(p);
      const assignments = createSkillAssignments(
        p,
        authorize,
        async (_tx, owner, run, evaluationId) =>
          owner === userId && evaluationRuns.get(run.id) === evaluationId,
      );
      const store = createFactoryStore(p, authorize, null, factoryTestLifecycle);
      const dispatch = createFactoryDispatch(p, store, (tx, owner, input, botId, context) =>
        insertRunOnce(factoryDispatchDatabase(tx), owner, { ...input, requestKey: `factory:${context.attemptId}` }, {
          deviceId,
          baseBranch: "main",
          prompt: "Explicit Harness fixture",
          botId,
        }),
      );
      return {
        store,
        dispatch,
        assignments,
        questions: createFactoryQuestions(
          p,
          authorize,
          store,
          dispatch,
          withSkills
            ? {
                lockOrigin: assignments.lockQuestion,
                continueQuestion: assignments.continueQuestion,
              }
            : undefined,
        ),
      };
    };
    const { store, dispatch, questions, assignments } = make(pool);
    try {
      const dir = new URL("../../../drizzle/", import.meta.url);
      for (const name of orderMigrations(
        (await readdir(dir)).filter((n) => n.endsWith(".sql")),
      ))
        await pool.query(await readFile(new URL(name, dir), "utf8"));
      await pool.query(
        await readFile(
          new URL("20261029044006_factory_192_questions.sql", dir),
          "utf8",
        ),
      );
      await pool.query(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture owner','questions@example.invalid',true,now(),now())`,
      );
      await pool.query(
        `INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,'owner',$2,now()+interval '1 hour',now(),now())`,
        [sessionId, `fixture-${randomUUID()}`],
      );
      await pool.query(
        `INSERT INTO devices (id,"ownerId",name,enabled,"lastSeenAt",harnesses) VALUES ($1,'owner','Fixture device',true,now(),'[{"harness":"codex","installed":true}]')`,
        [deviceId],
      );
      await pool.query(
        `INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,'owner','/isolated','fixture/repo')`,
        [repoId, deviceId],
      );
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture agent','codex',$2)`,
        [agentId, deviceId],
      );
      const fixture = async (
        kind: "context" | "decision" | "permission" | "external" = "context",
        record = true,
        selectSkill: (runId: string, issueId: string) => Promise<unknown> = (
          runId,
        ) => assignments.selectBaseline(userId, runId),
        workspaceId?: string,
      ) => {
        // This fixture represents an online daemon. Refresh its heartbeat for
        // each case so earlier database cases cannot age it past the real
        // liveness window before a later continuation is claimed.
        await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [deviceId]);
        const issueId = randomUUID(),
          eventId = randomUUID(),
          questionId = randomUUID();
        await pool.query(
          `INSERT INTO issues (id,"userId",title,content,status,priority,"workspaceId","ownershipState") VALUES ($1,'owner','Use existing HTTP API','{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Keep the existing public API"}]}]}','todo','normal',$2,'bound')`,
          [issueId, workspaceId ?? await seedFixtureWorkspace(pool, userId)],
        );
        await pool.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId",payload) VALUES ($1,'owner','user_message',$2,$3,'{"text":"Keep the existing public API"}')`,
          [eventId, eventId, issueId],
        );
        let state = await store.route(userId, {
          issueId,
          eventId: randomUUID(),
          sourceEventId: eventId,
          rationale: "Explicit fixture",
        });
        // Freeze and bind the origin through the same dispatch consumer used
        // by its continuation. The stopped CLI hand-in below is synthetic.
        const dispatched = await dispatch(userId, {
          binding: {
            taskId: state.task.id,
            issueId,
            attemptId: state.task.attemptId,
            revision: state.task.revision,
            candidateId: state.task.candidateId,
          },
          agentId,
          deviceRepoId: repoId,
        });
        state = dispatched;
        const runId = dispatched.runId;
        originRuns.set(issueId, runId);
        await selectSkill(runId, issueId);
        const lease = new Date(Date.now() + 60000).toISOString();
        await pool.query(
          `UPDATE agent_runs SET status='preparing',"startedAt"=now(),"leaseExpiresAt"=$2,"sessionId"=$3 WHERE id=$1`,
          [runId, lease, `session:${runId}`],
        );
        const { skillReceipt } = await assignments.recordClaim(
          userId,
          deviceId,
          runId,
          lease,
          true,
        );
        await pool.query(
          `UPDATE agent_runs SET status='stopped',"stopReason"=$2,report=$3,"finishedAt"=now() WHERE id=$1`,
          [
            runId,
            kind === "external" ? "blocked" : "asked_human",
            JSON.stringify({
              summary: "Synthetic run hand-in",
              openQuestions: ["Which API?"],
              question: {
                questionId,
                kind,
                question: "Which API?",
                options: [],
              },
            }),
          ],
        );
        const q = record ? await questions.record(userId, runId) : null;
        return {
          task: state.task,
          issueId,
          eventId,
          runId,
          questionId,
          q: q!,
          skillReceipt,
        };
      };
      const facts = (f: Awaited<ReturnType<typeof fixture>>) => ({
        reference: questionReference(f.q),
        answerId: randomUUID(),
        facts: [{ kind: "issue", quote: "Keep the existing public API" }],
      });
      const human = { source: "human" as const, userId, sessionId };
      const orchestrator = { source: "orchestrator" as const, userId };
      const queued = async (issueId: string) =>
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1 AND "dispatchKey" IS NOT NULL AND id<>$2::uuid`,
            [issueId, originRuns.get(issueId)],
          )
        ).rows[0].n;

      await t.test("Coordinator attention completes a permission handoff once without another read or a fabricated answer", async (t) => {
        const normal = await fixture('permission');
        const missing = await fixture('permission');
        const normalView = (await questions.list(userId, normal.task.id)).find(q => q.id === normal.questionId)!;
        const missingView = (await questions.list(userId, missing.task.id)).find(q => q.id === missing.questionId)!;
        const event = (q: typeof normalView) => ({
          eventId:q.sourceEventId,taskId:q.taskId,issueId:q.issueId,questionId:q.id,runId:q.originRunId,
        });
        const messages = (q: typeof normalView, written?: unknown): ModelMessage[] => [
          {role:'assistant',content:[{type:'tool-call',toolCallId:'read-question',toolName:'list_factory_questions',input:{taskId:q.taskId}}]},
          {role:'tool',content:[{type:'tool-result',toolCallId:'read-question',toolName:'list_factory_questions',output:{type:'json',value:[q] as never}}]},
          ...(written ? [
            {role:'assistant',content:[{type:'tool-call',toolCallId:'escalate-question',toolName:'escalate_factory_question',input:{reference:q.reference,eventId:q.sourceEventId,reason:'A human decision is needed.'}}]},
            {role:'tool',content:[{type:'tool-result',toolCallId:'escalate-question',toolName:'escalate_factory_question',output:{type:'json',value:written}}]},
          ] as ModelMessage[] : []),
          {role:'assistant',content:[{type:'text',text:'Please confirm the requested permission.'}]},
        ];
        let submitted: Parameters<Parameters<typeof completeAttentionQuestions>[2]['escalate']>[0] | undefined;
        const handoff = await measured(() => completeAttentionQuestions([event(missingView)],messages(missingView),{
          userId,enabled:true,escalate:async input => {
            assert.equal(submitted,undefined);
            submitted=input;
            return questions.escalate(userId,input);
          },
        }));
        assert.equal(handoff.value,1);
        assert.ok(submitted);
        assert.deepEqual(submitted.reference,missingView.reference);
        assert.equal(submitted.eventId,missingView.sourceEventId);
        const normalWrite = await measured(() => questions.escalate(userId,{
          ...submitted!,reference:normalView.reference,eventId:normalView.sourceEventId,
        }));
        const afterReceipt = await measured(() => completeAttentionQuestions([event(normalView)],messages(normalView,normalWrite.value),{
          userId,enabled:true,escalate:async () => { throw new Error('The normal escalation must not run twice'); },
        }));
        t.diagnostic(JSON.stringify({
          case:'coordinator_permission_attention',
          existingEscalation:readMetrics(normalWrite),
          missingEscalation:readMetrics(handoff),
          completionAfterActualReceipt:readMetrics(afterReceipt),
        }));
        assert.equal(afterReceipt.value,0);
        assert.equal(afterReceipt.statements,0);
        assert.equal(afterReceipt.bytes,0);
        assert.equal(afterReceipt.bytesWritten,0);
        assert.equal(handoff.statements,normalWrite.statements,'the missing handoff uses only the existing business write');
        const waiting = await questions.read(userId,missing.questionId);
        assert.equal(waiting.status,'waiting_user');
        assert.equal(waiting.answerId,null);
        assert.equal(waiting.continuationRunId,null);
        assert.equal(waiting.originSessionId,missing.q.originSessionId);
        assert.equal(await queued(missing.issueId),0,'escalation is not a human answer or permission to resume');
        const persisted = (await pool.query('SELECT id,payload FROM coordinator_events WHERE id=$1',[factoryEventId('question-escalated',missing.questionId)])).rows;
        assert.equal(persisted.length,1);
        assert.equal(persisted[0].payload.needsUser,true);
        assert.equal(persisted[0].payload.questionId,missing.questionId);
        assert.equal((await questions.escalate(userId,submitted)).id,waiting.id,'the actual source-event key replays the same normal escalation');
        const answer = await questions.answer(human,{
          reference:waiting.reference,answerId:randomUUID(),text:'The person permits the requested continuation.',
        });
        assert.ok(answer.continuationRunId);
        const child = (await pool.query('SELECT "questionContinuation" FROM agent_runs WHERE id=$1',[answer.continuationRunId])).rows[0];
        assert.equal(child.questionContinuation.originRunId,missing.runId);
        assert.equal(child.questionContinuation.originSessionId,missing.q.originSessionId);
        assert.equal(child.questionContinuation.requireSessionResume,true);
        const claim = await questions.claimContinuation(userId,deviceId,answer.continuationRunId,new Date(Date.now()+60000).toISOString());
        assert.equal(claim.resumeSessionId,missing.q.originSessionId);
        assert.equal(claim.requireSessionResume,true);
      });

      await t.test("cloud question answer keeps the exact task VM, frozen identity and original SID; replay dispatches once", async (t) => {
        type CloudQuestionTarget = { repoPath: string; remoteUrl: string | null; readOnly?: boolean };
        const cloudFixture = async (state = 'running', afterContinuation?: (owner:string,result:{continuationRunId:string})=>Promise<void>, withSkills = false, beforeRecovery?: Parameters<typeof createFactoryQuestions>[7], target: CloudQuestionTarget = { repoPath: '/isolated', remoteUrl: 'fixture/repo' }) => {
          const workspaceId=await seedFixtureWorkspace(pool,userId,'team');
          const f = await fixture('context',true,async () => undefined,workspaceId);
          const botId=randomUUID(),childDevice=randomUUID(),childRepo=randomUUID(),connectionId=randomUUID(),credentialId=randomUUID();
          await pool.query(`INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,'Cloud fixture')`,[botId,workspaceId,userId]);
          await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,"lastSeenAt",harnesses) VALUES($1,$2,'Task VM','cloud',now(),'[{"harness":"codex","installed":true}]')`,[childDevice,userId]);
          await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl","baseBranch") VALUES($1,$2,$3,$4,$5,'main')`,[childRepo,childDevice,userId,target.repoPath,target.remoteUrl]);
          await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",state,epoch,provider,"secretName","providerSubject","secretDigest") VALUES($1,$2,$3,'connected',2,'codex','synthetic-secret-reference-' || $1::uuid::text,'synthetic-subject',repeat('a',64))`,[connectionId,userId,workspaceId]);
          await pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,$2,$3,$4,$5,2,'codex_cli','fixture-model')`,[credentialId,userId,workspaceId,agentId,connectionId]);
          const definition=freezeWorkerDefinition({harness:'codex',instructions:'frozen original policy',prompt:'Original task',parent:null,executionId:null,model:'fixture-model',subscription:{id:credentialId,modelId:'fixture-model',route:'codex_cli'},readOnly:target.readOnly});
          await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"agentDefinition"=$4,"baseBranch"='main' WHERE id=$1`,[f.runId,childDevice,childRepo,JSON.stringify(definition)]);
          await pool.query(`INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)`,[f.runId,botId,workspaceId,userId]);
          const sandboxId='same-vm-'+f.runId;
          await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId") VALUES($1,$2,$3,$4,$5,$6,'codex',$7,$8,$9,$10)`,[f.runId,workspaceId,userId,botId,f.issueId,sandboxId,randomUUID(),state,childDevice,childRepo]);
          let fallbackCalls=0;
          const cloudDispatch=createFactoryDispatch(pool,store,async (tx,owner,input,scopeBot,context) => {
            const result=await queueCloudQuestionContinuation(tx,owner,input,scopeBot,context);
            if(result)return result;
            fallbackCalls++;throw new Error('Cloud question used local fallback');
          });
          const service=createFactoryQuestions(pool,authorize,store,cloudDispatch,withSkills ? {lockOrigin:async (...args:Parameters<typeof assignments.lockQuestion>)=>{
            try { await assignments.lockQuestion(...args); }
            catch(error) { if(error instanceof ImprovementError) throw new FactoryError('factoryQuestionContinuationUnavailable'); throw error; }
          },continueQuestion:assignments.continueQuestion} : undefined,undefined,afterContinuation,beforeRecovery);
          return {...f,workspaceId,botId,childDevice,childRepo,connectionId,credentialId,definition,sandboxId,service,fallbackCalls:()=>fallbackCalls};
        };
        const failedContinuation = async (beforeRecovery?: Parameters<typeof createFactoryQuestions>[7], afterContinuation?: (owner:string,result:{continuationRunId:string})=>Promise<void>, target?: CloudQuestionTarget) => {
          const f=await cloudFixture('running',afterContinuation,true,beforeRecovery,target);
          const answer={reference:questionReference(f.q),answerId:randomUUID(),text:'Continue once on original SID'};
          const first=await f.service.answer(human,answer);
          await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',"sessionId"=$2,"finishedAt"=now() WHERE id=$1`,[first.continuationRunId,f.q.originSessionId]);
          await f.service.settle(userId,first.continuationRunId);
          const q=await f.service.read(userId,f.q.id);
          return {...f,answer,first,recovery:{requestId:randomUUID(),...q.recoverReference!}};
        };
        const recoverySnapshot = async (f: Awaited<ReturnType<typeof failedContinuation>>) => (await pool.query(`SELECT to_jsonb(q) AS question,to_jsonb(t) AS task,
          (SELECT count(*)::int FROM agent_runs WHERE "issueId"=q."issueId") AS runs,
          (SELECT count(*)::int FROM factory_events WHERE "taskId"=t.id) AS events,
          (SELECT to_jsonb(m) FROM thread_machines m WHERE "runId"=q."continuationRunId") AS machine
          FROM factory_questions q JOIN factory_tasks t ON t.id=q."taskId" WHERE q.id=$1`,[f.q.id])).rows[0];
        for (const [expectedKind, target] of [
          ['deliverable', { repoPath: '/home/user/.mikka/bot-workspaces/question-delivery', remoteUrl: null }],
          ['repository', { repoPath: '/isolated', remoteUrl: 'fixture/repo' }],
          ['report', { repoPath: '/isolated', remoteUrl: 'fixture/repo', readOnly: true }],
        ] as const) for (const recover of [false, true]) await t.test(`composed ${recover ? 'recovered' : 'answered'} question claim retains host ${expectedKind} execution purpose`, async () => {
          let f: Awaited<ReturnType<typeof cloudFixture>>, runId: string, historyRunId: string;
          if (recover) {
            const failed = await failedContinuation(undefined, undefined, target);
            f = failed;
            runId = (await f.service.recover(human, failed.recovery)).continuationRunId;
            historyRunId = failed.first.continuationRunId;
          } else {
            f = await cloudFixture('running', undefined, true, undefined, target);
            runId = (await f.service.answer(human, { reference: questionReference(f.q), answerId: randomUUID(), text: 'Continue the original delivery in its original session' })).continuationRunId;
            historyRunId = f.runId;
          }
          const historyIds = [...new Set([f.runId, historyRunId])];
          const before = (await pool.query('SELECT to_jsonb(r) AS run FROM agent_runs r WHERE id=ANY($1::uuid[]) ORDER BY id', [historyIds])).rows;
          const questionBefore = (await pool.query('SELECT to_jsonb(q) AS question FROM factory_questions q WHERE id=$1', [f.q.id])).rows;
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            // Exercise the outer claim composition used by device claims. Calling
            // claimContinuation directly misses the execution-purpose regression.
            const claimed = await createFactoryClaim(store, f.service)(tx, userId, f.childDevice, runId, new Date(Date.now() + 60000).toISOString());
            assert.equal(claimed.factoryExecuteKind, expectedKind);
            assert.equal(claimed.preserveQuestionWorktree, true);
            assert.equal(claimed.continuesRunId, historyRunId);
            assert.equal(claimed.resumeSessionId, f.q.originSessionId);
            assert.equal(claimed.requireSessionResume, true);
            assert.equal(claimed.questionId, f.q.id);
            assert.equal(Object.hasOwn(claimed, 'factoryCheck'), false);
            assert.doesNotMatch(claimed.followUp as string, /Current host-recorded command evidence|Persisted producer command observations/,
              'execution answer/recovery does not receive independent-check instructions');
            assert.deepEqual((await tx.query('SELECT to_jsonb(r) AS run FROM agent_runs r WHERE id=ANY($1::uuid[]) ORDER BY id', [historyIds])).rows, before);
            assert.deepEqual((await tx.query('SELECT to_jsonb(q) AS question FROM factory_questions q WHERE id=$1', [f.q.id])).rows, questionBefore);
          } finally { await tx.query('ROLLBACK'); tx.release(); }
          const current = (await pool.query('SELECT status,"agentDefinition" FROM agent_runs WHERE id=$1', [runId])).rows[0];
          assert.equal(current.status, 'queued');
          assert.equal(current.agentDefinition.definitionDigest, f.definition.definitionDigest);
          assert.deepEqual(current.agentDefinition.subscription, f.definition.subscription);
          assert.equal(f.fallbackCalls(), 0);
        });
        await t.test('owner Retry prepares outside transaction locks and receipt replay never maintains transferred custody',async()=>{
          const prepared: string[]=[],wakes: string[]=[];
          let f: Awaited<ReturnType<typeof failedContinuation>>;
          f=await failedContinuation(async(owner,scope)=>{
            assert.equal(owner,userId);
            assert.deepEqual(scope,{runId:f.first.continuationRunId,workspaceId:f.workspaceId});
            const before=await recoverySnapshot(f);
            assert.equal(before.question.status,'blocked');assert.equal(before.task.status,'blocked');assert.equal(before.runs,2);
            const tx=await pool.connect();
            try {
              await tx.query('BEGIN');
              await tx.query('SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE NOWAIT',[f.task.id]);
              await tx.query('SELECT id FROM factory_questions WHERE id=$1 FOR UPDATE NOWAIT',[f.q.id]);
              await tx.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE NOWAIT',[scope.runId]);
              await tx.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1 FOR UPDATE NOWAIT',[scope.runId]);
            } finally { await tx.query('ROLLBACK');tx.release(); }
            prepared.push(scope.runId);
          },async(_owner,result)=>{wakes.push(result.continuationRunId);});
          const recovered=await f.service.recover(human,f.recovery);
          assert.deepEqual(prepared,[f.first.continuationRunId]);
          const old=(await pool.query('SELECT state,"sandboxId" FROM thread_machines WHERE "runId"=$1',[f.first.continuationRunId])).rows[0];
          assert.deepEqual(old,{state:'ended',sandboxId:null});
          // A receipt replay must not require the old run's custody or current credential.
          await pool.query('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1',[f.connectionId]);
          const replay=await f.service.recover(human,f.recovery);
          assert.equal(replay.continuationRunId,recovered.continuationRunId);assert.equal(replay.replayed,true);
          assert.deepEqual(prepared,[f.first.continuationRunId]);
          assert.deepEqual(wakes.slice(-2),[recovered.continuationRunId,recovered.continuationRunId]);
          assert.equal((await recoverySnapshot(f)).runs,3);
        });
        await t.test('maintenance failure preserves answer, task, receipt count and custody; the same request can retry',async()=>{
          let calls=0;
          const f=await failedContinuation(async()=>{if(++calls===1)throw new Error('Synthetic maintenance unavailable');});
          const before=await recoverySnapshot(f);
          await assert.rejects(f.service.recover(human,f.recovery),/Synthetic maintenance unavailable/);
          assert.equal(calls,1);assert.deepEqual(await recoverySnapshot(f),before);
          const recovered=await f.service.recover(human,f.recovery);
          assert.equal(calls,2);assert.notEqual(recovered.continuationRunId,f.first.continuationRunId);
          assert.equal((await recoverySnapshot(f)).runs,3);
          assert.deepEqual((await recoverySnapshot(f)).question.answer,before.question.answer);
        });
        for(const drift of ['subscription','question','custody','epoch']) await t.test('recovery revalidates '+drift+' after runtime maintenance before any dispatch',async()=>{
          let f: Awaited<ReturnType<typeof failedContinuation>>,afterMaintenance: unknown,calls=0;
          f=await failedContinuation(async()=>{
            calls++;
            if(drift==='subscription')await pool.query('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1',[f.connectionId]);
            if(drift==='question')await pool.query('UPDATE factory_questions SET revision=revision+1 WHERE id=$1',[f.q.id]);
            if(drift==='custody')await pool.query('UPDATE thread_machines SET "sandboxId"=$2 WHERE "runId"=$1',[f.first.continuationRunId,'different-vm']);
            if(drift==='epoch') {
              const tx=await pool.connect();
              try {
                await tx.query('BEGIN');
                const current=await store.lockTask(tx,userId,f.task.id),sourceEventId=randomUUID();
                await tx.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload)
                  VALUES($1,$2,$3,$4,'user_message',$6,$5)`,[sourceEventId,userId,current.botId,f.issueId,
                  {text:'The owner changed the target during runtime maintenance',source:'thread_continuation',previousRunId:f.first.continuationRunId},`epoch:${sourceEventId}`]);
                await advanceFactoryRequest(tx,current,sourceEventId);
                await tx.query('COMMIT');
              } catch(error) { await tx.query('ROLLBACK'); throw error; }
              finally { tx.release(); }
            }
            afterMaintenance=await recoverySnapshot(f);
          });
          await assert.rejects(f.service.recover(human,f.recovery),e=>e instanceof FactoryError);
          assert.equal(calls,1);assert.deepEqual(await recoverySnapshot(f),afterMaintenance);
          assert.equal((await recoverySnapshot(f)).runs,2);
        });
        for(const repaired of [false,true]) await t.test('a retained error machine '+(repaired?'can be maintained before recovery':'cannot dispatch without successful maintenance'),async()=>{
          let f: Awaited<ReturnType<typeof failedContinuation>>,calls=0;
          f=await failedContinuation(async(_owner,scope)=>{
            calls++;assert.equal((await recoverySnapshot(f)).machine.state,'error');
            if(repaired)await pool.query("UPDATE thread_machines SET state='running' WHERE \"runId\"=$1",[scope.runId]);
          });
          await pool.query("UPDATE thread_machines SET state='error' WHERE \"runId\"=$1",[f.first.continuationRunId]);
          const before=await recoverySnapshot(f);
          if(repaired) {
            const result=await f.service.recover(human,f.recovery);
            assert.equal((await recoverySnapshot(f)).runs,3);
            assert.equal((await pool.query('SELECT "sandboxId" FROM thread_machines WHERE "runId"=$1',[result.continuationRunId])).rows[0].sandboxId,f.sandboxId);
          } else {
            await rejects(()=>f.service.recover(human,f.recovery),'factoryQuestionContinuationUnavailable');
            assert.deepEqual(await recoverySnapshot(f),before);
          }
          assert.equal(calls,1);
        });
        await t.test('owner recovery preserves immutable answer and original identity, selects latest failed history, and replays once',async()=>{
          const f=await failedContinuation();
          const before=(await pool.query('SELECT answer,"answerFingerprint",result,"originRunId","originSessionId" FROM factory_questions WHERE id=$1',[f.q.id])).rows[0];
          for(const action of ['retry','repair'] as const) await rejects(()=>store.apply(userId,f.recovery.reference.binding,randomUUID(),{action,reason:'ordinary retry must preserve SID'}),'factoryQuestionContinuationUnavailable');
          const [recovered,replayed]=await Promise.all([f.service.recover(human,f.recovery),f.service.recover(human,f.recovery)]);
          assert.equal(recovered.continuationRunId,replayed.continuationRunId);
          assert.equal((await pool.query('SELECT count(*)::int n FROM agent_runs WHERE "issueId"=$1',[f.issueId])).rows[0].n,3);
          assert.deepEqual((await pool.query('SELECT answer,"answerFingerprint",result,"originRunId","originSessionId" FROM factory_questions WHERE id=$1',[f.q.id])).rows[0],before);
          assert.equal((await f.service.answer(human,f.answer)).continuationRunId,f.first.continuationRunId);
          const claimed=await f.service.claimContinuation(userId,f.childDevice,recovered.continuationRunId,new Date(Date.now()+60000).toISOString());
          assert.equal(claimed.continuesRunId,f.first.continuationRunId);assert.equal(claimed.resumeSessionId,f.q.originSessionId);assert.equal(claimed.requireSessionResume,true);
          assert.equal((await pool.query('SELECT "sandboxId" FROM thread_machines WHERE "runId"=$1',[recovered.continuationRunId])).rows[0].sandboxId,f.sandboxId);
          await rejects(()=>f.service.recover(human,{...f.recovery,expectedFailedRunId:randomUUID()}),'factoryReplayMismatch');
        });
        await t.test('recovery cannot claim without its receipt or redirect its history; latest recovery can itself recover',async()=>{
          const f=await failedContinuation();
          const result=await f.service.recover(human,f.recovery);
          const {rows:[event]}=await pool.query(`SELECT "eventId",request,result FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='question_recover'`,[result.task.id]);
          await pool.query('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',[result.task.id,event.eventId]);
          await rejects(()=>f.service.claimContinuation(userId,f.childDevice,result.continuationRunId,new Date(Date.now()+60000).toISOString()),'factoryQuestionContinuationUnavailable');
          await pool.query('UPDATE agent_runs SET "continuesRunId"=NULL WHERE id=$1',[result.continuationRunId]);
          await rejects(()=>f.service.claimContinuation(userId,f.childDevice,result.continuationRunId,new Date(Date.now()+60000).toISOString()),'factoryQuestionContinuationUnavailable');
          await pool.query('INSERT INTO factory_events ("taskId","eventId",request,result) VALUES($1,$2,$3,$4)',[result.task.id,event.eventId,event.request,event.result]);
          await pool.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1',[result.continuationRunId,f.runId]);
          await rejects(()=>f.service.claimContinuation(userId,f.childDevice,result.continuationRunId,new Date(Date.now()+60000).toISOString()),'factoryQuestionContinuationUnavailable');
          await pool.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1',[result.continuationRunId,f.first.continuationRunId]);
          await f.service.claimContinuation(userId,f.childDevice,result.continuationRunId,new Date(Date.now()+60000).toISOString());
          await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',"sessionId"=$2,"finishedAt"=now() WHERE id=$1`,[result.continuationRunId,f.q.originSessionId]);
          await f.service.settle(userId,result.continuationRunId);
          const latest=await f.service.read(userId,f.q.id);
          const next=await f.service.recover(human,{requestId:randomUUID(),...latest.recoverReference!});
          const claimed=await f.service.claimContinuation(userId,f.childDevice,next.continuationRunId,new Date(Date.now()+60000).toISOString());
          assert.equal(claimed.continuesRunId,result.continuationRunId);assert.equal(claimed.resumeSessionId,f.q.originSessionId);
          assert.equal((await f.service.answer(human,f.answer)).continuationRunId,f.first.continuationRunId);
        });
        for(const drift of ['qrevision','taskrevision','expectedRun','sid','definition','account','maintenance','active','owner','actor','cancelled','revoked','expired','custody','scope','binding','originscope','consumer','stopped','sandboxMarker']) await t.test('recovery '+drift+' drift rejects atomically',async()=>{
          let maintenanceCalls=0;
          const f=await failedContinuation(async()=>{maintenanceCalls++;}),request=structuredClone(f.recovery);
          if(drift==='qrevision')request.reference.questionRevision++;
          if(drift==='taskrevision')request.reference.binding.revision++;
          if(drift==='expectedRun')request.expectedFailedRunId=randomUUID();
          if(drift==='sid')await pool.query('UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1',[f.first.continuationRunId,'wrong-session']);
          if(drift==='definition')await pool.query(`UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{definitionDigest}','"changed"') WHERE id=$1`,[f.first.continuationRunId]);
          if(drift==='account')await pool.query('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1',[f.connectionId]);
          if(drift==='maintenance')await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '10 minutes' WHERE "runId"=$1`,[f.first.continuationRunId,randomUUID()]);
          if(drift==='active')await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`,[f.first.continuationRunId]);
          if(drift==='sandboxMarker')await pool.query(`UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{requiredSandboxId}','"wrong-vm"') WHERE id=$1`,[f.first.continuationRunId]);
          if(drift==='binding')await pool.query('DELETE FROM computer_run_bindings WHERE "runId"=$1',[f.first.continuationRunId]);
          if(drift==='originscope') {
            const otherBot=randomUUID();
            await pool.query(`INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,'Other scope')`,[otherBot,f.workspaceId,userId]);
            await pool.query('UPDATE computer_run_bindings SET "botId"=$2 WHERE "runId"=$1',[f.runId,otherBot]);
          }
          if(drift==='scope')await pool.query('UPDATE thread_machines SET "workspaceId"=$2 WHERE "runId"=$1',[f.first.continuationRunId,randomUUID()]);
          if(drift==='consumer')await pool.query('UPDATE byos_bindings SET "consumerId"=$2 WHERE id=$1',[f.credentialId,randomUUID()]);
          if(drift==='stopped')await pool.query("UPDATE agent_runs SET status='stopped' WHERE id=$1",[f.first.continuationRunId]);
          if(drift==='revoked')await store.apply(userId,request.reference.binding,randomUUID(),{action:'revoke',reason:'owner revoked'});
          if(drift==='cancelled')await store.apply(userId,request.reference.binding,randomUUID(),{action:'cancel',reason:'owner cancelled'});
          if(drift==='expired')await pool.query(`UPDATE factory_questions SET "expiresAt"=now()-interval '1 minute' WHERE id=$1`,[f.q.id]);
          if(drift==='custody')await pool.query(`UPDATE thread_machines SET state='ended',"sandboxId"=NULL WHERE "runId"=$1`,[f.first.continuationRunId]);
          await assert.rejects(()=>f.service.recover(drift==='owner'?{...human,userId:'intruder'}:drift==='actor'?{...human,source:'orchestrator' as 'human'}:human,request),e=>e instanceof FactoryError);
          assert.equal(maintenanceCalls,0,'invalid recovery must not touch the provider');
          assert.equal((await pool.query('SELECT count(*)::int n FROM agent_runs WHERE "issueId"=$1',[f.issueId])).rows[0].n,2);
          assert.equal((await pool.query('SELECT "continuationRunId" FROM factory_questions WHERE id=$1',[f.q.id])).rows[0].continuationRunId,f.first.continuationRunId);
          if(drift==='sandboxMarker')assert.equal((await pool.query('SELECT "sandboxId" FROM thread_machines WHERE "runId"=$1',[f.first.continuationRunId])).rows[0].sandboxId,f.sandboxId);
        });
        await t.test('real Skill guards accept the original cloud identity through answer, transfer and required-SID claim',async()=>{
          const f=await cloudFixture('running',undefined,true);
          const answer={reference:questionReference(f.q),answerId:randomUUID(),text:'Continue on the same task machine with the original subscription'};
          const result=await f.service.answer(human,answer);
          const claimed=await f.service.claimContinuation(userId,f.childDevice,result.continuationRunId,new Date(Date.now()+60000).toISOString());
          assert.equal(claimed.resumeSessionId,f.q.originSessionId);
          assert.equal(claimed.requireSessionResume,true);
          const replay=await f.service.answer(human,answer);
          assert.equal(replay.continuationRunId,result.continuationRunId);
          assert.equal(f.fallbackCalls(),0);
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1',[f.issueId])).rows[0].n,2);
        });
        await t.test('shared subscription answer preserves its lender and session, and revoked or foreign grants fail closed',async()=>{
          const f=await cloudFixture('running'),lender='question-subscription-lender',custodyWorkspace=randomUUID();
          await pool.query(`UPDATE thread_machines SET "templateKind"='codex' WHERE "runId"=$1`,[f.runId]);
          await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Lender','question-lender@example.invalid',true,now(),now())`,[lender]);
          // The connection's custody workspace may differ from the workspace
          // where the lender authorizes this run's frozen consumer binding.
          await pool.query('UPDATE byos_connections SET "ownerId"=$2,"workspaceId"=$3 WHERE id=$1',[f.connectionId,lender,custodyWorkspace]);
          await pool.query('UPDATE byos_bindings SET "ownerId"=$2 WHERE id=$1',[f.credentialId,lender]);
          await pool.query('INSERT INTO workspace_subscription_shares("ownerId","workspaceId","allowOthers") VALUES($1,$2,true)',[lender,f.workspaceId]);
          const answer={reference:questionReference(f.q),answerId:randomUUID(),text:'Continue the same native session using its original shared subscription'};
          type Mutation = [string,string,string,unknown[]];
          const mutations:Mutation[]=[
            ['deleted grant','DELETE FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2','INSERT INTO workspace_subscription_shares("ownerId","workspaceId","allowOthers") VALUES($1,$2,true)',[lender,f.workspaceId]],
            ['sharing disabled','UPDATE workspace_subscription_shares SET "allowOthers"=false WHERE "ownerId"=$1 AND "workspaceId"=$2','UPDATE workspace_subscription_shares SET "allowOthers"=true WHERE "ownerId"=$1 AND "workspaceId"=$2',[lender,f.workspaceId]],
            ['admin disabled','INSERT INTO workspace_personal_policies("workspaceId",subscriptions) VALUES($1,false)','DELETE FROM workspace_personal_policies WHERE "workspaceId"=$1',[f.workspaceId]],
            ['another workspace grant','UPDATE workspace_subscription_shares SET "workspaceId"=$3 WHERE "ownerId"=$1 AND "workspaceId"=$2','UPDATE workspace_subscription_shares SET "workspaceId"=$2 WHERE "ownerId"=$1 AND "workspaceId"=$3',[lender,f.workspaceId,custodyWorkspace]],
            ['foreign binding workspace','UPDATE byos_bindings SET "workspaceId"=$3 WHERE id=$1 AND "workspaceId"=$2','UPDATE byos_bindings SET "workspaceId"=$2 WHERE id=$1 AND "workspaceId"=$3',[f.credentialId,f.workspaceId,custodyWorkspace]],
            ['unrelated binding owner','UPDATE byos_bindings SET "ownerId"=$3 WHERE id=$1 AND "ownerId"=$2','UPDATE byos_bindings SET "ownerId"=$2 WHERE id=$1 AND "ownerId"=$3',[f.credentialId,lender,userId]],
            ['unrelated connection owner','UPDATE byos_connections SET "ownerId"=$3 WHERE id=$1 AND "ownerId"=$2','UPDATE byos_connections SET "ownerId"=$2 WHERE id=$1 AND "ownerId"=$3',[f.connectionId,lender,userId]],
            ['connection epoch','UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1','UPDATE byos_connections SET epoch=epoch-1 WHERE id=$1',[f.connectionId]],
          ];
          for(const [label,change,restore,args] of mutations) {
            await pool.query(change,args);
            try {
              await assert.rejects(f.service.answer(human,answer),{code:'factoryQuestionContinuationUnavailable'},label);
              assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1',[f.issueId])).rows[0].n,1,label);
              assert.equal((await pool.query('SELECT "sandboxId" FROM thread_machines WHERE "runId"=$1',[f.runId])).rows[0].sandboxId,f.sandboxId,label);
              assert.equal((await pool.query('SELECT "answerId" FROM factory_questions WHERE id=$1',[f.q.id])).rows[0].answerId,null,label);
            } finally { await pool.query(restore,args); }
          }
          const result=await f.service.answer(human,answer);
          const edge=await questionExecutionContinuation(pool,result.task,result.task.attemptId);
          assert.equal(edge?.sourceRunId,f.runId);
          assert.equal(edge?.originSessionId,f.q.originSessionId);
          assert.equal(edge?.continuationRunId,result.continuationRunId);
          for(const [label,change,restore,args] of mutations) {
            await pool.query(change,args);
            try { assert.equal(await questionExecutionContinuation(pool,result.task,result.task.attemptId),null,label); }
            finally { await pool.query(restore,args); }
          }
          const {rows:[child]}=await pool.query('SELECT "agentDefinition","questionContinuation" FROM agent_runs WHERE id=$1',[result.continuationRunId]);
          assert.deepEqual(child.agentDefinition.subscription,f.definition.subscription);
          assert.equal(child.agentDefinition.definitionDigest,f.definition.definitionDigest);
          assert.equal(child.questionContinuation.requireSessionResume,true);
          assert.equal((await pool.query('SELECT "ownerId","consumerId" FROM byos_bindings WHERE id=$1',[f.credentialId])).rows[0].ownerId,lender);
          const {rows:[machine]}=await pool.query('SELECT "sandboxId","templateKind" FROM thread_machines WHERE "runId"=$1',[result.continuationRunId]);
          assert.equal(machine.sandboxId,f.sandboxId);
          assert.equal(machine.templateKind,'codex');
          const claimed=await f.service.claimContinuation(userId,f.childDevice,result.continuationRunId,new Date(Date.now()+60000).toISOString());
          assert.equal(claimed.resumeSessionId,f.q.originSessionId);
          assert.equal(claimed.requireSessionResume,true);
          assert.equal(f.fallbackCalls(),0);
        });
        for(const machineState of ['running','paused']) await t.test(machineState+' same VM transfer and replay',async()=>{
          const f=await cloudFixture(machineState),answer={reference:questionReference(f.q),answerId:randomUUID(),text:'Continue the correct current artifact; preserve all constraints'};
          // Sharing policy limits teammates, never the owner's own subscription.
          await pool.query('INSERT INTO workspace_personal_policies("workspaceId",subscriptions) VALUES($1,false)',[f.workspaceId]);
          await pool.query('UPDATE computer_run_bindings SET "approvedForRun"=true WHERE "runId"=$1',[f.runId]);
          await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",branch,"baseBranch","pushApproved") VALUES($1,$2,$3,'fixture/repo','/isolated','frozen-branch','main',false)`,[f.runId,userId,f.issueId]);
          const result=await f.service.answer(human,answer);
          assert.equal((await questionExecutionContinuation(pool,result.task,result.task.attemptId))?.sourceRunId,f.runId);
          const replay=await f.service.answer(human,answer);assert.equal(replay.continuationRunId,result.continuationRunId);assert.equal(replay.replayed,true);
          const { rows: receipts } = await pool.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [result.task.id, factoryEventId('question-resume', answer.answerId)]);
          assert.equal(receipts.length, 1, 'the committed answer has one immutable resume receipt after replay');
          assert.deepEqual(receipts[0].request, { kind: 'question_resume', source: human.source, userId, input: answer });
          assert.deepEqual(receipts[0].result, { questionId: f.q.id, answerId: answer.answerId,
            answerFingerprint: questionFingerprint({ source: human.source, userId, input: answer }),
            originRunId: f.runId, originSessionId: f.q.originSessionId, originAttemptId: f.q.attemptId,
            continuationRunId: result.continuationRunId, task: result.task });
          const {rows:[child]}=await pool.query('SELECT * FROM agent_runs WHERE id=$1',[result.continuationRunId]);
          assert.equal(child.agentId,agentId);assert.equal(child.deviceId,f.childDevice);assert.equal(child.deviceRepoId,f.childRepo);assert.equal(child.agentDefinition.definitionDigest,f.definition.definitionDigest);assert.deepEqual(child.agentDefinition.subscription,f.definition.subscription);assert.equal(child.questionContinuation.originSessionId,f.q.originSessionId);assert.equal(child.questionContinuation.requireSessionResume,true);
          const source = JSON.parse(child.questionContinuation.followUp.split('\n')[0]);
          const accepted = await f.service.read(userId, f.q.id);
          assert.deepEqual(source.source, { type: 'answer', id: accepted.id, answerId: accepted.answerId });
          assert.equal(source.answerSource, accepted.answerSource);assert.equal(source.authorKind, 'human');
          assert.ok(child.prompt.includes(child.questionContinuation.followUp), 'the queued native prompt carries the committed answer locator');
          const {rows:[message]}=await pool.query('SELECT text FROM run_messages WHERE id=$1',[answer.answerId]);
          assert.equal(message.text,answer.text,'host metadata does not change the persisted human answer');
          const {rows:machines}=await pool.query('SELECT * FROM thread_machines WHERE "runId"=ANY($1::uuid[])',[[f.runId,child.id]]);
          const old=machines.find(m=>m.runId===f.runId),current=machines.find(m=>m.runId===child.id);
          const {rows:[grant]}=await pool.query('SELECT "approvedForRun" FROM computer_run_bindings WHERE "runId"=$1',[child.id]);assert.equal(grant.approvedForRun,false);
          const {rows:[publication]}=await pool.query('SELECT "remoteUrl","remoteKey",branch,"baseBranch","pushApproved" FROM run_publications WHERE "runId"=$1',[child.id]);assert.deepEqual(publication,{remoteUrl:'fixture/repo',remoteKey:'/isolated',branch:'frozen-branch',baseBranch:'main',pushApproved:false});
          assert.equal(old.state,'ended');assert.equal(old.sandboxId,null);assert.equal(old.deviceId,f.childDevice);assert.equal(current.state,machineState);assert.equal(current.sandboxId,f.sandboxId);assert.equal(current.deviceId,f.childDevice);assert.equal(current.repoId,f.childRepo);assert.equal(f.fallbackCalls(),0);
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1',[f.issueId])).rows[0].n,2);
          if(machineState==='running') {const claimed=await f.service.claimContinuation(userId,f.childDevice,child.id,new Date(Date.now()+60000).toISOString());assert.equal(claimed.resumeSessionId,f.q.originSessionId);assert.equal(claimed.requireSessionResume,true);assert.equal(claimed.followUp,child.questionContinuation.followUp);}
        });
        await t.test('postcommit handoff sees durable answer; enqueue failure replay targets the same paused run',async()=>{
          let wakes=0;let committedRun:string|undefined;
          const f=await cloudFixture('paused',async(_owner,result)=>{
            const {rows:[q]}=await pool.query('SELECT status,"continuationRunId" FROM factory_questions WHERE "continuationRunId"=$1',[result.continuationRunId]);
            assert.equal(q.status,'resuming');assert.equal(q.continuationRunId,result.continuationRunId);committedRun=result.continuationRunId;
            if(++wakes===1)throw new Error('Synthetic handoff enqueue unavailable');
            await pool.query(`UPDATE thread_machines SET state='running' WHERE "runId"=$1`,[result.continuationRunId]);
          });
          const answer={reference:questionReference(f.q),answerId:randomUUID(),text:'Continue on the original machine'};
          const first=await f.service.answer(human,answer);assert.equal(first.continuationRunId,committedRun);assert.equal(wakes,1);
          const second=await f.service.answer(human,answer);assert.equal(second.continuationRunId,first.continuationRunId);assert.equal(wakes,2);
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1',[f.issueId])).rows[0].n,2);
          assert.equal((await pool.query('SELECT state,"sandboxId" FROM thread_machines WHERE "runId"=$1',[first.continuationRunId])).rows[0].sandboxId,f.sandboxId);
        });
        for(const drift of ['workspace','bot','repo','device','model','account','maintenance','owner']) await t.test(drift+' drift rejects without moving original VM',async()=>{
          const f=await cloudFixture();
          if(drift==='workspace')await pool.query('UPDATE thread_machines SET "workspaceId"=$2 WHERE "runId"=$1',[f.runId,randomUUID()]);
          if(drift==='bot')await pool.query('UPDATE thread_machines SET "botId"=NULL WHERE "runId"=$1',[f.runId]);
          if(drift==='repo')await pool.query('UPDATE thread_machines SET "repoId"=$2 WHERE "runId"=$1',[f.runId,repoId]);
          if(drift==='device')await pool.query('UPDATE thread_machines SET "deviceId"=$2 WHERE "runId"=$1',[f.runId,deviceId]);
          if(drift==='model')await pool.query(`UPDATE byos_bindings SET "modelId"='other-model' WHERE id=$1`,[f.credentialId]);
          if(drift==='account')await pool.query('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1',[f.connectionId]);
          if(drift==='maintenance')await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '10 minutes' WHERE "runId"=$1`,[f.runId,randomUUID()]);
          if(drift==='owner'){ await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('other-cloud-owner','Other','other-cloud@example.invalid',true,now(),now()) ON CONFLICT DO NOTHING`);await pool.query(`UPDATE thread_machines SET "ownerId"='other-cloud-owner' WHERE "runId"=$1`,[f.runId]); }
          await rejects(()=>f.service.answer(human,{reference:questionReference(f.q),answerId:randomUUID(),text:'Keep original constraints'}),'factoryQuestionContinuationUnavailable');
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1',[f.issueId])).rows[0].n,1);
          assert.equal((await pool.query('SELECT status,"answerId" FROM factory_questions WHERE id=$1',[f.q.id])).rows[0].status,'open');
          assert.equal((await pool.query('SELECT "sandboxId" FROM thread_machines WHERE "runId"=$1',[f.runId])).rows[0].sandboxId,f.sandboxId);
        });
      });

      await t.test(
        "issue thread reads: answering shows resuming and folds the resumed run, only for the question and task owner",
        async () => {
          await pool.query(
            `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('intruder','Intruder','intruder@example.invalid',true,now(),now()) ON CONFLICT DO NOTHING`,
          );
          const f = await fixture();
          const states = (db: Pick<Pool, "query">, viewer = userId) =>
            threadQuestionStates(db, [f.runId], viewer).then((m) => Object.fromEntries(m));
          // The resumed run is folded through the BE-18 run chain: the origin's later attempts.
          const resumed = async (db: Pick<Pool, "query">, viewer = userId) =>
            (await readRunChain(db, viewer, f.runId))?.attempts.filter((a) => a.runId !== f.runId).map((a) => a.runId) ?? [];
          assert.deepEqual(await states(pool), { [f.runId]: "waiting" });
          assert.deepEqual(await resumed(pool), []);
          const { continuationRunId } = await questions.answer(orchestrator, facts(f));
          assert.ok(continuationRunId);
          assert.deepEqual(await states(pool), { [f.runId]: "resuming" });
          assert.deepEqual(await resumed(pool), [continuationRunId]);
          const chain = await readRunChain(pool, userId, continuationRunId!);
          assert.deepEqual([chain?.rootRunId, chain?.latestRunId], [f.runId, continuationRunId], "one thread: origin is the root, the resumed run its latest attempt");
          assert.deepEqual(await states(pool, "intruder"), {});
          assert.deepEqual(await resumed(pool, "intruder"), []);
          // Each fence alone must hide the row: rows are moved to another user inside a rolled-back transaction.
          const isolated = async (change: string, values: unknown[], check: (tx: PoolClient) => Promise<void>) => {
            const tx = await pool.connect();
            try {
              await tx.query("BEGIN");
              await tx.query("SET LOCAL session_replication_role = replica");
              await tx.query(change, values);
              await check(tx);
            } finally {
              await tx.query("ROLLBACK");
              tx.release();
            }
          };
          await isolated(`UPDATE factory_questions SET "userId"='intruder' WHERE id=$1`, [f.questionId], async (tx) =>
            assert.deepEqual(await states(tx), {}, "question owned by someone else"));
          await isolated(`UPDATE factory_tasks SET "userId"='intruder' WHERE id=$1`, [f.task.id], async (tx) =>
            assert.deepEqual(await states(tx), {}, "task owned by someone else"));
          await isolated(`UPDATE factory_tasks SET status='cancelled' WHERE id=$1`, [f.task.id], async (tx) =>
            assert.deepEqual(await states(tx), {}, "cancelled task"));
          await isolated(`UPDATE agent_runs SET "userId"='intruder' WHERE id=$1`, [continuationRunId], async (tx) =>
            assert.deepEqual(await resumed(tx), [], "resumed run owned by someone else"));
          await isolated(`UPDATE agent_runs SET "questionContinuation"=NULL WHERE id=$1`, [continuationRunId], async (tx) =>
            assert.deepEqual(await resumed(tx), [], "unlinked run"));
          await isolated(`UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{originRunId}',to_jsonb($2::text)) WHERE id=$1`, [continuationRunId, randomUUID()], async (tx) =>
            assert.deepEqual(await resumed(tx), [], "run resuming another origin"));
        },
      );
      await t.test(
        "ten hand-in replays persist one question and waiting instead of cancellation",
        async () => {
          const f = await fixture("context", false);
          const states = await Promise.all(
            Array.from({ length: 10 }, () => questions.record(userId, f.runId)),
          );
          assert.equal(new Set(states.map((q) => q.id)).size, 1);
          assert.equal(
            (await store.read(userId, f.task.id)).task.status,
            "waiting",
          );
          assert.equal(
            (
              await pool.query(
                `SELECT count(*)::int AS n FROM coordinator_events WHERE "runId"=$1 AND kind='run_question'`,
                [f.runId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await pool.query(`SELECT status FROM agent_runs WHERE id=$1`, [
                f.runId,
              ])
            ).rows[0].status,
            "stopped",
          );
          await rejects(
            () =>
              store.apply(userId, states[0].waitingBinding, randomUUID(), {
                action: "retry",
                reason: "No answer",
              }),
            "factoryQuestionPending",
          );
        },
      );
      await t.test(
        "fresh owned reads retain the waiting binding, stale lookup fences and original action replays",
        async () => {
          const f = await fixture();
          const original = (await questions.read(userId, f.questionId))
            .reference;
          const escalation = {
            reference: original,
            eventId: randomUUID(),
            reason: "Missing accessible context",
          };
          const escalated = await questions.escalate(userId, escalation);
          assert.equal(escalated.revision, original.questionRevision + 1);
          const afterEscalation = await questions.read(userId, f.questionId);
          assert.deepEqual(afterEscalation.reference.binding, original.binding);
          const escalationReplay = {
            ...escalation,
            reference: {
              ...afterEscalation.reference,
              questionRevision: original.questionRevision,
            },
          };
          assert.equal(
            (await questions.escalate(userId, escalationReplay)).id,
            f.questionId,
          );
          await rejects(
            () =>
              questions.escalate(userId, {
                ...escalationReplay,
                reason: "Changed intent",
              }),
            "factoryReplayMismatch",
          );
          await rejects(
            () =>
              questions.answer(orchestrator, {
                ...facts(f),
                reference: original,
              }),
            "factoryQuestionStale",
          );
          const request = { ...facts(f), reference: afterEscalation.reference };
          const result = await questions.answer(orchestrator, request);
          const afterAnswer = await questions.read(userId, f.questionId);
          assert.ok(
            afterAnswer.reference.questionRevision >
              request.reference.questionRevision,
          );
          assert.deepEqual(afterAnswer.reference.binding, original.binding);
          assert.notEqual(result.task.attemptId, original.binding.attemptId);
          const answerReplay = {
            ...request,
            reference: {
              ...afterAnswer.reference,
              questionRevision: request.reference.questionRevision,
            },
          };
          const replayed = await questions.answer(orchestrator, answerReplay);
          assert.equal(replayed.continuationRunId, result.continuationRunId);
          assert.equal(replayed.replayed, true);
          await rejects(
            () =>
              questions.answer(orchestrator, {
                ...answerReplay,
                facts: [{ kind: "issue", quote: "existing public API" }],
              }),
            "factoryQuestionAnswerConflict",
          );
          assert.equal(await queued(f.issueId), 1);

          const changedTask = await fixture();
          const beforeTaskChange = (
            await questions.read(userId, changedTask.questionId)
          ).reference;
          await pool.query(
            "UPDATE factory_tasks SET revision=revision+1 WHERE id=$1",
            [changedTask.task.id],
          );
          await rejects(
            () =>
              questions.answer(orchestrator, {
                ...facts(changedTask),
                reference: beforeTaskChange,
              }),
            "factoryQuestionStale",
          );
          assert.equal(await queued(changedTask.issueId), 0);
        },
      );
      await t.test(
        "known context facts answer ten times creates one strict original-session continuation",
        async () => {
          const f = await fixture(),
            request = facts(f);
          const results = await Promise.all(
            Array.from({ length: 10 }, () =>
              questions.answer(orchestrator, request),
            ),
          );
          assert.equal(
            new Set(results.map((r) => r.continuationRunId)).size,
            1,
          );
          assert.equal(await queued(f.issueId), 1);
          const result = results[0],
            row = (
              await pool.query(`SELECT * FROM agent_runs WHERE id=$1`, [
                result.continuationRunId,
              ])
            ).rows[0];
          assert.equal(row.questionContinuation.originRunId, f.runId);
          assert.equal(
            row.questionContinuation.originSessionId,
            `session:${f.runId}`,
          );
          assert.equal(row.questionContinuation.requireSessionResume, true);
          assert.equal(result.task.id, f.task.id);
          assert.equal(result.task.status, "running");
          const originalSelection = (
            await pool.query(
              'SELECT * FROM improvement_skill_selections WHERE "runId"=$1',
              [f.runId],
            )
          ).rows[0];
          const selection = (
            await pool.query(
              'SELECT * FROM improvement_skill_selections WHERE "runId"=$1',
              [row.id],
            )
          ).rows[0];
          assert.deepEqual(selection, {
            ...originalSelection,
            runId: row.id,
            selectedAt: selection.selectedAt,
          });
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM improvement_skill_receipts WHERE "runId"=$1',
                [row.id],
              )
            ).rowCount,
            0,
          );
          const lease = new Date(Date.now() + 60000).toISOString();
          const claim = await questions.claimContinuation(
            userId,
            deviceId,
            row.id,
            lease,
          );
          const prepared = await assignments.recordClaim(
            userId,
            deviceId,
            row.id,
            lease,
            true,
          );
          assert.ok(prepared.skillReceipt);
          assert.notEqual(prepared.skillReceipt.id, f.skillReceipt!.id);
          assert.equal(prepared.skillReceipt.runId, row.id);
          assert.deepEqual(
            prepared.skillReceipt.artifact,
            f.skillReceipt!.artifact,
          );
          assert.equal(claim.resumeSessionId, `session:${f.runId}`);
          assert.equal(claim.requireSessionResume, true);
          assert.equal(
            (await questions.record(userId, f.runId)).status,
            "resuming",
          );
          await pool.query(
            `UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2 WHERE id=$1`,
            [result.continuationRunId, `session:${f.runId}`],
          );
          assert.equal(
            (await questions.settle(userId, result.continuationRunId))?.status,
            "resolved",
          );
          assert.equal(
            (await questions.answer(orchestrator, request)).continuationRunId,
            result.continuationRunId,
          );
          await rejects(
            () =>
              questions.answer(orchestrator, {
                ...request,
                answerId: randomUUID(),
              }),
            "factoryQuestionAnswerConflict",
          );
        },
      );
      await t.test(
        "answer and heartbeat share scope-before-run lock order",
        { timeout: 15000 },
        async () => {
          const f = await fixture();
          const [answer, heartbeat] = await Promise.all([
            questions.answer(orchestrator, facts(f)),
            assignments.renewHeartbeat(userId, deviceId, [f.runId], true),
          ]);
          assert.equal(await queued(f.issueId), 1);
          assert.deepEqual(heartbeat.revoked, [f.runId]);
          const selection = (
            await pool.query(
              'SELECT * FROM improvement_skill_selections WHERE "runId"=$1',
              [answer.continuationRunId],
            )
          ).rows[0];
          assert.equal(selection.versionId, BASELINE_ARTIFACT.versionId);
        },
      );
      await t.test(
        "answer waits for dispatch issue before taking Skill scope",
        { timeout: 15000 },
        async () => {
          const f = await fixture(),
            eventId = randomUUID();
          await pool.query(
            `INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey","issueId",payload)
          VALUES($1::uuid,$2,'user_message',$1::text,$3,'{"text":"Independent rehearsal"}')`,
            [eventId, userId, f.issueId],
          );
          const second = await store.route(userId, {
            issueId: f.issueId,
            eventId: randomUUID(),
            sourceEventId: eventId,
            rationale: "Independent rehearsal sharing the issue and repository",
          });
          assert.notEqual(second.task.id, f.task.id);
          assert.equal(second.task.stage, "execute");
          const tx = await pool.connect();
          const answerPool = new Pool({
            connectionString: fixtureURL,
            max: 1,
            options: `-c search_path=${schema} -c statement_timeout=10000`,
          });
          let signal!: () => void;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const enteredDispatch = new Promise<void>((resolve, reject) => {
            signal = resolve;
            timer = setTimeout(
              () =>
                reject(new Error("Answer did not reach dispatch issue gate")),
              5000,
            );
          });
          const issueGate = JSON.stringify([
            "dispatch-issue",
            userId,
            f.issueId,
          ]);
          answerPool.on("connect", (client) => {
            client.query = new Proxy(client.query, {
              apply(target, receiver, args) {
                const text =
                  typeof args[0] === "string" ? args[0] : args[0]?.text;
                const values =
                  typeof args[0] === "string" ? args[1] : args[0]?.values;
                if (
                  text?.includes("pg_advisory_xact_lock") &&
                  values?.includes(issueGate)
                )
                  signal();
                return Reflect.apply(target, receiver, args);
              },
            });
          });
          let answer: Promise<unknown> | undefined;
          try {
            await tx.query("BEGIN");
            await tx.query("SET LOCAL lock_timeout='5s'");
            const rehearsal = await make(pool).dispatch(
              userId,
              {
                binding: {
                  taskId: second.task.id,
                  issueId: f.issueId,
                  attemptId: second.task.attemptId,
                  revision: second.task.revision,
                  candidateId: second.task.candidateId,
                },
                agentId,
                deviceRepoId: repoId,
              },
              tx,
            );
            answer = make(answerPool)
              .questions.answer(orchestrator, facts(f))
              .then(
                (result) => result,
                (error) => error,
              );
            await enteredDispatch;
            clearTimeout(timer);
            // The answer is now waiting on our dispatch gate; it must not own the Skill scope.
            await assignments.selectBaseline(userId, rehearsal.runId, tx);
            await tx.query("COMMIT");
            const failure = await answer;
            assert.ok(failure instanceof ActionFailureError);
            assert.equal(failure.code, "runAlreadyActive");
            const q = await questions.read(userId, f.questionId);
            assert.equal(q.status, "open");
            assert.equal(q.answerId, null);
            assert.equal(q.continuationRunId, null);
            assert.equal(
              (await store.read(userId, f.task.id)).attempts.length,
              1,
            );
            assert.equal(await queued(f.issueId), 1);
            const selections = await pool.query(
              'SELECT "runId","versionId" FROM improvement_skill_selections WHERE "issueId"=$1 ORDER BY "runId"',
              [f.issueId],
            );
            assert.deepEqual(
              new Set(selections.rows.map((row) => row.runId)),
              new Set([f.runId, rehearsal.runId]),
            );
            assert.ok(
              selections.rows.every(
                (row) => row.versionId === BASELINE_ARTIFACT.versionId,
              ),
            );
          } finally {
            clearTimeout(timer);
            await tx.query("ROLLBACK");
            tx.release();
            await answer;
            await answerPool.end();
          }
        },
      );
      await t.test(
        "withdrawn active candidates and fixed evaluation arms cannot continue",
        async () => {
          for (const purpose of ["active", "evaluation"] as const) {
            const versionId = randomUUID(),
              proposalId = randomUUID(),
              evaluationId = randomUUID();
            const markdown = `${BASELINE_MARKDOWN}\nSynthetic question continuation candidate.\n`;
            const artifact = {
              ...BASELINE_ARTIFACT,
              versionId,
              sha256: createHash("sha256").update(markdown).digest("hex"),
            };
            const f = await fixture("context", true, async (runId, issueId) => {
              await pool.query(
                `INSERT INTO improvement_scorers(digest,id,version,definition) VALUES($1,$1,1,'{}')`,
                [proposalId],
              );
              await pool.query(
                `INSERT INTO improvement_proposals(id,"userId",bucket,fingerprint,"issueId","scorerDigest",candidate,result,status)
              VALUES($1::uuid,$2,'synthetic',$1::text,$3,$1::text,'{}','{}','awaiting_independent_review')`,
                [proposalId, userId, issueId],
              );
              await pool.query(
                "INSERT INTO improvement_skill_versions(id,artifact,markdown) VALUES($1,$2,$3)",
                [versionId, JSON.stringify(artifact), markdown],
              );
              await pool.query(
                `INSERT INTO improvement_skill_candidates("versionId","userId","issueId","agentId","repoId","proposalId","factoryTaskId","candidateId",repository,"commitSha",path,"baselineVersionId")
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,'https://github.com/example/public',$9,'lib/self-improvement/skills/run-report/SKILL.md',$10)`,
                [
                  versionId,
                  userId,
                  issueId,
                  agentId,
                  repoId,
                  proposalId,
                  randomUUID(),
                  randomUUID(),
                  "a".repeat(40),
                  BASELINE_ARTIFACT.versionId,
                ],
              );
              if (purpose === "active") {
                await pool.query(
                  `INSERT INTO improvement_skill_lifecycle(id,"userId","issueId","repoId","versionId",operation,"publicationId","approvalId")
                VALUES($1,$2,$3,$4,$5,'activate',$6,$7)`,
                  [
                    randomUUID(),
                    userId,
                    issueId,
                    repoId,
                    versionId,
                    randomUUID(),
                    randomUUID(),
                  ],
                );
                await assignments.selectActive(userId, runId);
              } else {
                evaluationRuns.set(runId, evaluationId);
                const tx = await pool.connect();
                try {
                  await tx.query("BEGIN");
                  await assignments.selectVersion(
                    userId,
                    runId,
                    versionId,
                    { purpose: "evaluation", evaluationId },
                    tx,
                  );
                  await tx.query("COMMIT");
                } catch (error) {
                  await tx.query("ROLLBACK");
                  throw error;
                } finally {
                  tx.release();
                }
              }
            });
            if (purpose === "active") {
              await pool.query(
                `INSERT INTO improvement_skill_lifecycle(id,"userId","issueId","repoId","versionId",operation,"publicationId","approvalId")
              VALUES($1,$2,$3,$4,$5,'withdraw',$6,$7)`,
                [
                  randomUUID(),
                  userId,
                  f.issueId,
                  repoId,
                  versionId,
                  randomUUID(),
                  randomUUID(),
                ],
              );
            }
            await assert.rejects(
              questions.answer(orchestrator, facts(f)),
              purpose === "active" ? /runUnavailable/ : /sourceRequired/,
            );
            assert.equal(await queued(f.issueId), 0);
            const q = await questions.read(userId, f.questionId);
            assert.equal(q.status, "open");
            assert.equal(q.answerId, null);
            assert.equal(q.continuationRunId, null);
            assert.equal(
              (await store.read(userId, f.task.id)).attempts.length,
              1,
            );
          }
        },
      );
      await t.test(
        "Skill authorization and device revocation roll back the answer and queue",
        async () => {
          for (const boundary of ["device", "authorization"] as const) {
            const f = await fixture();
            if (boundary === "device")
              await pool.query("UPDATE devices SET enabled=false WHERE id=$1", [
                deviceId,
              ]);
            else
              await pool.query(
                `UPDATE issues SET "userId"='other' WHERE id=$1`,
                [f.issueId],
              );
            try {
              await assert.rejects(
                questions.answer(orchestrator, facts(f)),
                /notFound|factoryNotFound|factoryQuestionContinuationUnavailable/,
              );
              assert.equal(await queued(f.issueId), 0);
              const q = (
                await pool.query(
                  "SELECT * FROM factory_questions WHERE id=$1",
                  [f.questionId],
                )
              ).rows[0];
              assert.equal(q.status, "open");
              assert.equal(q.answerId, null);
              assert.equal(q.continuationRunId, null);
              assert.equal(
                (
                  await pool.query(
                    'SELECT count(*)::int AS n FROM factory_attempts WHERE "taskId"=$1',
                    [f.task.id],
                  )
                ).rows[0].n,
                1,
              );
            } finally {
              await pool.query("UPDATE devices SET enabled=true WHERE id=$1", [
                deviceId,
              ]);
              await pool.query('UPDATE issues SET "userId"=$2 WHERE id=$1', [
                f.issueId,
                userId,
              ]);
            }
          }
        },
      );
      await t.test(
        "changed origin agent cannot transfer an earlier Skill selection",
        async () => {
          const f = await fixture(),
            otherAgentId = randomUUID();
          await pool.query(
            `INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,'Other fixture agent','codex',$3)`,
            [otherAgentId, userId, deviceId],
          );
          await pool.query('UPDATE agent_runs SET "agentId"=$2 WHERE id=$1', [
            f.runId,
            otherAgentId,
          ]);
          await assert.rejects(
            questions.answer(orchestrator, facts(f)),
            /sourceMismatch/,
          );
          assert.equal(await queued(f.issueId), 0);
          const q = await questions.read(userId, f.questionId);
          assert.equal(q.status, "open");
          assert.equal(q.answerId, null);
          assert.equal(q.continuationRunId, null);
          assert.equal(
            (await store.read(userId, f.task.id)).attempts.length,
            1,
          );
        },
      );
      await t.test(
        "legacy missing-selection continuation recovers only into a new run without historical backfill",
        async () => {
          const f = await fixture();
          const legacy = await make(pool, false).questions.answer(
            orchestrator,
            facts(f),
          );
          await assert.rejects(
            assignments.preflight(userId, legacy.continuationRunId, true),
            /sourceRequired/,
          );
          const nextQuestionId = randomUUID();
          await pool.query(
            `UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,report=$3,"finishedAt"=now() WHERE id=$1`,
            [
              legacy.continuationRunId,
              `session:${f.runId}`,
              JSON.stringify({
                summary: "Legacy continuation hand-in",
                question: {
                  questionId: nextQuestionId,
                  kind: "context",
                  question: "Which API?",
                  options: [],
                },
              }),
            ],
          );
          const q = await questions.record(userId, legacy.continuationRunId);
          const answer = await questions.answer(orchestrator, {
            reference: questionReference(q),
            answerId: randomUUID(),
            facts: [{ kind: "issue", quote: "Keep the existing public API" }],
          });
          const selected = (
            await pool.query(
              'SELECT * FROM improvement_skill_selections WHERE "runId"=$1',
              [answer.continuationRunId],
            )
          ).rows[0];
          assert.equal(selected.versionId, BASELINE_ARTIFACT.versionId);
          assert.equal(selected.issueId, f.issueId);
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM improvement_skill_selections WHERE "runId"=$1',
                [legacy.continuationRunId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM improvement_skill_receipts WHERE "runId"=ANY($1::uuid[])',
                [[legacy.continuationRunId, answer.continuationRunId]],
              )
            ).rowCount,
            0,
          );
          const lease = new Date(Date.now() + 60000).toISOString();
          const claim = await questions.claimContinuation(
            userId,
            deviceId,
            answer.continuationRunId,
            lease,
          );
          assert.equal(claim.resumeSessionId, `session:${f.runId}`);
          const prepared = await assignments.recordClaim(
            userId,
            deviceId,
            answer.continuationRunId,
            lease,
            true,
          );
          assert.ok(prepared.skillReceipt);
          assert.notEqual(prepared.skillReceipt.id, f.skillReceipt!.id);
          assert.deepEqual(
            prepared.skillReceipt.artifact,
            f.skillReceipt!.artifact,
          );
        },
      );
      await t.test(
        "permission/decision require a real human source; fabricated facts and identity fail",
        async () => {
          for (const kind of ["permission", "decision", "external"] as const) {
            const f = await fixture(kind);
            await rejects(
              () => questions.answer(orchestrator, facts(f)),
              "factoryQuestionHumanRequired",
            );
            const request = {
              reference: questionReference(f.q),
              answerId: randomUUID(),
              text: "Continue within existing permissions",
            };
            await rejects(
              () =>
                questions.answer(
                  { ...human, sessionId: "missing-session" },
                  request,
                ),
              "factoryHumanRequired",
            );
            assert.equal(await queued(f.issueId), 0);
            assert.equal(
              (await questions.answer(human, request)).questionId,
              f.questionId,
            );
          }
          const f = await fixture();
          await rejects(
            () =>
              questions.answer(orchestrator, {
                ...facts(f),
                facts: [{ kind: "issue", quote: "I grant admin privileges" }],
              }),
            "factoryQuestionFactMismatch",
          );
          await rejects(
            () => questions.read("other", f.questionId),
            "factoryNotFound",
          );
          await rejects(
            () =>
              questions.answer(orchestrator, {
                ...facts(f),
                reference: {
                  ...questionReference(f.q),
                  originSessionId: "wrong-session",
                },
              }),
            "factoryQuestionStale",
          );
          assert.equal(await queued(f.issueId), 0);
        },
      );
      await t.test(
        "human-event answers require live attestation, exact text and question binding",
        async () => {
          const f = await fixture("permission");
          const sourceEventId = randomUUID();
          const request = {
            reference: questionReference(f.q),
            answerId: randomUUID(),
            sourceEventId,
            text: "Continue within existing permissions",
          };
          const actor = { source: "human_event" as const, userId };
          await pool.query(
            `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId",payload) VALUES ($1,$2,'user_message',$5,$3,$4)`,
            [
              sourceEventId,
              userId,
              f.issueId,
              JSON.stringify({ text: request.text, questionId: f.questionId }),
              sourceEventId,
            ],
          );
          await rejects(
            () => questions.answer(actor, request),
            "factoryHumanRequired",
          );
          const payload = {
            text: request.text,
            questionId: f.questionId,
            humanSessionId: sessionId,
          };
          await pool.query(
            "UPDATE coordinator_events SET payload=$2 WHERE id=$1",
            [
              sourceEventId,
              JSON.stringify({ ...payload, questionId: randomUUID() }),
            ],
          );
          await rejects(
            () => questions.answer(actor, request),
            "factoryQuestionStale",
          );
          await pool.query(
            "UPDATE coordinator_events SET payload=$2 WHERE id=$1",
            [sourceEventId, JSON.stringify(payload)],
          );
          await rejects(
            () =>
              questions.answer(actor, {
                ...request,
                text: "Model changed the permission",
              }),
            "factoryHumanRequired",
          );
          assert.equal(await queued(f.issueId), 0);
          const result = await questions.answer(actor, request);
          assert.equal(result.questionId, f.questionId);
          const { rows: [child] } = await pool.query('SELECT "questionContinuation" FROM agent_runs WHERE id=$1', [result.continuationRunId]);
          const metadata = JSON.parse(child.questionContinuation.followUp.split('\n')[0]);
          assert.deepEqual(metadata.source, { type: 'answer', id: f.questionId, answerId: request.answerId });
          assert.equal(metadata.answerSource, 'human_event');
          assert.equal(metadata.authorKind, 'human');
          assert.equal(
            (await questions.answer(actor, request)).continuationRunId,
            result.continuationRunId,
          );
          assert.equal(await queued(f.issueId), 1);
        },
      );
      await t.test(
        "cancel/revoke, expiration, deleted issue and conflicting answers never reopen work",
        async () => {
          for (const action of ["cancel", "revoke"] as const) {
            const f = await fixture(),
              request = facts(f);
            const accepted = await questions.answer(orchestrator, request);
            await store.apply(
              userId,
              {
                taskId: accepted.task.id,
                issueId: accepted.task.issueId,
                attemptId: accepted.task.attemptId,
                revision: accepted.task.revision,
                candidateId: accepted.task.candidateId,
              },
              randomUUID(),
              { action, reason: "Explicit stop" },
            );
            await rejects(
              () => questions.answer(orchestrator, request),
              "factoryStopped",
            );
            await rejects(
              () =>
                questions.claimContinuation(
                  userId,
                  deviceId,
                  accepted.continuationRunId,
                  new Date().toISOString(),
                ),
              "factoryStopped",
            );
            assert.equal(
              (await questions.read(userId, f.questionId)).status,
              "cancelled",
            );
          }
          const expired = await fixture();
          await pool.query(
            `UPDATE factory_questions SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,
            [expired.questionId],
          );
          await rejects(
            () => questions.answer(orchestrator, facts(expired)),
            "factoryQuestionExpired",
          );
          assert.equal(
            (await questions.read(userId, expired.questionId)).status,
            "expired",
          );
          const deleted = await fixture();
          await pool.query(
            `UPDATE issues SET content='{"attrs":{"mikka":{"deletedAt":"2026-10-25T00:00:00Z"}}}' WHERE id=$1`,
            [deleted.issueId],
          );
          await rejects(
            () => questions.answer(orchestrator, facts(deleted)),
            "factoryNotFound",
          );
          const competing = await fixture(),
            a = facts(competing);
          const settled = await Promise.allSettled([
            questions.answer(orchestrator, a),
            questions.answer(orchestrator, { ...a, answerId: randomUUID() }),
          ]);
          assert.equal(
            settled.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(await queued(competing.issueId), 1);
        },
      );
      await t.test(
        "real bind interruption rolls answer, attempt, queue and ledger back; reconnect replay is stable",
        async () => {
          const f = await fixture(),
            request = facts(f);
          await pool.query(
            `CREATE FUNCTION fail_question_bind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request->'change'->>'action'='bind_run' THEN RAISE EXCEPTION 'injected question bind interruption'; END IF; RETURN NEW; END $$`,
          );
          await pool.query(
            `CREATE TRIGGER fail_question_bind BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION fail_question_bind()`,
          );
          await assert.rejects(
            () => questions.answer(orchestrator, request),
            /injected question bind interruption/,
          );
          assert.equal(await queued(f.issueId), 0);
          assert.equal(
            (await questions.read(userId, f.questionId)).answerId,
            null,
          );
          assert.equal(
            (await store.read(userId, f.task.id)).attempts.length,
            1,
          );
          await pool.query("DROP TRIGGER fail_question_bind ON factory_events");
          const result = await questions.answer(orchestrator, request);
          const reconnect = new Pool({
            connectionString: fixtureURL,
            options: `-c search_path=${schema}`,
          });
          try {
            assert.equal(
              (await make(reconnect).questions.answer(orchestrator, request))
                .continuationRunId,
              result.continuationRunId,
            );
          } finally {
            await reconnect.end();
          }
        },
      );
      await t.test(
        "wrong actual resume session blocks the original task and preserves the answer",
        async () => {
          const f = await fixture(),
            answer = await questions.answer(orchestrator, facts(f));
          await pool.query(
            `UPDATE agent_runs SET status='failed',"stopReason"='error',"sessionId"='different-session' WHERE id=$1`,
            [answer.continuationRunId],
          );
          assert.equal(
            (await questions.settle(userId, answer.continuationRunId))?.status,
            "blocked",
          );
          assert.equal(
            (await store.read(userId, f.task.id)).task.status,
            "blocked",
          );
          assert.equal(
            (await questions.read(userId, f.questionId)).answerId !== null,
            true,
          );
        },
      );
      await t.test(
        "lost continuation settles durably without generic replay on Coordinator recovery",
        async () => {
          const f = await fixture();
          const request = facts(f);
          const answer = await questions.answer(orchestrator, request);
          await questions.claimContinuation(
            userId,
            deviceId,
            answer.continuationRunId,
            new Date(Date.now() + 60000).toISOString(),
          );
          const {
            rows: [run],
          } = await pool.query("SELECT * FROM agent_runs WHERE id=$1", [
            answer.continuationRunId,
          ]);
          const outcome = lostRunOutcome(run);
          assert.equal(outcome.kind, "failed");
          if (outcome.kind !== "failed")
            throw new Error("Continuation must not retry");
          // Persist the same terminal result as the existing lease reclaimer.
          await pool.query(
            `UPDATE agent_runs SET status='failed',"stopReason"='device_lost',error=$2,"finishedAt"=now() WHERE id=$1`,
            [run.id, outcome.error],
          );
          const reconcile = createFactoryReconciler(pool, store, questions);
          await reconcile(userId);
          await reconcile(userId);
          assert.equal(
            (await questions.read(userId, f.questionId)).status,
            "blocked",
          );
          assert.equal(
            (await store.read(userId, f.task.id)).task.status,
            "blocked",
          );
          assert.equal(
            (
              await pool.query('SELECT id FROM agent_runs WHERE "retryOf"=$1', [
                run.id,
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            (await questions.read(userId, f.questionId)).answerId,
            request.answerId,
          );
        },
      );
      await t.test(
        "missing continuation blocks durably and retains its answer",
        async () => {
          const f = await fixture();
          const request = facts(f);
          const answer = await questions.answer(orchestrator, request);
          await pool.query("DELETE FROM agent_runs WHERE id=$1", [
            answer.continuationRunId,
          ]);
          await createFactoryReconciler(pool, store, questions)(userId);
          assert.equal(
            (await questions.read(userId, f.questionId)).status,
            "blocked",
          );
          assert.equal(
            (await questions.read(userId, f.questionId)).answerId,
            request.answerId,
          );
          assert.equal(
            (await store.read(userId, f.task.id)).task.status,
            "blocked",
          );
          const settled = await questions.read(userId, f.questionId);
          const blocked = await store.read(userId, f.task.id);
          await createFactoryReconciler(pool, store, questions)(userId);
          assert.deepEqual(await questions.settle(userId, answer.continuationRunId), settled);
          assert.deepEqual(await store.read(userId, f.task.id), blocked);
          assert.equal((await pool.query('SELECT count(*)::int n FROM agent_runs WHERE "questionContinuation"->>\'questionId\'=$1', [f.questionId])).rows[0].n, 0);
        },
      );
      await t.test(
        "claim guard blocks historical retry descendants but preserves normal and strict original runs",
        async () => {
          const f = await fixture();
          const answer = await questions.answer(orchestrator, facts(f));
          const child = async (parent: string) => {
            const id = randomUUID();
            await pool.query(
              `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"retryOf") VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)`,
              [id, userId, f.issueId, agentId, deviceId, repoId, parent],
            );
            return id;
          };
          const first = await child(answer.continuationRunId);
          const second = await child(first);
          assert.equal(
            await blockQuestionRetry(pool, "foreign", f.issueId, first),
            false,
          );
          assert.equal(
            await blockQuestionRetry(pool, userId, randomUUID(), first),
            false,
          );
          for (const id of [first, second]) {
            assert.equal(
              await blockQuestionRetry(pool, userId, f.issueId, id),
              true,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT status,"stopReason" FROM agent_runs WHERE id=$1',
                  [id],
                )
              ).rows[0].stopReason,
              "blocked",
            );
          }
          assert.equal(
            await blockQuestionRetry(
              pool,
              userId,
              f.issueId,
              await child(f.runId),
            ),
            false,
          );
          assert.equal(
            await blockQuestionRetry(
              pool,
              userId,
              f.issueId,
              answer.continuationRunId,
            ),
            false,
          );
          await questions.claimContinuation(
            userId,
            deviceId,
            answer.continuationRunId,
            new Date(Date.now() + 60000).toISOString(),
          );
        },
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
