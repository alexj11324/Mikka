import { syncFactoryPresentation } from './stage-progress';
import { readFactoryFlow } from './public-flow';
import { createFactorySpecApproval } from './spec-approval';
import { createFactoryHumanStore } from './human-store';
import { handleFactoryFlow } from './flow-http';
import { handleFactory } from './http';
import { readIssueThreads, loadIssueDocument, encodedIssueDocument } from '../linear-sync/document';
import { runArtifactSubmissions } from '../artifacts/run-submissions';
// Real #192 migrations/store/dispatch/questions/claim and #193 consumers.
// Run production code over isolated PG; queue, actor and terminal reports are fixtures.
// #331 host invocation uses a real loopback HTTP provider fixture and synthetic PNG.
// No real provider, account credential, screenshot or visual understanding is claimed.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { DECISION_MODEL, DECISIONS_URL } from "../coordinator/decision";
import { invokeDecision } from "../coordinator/decide";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  defaultRunPolicy,
  DEFAULT_NETWORK_ALLOW,
  type RunPolicy,
} from "@mikka/protocol/agent-policy";
import { Pool } from "pg";
import { assertE2eTarget } from "../../tests/helpers/e2e-target.mjs";
import { createRequestDatabaseScope } from "../db";
import { observePoolCommits } from '../db/commit-effects';
import { coordinatorWakeTransport } from '../coordinator/wake-after-commit';
import { hostedBillingScope } from "../abuse/context";
import { HostedUsageStore } from "../abuse/store";
import { exerciseFactoryRecoveryEntry } from "../../tests/support/factory-recovery-entry-fixture";
import { bindFixtureWorkspaceDatabase } from "../../tests/helpers/workspace-database";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { addFactoryPublicationEvidence, addFactoryVisualEvidence } from '../../tests/helpers/factory-visual-evidence';
import { freezeWorkerDefinition } from "../agent-kit/worker";
import { claimLocalRun } from "../computer/claim";
import { FactoryError } from "./contract";
import { approvalEvidence, hasFactoryVisualEvidence } from "./evidence";
import { createFactoryApprovalGates } from './approval';
import { createFactoryMerges } from './merge';
import { createFactoryStore, type FactoryTask } from "./store";
import {
  createFactoryDispatch,
  defaultFactoryDispatchAdapters,
  factoryBinding,
  type FactoryQueue,
} from "./dispatch";
import { createFactoryClaim } from "./claim";
import { createFactoryQuestions, questionReference } from "./questions/store";
import { queueCloudQuestionContinuation } from "./questions/queue-continuation";
import { cloudTaskTarget, ownedCloudTaskTarget } from "../computer/cloud-task-target";
import { humanQuestionAnswerSchema, questionFingerprint } from './questions/contract';
import { factoryEventId } from './event-id';
import { handleFactoryQuestion } from "./questions/http";
import { createFactoryReconciler } from "./reconcile";
import { factoryCheckIndependent } from "./check-independence";
import { observeFactoryCheckDispatch } from "./check-dispatch";
import {
  appendFactoryCheckContinuationContext,
  configureFactoryCheck,
  producerCommandObservations,
  priorReviewArtifactObservations,
  factoryCheckAssignment,
  factoryCheckGates,
  factoryRepairBrief,
  currentFactoryRequest,
} from "./checks";
import { reconcileFactoryCheck } from "./reconcile-check";
import {
  createFactoryCheckRecovery,
  type FactoryCheckRecoveryDependencies,
} from "./check-recovery";

test(
  "actual migrated PG/HTTP: review/verify receipt consumers and bounded repair",
  // This parent includes migrations/setup and more than 90 sequential PG/HTTP cases.
  // Allow their aggregate work under the normal four-suite CI concurrency;
  // individual SQL, lock and model deadlines and all assertions stay unchanged.
  { timeout: 300_000 },
  async (t) => {
    // Acceptance Artifacts register real after-COMMIT wakes. The consumer is
    // outside this fixture; do not start a Coordinator or pre-load the native
    // and queue modules before their explicit recovery fixtures below.
    const previousWake=coordinatorWakeTransport.wake;
    coordinatorWakeTransport.wake=async()=>{};
    t.after(()=>{coordinatorWakeTransport.wake=previousWake;});
    assert.equal(process.env.REQUIRE_DB, "1");
    const url = process.env.E2E_DATABASE_URL;
    assert.ok(url);
    assert.equal(process.env.DATABASE_URL, url);
    assert.equal(process.env.MIKKA_DATABASE_URL, url);
    const target = assertE2eTarget(url);
    if (process.env.GITHUB_ACTIONS === "true") {
      assert.equal(process.env.CI, "true");
      assert.equal(target.hostname, "127.0.0.1");
      assert.equal(target.port, "5432");
      assert.equal(target.username, "e2e");
      assert.equal(target.pathname, "/mikka_e2e");
    }
    const admin = new Pool({ connectionString: url });
    const database = `factory193_consumers_${randomUUID().replaceAll("-", "")}_e2e`;
    let pool: Pool | undefined;
    let modelDatabase: ReturnType<typeof createRequestDatabaseScope> | undefined;
    let closeWorkspaceDatabase: (() => Promise<void>) | undefined;
    let installedGatewayFixture = false;
    try {
      assert.equal(
        Math.floor(
          Number(
            (await admin.query("SHOW server_version_num")).rows[0]
              .server_version_num,
          ) / 10000,
        ),
        17,
      );
      // Extensions are database-wide. A schema in shared mikka_e2e would install
      // pg_trgm into that schema and break later isolated-schema suites.
      // Use this same validated isolated service and role; no DROP.
      await admin.query(`CREATE DATABASE "${database}"`);
      const isolated = new URL(url);
      isolated.pathname = `/${database}`;
      pool = new Pool({
        connectionString: isolated.toString(),
        max: 12,
        options: "-c statement_timeout=15000 -c lock_timeout=5000",
      });
      observePoolCommits(pool);
      const db = pool;
      modelDatabase = createRequestDatabaseScope(isolated.toString());
      closeWorkspaceDatabase = await bindFixtureWorkspaceDatabase(db);
      const directory = new URL("../../drizzle/", import.meta.url);
      for (const file of orderMigrations(
        (await readdir(directory)).filter((f) => f.endsWith(".sql")),
      ))
        await db.query(await readFile(new URL(file, directory), "utf8"));
      await db.query(
        `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','check@example.invalid',true,now(),now()),('other','Other','other-check@example.invalid',true,now(),now())`,
      );
      const billingWorkspaceId = randomUUID();
      await db.query(`INSERT INTO mikka_workspaces(id,"userId",name,slug) VALUES($1,'owner','Factory model fixture',$2)`,
        [billingWorkspaceId,`factory-${billingWorkspaceId}`]);
      await db.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status)
        VALUES($1,'owner','Fixture','check@example.invalid','admin','active')`,[billingWorkspaceId]);
      // The person's Coordinator is an ordinary bot row; its chat, runs and
      // factory tasks carry that bot's id from the entry point on.
      const coordinatorBot = randomUUID();
      await db.query(`INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,'owner','Coordinator')`,[coordinatorBot,billingWorkspaceId]);
      await db.query(`INSERT INTO coordinator_bots("ownerId","workspaceId","botId") VALUES('owner',$1,$2)`,[billingWorkspaceId,coordinatorBot]);
      const usage = new HostedUsageStore(db);
      await usage.verify(billingWorkspaceId, "synthetic-factory-customer", `factory-${billingWorkspaceId}`);
      // Bind the runtime to this test's actual accounting store, never a fake
      // successful budget response. Model admission uses its real implementation.
      t.mock.module(new URL("../abuse/runtime.ts",import.meta.url).href,{namedExports:{
        canUseMikkaPaid:(workspaceId:string)=>usage.canUseMikkaPaid(workspaceId),
        hostedUsage:usage,
      }});
      const authorize = async (
        user: string,
        issue: string,
        tx: import("pg").PoolClient,
      ) =>
        (
          await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [
            issue,
            user,
          ])
        ).rowCount === 1;
      const deviceId = randomUUID(),
        agentId = randomUUID(),
        repoId = randomUUID(),
        sha = "a".repeat(40),
        command = "node acceptance.mjs";
      await db.query(
        `INSERT INTO devices(id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Disposable check device',now(),'[{"harness":"codex","installed":true}]')`,
        [deviceId],
      );
      await db.query(
        `INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Check fixture','codex',$2)`,
        [agentId, deviceId],
      );
      await db.query(
        `INSERT INTO device_repos(id,"deviceId","userId","repoPath","verifyCommand") VALUES ($1,$2,'owner','/fixture/repo',$3)`,
        [repoId, deviceId, command],
      );
      let emitPresentation = false;
      let acceptanceReaderFixture: { taskId: string; artifactId: string; captureId: string } | undefined;
      const store = createFactoryStore(db, authorize, coordinatorBot, {
        onTransition: async (tx,task) => { if (emitPresentation) await syncFactoryPresentation(tx,task); },
        independent: factoryCheckIndependent,
        gates: factoryCheckGates,
      });
      const queue: FactoryQueue = async (tx, user, input, botId) => {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','Synthetic queue input, no provider')`,
          [
            id,
            user,
            input.issueId,
            input.agentId,
            deviceId,
            input.deviceRepoId,
            botId,
          ],
        );
        return { runId: id };
      };
      let selectedPolicy: RunPolicy | undefined;
      const dispatch = createFactoryDispatch(db, store, queue, {
        configure: {
          execute: factoryRepairBrief,
          // The fixture device is "online" only within the 90 s presence window (lib/device-presence.ts),
          // and this file runs for minutes: keep its heartbeat current so a slow runner cannot age it out.
          review: async (tx, task, id) => {
            await tx.query(`UPDATE devices SET "lastSeenAt"=now() WHERE id=$1`, [deviceId]);
            return configureFactoryCheck(tx, task, id, selectedPolicy);
          },
          verify: async (tx, task, id) => {
            await tx.query(`UPDATE devices SET "lastSeenAt"=now() WHERE id=$1`, [deviceId]);
            return configureFactoryCheck(tx, task, id, selectedPolicy);
          },
        },
        freeze: async (tx, _task, id) => {
          const {
            rows: [run],
          } = await tx.query("SELECT prompt FROM agent_runs WHERE id=$1", [id]);
          await tx.query(
            'UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1',
            [
              id,
              JSON.stringify(
                freezeWorkerDefinition({
                  harness: "codex",
                  instructions: "Frozen fixture",
                  prompt: run.prompt,
                  parent: null,
                  executionId: null,
                }),
              ),
            ],
          );
        },
      });
      const assignment = (
        tx: import("pg").PoolClient,
        task: FactoryTask,
        id: string,
      ) => factoryCheckAssignment(tx, task.userId, id);
      const questions = createFactoryQuestions(
        db,
        authorize,
        store,
        dispatch,
        assignment,
      );
      const claim = createFactoryClaim(store, questions, assignment);
      let chosenAction = "repair_code",
        modelCalls = 0;
      let mutateReceipt:
        | ((
            result: NonNullable<
              Awaited<
                ReturnType<
                  NonNullable<FactoryCheckRecoveryDependencies["invoke"]>
                >
              >
            >,
          ) => void)
        | undefined;
      let beforeModel: (() => Promise<void>) | undefined;
      let nullModel = false;
      let replyAnswers: unknown[] | undefined,
        replyConfidence: number | undefined;
      assert.equal(
        Object.hasOwn(process.env, "AI_GATEWAY_API_KEY"),
        false,
        "Offline tests must not inherit a provider credential",
      );
      process.env.AI_GATEWAY_API_KEY = "synthetic-offline-fixture";
      installedGatewayFixture = true;
      const networkRequests: unknown[] = [];
      const originalFetch = globalThis.fetch;
      const providerErrors: unknown[] = [];
      const provider = createServer(async (request, response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          networkRequests.push(body);
          assert.equal(request.headers.authorization,"Bearer synthetic-offline-fixture");
          assert.equal(body.model, DECISION_MODEL);
          response.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({
            model: DECISION_MODEL,
            provider_metadata: {
              gateway: { generationId: `fixture_generation_${modelCalls}`, cost: "0.000001" },
            },
            answers: replyAnswers ?? [{
              type: "choice", name: "recovery", choice: chosenAction,
              ...(replyConfidence !== undefined ? {confidence:replyConfidence} : {}),
            }],
          }));
        } catch(error) { providerErrors.push(error);response.writeHead(500).end(); }
      });
      await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
      const providerUrl=`http://127.0.0.1:${(provider.address() as {port:number}).port}`;
      t.after(async()=>{
        provider.closeAllConnections();
        await new Promise<void>(resolve=>provider.close(()=>resolve()));
        assert.deepEqual(providerErrors,[]);
      });
      t.mock.method(
        globalThis,
        "fetch",
        async (
          resource: Parameters<typeof fetch>[0],
          options?: Parameters<typeof fetch>[1],
        ) => {
          const url = String(resource);
          if (url === DECISIONS_URL) {
            assert.equal(options?.redirect,"error");
            return originalFetch(providerUrl,options);
          }
          assert.match(
            url,
            /^http:\/\/127\.0\.0\.1:/,
            "No external provider request is allowed",
          );
          return originalFetch(resource, options);
        },
      );
      // Production bundles these modules. Warm the offline tsx loader before
      // opening the real ten-second invocation reservation, so cold compilation
      // under the full source suite is not mistaken for an expired model lease.
      await Promise.all([import('../abuse/runtime'),import('../abuse/alerts'),import('../credit-shares'),import('../model-admission/runtime')]);
      const modelInvoke: NonNullable<
        FactoryCheckRecoveryDependencies["invoke"]
      > = async (purpose, input, questions, signal) => {
        assert.equal(
          db.totalCount - db.idleCount,
          0,
          "No SQL client may be checked out while invoking the model",
        );
        modelCalls++;
        await beforeModel?.();
        if (nullModel) return null;
        // This explicitly injected model wrapper owns fixture scope; the
        // default recovery wrapper cannot infer scope for a custom dependency.
        const result = await modelDatabase!.run(()=>hostedBillingScope.run(
          {workspaceId:billingWorkspaceId,ownerId:"owner"},
          ()=>invokeDecision(purpose, input, questions, signal),
        ));
        if (result) mutateReceipt?.(result);
        return result;
      };
      const recoverRaw = createFactoryCheckRecovery(db, store, {
        invoke: modelInvoke,
      });
      const recover = async (
        user: string,
        input: {
          binding: import("./contract").FactoryBinding;
          choice: string;
          rationale?: string;
        },
        _unused?: undefined,
      ) => {
        chosenAction = input.choice;
        const result = await recoverRaw(
          user,
          { binding: input.binding },
          "synthetic_sdk_context",
        );
        assert.ok("task" in result, JSON.stringify(result));
        return result;
      };
      const reconcile = createFactoryReconciler(db, store, questions, {
        review: reconcileFactoryCheck,
        verify: reconcileFactoryCheck,
      }, coordinatorBot);
      async function pendingReview(kind: 'repository' | 'report' | 'deliverable' = 'repository', legacy = true, producer?: (runId: string, issueId: string) => Promise<void>, options: { visual?: boolean; publication?: boolean } = {}) {
        const issueId = randomUUID(),
          sourceEventId = randomUUID();
        await db.query(
          `INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState",scope) VALUES ($1,'owner','Check fixture',$2,'todo','normal',$3,'bound','workspace')`,
          [issueId,emitPresentation ? JSON.stringify({type:'doc',content:[]}) : '{}',billingWorkspaceId],
        );
        await db.query(
          `INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1,'owner',$3,'user_message',$2,'{"text":"Check original request"}')`,
          [sourceEventId, sourceEventId, coordinatorBot],
        );
        let state = await store.route("owner", {
          issueId,
          sourceEventId,
          eventId: randomUUID(),
          rationale: "Check fixture",
          missingInformation: [],
          missingPermissions: [],
          needsSpec: false,
        });
        if (legacy) {
          // Materialize the historical contract before any work: these existing
          // fixtures keep exercising retained Verify receipts after the upgrade.
          await db.query(`UPDATE factory_tasks SET route=route-'flowVersion' WHERE id=$1`, [state.task.id]);
          await db.query(`UPDATE factory_events SET result=jsonb_set(result,'{task,route}',(result#>'{task,route}')-'flowVersion') WHERE "taskId"=$1`, [state.task.id]);
        }
        const execute = await dispatch("owner", {
          binding: factoryBinding(state.task),
          agentId,
          deviceRepoId: repoId,
        });
        await db.query(
          `UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"startedAt"=now()-interval '1 second',"finishedAt"=now(),report=$3 WHERE id=$1`,
          [
            execute.runId,
            `execute-${issueId}`,
            JSON.stringify({
              publish: { commit: sha },
              sourceCommit: sha,
              ...(kind === 'deliverable' ? { deliverableCommit: sha } : {}),
              verify: { status: "passed" },
            }),
          ],
        );
        await producer?.(execute.runId,issueId);
        if (options.visual !== false && !(await db.query(`SELECT 1 FROM run_captures WHERE "runId"=$1 AND status='ready'`, [execute.runId])).rowCount)
          await addFactoryVisualEvidence(db,execute.runId);
        state = await store.apply("owner", execute.binding, randomUUID(), {
          action: "candidate",
          runId: execute.runId,
          candidate: kind === 'deliverable'
            ? { kind, sha: null, repository: "/fixture/repo", environment: `device:${deviceId}`, scope: `issue:${issueId}` }
            : kind === 'report'
              ? { kind, sha, repository: "/fixture/repo", environment: `device:${deviceId}`, scope: `issue:${issueId}` }
              : { sha, repository: "/fixture/repo", environment: `device:${deviceId}`, scope: `issue:${issueId}` },
        });
        state = await store.apply(
          "owner",
          factoryBinding(state.task),
          randomUUID(),
          {
            action: "finish",
            status: "passed",
            reason: "Synthetic execute completion",
            evidence: [
              {
                artifact: `run-report:${execute.runId}`,
                kind: "report",
                runId: execute.runId,
                sessionId: `execute-${issueId}`,
                candidateId: state.task.candidateId,
                sha: kind === 'deliverable' ? null : sha,
                environment: `device:${deviceId}`,
                recordedAt: new Date().toISOString(),
              },
            ],
            output: {},
          },
        );
        if (state.task.status !== 'passed') return state;
        if (options.publication !== false) await addFactoryPublicationEvidence(db,state.task.id);
        return store.apply("owner", factoryBinding(state.task), randomUUID(), {
          action: "advance",
          stage: "review",
          reason: "Independent review",
        });
      }
      const start = async (task: FactoryTask, deviceRepoId = repoId) => {
        // A positive local-device fixture represents a daemon which is still
        // online. Refresh its real heartbeat for each dispatch, rather than
        // relying on the suite finishing inside the 60-second presence window.
        await db.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1 AND "ownerId"=\'owner\' AND kind=\'local\'', [deviceId]);
        return dispatch("owner", {
          binding: factoryBinding(task),
          agentId,
          deviceRepoId,
        });
      };
      async function terminal(
        id: string,
        session: string,
        failed = false,
        edit?: (report: Record<string, any>) => void,
      ) {
        const report = {
          summary: "Synthetic terminal report",
          filesChanged: [],
          verify: {
            status: failed ? "failed" : "passed",
            command,
            exitCode: failed ? 17 : 0,
            signal: null,
            timedOut: false,
            output: failed ? "ACTUAL_FIXTURE_EXIT_17" : "FIXTURE_PASS",
          },
          check: { sha, readOnly: true },
          criteria: [
            {
              text: "Acceptance fixture",
              passed: !failed,
              evidence: "Original recorded observation",
            },
          ],
          knownIssues: [],
          openQuestions: [],
          nextStep: null,
        };
        edit?.(report);
        await db.query(
          `UPDATE agent_runs SET status=$2,"stopReason"='submitted',"sessionId"=$3,"startedAt"=now()-interval '1 second',"finishedAt"=now(),report=$4 WHERE id=$1`,
          [
            id,
            failed ? "failed" : "succeeded",
            session,
            JSON.stringify(report),
          ],
        );
      }
      async function toolChunks(
        id: string,
        error = false,
        afterFinish = false,
      ) {
        const call = randomUUID();
        for (const [seq, chunk] of [
          [
            1,
            {
              type: "tool-input-available",
              toolName: "shell",
              toolCallId: call,
              input: { command },
            },
          ],
          [
            2,
            {
              type: error ? "tool-output-error" : "tool-output-available",
              toolCallId: call,
              output: {
                exitCode: error ? 17 : 0,
                stdout: "Fixture child output",
              },
            },
          ],
        ] as const)
          await db.query(
            'INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") SELECT $1,$2,$3,$4,"finishedAt" + ($5::int * interval \'1 millisecond\') FROM agent_runs WHERE id=$2',
            [
              randomUUID(),
              id,
              seq,
              JSON.stringify(chunk),
              afterFinish ? 500 : -500 + seq,
            ],
          );
      }
      const state = (id: string) => store.read("owner", id);
      // Native events are synthetic fixtures in the already migrated isolated PG.
      // The production dispatch, assignment and observation readers remain real.
      const handoffText = 'mikka-group-policy-v3\npath=claude-code\nstatus=ready\n';
      const handoffHash = createHash('sha256').update(handoffText).digest('hex');
      const handoffBase = 'b'.repeat(40);
      async function artifactInspectionChunks(runId: string, format: 'claude' | 'codex' = 'claude') {
        const encode = (value: unknown) => format === 'claude'
          ? JSON.stringify(value) : [{ type: 'text', text: JSON.stringify(value) }];
        const records = [
          {
            toolName: 'mcp__mikka__inspect_artifact',
            input: { path: 'delivery.txt', expectedUtf8: handoffText },
            output: encode({ path: 'delivery.txt', bytes: 52, sha256: handoffHash, head: sha,
              committedSha256: handoffHash, contentMatchesGit: true, matchesExpectedUtf8: true,
              contentUtf8: handoffText, textUnavailable: null }),
          },
          {
            toolName: 'mcp__mikka__inspect_repository',
            input: { path: '.', baseCommit: handoffBase },
            output: encode({ path: '.', head: sha, repository: null,
              comparison: { baseCommit: handoffBase, head: sha,
                changes: [{ status: 'A', path: 'delivery.txt' }], truncated: false } }),
          },
        ].map((record, index) => ({ ...record, toolCallId: randomUUID(), inputChunkId: randomUUID(),
          outputChunkId: randomUUID(), inputSeq: 1 + index * 2, outputSeq: 2 + index * 2 }));
        for (const record of records) for (const [id, seq, chunk] of [
          [record.inputChunkId, record.inputSeq, { type: 'tool-input-available', toolName: record.toolName,
            toolCallId: record.toolCallId, input: record.input }],
          [record.outputChunkId, record.outputSeq, { type: 'tool-output-available',
            toolCallId: record.toolCallId, output: record.output }],
        ] as const) await db.query(`INSERT INTO run_chunks (id,"runId",seq,chunk,"createdAt")
          SELECT $1,id,$3,$4,"finishedAt"-interval '500 milliseconds'+($3::int*interval '1 millisecond')
          FROM agent_runs WHERE id=$2`, [id, runId, seq, JSON.stringify(chunk)]);
        return records;
      }
      async function priorReviewFixture(format: 'claude' | 'codex' = 'claude') {
        let producerRunId = '';
        const pending = await pendingReview('deliverable', true, async runId => {
          producerRunId = runId;
          await db.query(`UPDATE agent_runs SET report=jsonb_set(report,'{sourceCommit}',to_jsonb($2::text)) WHERE id=$1`,
            [runId, handoffBase]);
        });
        const review = await start(pending.task);
        const reviewBefore = await state(pending.task.id);
        const reviewCheck = reviewBefore.attempts.find(a => a.runId === review.runId)!.output.check;
        assert.ok(reviewCheck);
        assert.equal(Object.hasOwn(reviewCheck as object, 'priorReviewArtifactObservation'), false,
          'review must not depend on a future verify observation');
        const reviewPrompt = (await db.query('SELECT prompt FROM agent_runs WHERE id=$1', [review.runId])).rows[0].prompt;
        assert.doesNotMatch(reviewPrompt, /Host-recorded prior review artifact observations/);
        const reviewSession = `review-artifact-${pending.task.id}`;
        await terminal(review.runId, reviewSession, false, report => {
          report.verify = { status: 'not_run' };
          report.summary = 'FORGED_REVIEW_REPORT_ONLY_SUCCESS';
          report.criteria = [{ text: 'Independent artifact inspection', passed: true,
            evidence: 'FORGED_REVIEW_REPORT_ONLY_SUCCESS' }];
        });
        const records = await artifactInspectionChunks(review.runId, format);
        await reconcile.run('owner', review.runId);
        const beforeVerify = await state(pending.task.id);
        assert.equal(beforeVerify.task.stage, 'verify');
        assert.equal(beforeVerify.task.status, 'pending');
        const verify = await start(beforeVerify.task);
        const current = await state(pending.task.id);
        const candidate = { id: pending.task.candidateId!, executionSha: sha,
          producerExecution: { runId: producerRunId, sessionId: `execute-${pending.task.issueId}` } };
        return { task: current.task, candidate, review, verify, reviewSession, records,
          reviewAttemptId: beforeVerify.attempts.find(a => a.runId === review.runId)!.id };
      }
      await t.test('prior review handoff carries real paired artifact observations into verify, which still inspects independently', async () => {
        for (const format of ['claude', 'codex'] as const) {
          const fixture = await priorReviewFixture(format);
          const observed = await priorReviewArtifactObservations(db, fixture.task, fixture.verify.runId, fixture.candidate);
          assert.equal(observed.data.complete, true);
          assert.deepEqual(observed.data.incompleteReasons, []);
          assert.deepEqual([observed.data.taskId, observed.data.requestEpoch, observed.data.candidateId, observed.data.candidateSha],
            [fixture.task.id, fixture.task.sourceEventId, fixture.candidate.id, sha]);
          assert.deepEqual([observed.data.review?.attemptId, observed.data.review?.runId, observed.data.review?.sessionId],
            [fixture.reviewAttemptId, fixture.review.runId, fixture.reviewSession]);
          assert.equal(observed.data.review?.continuesRunId, null);
          assert.equal(observed.data.review?.questionContinuationPresent, false);
          assert.equal(observed.data.records.length, 2);
          for (const [i, original] of fixture.records.entries()) {
            const actual = observed.data.records[i];
            for (const key of ['toolName', 'toolCallId', 'inputChunkId', 'outputChunkId', 'inputSeq', 'outputSeq', 'input', 'output'] as const)
              assert.deepEqual(actual[key], original[key], `${format}: preserve actual ${key}`);
          }
          const run = (await db.query('SELECT prompt FROM agent_runs WHERE id=$1', [fixture.verify.runId])).rows[0];
          assert.ok(run.prompt.includes(JSON.stringify(observed.data)), 'the actual verify prompt must contain this admitted collection');
          assert.match(run.prompt, /does not replace your own new independent artifact and repository inspections/);
          assert.doesNotMatch(run.prompt, /FORGED_REVIEW_REPORT_ONLY_SUCCESS/);
          const saved = (await state(fixture.task.id)).attempts.find(a => a.runId === fixture.verify.runId)!.output.check as {
            priorReviewArtifactObservation: { digest: string };
          };
          assert.equal(saved.priorReviewArtifactObservation.digest, observed.digest);
          assert.equal((await db.query('SELECT count(*)::int AS n FROM run_chunks WHERE "runId"=$1', [fixture.verify.runId])).rows[0].n, 0,
            'the host must not turn historical review chunks into verifier-owned observations');
          await terminal(fixture.verify.runId, `verify-artifact-${fixture.task.id}`, false, report => {
            report.verify = { status: 'not_run' };
            report.criteria = [{ text: 'Independent artifact inspection', passed: true,
              evidence: 'Synthetic verifier has its own paired native artifact observations.' }];
          });
          const fresh = await artifactInspectionChunks(fixture.verify.runId, format);
          assert.ok(fresh.every(pair => fixture.records.every(old => old.inputChunkId !== pair.inputChunkId && old.outputChunkId !== pair.outputChunkId)));
          await reconcile.run('owner', fixture.verify.runId);
          const complete = await state(fixture.task.id);
          assert.equal(complete.task.stage, 'approval');
          assert.equal(complete.task.status, 'pending');
          assert.equal(complete.task.candidateId, fixture.candidate.id);
          assert.deepEqual(complete.attempts.filter(a => ['review', 'verify'].includes(a.stage)).map(a => a.status), ['passed', 'passed']);
        }
      });
      await t.test('prior review observations retain owner, candidate, epoch, independent SID and latest-review fences', async () => {
        const fixture = await priorReviewFixture();
        const tx = await db.connect();
        const incomplete = (result: Awaited<ReturnType<typeof priorReviewArtifactObservations>>) => {
          assert.equal(result.data.complete, false);
          assert.ok(result.data.incompleteReasons.length > 0);
          assert.deepEqual(result.data.records, []);
        };
        try {
          await tx.query('BEGIN');
          const original = await priorReviewArtifactObservations(tx, fixture.task, fixture.verify.runId, fixture.candidate);
          await tx.query('SAVEPOINT prior_review_continuation_projection');
          try {
            // Test only the reader's projection of continuation metadata on an
            // already passed review. This does not establish a question/answer
            // chain, bypass an independence gate, or reconcile this variant.
            const predecessorId = randomUUID();
            await tx.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",kind,
              "baseBranch","agentDefinition",status,"stopReason","sessionId",prompt,"startedAt","finishedAt")
              SELECT $2,"userId","issueId","agentId","deviceId","deviceRepoId","botId",kind,
                "baseBranch","agentDefinition",'stopped','asked_human',"sessionId",'Earlier projection-only segment fixture',
                "startedAt"-interval '2 seconds',"startedAt"-interval '1 second' FROM agent_runs WHERE id=$1`,
              [fixture.review.runId, predecessorId]);
            await tx.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt")
              SELECT gen_random_uuid(),$2,seq,chunk,"createdAt"-interval '2 seconds' FROM run_chunks WHERE "runId"=$1`,
              [fixture.review.runId, predecessorId]);
            await tx.query('UPDATE agent_runs SET "continuesRunId"=$2,"questionContinuation"=$3 WHERE id=$1',
              [fixture.review.runId, predecessorId, JSON.stringify({ originRunId: predecessorId,
                originSessionId: fixture.reviewSession, requireSessionResume: true })]);
            const projected = await priorReviewArtifactObservations(tx, fixture.task, fixture.verify.runId, fixture.candidate);
            assert.equal(projected.data.complete, true, 'continuation metadata alone must not globally suppress the reader');
            assert.equal(projected.data.review?.runId, fixture.review.runId);
            assert.equal(projected.data.review?.continuesRunId, predecessorId);
            assert.equal(projected.data.review?.questionContinuationPresent, true);
            assert.deepEqual(projected.data.records, original.data.records, 'exclude native records in earlier segments');
          } finally { await tx.query('ROLLBACK TO SAVEPOINT prior_review_continuation_projection'); }
          for (const [task, candidate] of [
            [{ ...fixture.task, userId: 'other' }, fixture.candidate],
            [{ ...fixture.task, issueId: randomUUID() }, fixture.candidate],
            [{ ...fixture.task, sourceEventId: randomUUID() }, fixture.candidate],
            [fixture.task, { ...fixture.candidate, id: randomUUID() }],
            [fixture.task, { ...fixture.candidate, executionSha: 'c'.repeat(40) }],
          ] as const) incomplete(await priorReviewArtifactObservations(tx, task, fixture.verify.runId, candidate));
          const mutations: [string, (tx: import('pg').PoolClient) => Promise<unknown>][] = [
            ['review no longer binds this candidate', client => client.query('UPDATE factory_attempts SET "candidateId"=NULL WHERE id=$1', [fixture.reviewAttemptId])],
            ['native review did not succeed', client => client.query("UPDATE agent_runs SET status='failed',\"stopReason\"='error' WHERE id=$1", [fixture.review.runId])],
            ['verifier reuses review SID', client => client.query('UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [fixture.verify.runId, fixture.reviewSession])],
            ['attempt SID differs from native SID', client => client.query('UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1', [fixture.reviewAttemptId, 'wrong-review-session'])],
            ['review reuses producer SID', async client => {
              await client.query('UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [fixture.review.runId, fixture.candidate.producerExecution.sessionId]);
              await client.query('UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1', [fixture.reviewAttemptId, fixture.candidate.producerExecution.sessionId]);
            }],
            ['latest review belongs to another request epoch', client => client.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{requestEpoch}',to_jsonb($2::text)) WHERE id=$1`,
              [fixture.reviewAttemptId, randomUUID()])],
            ['newer failed review must hide the earlier passed review', async client => {
              await client.query('UPDATE factory_attempts SET position=position+1 WHERE id=$1', [fixture.task.attemptId]);
              await client.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"candidateId",reason,output)
                SELECT $2,"taskId",'review',ordinal+1,position+1,'failed',"candidateId",'Newer failed review fixture',output
                FROM factory_attempts WHERE id=$1`, [fixture.reviewAttemptId, randomUUID()]);
            }],
          ];
          for (const [label, mutate] of mutations) {
            await tx.query('SAVEPOINT prior_review_fence');
            try { await mutate(tx); incomplete(await priorReviewArtifactObservations(tx, fixture.task, fixture.verify.runId, fixture.candidate)); }
            finally { await tx.query('ROLLBACK TO SAVEPOINT prior_review_fence'); }
            assert.equal((await priorReviewArtifactObservations(tx, fixture.task, fixture.verify.runId, fixture.candidate)).data.complete, true, label);
          }
          for (const [path, value] of [
            ['{check,sha}', 'd'.repeat(40)], ['{check,candidateId}', randomUUID()],
            ['{check,requestEpoch}', randomUUID()], ['{check,policy,readOnly}', false],
          ] as const) {
            await tx.query('SAVEPOINT historical_assignment');
            try {
              await tx.query('UPDATE factory_attempts SET output=jsonb_set(output,$2::text[],$3::jsonb) WHERE id=$1',
                [fixture.reviewAttemptId, path, JSON.stringify(value)]);
              await assert.rejects(priorReviewArtifactObservations(tx, fixture.task, fixture.verify.runId, fixture.candidate),
                { code: 'factoryCheckBindingMismatch' }, path);
            } finally { await tx.query('ROLLBACK TO SAVEPOINT historical_assignment'); }
          }
        } finally { await tx.query('ROLLBACK'); tx.release(); }
      });
      await t.test('prior review native IO is all-or-incomplete for missing, ambiguous, failed, over-budget or redacted records', async () => {
        const fixture = await priorReviewFixture();
        const exhausted = await priorReviewArtifactObservations(db, fixture.task, fixture.verify.runId, fixture.candidate, 0);
        assert.equal(exhausted.data.complete, false);
        assert.deepEqual(exhausted.data.records, []);
        assert.deepEqual(exhausted.data.incompleteReasons, ['prior_review_records_omitted'], 'prior review cannot displace authenticated instructions when the shared evidence budget is exhausted');
        const pair = fixture.records[0];
        const tx = await db.connect();
        const mutateOutput = (client: import('pg').PoolClient, output: unknown) => client.query(
          `UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output}',$2::jsonb) WHERE id=$1`, [pair.outputChunkId, JSON.stringify(output)]);
        const mutations: [string, string, (tx: import('pg').PoolClient) => Promise<unknown>][] = [
          ['missing output', 'prior_review_pair_incomplete', client => client.query('DELETE FROM run_chunks WHERE id=$1', [pair.outputChunkId])],
          ['duplicate output outside the run window', 'prior_review_pair_incomplete', client => client.query(`INSERT INTO run_chunks (id,"runId",seq,chunk,"createdAt")
            SELECT $2,"runId",90,chunk,"createdAt"+interval '1 hour' FROM run_chunks WHERE id=$1`, [pair.outputChunkId, randomUUID()])],
          ['duplicate native input', 'prior_review_pair_incomplete', client => client.query(`INSERT INTO run_chunks (id,"runId",seq,chunk,"createdAt")
            SELECT $2,"runId",91,chunk,"createdAt" FROM run_chunks WHERE id=$1`, [pair.inputChunkId, randomUUID()])],
          ['tool error', 'prior_review_content_incomplete', client => client.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{type}','"tool-output-error"'::jsonb) WHERE id=$1`, [pair.outputChunkId])],
          ['oversized input', 'prior_review_content_incomplete', client => client.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{input}',$2::jsonb) WHERE id=$1`,
            [pair.inputChunkId, JSON.stringify({ path: 'delivery.txt', expectedUtf8: 'x'.repeat(4100) })])],
          ['oversized output', 'prior_review_content_incomplete', client => mutateOutput(client, 'x'.repeat(12100))],
          ['redacted output', 'prior_review_content_redacted', client => mutateOutput(client, 'password=fixture-private-prior-review')],
          ['persisted redaction marker', 'prior_review_content_redacted', client => mutateOutput(client, '[REDACTED]')],
          ['persisted secret reference', 'prior_review_content_redacted', client => mutateOutput(client, '[secret:fixture-private-prior-review]')],
          ['collection budget', 'prior_review_records_omitted', async client => {
            for (const item of fixture.records) await client.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output}',$2::jsonb) WHERE id=$1`,
              [item.outputChunkId, JSON.stringify('x'.repeat(8500))]);
          }],
          ['pair count bound', 'prior_review_records_omitted', async client => {
            for (let i = 0; i < 15; i++) {
              const toolCallId = randomUUID();
              for (const [id, seq, chunk] of [
                [randomUUID(), 10 + 2 * i, { type: 'tool-input-available', toolName: pair.toolName, toolCallId, input: pair.input }],
                [randomUUID(), 11 + 2 * i, { type: 'tool-output-available', toolCallId, output: pair.output }],
              ] as const) await client.query(`INSERT INTO run_chunks (id,"runId",seq,chunk,"createdAt")
                SELECT $1,id,$3,$4,"finishedAt"-interval '100 milliseconds' FROM agent_runs WHERE id=$2`,
                [id, fixture.review.runId, seq, JSON.stringify(chunk)]);
            }
          }],
        ];
        try {
          await tx.query('BEGIN');
          for (const [label, reason, mutate] of mutations) {
            await tx.query('SAVEPOINT prior_review_content');
            try {
              await mutate(tx);
              const result = await priorReviewArtifactObservations(tx, fixture.task, fixture.verify.runId, fixture.candidate);
              assert.equal(result.data.complete, false, label);
              assert.ok(result.data.incompleteReasons.includes(reason), label);
              assert.deepEqual(result.data.records, [], 'do not present the surviving valid repository pair as a complete collection');
              assert.doesNotMatch(JSON.stringify(result.data), /fixture-private-prior-review/);
            } finally { await tx.query('ROLLBACK TO SAVEPOINT prior_review_content'); }
          }
        } finally { await tx.query('ROLLBACK'); tx.release(); }
      });
      await t.test('verify continuation retains frozen prior-review identity and rejects native content or digest drift', async () => {
        const fixture = await priorReviewFixture();
        const observed = await priorReviewArtifactObservations(db, fixture.task, fixture.verify.runId, fixture.candidate);
        const tx = await db.connect();
        try {
          await tx.query('BEGIN');
          const followUp = await appendFactoryCheckContinuationContext(tx, fixture.task, fixture.verify.runId, 'Original saved answer');
          assert.ok(followUp.includes(JSON.stringify(observed.data)), 'continuation gets the exact admitted historical observations');
          assert.match(followUp, /^Original saved answer/);
          for (const value of ['0'.repeat(64), 'not-a-digest']) {
            await tx.query('SAVEPOINT prior_review_digest');
            try {
              await tx.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{check,priorReviewArtifactObservation,digest}',to_jsonb($2::text)) WHERE id=$1`,
                [fixture.task.attemptId, value]);
              await assert.rejects(appendFactoryCheckContinuationContext(tx, fixture.task, fixture.verify.runId, 'Original saved answer'),
                { code: 'factoryCheckBindingMismatch' });
            } finally { await tx.query('ROLLBACK TO SAVEPOINT prior_review_digest'); }
          }
          await tx.query('SAVEPOINT prior_review_raw_drift');
          try {
            await tx.query(`UPDATE run_chunks SET chunk=jsonb_set(chunk,'{output}',$2::jsonb) WHERE id=$1`,
              [fixture.records[0].outputChunkId, JSON.stringify('Changed actual native observation')]);
            const changed = await priorReviewArtifactObservations(tx, fixture.task, fixture.verify.runId, fixture.candidate);
            assert.equal(changed.data.complete, true, 'complete collection is not a synthesized semantic pass');
            assert.notEqual(changed.digest, observed.digest);
            await assert.rejects(appendFactoryCheckContinuationContext(tx, fixture.task, fixture.verify.runId, 'Original saved answer'),
              { code: 'factoryCheckBindingMismatch' });
          } finally { await tx.query('ROLLBACK TO SAVEPOINT prior_review_raw_drift'); }
          await tx.query('UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [fixture.review.runId, 'replacement-review-session']);
          await tx.query('UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1', [fixture.reviewAttemptId, 'replacement-review-session']);
          await assert.rejects(appendFactoryCheckContinuationContext(tx, fixture.task, fixture.verify.runId, 'Original saved answer'),
            { code: 'factoryCheckBindingMismatch' });
        } finally { await tx.query('ROLLBACK'); tx.release(); }
      });
      await t.test('a stale local heartbeat rejects direct dispatch until the same pending check receives a real fresh heartbeat', async () => {
        const pending = await pendingReview();
        const before = await state(pending.task.id);
        const runsBefore = (await db.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [pending.task.issueId])).rows;
        const gateway = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET };
        delete process.env.DEVICE_GATEWAY_URL;
        delete process.env.DEVICE_GATEWAY_PUSH_SECRET;
        try {
          await db.query('UPDATE devices SET "lastSeenAt"=now()-interval \'61 seconds\' WHERE id=$1', [deviceId]);
          const stale = (await db.query('SELECT "lastSeenAt" FROM devices WHERE id=$1', [deviceId])).rows[0].lastSeenAt;
          // The normal fixture refreshes presence in its adapter. This refusal
          // exercises the unwrapped production adapter so it sees the stale row.
          await assert.rejects(createFactoryDispatch(db, store, queue)("owner", { binding: factoryBinding(pending.task), agentId, deviceRepoId: repoId }),
            (error: unknown) => error instanceof FactoryError && error.code === 'factoryCheckHarnessUnavailable');
          assert.deepEqual(await state(pending.task.id), before, 'failed admission leaves the exact pending check intact');
          assert.deepEqual((await db.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [pending.task.issueId])).rows,
            runsBefore, 'the rejected dispatch cannot commit an orphan run');

          const accepted = await start(pending.task);
          const heartbeat = (await db.query('SELECT "lastSeenAt","lastSeenAt"<=clock_timestamp() AS "notFuture" FROM devices WHERE id=$1', [deviceId])).rows[0];
          assert.ok(heartbeat.lastSeenAt.getTime() > stale.getTime());
          assert.equal(heartbeat.notFuture, true, 'the fixture uses a real current heartbeat, never a future timestamp');
          assert.ok(accepted.runId);
          assert.equal((await db.query('SELECT id FROM agent_runs WHERE "issueId"=$1', [pending.task.issueId])).rowCount, runsBefore.length + 1);
          const admitted = await state(pending.task.id);
          assert.equal(admitted.task.candidateId, pending.task.candidateId);
          assert.equal(admitted.task.stage, 'review');
          await store.apply("owner", factoryBinding(admitted.task), randomUUID(), { action: "cancel", reason: "Presence fixture complete" });
        } finally {
          await db.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [deviceId]);
          if (gateway.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = gateway.url;
          if (gateway.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = gateway.secret;
        }
      });
      async function currentEvidence(taskId: string) {
        const tx = await db.connect();
        try {
          await tx.query('BEGIN');
          const task = await store.lockTask(tx, 'owner', taskId);
          const result = await approvalEvidence(tx, task);
          await tx.query('ROLLBACK');
          return result;
        } finally { tx.release(); }
      }
      for (const kind of ['repository','report','deliverable'] as const) await t.test(`${kind} report-only completion is durably blocked before handoff`, async () => {
        const blocked = await pendingReview(kind,false,undefined,{visual:false});
        assert.equal(blocked.task.stage,'execute');
        assert.equal(blocked.task.status,'blocked');
        assert.equal(blocked.refusal?.code,'factory_visual_evidence_required');
        assert.match(blocked.task.reason,/no ready screenshot or recording/);
        assert.equal(blocked.attempts.some(attempt=>attempt.stage==='approval'||attempt.stage==='review'),false);
        const persisted = await state(blocked.task.id);
        assert.equal(persisted.task.status,'blocked');
        assert.equal((await readFactoryFlow(db,persisted.task)).needsYou?.kind,'blocked');
        await assert.rejects(store.apply('owner',factoryBinding(persisted.task),randomUUID(),{action:'advance',stage:'approval',reason:'Unverified is not handoff evidence'}),
          (error:unknown)=>error instanceof FactoryError && error.code==='factoryTransition');
      });
      await t.test('retrying a visual-evidence refusal creates a fresh producer candidate and preserves the blocked history',async()=>{
        const blocked=await pendingReview('repository',false,undefined,{visual:false});
        const previous=blocked.attempts.find(attempt=>attempt.id===blocked.task.attemptId)!;
        const retried=await store.apply('owner',factoryBinding(blocked.task),randomUUID(),{action:'retry',reason:'Record the implementation verification'});
        assert.equal(retried.task.candidateId,null);
        const run=await start(retried.task);
        await terminal(run.runId,`visual-retry-${blocked.task.id}`,false,report=>{
          report.sourceCommit='b'.repeat(40);report.publish={commit:'b'.repeat(40),pushed:true};
        });
        await addFactoryVisualEvidence(db,run.runId,{kind:'video'});
        await reconcile.run('owner',run.runId);
        const current=await state(blocked.task.id);
        assert.equal(current.task.stage,'review');assert.equal(current.task.status,'pending');
        assert.notEqual(current.task.candidateId,blocked.task.candidateId);
        assert.equal(current.candidates.find(candidate=>candidate.id===current.task.candidateId)?.runId,run.runId);
        assert.deepEqual(current.attempts.find(attempt=>attempt.id===previous.id),previous);
        assert.ok(current.candidates.some(candidate=>candidate.id===blocked.task.candidateId));
      });
      await t.test('retrying a repaired implementation awaiting public evidence replaces only its current candidate and keeps one review',async()=>{
        // Reconciliation derives the candidate kind from the queued repository.
        // The default fixture has no remote and correctly becomes report-only;
        // these repairs retain the original repository identity and PR gate.
        const repairRepoId=randomUUID();
        await db.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl","verifyCommand") VALUES($1,$2,'owner','/fixture/public-evidence-repair','/fixture/repo',$3)`,[repairRepoId,deviceId,command]);
        const pending=await pendingReview('repository',false);
        const review=await start(pending.task);
        await terminal(review.runId,`public-retry-review-${pending.task.id}`);
        await reconcile.run('owner',review.runId);
        const approved=await state(pending.task.id);
        const repair=await store.apply('owner',factoryBinding(approved.task),randomUUID(),{action:'repair',reason:'Update the reviewed implementation'});
        const first=await start(repair.task,repairRepoId);
        await terminal(first.runId,`public-retry-first-${pending.task.id}`,false,report=>{report.sourceCommit='b'.repeat(40);report.publish={commit:'b'.repeat(40),pushed:true};});
        await addFactoryVisualEvidence(db,first.runId,{kind:'video'});
        await reconcile.run('owner',first.runId);
        const blocked=await state(pending.task.id),previous=blocked.attempts.find(attempt=>attempt.id===blocked.task.attemptId)!;
        assert.equal(blocked.candidates.find(candidate=>candidate.id===blocked.task.candidateId)?.kind,'repository');
        assert.equal(blocked.task.stage,'execute');assert.equal(blocked.task.status,'blocked');
        assert.equal(blocked.refusal?.code,'factory_public_evidence_required');
        const retried=await store.apply('owner',factoryBinding(blocked.task),randomUUID(),{action:'retry',reason:'Check and declare the visual evidence safe to publish'});
        assert.equal(retried.task.stage,'execute');assert.equal(retried.task.status,'pending');
        assert.equal(retried.task.candidateId,null);
        const run=await start(retried.task,repairRepoId);
        await terminal(run.runId,`public-retry-final-${pending.task.id}`,false,report=>{report.sourceCommit='c'.repeat(40);report.publish={commit:'c'.repeat(40),pushed:true};});
        await addFactoryVisualEvidence(db,run.runId,{kind:'video'});
        await reconcile.run('owner',run.runId);
        await addFactoryPublicationEvidence(db,pending.task.id);
        const current=await store.resumeEvidenceHandoff('owner',run.runId);
        assert.equal(current?.task.stage,'approval');assert.equal(current?.task.status,'pending');
        assert.notEqual(current?.task.candidateId,blocked.task.candidateId);
        assert.equal(current?.attempts.filter(attempt=>attempt.stage==='review').length,1);
        assert.deepEqual(current?.attempts.find(attempt=>attempt.id===previous.id),previous);
        assert.ok(current?.candidates.some(candidate=>candidate.id===blocked.task.candidateId));
      });
      await t.test('only a ready media object from the exact producer session and candidate SHA passes the visual gate',async()=>{
        const pending = await pendingReview('repository',false);
        const producer = pending.candidates.find(candidate=>candidate.id===pending.task.candidateId)!;
        const {rows:[capture]} = await db.query('SELECT id FROM run_captures WHERE "runId"=$1',[producer.runId]);
        const tx=await db.connect();
        try {
          await tx.query('BEGIN');
          assert.equal(await hasFactoryVisualEvidence(tx,pending.task),true);
          const invalid: [string,unknown[]][] = [
            [`UPDATE run_captures SET status='uploading' WHERE id=$1`,[capture.id]],
            [`UPDATE run_captures SET "userId"='other' WHERE id=$1`,[capture.id]],
            [`UPDATE run_captures SET "contentType"='video/mp4' WHERE id=$1`,[capture.id]],
            [`UPDATE run_captures SET size=0 WHERE id=$1`,[capture.id]],
            [`UPDATE run_captures SET size=100000001 WHERE id=$1`,[capture.id]],
            [`UPDATE run_captures SET sha256='' WHERE id=$1`,[capture.id]],
            [`UPDATE run_captures SET "storageKey"='',"inlineContent"=NULL WHERE id=$1`,[capture.id]],
            [`UPDATE agent_runs SET "sessionId"='another-session' WHERE id=$1`,[producer.runId]],
            [`UPDATE factory_candidates SET sha=repeat('f',40) WHERE id=$1`,[producer.id]],
          ];
          for (const [sql,params] of invalid) {
            await tx.query('SAVEPOINT invalid_media');
            await tx.query(sql,params);
            assert.equal(await hasFactoryVisualEvidence(tx,pending.task),false,sql);
            await tx.query('ROLLBACK TO SAVEPOINT invalid_media');
          }
          await tx.query('ROLLBACK');
        } finally {await tx.query('ROLLBACK');tx.release();}
      });
      await t.test('reviewer media cannot replace missing producer evidence at the handoff transition',async()=>{
        const pending=await pendingReview('repository',false);
        const producer=pending.candidates.find(candidate=>candidate.id===pending.task.candidateId)!;
        await db.query('DELETE FROM run_captures WHERE "runId"=$1',[producer.runId]);
        const review=await start(pending.task);
        await addFactoryVisualEvidence(db,review.runId,{kind:'video'});
        await terminal(review.runId,`reviewer-only-${pending.task.id}`,false,report=>{
          report.verify={status:'not_run'};
          report.criteria=[{text:'Application behavior',passed:false,status:'unverified',reason:'Reviewer could not verify the requested behavior.'}];
        });
        await reconcile.run('owner',review.runId);
        const blocked=await state(pending.task.id);
        assert.equal(blocked.task.stage,'review');
        assert.equal(blocked.task.status,'blocked');
        assert.equal(blocked.refusal?.code,'factory_visual_evidence_required');
        assert.equal(blocked.attempts.filter(attempt=>attempt.stage==='approval').length,0);
        assert.equal(blocked.attempts.find(attempt=>attempt.runId===review.runId)?.status,'passed','the review advice remains immutable');
      });
      await t.test('a repaired candidate cannot inherit the previous implementation video',async()=>{
        const pending=await pendingReview('repository',false,async runId=>{await addFactoryVisualEvidence(db,runId,{kind:'video'});});
        const original=pending.candidates.find(candidate=>candidate.id===pending.task.candidateId)!;
        const repair=await store.apply('owner',factoryBinding(pending.task),randomUUID(),{action:'repair',reason:'Produce the corrected implementation'});
        const execution=await start(repair.task);
        await terminal(execution.runId,`uncaptured-repair-${repair.task.id}`,false,report=>{
          report.sourceCommit='b'.repeat(40);report.publish={commit:'b'.repeat(40),pushed:true};
        });
        await reconcile.run('owner',execution.runId);
        const blocked=await state(pending.task.id);
        assert.notEqual(blocked.task.candidateId,original.id);
        assert.equal(blocked.task.stage,'execute');assert.equal(blocked.task.status,'blocked');
        assert.equal(blocked.refusal?.code,'factory_visual_evidence_required');
        assert.equal((await db.query(`SELECT id FROM run_captures WHERE "runId"=$1 AND kind='video' AND status='ready'`,[original.runId])).rowCount,1);
        assert.equal((await db.query('SELECT id FROM run_captures WHERE "runId"=$1',[execution.runId])).rowCount,0);
      });
      await t.test('retrying an old approval without media returns HTTP 409 and keeps it blocked',async()=>{
        const pending=await pendingReview('report',false);
        const review=await start(pending.task);
        await terminal(review.runId,`retry-approval-${pending.task.id}`);
        await reconcile.run('owner',review.runId);
        const ready=await state(pending.task.id);
        const stopped=await store.apply('owner',factoryBinding(ready.task),randomUUID(),{action:'finish',status:'blocked',reason:'Evidence needs recovery',evidence:[],output:{}});
        await db.query('DELETE FROM run_captures WHERE "runId"=(SELECT "runId" FROM factory_candidates WHERE id=$1)',[ready.task.candidateId]);
        const response=await handleFactory(store,{userId:'owner',method:'POST',taskId:ready.task.id,origin:'https://mikka.example',
          url:`https://mikka.example/api/factory/tasks/${ready.task.id}`,body:{binding:factoryBinding(stopped.task),eventId:randomUUID(),action:'retry',reason:'Retry handoff'}});
        assert.equal(response.status,409);
        assert.equal((response.body as {error:string}).error,'factory_visual_evidence_required');
        assert.equal((await state(ready.task.id)).task.status,'blocked');
        assert.equal((await state(ready.task.id)).attempts.filter(attempt=>attempt.stage==='approval').length,1);
      });
      await t.test('a playable producer video hands off only after its exact PR receipt is published, then resumes once without repeating review',async()=>{
        let producerRun='';
        const pending=await pendingReview('repository',false,async runId=>{
          producerRun=runId;
          await addFactoryVisualEvidence(db,runId,{kind:'video'});
        },{publication:false});
        const review=await start(pending.task);
        await terminal(review.runId,`publication-race-${pending.task.id}`);
        await reconcile.run('owner',review.runId);
        const blocked=await state(pending.task.id);
        assert.equal(blocked.task.stage,'review');
        assert.equal(blocked.task.status,'blocked');
        assert.equal(blocked.refusal?.code,'factory_public_evidence_required');
        assert.equal((await store.resumeEvidenceHandoff('owner',producerRun))?.task.status,'blocked');
        await addFactoryPublicationEvidence(db,pending.task.id);
        const ready=await store.resumeEvidenceHandoff('owner',producerRun);
        assert.equal(ready?.task.stage,'approval');
        assert.equal(ready?.task.status,'pending');
        assert.equal(ready?.task.candidateId,blocked.task.candidateId);
        assert.equal(ready?.attempts.filter(attempt=>attempt.stage==='review').length,1);
        assert.equal(ready?.attempts.filter(attempt=>attempt.stage==='approval').length,1);
        assert.equal(await store.resumeEvidenceHandoff('owner',producerRun),null,'duplicate publication events cannot create a second handoff');
      });
      await t.test('new host-frozen flow hands a single review to the person without a Verify run', async () => {
        const pending = await pendingReview('repository', false);
        assert.equal(pending.task.route.flowVersion, 2);
        const review = await start(pending.task);
        const single = await state(pending.task.id);
        assert.equal(Object.hasOwn(single.attempts.find(a => a.runId === review.runId)!.output.check as object, 'priorReviewArtifactObservation'), false);
        assert.doesNotMatch((await db.query('SELECT prompt FROM agent_runs WHERE id=$1', [review.runId])).rows[0].prompt,
          /Host-recorded prior review artifact observations/);
        const extras = await factoryCheckAssignment(db, 'owner', review.runId);
        assert.equal(extras.factoryCheck.reportOnly, true);
        assert.equal(extras.verifyCommand, undefined);
        await terminal(review.runId, `single-review-${pending.task.id}`, false, report => { report.verify = { status: 'not_run' }; });
        await reconcile('owner');
        const ready = await state(pending.task.id);
        assert.equal(ready.task.stage, 'approval');
        assert.equal(ready.task.status, 'pending');
        assert.equal(ready.attempts.filter(a => a.stage === 'review').length, 1);
        assert.equal(ready.attempts.filter(a => a.stage === 'verify').length, 0);
        const evidence = await currentEvidence(pending.task.id);
        assert.deepEqual([...new Set(evidence.manifest.artifacts.map(a => a.stage))], ['execute', 'review']);
        assert.deepEqual(evidence.manifest.reviewHistory, []);
      });
      await t.test('single review hands unverified observations to the person with their reason instead of asking for a command', async () => {
        const pending = await pendingReview('repository', false);
        await db.query('UPDATE device_repos SET "verifyCommand"=NULL WHERE id=$1', [repoId]);
        try {
          const review = await start(pending.task);
          const { rows: [queued] } = await db.query('SELECT prompt FROM agent_runs WHERE id=$1', [review.runId]);
          assert.doesNotMatch(queued.prompt, /report_blocked or request_help with the missing evidence|asking the person to reply with the exact command/);
          await terminal(review.runId, `unverified-review-${pending.task.id}`, false, report => {
            report.verify = { status: 'not_run' };
            report.criteria = [{ text: 'End-to-end behavior', passed: false, status: 'unverified', reason: 'No package.json, Makefile or CI workflow defines a command.' }];
          });
          await reconcile('owner');
          const ready = await state(pending.task.id);
          assert.equal(ready.task.stage, 'approval');
          assert.equal(ready.task.status, 'pending');
          assert.equal(ready.attempts.filter(a => a.stage === 'review').length, 1);
          assert.equal(ready.attempts.filter(a => a.stage === 'verify').length, 0);
          assert.equal((await db.query('SELECT id FROM factory_questions WHERE "taskId"=$1', [pending.task.id])).rowCount, 0);
          const detail = await store.read('owner', pending.task.id);
          const criterion = detail.checks!.find(c => c.runId === review.runId)!.criteria[0] as { status?: string; reason?: string; passed: boolean };
          assert.equal(criterion.status, 'unverified');
          assert.equal(criterion.passed, false);
          assert.match(criterion.reason!, /No package.json/);
          await currentEvidence(pending.task.id);
        } finally { await db.query('UPDATE device_repos SET "verifyCommand"=$2 WHERE id=$1', [repoId, command]); }
      });
      for (const kind of ['report', 'deliverable'] as const) await t.test(`${kind} human acceptance completes the public flow through its real receipt without changing the review verdict`, async () => {
        const pending = await pendingReview(kind, false);
        const review = await start(pending.task);
        await terminal(review.runId, `accepted-${pending.task.id}`, false, report => {
          report.verify = { status: 'not_run' }; report.reviewVerdict = 'needs_judgment';
          report.criteria = [{ text: 'Document accuracy', passed: false, status: 'unverified', reason: 'Requires the person to judge the document.' }];
        });
        await reconcile.run('owner', review.runId);
        const ready = await state(pending.task.id);
        const before = await readFactoryFlow(db, ready.task);
        assert.equal(before.stage, 'handoff'); assert.equal(before.needsYou?.kind, 'pr_review');
        assert.equal(before.review?.verdict, 'needs_judgment');
        const actor = { userId: 'owner', sessionId: randomUUID() }, eventId = randomUUID();
        await db.query(`INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,'owner',$2,now()+interval '1 hour',now(),now())`, [actor.sessionId, randomUUID()]);
        await db.query(`UPDATE issues SET status='review' WHERE id=$1`, [ready.task.issueId]);
        const acceptanceStore = createFactoryStore(db, authorize, coordinatorBot, { gates: createFactoryApprovalGates() });
        const merges = createFactoryMerges(db, authorize, acceptanceStore, {
          pullRequest: async () => assert.fail('a report has no GitHub pull request'),
          mergeMethods: async () => assert.fail('a report has no GitHub merge method'),
          merge: async () => assert.fail('a report must not merge on GitHub'),
        });
        const input = { binding: factoryBinding(ready.task), eventId };
        const result = await merges.accept(actor, input, null);
        assert.equal(result.status, 'accepted');
        if (result.status !== 'accepted') assert.fail('expected a deliverable acceptance receipt');
        const accepted = await state(pending.task.id);
        assert.equal(accepted.task.stage, 'approval'); assert.equal(accepted.task.status, 'passed');
        assert.equal(accepted.attempts.find(attempt => attempt.id === accepted.task.attemptId)?.output.deliverableAcceptanceId, result.acceptanceId);
        assert.deepEqual((await db.query('SELECT id,"candidateId","userId","sessionId" FROM factory_deliverable_acceptances WHERE "taskId"=$1', [accepted.task.id])).rows,
          [{ id: result.acceptanceId, candidateId: accepted.task.candidateId, userId: actor.userId, sessionId: actor.sessionId }]);
        assert.equal((await db.query('SELECT status FROM issues WHERE id=$1', [accepted.task.issueId])).rows[0].status, 'done');
        const flow = await readFactoryFlow(db, accepted.task);
        assert.equal(flow.stage, 'completed'); assert.equal(flow.completion, 'accepted'); assert.equal(flow.needsYou, undefined);
        assert.deepEqual(flow.review, before.review, 'human acceptance does not rewrite an independent needs_judgment verdict');
        const summary = (await store.listPublicForIssue('owner', accepted.task.issueId)).tasks[0];
        assert.equal(summary.stage, 'completed'); assert.equal('completion' in summary && summary.completion, 'accepted');
        assert.equal('needsYou' in summary, false, 'the public issue list does not keep asking for acceptance');
        assert.deepEqual(await merges.accept(actor, input, null), result, 'a replay returns the same durable acceptance');
        assert.equal((await readFactoryFlow(db, (await state(accepted.task.id)).task)).completion, 'accepted');
      });

      await t.test('public flow, same Artifact versions and one Bot comment per visited stage use real persisted provenance', async () => {
        emitPresentation = true;
        try {
          const captureId = randomUUID();
          let producerRun = '';
          const initial = await pendingReview('repository',false,async (runId,issueId) => {
            producerRun = runId;
            const report = { summary: 'Implemented a readable report', filesChanged: ['README.md'], sourceCommit: sha, publish: { commit: sha, pushed: true }, verify: { status: 'not_run' },
              criteria: [ { text: 'End-to-end execution', passed: false, status: 'unverified', reason: 'No executable test command exists in this repository.' },
                { text: 'Report is readable', passed: true, status: 'passed', evidence: `Observed actual fixture capture run-capture:${captureId}` } ] };
            await db.query('UPDATE agent_runs SET report=$2 WHERE id=$1',[runId,JSON.stringify(report)]);
            await db.query(`INSERT INTO run_captures(id,"userId","runId","issueId","botId",kind,"contentType",source,status,title,size,sha256,"inlineContent","storageKey")
              VALUES ($1,'owner',$2,$3,$4,'image','image/png','local','ready','Synthetic fixture image',1,$5,$6,'synthetic/fixture.png')`,[captureId,runId,issueId,coordinatorBot,'1'.repeat(64),Buffer.from([0])]);
          });
          const review = await start(initial.task);
          const reviewPrompt=(await db.query('SELECT prompt FROM agent_runs WHERE id=$1',[review.runId])).rows[0].prompt;
          assert.match(reviewPrompt,/Acceptance Artifact receipt/);
          assert.ok(reviewPrompt.includes((await readFactoryFlow(db,initial.task)).acceptance!.artifactId));
          await db.query("UPDATE agent_runs SET status='waiting_input' WHERE id=$1",[review.runId]);
          assert.equal((await readFactoryFlow(db,(await store.read('owner',initial.task.id)).task)).needsYou,undefined);
          await terminal(review.runId,`presentation-${randomUUID()}`,false,report => {
            report.verify = {status:'not_run'}; report.reviewVerdict='needs_judgment';
            report.criteria = [{text:'End-to-end execution',passed:false,status:'unverified',reason:'No executable test command exists in this repository.'},
              {text:'Report is readable',passed:true,evidence:'Inspected the fixed report bytes.'}];
          });
          await reconcile.run('owner',review.runId);
          const state = await store.read('owner',initial.task.id);
          const flowReadBytes: number[]=[];
          const measuredFlow = {query:async (sql:string,values:unknown[])=>{
            const result=await db.query(sql,values);
            flowReadBytes.push(Buffer.byteLength(JSON.stringify(result.rows)));
            return result;
          }} as Pick<import('pg').PoolClient,'query'>;
          const flow = await readFactoryFlow(measuredFlow,state.task);
          assert.equal(flow.stage,'handoff'); assert.equal(flow.needsYou?.kind,'pr_review');
          assert.deepEqual(flow.stages,['implement','review','handoff']);
          assert.equal(flow.review?.verdict,'needs_judgment'); assert.equal(flow.review?.currentCandidateReviewed,true);
          assert.ok(flow.acceptance); assert.equal(flow.acceptance.runId,producerRun);
          assert.deepEqual(flow.acceptance.counts,{passed:1,failed:0,unverified:1});
          assert.equal(flow.acceptance.media[0].captureId,captureId); assert.equal(flow.acceptance.media[0].criterion,'criterion-2');
          assert.equal(flow.acceptance.version,2);
          acceptanceReaderFixture = { taskId: state.task.id, artifactId: flow.acceptance.artifactId, captureId };
          const document = (await db.query('SELECT "inlineContent" FROM artifact_versions WHERE "artifactId"=$1 AND version=2',[flow.acceptance.artifactId])).rows[0].inlineContent;
          assert.ok(document.indexOf('未验证') < document.indexOf('已验证')); assert.match(document,/No executable test command exists/);
          assert.ok(document.includes(captureId)); assert.match(document,/!\[/);
          assert.equal((await runArtifactSubmissions(db,'owner',[producerRun]))[0].latestVersion,2);
          const tx = await db.connect();
          try { await tx.query('BEGIN'); await syncFactoryPresentation(tx,state.task); await syncFactoryPresentation(tx,state.task); await tx.query('COMMIT'); }
          finally { tx.release(); }
          assert.equal((await db.query('SELECT count(*)::int AS n FROM artifact_versions WHERE "artifactId"=$1',[flow.acceptance.artifactId])).rows[0].n,2);
          const saved = (await db.query('SELECT state FROM issue_documents WHERE "issueId"=$1',[state.task.issueId])).rows[0];
          const ydoc = loadIssueDocument(saved.state,{type:'doc',content:[]});
          try { const threads=readIssueThreads(ydoc); assert.equal(threads.length,1); assert.equal(threads[0].id,state.task.id);
            assert.equal(threads[0].messages.length,3); assert.ok(threads[0].messages.every(message => message.author==='Coordinator' && !message.authorUserId));
            assert.ok(threads[0].messages.some(message => message.body.includes(`?artifact=${flow.acceptance!.artifactId}`))); }
          finally { ydoc.destroy(); }
          const humanStore = createFactoryHumanStore(db,botId => createFactoryStore(db,authorize,botId));
          const read = (userId: string) => handleFactoryFlow(db,humanStore,createFactorySpecApproval(db,humanStore),{ actor:{userId,sessionId:'fixture-browser'},authorization:null,
            method:'GET',taskId:state.task.id,origin:null,url:'https://app.invalid/api/factory/tasks/'+state.task.id+'/flow' });
          assert.equal((await read('owner')).status,200); assert.equal((await read('other')).status,404);
          const beforeBytes = Buffer.byteLength(JSON.stringify(state)), afterBytes = Buffer.byteLength(JSON.stringify(flow));
          t.diagnostic(`Factory flow fixture: full snapshot ${beforeBytes} bytes; public flow ${afterBytes} bytes; projected DB rows ${flowReadBytes.join(" + ")} bytes; acceptance Markdown ${Buffer.byteLength(document)} bytes.`);
          assert.ok(afterBytes < beforeBytes);
          // A normal owner edit may append a version to an Artifact, but it
          // cannot become the host's acceptance report for this candidate.
          await db.query(`INSERT INTO artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName")
            SELECT $1,id,"latestVersion"+1,'synthetic-owner-edit','# Unrelated owner edit',$2,22,'Owner' FROM artifacts WHERE id=$3`,
            [randomUUID(),'f'.repeat(64),flow.acceptance.artifactId]);
          await db.query('UPDATE artifacts SET "latestVersion"="latestVersion"+1 WHERE id=$1',[flow.acceptance.artifactId]);
          assert.equal((await readFactoryFlow(db,state.task)).acceptance,null,'the decision projection must match the host report hash at the latest version');
          await db.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey","pullRequest")
            VALUES($1,'owner',$2,'https://github.com/example/fixture.git','github.com/example/fixture',$3)
            ON CONFLICT ("runId") DO UPDATE SET "pullRequest"=EXCLUDED."pullRequest"`,[producerRun,state.task.issueId,JSON.stringify({url:'https://github.com/example/fixture/pull/1',state:'closed'})]);
          assert.equal((await readFactoryFlow(db,state.task)).stage,'handoff','closed without merge is never completed');
          await db.query(`INSERT INTO factory_merges(id,"taskId","candidateId","userId","eventId","pullRequestUrl",sha,status,source,"finishedAt")
            VALUES($1,$2,$3,'owner',$4,'https://github.com/example/fixture/pull/1',$5,'merged','github',now())`,[randomUUID(),state.task.id,state.task.candidateId,randomUUID(),sha]);
          const merged = await readFactoryFlow(db,state.task);
          assert.equal(merged.stage,'completed'); assert.equal(merged.needsYou,undefined);
        } finally { emitPresentation=false; }
      });

      await t.test('acceptance history survives live run cleanup and keeps task and Artifact deletion semantics', async () => {
        emitPresentation=true;
        try {
          const pending=await pendingReview('repository',false,async runId=>{
            await db.query('UPDATE agent_runs SET report=$2 WHERE id=$1',[runId,JSON.stringify({summary:'Retained acceptance receipt',filesChanged:[],sourceCommit:sha,publish:{commit:sha,pushed:true},verify:{status:'passed'},
              criteria:[{text:'Retained observation',passed:true,status:'passed',evidence:'Observed before live run cleanup.'}]})]);
          });
          const before=await readFactoryFlow(db,pending.task);
          assert.ok(before.acceptance);
          const {artifactId,runId,candidateId}=before.acceptance;
          const versions=(await db.query('SELECT id,version,sha256,"inlineContent","executionIdentity" FROM artifact_versions WHERE "artifactId"=$1 ORDER BY version',[artifactId])).rows;
          assert.ok(versions.length>0);
          await db.query('DELETE FROM agent_runs WHERE id=$1',[runId]);
          assert.equal((await db.query('SELECT id FROM agent_runs WHERE id=$1',[runId])).rowCount,0);
          assert.deepEqual((await db.query('SELECT "runId","candidateId" FROM factory_acceptance_artifacts WHERE "taskId"=$1',[pending.task.id])).rows,[{runId,candidateId}]);
          assert.equal((await db.query('SELECT "runId" FROM artifacts WHERE id=$1',[artifactId])).rows[0].runId,null);
          assert.deepEqual((await readFactoryFlow(db,pending.task)).acceptance,before.acceptance,'a retained receipt identifies the historical source without requiring a live run');
          assert.deepEqual((await db.query('SELECT id,version,sha256,"inlineContent","executionIdentity" FROM artifact_versions WHERE "artifactId"=$1 ORDER BY version',[artifactId])).rows,versions);
          await db.query('DELETE FROM factory_tasks WHERE id=$1',[pending.task.id]);
          assert.equal((await db.query('SELECT 1 FROM factory_acceptance_artifacts WHERE "taskId"=$1',[pending.task.id])).rowCount,0);
          assert.equal((await db.query('SELECT 1 FROM factory_stage_updates WHERE "taskId"=$1',[pending.task.id])).rowCount,0);
          assert.deepEqual((await db.query('SELECT id,version,sha256,"inlineContent","executionIdentity" FROM artifact_versions WHERE "artifactId"=$1 ORDER BY version',[artifactId])).rows,versions,'task deletion retains the independently owned Artifact history');
          await db.query('DELETE FROM artifacts WHERE id=$1',[artifactId]);
          assert.equal((await db.query('SELECT 1 FROM artifact_versions WHERE "artifactId"=$1',[artifactId])).rowCount,0);
        } finally {emitPresentation=false;}
      });

      await t.test('current review-only missing observations update handoff counts; repairs never expose an earlier candidate as current acceptance', async () => {
        emitPresentation=true;
        try {
          const criterionId=randomUUID();
          const pending=await pendingReview('repository',false,async runId=>{
            await db.query('UPDATE agent_runs SET report=$2 WHERE id=$1',[runId,JSON.stringify({summary:'Implementation observed one success',filesChanged:[],sourceCommit:sha,publish:{commit:sha,pushed:true},verify:{status:'passed'},
              criteria:[{criterionId,text:'Behavior',passed:true,status:'passed',evidence:'Implementation fixture passed.'}]})]);
          });
          const check=await start(pending.task);
          await terminal(check.runId,`review-only-${pending.task.id}`,false,report=>{
            report.verify={status:'not_run'};report.reviewVerdict='needs_judgment';
            report.criteria=[{criterionId,text:'Behavior',passed:false,status:'unverified',reason:'Independent observation unavailable.',evidence:''},
              {text:'Review-only capability',passed:false,status:'unverified',reason:'Review environment unavailable.'}];
          });
          await reconcile.run('owner',check.runId);
          const handed=await store.read('owner',pending.task.id),flow=await readFactoryFlow(db,handed.task);
          const artifactId=flow.acceptance!.artifactId;
          const content=(await db.query('SELECT "inlineContent" FROM artifact_versions WHERE "artifactId"=$1 AND version=$2',[artifactId,flow.acceptance!.version])).rows[0].inlineContent;
          const ydoc=loadIssueDocument((await db.query('SELECT state FROM issue_documents WHERE "issueId"=$1',[handed.task.issueId])).rows[0].state,{type:'doc',content:[]});
          let correctSummary=false;
          try {correctSummary=readIssueThreads(ydoc)[0].messages.some(message=>message.body.includes('0 项已验证，2 项未验证'));}finally{ydoc.destroy();}
          const repair=await store.apply('owner',factoryBinding(handed.task),randomUUID(),{action:'repair',reason:'Owner requested further observations'});
          assert.equal(repair.task.candidateId,null);
          assert.equal((await readFactoryFlow(db,repair.task)).acceptance,null,'repair pending cannot expose old acceptance');
          assert.deepEqual(flow.acceptance!.counts,{passed:0,failed:0,unverified:2});
          assert.ok(content.includes('Independent observation unavailable')&&content.indexOf('Independent observation unavailable')<content.indexOf('## 审阅'));
          assert.ok(content.includes('Review environment unavailable')&&content.indexOf('Review environment unavailable')<content.indexOf('## 审阅'));
          assert.equal(correctSummary,true);

          const execution=await start(repair.task),session=`repair-observed-${repair.task.id}`;
          await terminal(execution.runId,session,false,report=>{
            report.verify={status:'passed'};report.publish={commit:sha,pushed:true};report.sourceCommit=sha;
            report.criteria=[{criterionId,text:'Behavior',passed:true,status:'passed',evidence:'New implementation fixture observed the requested behavior.',resolution:'Added the observation.'}];
          });
          await addFactoryVisualEvidence(db,execution.runId);
          let completed=await store.apply('owner',execution.binding,randomUUID(),{action:'candidate',runId:execution.runId,
            candidate:{sha,repository:'/fixture/repo',environment:`device:${deviceId}`,scope:`issue:${repair.task.issueId}`}});
          assert.notEqual(completed.task.candidateId,handed.task.candidateId);
          assert.equal((await readFactoryFlow(db,completed.task)).acceptance,null,'a newly selected but unfinished candidate cannot inherit old acceptance');
          completed=await store.apply('owner',factoryBinding(completed.task),randomUUID(),{action:'finish',status:'passed',reason:'Repair observed',
            evidence:[{artifact:`run-report:${execution.runId}`,kind:'report',runId:execution.runId,sessionId:session,candidateId:completed.task.candidateId,sha,environment:`device:${deviceId}`,recordedAt:new Date().toISOString()}],output:{}});
          await addFactoryPublicationEvidence(db,completed.task.id);
          completed=await store.apply('owner',factoryBinding(completed.task),randomUUID(),{action:'advance',stage:'approval',reason:'Single review already completed'});
          const current=await readFactoryFlow(db,completed.task);
          assert.equal(current.acceptance!.artifactId,artifactId);assert.equal(current.acceptance!.candidateId,completed.task.candidateId);
          assert.deepEqual(current.acceptance!.counts,{passed:1,failed:0,unverified:0});
          assert.equal(completed.attempts.filter(attempt=>attempt.stage==='review').length,1);
          const updated=(await db.query('SELECT "inlineContent" FROM artifact_versions WHERE "artifactId"=$1 AND version=$2',[artifactId,current.acceptance!.version])).rows[0].inlineContent;
          assert.match(updated,/审阅针对先前候选/);assert.match(updated,/Independent observation unavailable/,'empty historical evidence must not hide its unverified reason');
        } finally {emitPresentation=false;}
      });

      for (const exists of [false,true]) await t.test(`two tasks on one issue keep both comments without upgrading issue SHARE locks (document exists: ${exists})`, async () => {
        const issueId=randomUUID();
        await db.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState",scope) VALUES($1,'owner','Concurrent stages','{"type":"doc","content":[]}','todo','normal',$2,'bound','workspace')`,[issueId,billingWorkspaceId]);
        const tasks:FactoryTask[]=[];
        for (let i=0;i<2;i++) {
          const sourceEventId=randomUUID();
          await db.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1::uuid,'owner',$2,'user_message',$1::uuid::text,'{"text":"Concurrent stage fixture"}')`,[sourceEventId,coordinatorBot]);
          tasks.push((await store.route('owner',{issueId,sourceEventId,eventId:randomUUID(),rationale:'Fixture task',missingInformation:[],missingPermissions:[],needsSpec:false})).task);
        }
        if(exists){const initial=loadIssueDocument(null,{type:'doc',content:[]});try{
          await db.query(`INSERT INTO issue_documents("issueId","userId",state) VALUES($1,'owner',$2)`,[issueId,encodedIssueDocument(initial)]);
        }finally{initial.destroy();}}
        const transactions=await Promise.all(tasks.map(()=>db.connect()));
        const {beginFactoryTransaction,commitFactoryTransaction,rollbackFactoryTransaction,forgetFactoryTransaction}=await import('./transaction');
        try {
          await Promise.all(transactions.map(tx=>beginFactoryTransaction(tx)));
          const locked=await Promise.all(transactions.map((tx,index)=>store.lockTask(tx,'owner',tasks[index].id)));
          // Both transactions now hold their distinct task locks and the same
          // issue's SHARE lock. Neither may upgrade it while writing comments.
          emitPresentation=true;
          const results=await Promise.allSettled(transactions.map(async(tx,index)=>{
            try {await store.apply('owner',factoryBinding(locked[index]),randomUUID(),{action:'cancel',reason:'Fixture cancellation'},tx);await commitFactoryTransaction(tx);}
            catch(error){await rollbackFactoryTransaction(tx);throw error;}
          }));
          assert.deepEqual(results.map(result=>result.status),['fulfilled','fulfilled'],results.filter(result=>result.status==='rejected').map(result=>String(result.reason)).join('; '));
          const doc=loadIssueDocument((await db.query('SELECT state FROM issue_documents WHERE "issueId"=$1',[issueId])).rows[0].state,{type:'doc',content:[]});
          try {assert.deepEqual(readIssueThreads(doc).map(thread=>thread.id).sort(),tasks.map(task=>task.id).sort());
            assert.ok(readIssueThreads(doc).every(thread=>thread.messages.length===1&&thread.messages[0].body.includes('已取消')));
          }finally{doc.destroy();}
        } finally {emitPresentation=false;for(const tx of transactions){forgetFactoryTransaction(tx);tx.release();}}
      });

      await t.test('completed specifications wait for a real browser approval receipt; stale and replayed requests cannot bypass it', async () => {
        const issueId=randomUUID(),sourceEventId=randomUUID();
        await db.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState",scope) VALUES($1,'owner','Spec fixture','{"type":"doc","content":[]}','todo','normal',$2,'bound','workspace')`,[issueId,billingWorkspaceId]);
        await db.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1::uuid,'owner',$2,'user_message',$1::uuid::text,'{"text":"Plan first"}')`,[sourceEventId,coordinatorBot]);
        const routed = await store.route('owner',{issueId,sourceEventId,eventId:randomUUID(),rationale:'Plan first',missingInformation:[],missingPermissions:[],needsSpec:true});
        const specDispatch = createFactoryDispatch(db,store,queue,defaultFactoryDispatchAdapters);
        const planned = await specDispatch('owner',{binding:factoryBinding(routed.task),agentId,deviceRepoId:repoId});
        await db.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"startedAt"=now()-interval '1 second',"finishedAt"=now(),report=$3 WHERE id=$1`,
          [planned.runId,'plan-fixture',JSON.stringify({summary:'Specification ready',filesChanged:[],verify:{status:'not_run'},openQuestions:[],nextStep:null})]);
        await reconcile.run('owner',planned.runId);
        const ready = await store.read('owner',routed.task.id);
        assert.equal(ready.task.stage,'spec'); assert.equal(ready.task.status,'passed');
        assert.equal((await readFactoryFlow(db,ready.task)).needsYou?.kind,'spec_review');
        await assert.rejects(store.apply('owner',factoryBinding(ready.task),randomUUID(),{action:'advance',stage:'execute',reason:'Agent cannot approve'}),{code:'factory_spec_approval_required'});
        let dispatched=0;
        const approve = createFactorySpecApproval(db,store,async()=>{dispatched++;return undefined;});
        const input={binding:{taskId:ready.task.id,revision:ready.task.revision},eventId:randomUUID()};
        await assert.rejects(approve({userId:'owner',sessionId:'fixture-browser'},{...input,binding:{...input.binding,revision:1}}),{code:'factoryStale'});
        const results=await Promise.all([approve({userId:'owner',sessionId:'fixture-browser'},input),approve({userId:'owner',sessionId:'fixture-browser'},input)]);
        assert.equal(dispatched,1); assert.equal(results.filter(result=>result.replayed).length,1);
        assert.equal((await store.read('owner',ready.task.id)).task.stage,'execute');
        assert.equal((await db.query('SELECT count(*)::int AS n FROM factory_spec_approvals WHERE "taskId"=$1',[ready.task.id])).rows[0].n,1);
      });

      await t.test('single review can hand an ambiguous finding to the person without starting a repair or a second review', async () => {
        const pending = await pendingReview('repository', false);
        const review = await start(pending.task);
        await terminal(review.runId, `judgment-review-${pending.task.id}`, false, report => {
          report.verify = { status: 'not_run' };
          report.reviewVerdict = 'needs_judgment';
          report.criteria = [{ text: 'Ambiguous product preference', passed: false, status: 'unverified', reason: 'Both documented behaviors are possible; the owner must choose.' }];
        });
        await reconcile('owner');
        const ready = await state(pending.task.id);
        assert.equal(ready.task.stage, 'approval');
        assert.equal(ready.attempts.filter(a => a.stage === 'review').length, 1);
        assert.equal((ready.attempts.find(a => a.id === review.task.attemptId)?.output.completion as { reviewVerdict?: string } | undefined)?.reviewVerdict, 'needs_judgment');
      });
      await t.test('single-review repair hands off its new candidate and keeps earlier findings tied to the old SHA', async () => {
        const pending = await pendingReview('repository', false);
        const review = await start(pending.task);
        await terminal(review.runId, `single-review-failed-${pending.task.id}`, true);
        await reconcile('owner');
        const failed = await state(pending.task.id);
        assert.equal(failed.task.status, 'failed');
        await assert.rejects(store.apply('owner', factoryBinding(failed.task), randomUUID(), { action: 'retry', reason: 'Do not run a second review' }),
          error => error instanceof FactoryError && error.code === 'factoryTransition');
        const repair = await recover('owner', { binding: factoryBinding(failed.task), choice: 'repair_code' });
        const run = await start(repair.task);
        const repairedSha = 'b'.repeat(40);
        await db.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,
          "startedAt"=now()-interval '1 second',"finishedAt"=now(),report=$3 WHERE id=$1`,
          [run.runId, `repair-${pending.task.id}`, JSON.stringify({ sourceCommit: repairedSha, publish: { commit: repairedSha, pushed: true },
            summary: 'The finding was repaired and validated during implementation', verify: { status: 'passed' }, filesChanged: [] })]);
        await addFactoryVisualEvidence(db,run.runId);
        await reconcile('owner');
        await addFactoryPublicationEvidence(db,pending.task.id);
        await store.resumeEvidenceHandoff('owner',run.runId);
        const ready = await state(pending.task.id);
        assert.equal(ready.task.stage, 'approval');
        assert.equal(ready.task.status, 'pending');
        assert.equal(ready.attempts.filter(a => a.stage === 'review').length, 1);
        assert.equal(ready.attempts.filter(a => a.stage === 'verify').length, 0);
        const evidence = await currentEvidence(pending.task.id);
        assert.equal(evidence.manifest.candidate.sha, repairedSha);
        assert.deepEqual([...new Set(evidence.manifest.artifacts.map(a => a.stage))], ['execute']);
        assert.ok(evidence.manifest.artifacts.every(a => a.sha === repairedSha && a.candidateId === ready.task.candidateId));
        assert.equal(evidence.manifest.reviewHistory?.length, 1);
        assert.equal(evidence.manifest.reviewHistory![0].sha, sha);
        assert.equal(evidence.manifest.reviewHistory![0].candidateId, failed.task.candidateId);
        assert.equal(evidence.manifest.reviewHistory![0].appliesToCurrentCandidate, false);
        assert.equal(evidence.manifest.reviewHistory![0].status, 'failed');
        assert.ok(evidence.evidence.every(a => a.candidateId === ready.task.candidateId));
      });
      for (const stage of ["review", "verify"] as const) {
        for (const prerequisite of ["harness"] as const) {
          await t.test(
            `${stage} missing ${prerequisite} persists blocked after rollback, without an orphan run`,
            async () => {
              let pending = await pendingReview();
              if (stage === "verify") {
                const review = await start(pending.task);
                await terminal(review.runId, `review-${pending.task.id}`);
                await reconcile("owner");
                pending = await state(pending.task.id);
              }
              const beforeRuns = (await db.query(
                'SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id',
                [pending.task.issueId],
              )).rows;
              const code = "factoryCheckHarnessUnavailable";
              if (prerequisite === "harness")
                await db.query("UPDATE devices SET harnesses='[]' WHERE id=$1", [deviceId]);
              else
                await db.query('UPDATE device_repos SET "verifyCommand"=NULL WHERE id=$1', [repoId]);
              try {
                await assert.rejects(
                  observeFactoryCheckDispatch(store, dispatch)("owner", {
                    binding: {
                      ...factoryBinding(pending.task),
                      taskId:pending.task.id.toUpperCase(),
                      issueId:pending.task.issueId.toUpperCase(),
                      attemptId:pending.task.attemptId.toUpperCase(),
                      candidateId:pending.task.candidateId!.toUpperCase(),
                    }, agentId:agentId.toUpperCase(), deviceRepoId: repoId.toUpperCase(),
                  }),
                  (error: unknown) => error instanceof FactoryError && error.code === code,
                );
              } finally {
                if (prerequisite === "harness")
                  await db.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [deviceId, JSON.stringify([{harness:"codex",installed:true}])]);
                else
                  await db.query('UPDATE device_repos SET "verifyCommand"=$2 WHERE id=$1', [repoId, command]);
              }
              const blocked = await state(pending.task.id);
              assert.equal(blocked.task.status, "blocked");
              assert.equal(blocked.task.stage, stage);
              assert.equal(blocked.task.candidateId, pending.task.candidateId);
              assert.equal(blocked.task.attemptId, pending.task.attemptId);
              assert.equal(blocked.task.revision, pending.task.revision + 1);
              const attempt = blocked.attempts.find(a => a.id === pending.task.attemptId)!;
              assert.equal(attempt.runId, null);
              assert.deepEqual(attempt.output.dispatch, {code,agentId,deviceRepoId:repoId});
              assert.deepEqual((await db.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id',[pending.task.issueId])).rows,beforeRuns);
              // Repeating the stale request creates neither another run nor a
              // second blocked observation; it is not a successful replay.
              await assert.rejects(observeFactoryCheckDispatch(store,dispatch)("owner",{
                binding:factoryBinding(pending.task),agentId,deviceRepoId:repoId,
              }));
              assert.deepEqual(await state(pending.task.id),blocked);
            },
          );
        }
      }
      for (const stage of ["review","verify"] as const) await t.test(`${stage} missing command queues an independent inference check instead of blocking dispatch`, async () => {
        let pending = await pendingReview();
        if (stage === "verify") {
          const review = await start(pending.task);
          await terminal(review.runId, `review-${pending.task.id}`);
          await reconcile("owner");
          pending = await state(pending.task.id);
        }
        await db.query('UPDATE device_repos SET "verifyCommand"=NULL WHERE id=$1',[repoId]);
        try {
          const dispatched = await start(pending.task);
          const snapshot = await state(pending.task.id);
          const check = snapshot.attempts.find(a => a.runId === dispatched.runId)!.output.check as {inferCommand:boolean;reportOnly:boolean;command:string|null};
          assert.equal(snapshot.task.status,"running");
          assert.equal(check.inferCommand,true);
          assert.equal(check.reportOnly,stage === "review");
          assert.equal(check.command,null);
        } finally { await db.query('UPDATE device_repos SET "verifyCommand"=$2 WHERE id=$1',[repoId,command]); }
      });
      await t.test('a real report-only review finding retains trusted provenance without fabricated process fields', async () => {
        const pending = await pendingReview();
        await db.query('UPDATE device_repos SET "verifyCommand"=NULL WHERE id=$1',[repoId]);
        try {
          const review = await start(pending.task);
          await terminal(review.runId, `report-only-${review.runId}`, false, report => {
            report.verify = { status: 'not_run' };
            report.criteria[0].passed = false;
          });
          await reconcile('owner');
          const failed = await state(pending.task.id);
          assert.equal(failed.task.status, 'failed');
          assert.equal((failed.attempts.find(a => a.runId === review.runId)!.output.completion as {trustedFailureProvenance:boolean}).trustedFailureProvenance, true);
        } finally { await db.query('UPDATE device_repos SET "verifyCommand"=$2 WHERE id=$1',[repoId,command]); }
      });
      for (const stage of ["review","verify"] as const) await t.test(`${stage} quota fallback restarts independently and preserves the exact candidate assignment`, async () => {
        let pending = await pendingReview();
        if (stage === "verify") {
          const review = await start(pending.task);
          await terminal(review.runId, `review-${pending.task.id}`);
          await reconcile("owner"); pending = await state(pending.task.id);
        }
        const original = await start(pending.task);
        const { rows: [prior] } = await db.query('SELECT * FROM agent_runs WHERE id=$1',[original.runId]);
        const childId = randomUUID();
        const definition = (await import('../agent-kit/worker')).apiKeyWorkerDefinition(prior.agentDefinition, prior.prompt, { keyId: randomUUID(), model: prior.agentDefinition.model ?? 'gpt-5' });
        await db.query(`UPDATE agent_runs SET status='failed',"stopReason"='quota_exhausted',"finishedAt"=now(),"sessionId"='paused-check-session' WHERE id=$1`,[prior.id]);
        await db.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",kind,status,prompt,"baseBranch","agentDefinition","retryOf")
          SELECT $2,"userId","issueId","agentId","deviceId","deviceRepoId","botId",kind,'queued',prompt,"baseBranch",$3,id FROM agent_runs WHERE id=$1`,[prior.id,childId,JSON.stringify(definition)]);
        await reconcile("owner");
        const snapshot = await state(pending.task.id);
        assert.equal(snapshot.task.stage,stage);assert.equal(snapshot.task.status,'running');
        assert.equal(snapshot.task.candidateId,pending.task.candidateId);
        assert.equal(snapshot.attempts.at(-1)!.runId,childId);
        const assignmentTx = await db.connect();
        try { const assignment = await factoryCheckAssignment(assignmentTx,'owner',childId);assert.equal(assignment.baseBranch,prior.baseBranch); } finally { assignmentTx.release(); }
        const { rows: [child] } = await db.query('SELECT "retryOf","sessionId" FROM agent_runs WHERE id=$1',[childId]);
        assert.equal(child.retryOf,null);assert.equal(child.sessionId,null);
      });
      for (const race of ["cancel", "access-loss"] as const)
        await t.test(`dispatch blocked observation cannot overwrite ${race}`, async () => {
          // Compare persisted snapshots, including timestamps. apply's return
          // contains its pre-save task.updatedAt; a fresh read is authoritative.
          const pending = await state((await pendingReview()).task.id);
          const input = {binding:factoryBinding(pending.task),agentId,deviceRepoId:repoId};
          await db.query("UPDATE devices SET harnesses='[]' WHERE id=$1",[deviceId]);
          let cancelled: Awaited<ReturnType<typeof state>> | undefined;
          try {
            const raceDispatch: typeof dispatch = async (...args) => {
              try { return await dispatch(...args); }
              catch (error) {
                if (race === "cancel") {
                  await store.apply("owner",input.binding,randomUUID(),{action:"cancel",reason:"Fixture cancellation wins after queue rollback"});
                  cancelled = await state(pending.task.id);
                } else
                  await db.query('UPDATE issues SET "userId"=\'other\' WHERE id=$1',[pending.task.issueId]);
                throw error;
              }
            };
            await assert.rejects(observeFactoryCheckDispatch(store,raceDispatch)("owner",input));
          } finally {
            await db.query('UPDATE devices SET harnesses=$2 WHERE id=$1',[deviceId,JSON.stringify([{harness:"codex",installed:true}])]);
            if (race === "access-loss")
              await db.query('UPDATE issues SET "userId"=\'owner\' WHERE id=$1',[pending.task.issueId]);
          }
          assert.deepEqual(await state(pending.task.id),cancelled ?? pending);
          assert.equal((await db.query('SELECT count(*)::int n FROM factory_events WHERE "taskId"=$1 AND request->\'change\'->\'output\'->\'dispatch\' IS NOT NULL',[pending.task.id])).rows[0].n,0);
        });
      await t.test("question/caller transaction failure is left to its caller, with no committed blocked state or orphan", async () => {
        const pending = await state((await pendingReview()).task.id);
        const tx = await db.connect();
        const beforeRuns=(await db.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id',[pending.task.issueId])).rows;
        await db.query("UPDATE devices SET harnesses='[]' WHERE id=$1",[deviceId]);
        try {
          await tx.query("BEGIN");
          await assert.rejects(observeFactoryCheckDispatch(store,dispatch)("owner",{
            binding:factoryBinding(pending.task),agentId,deviceRepoId:repoId,
          },tx),(error:unknown)=>error instanceof FactoryError && error.code === "factoryCheckHarnessUnavailable");
          assert.equal((await tx.query('SELECT status FROM factory_tasks WHERE id=$1',[pending.task.id])).rows[0].status,"pending");
        } finally {
          await tx.query("ROLLBACK");
          tx.release();
          await db.query('UPDATE devices SET harnesses=$2 WHERE id=$1',[deviceId,JSON.stringify([{harness:"codex",installed:true}])]);
        }
        assert.deepEqual(await state(pending.task.id),pending);
        assert.deepEqual((await db.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id',[pending.task.issueId])).rows,beforeRuns);
      });
      for (const decision of ["allow", "ask", "deny"] as const)
        await t.test(
          `claim retains host network ${decision} and its frozen domain list`,
          async () => {
            const pending = await pendingReview();
            const base = defaultRunPolicy();
            selectedPolicy = {
              ...base,
              permissions: { ...base.permissions, network: decision },
              networkAllow: ["allowed.example.invalid"],
            };
            let dispatched: Awaited<ReturnType<typeof dispatch>>;
            try {
              dispatched = await start(pending.task);
            } finally {
              selectedPolicy = undefined;
            }
            const tx = await db.connect();
            try {
              await tx.query("BEGIN");
              const extras = await claim(
                tx,
                "owner",
                deviceId,
                dispatched.runId,
                new Date(Date.now() + 60000).toISOString(),
              );
              assert.equal(
                (extras.policy as RunPolicy).permissions.network,
                decision,
              );
              assert.deepEqual((extras.policy as RunPolicy).networkAllow, [
                "allowed.example.invalid",
              ]);
              assert.equal((extras.policy as RunPolicy).readOnly, true);
            } finally {
              await tx.query("ROLLBACK");
              tx.release();
            }
          },
        );
      await t.test(
        "dispatch freezes exact assignment and real snapshot; actual local claim joins token transaction",
        async () => {
          const r = await pendingReview(),
            d = await start(r.task),
            tx = await db.connect();
          try {
            await tx.query("BEGIN");
            const extras = await claim(
              tx,
              "owner",
              deviceId,
              d.runId,
              new Date(Date.now() + 60000).toISOString(),
            );
            assert.equal(extras.baseBranch, sha);
            assert.equal(extras.verifyCommand, command);
            assert.deepEqual((extras.policy as any).networkAllow, [
              ...DEFAULT_NETWORK_ALLOW,
            ]);
            await tx.query("ROLLBACK");
          } finally {
            await tx.query("ROLLBACK");
            tx.release();
          }
          const tokenId = randomUUID();
          const guard = async (tx: import("pg").PoolClient) => {
            await claim(
              tx,
              "owner",
              deviceId,
              d.runId,
              new Date(Date.now() + 60000).toISOString(),
            );
            return true;
          };
          await assert.rejects(
            claimLocalRun(
              db,
              d.runId,
              deviceId,
              new Date(Date.now() + 60000),
              undefined,
              guard,
              async (tx) => {
                await tx.query(
                  'INSERT INTO run_tokens(id,"runId","userId","tokenHash","expiresAt") VALUES ($1,$2,$3,$4,now()+interval \'1 minute\')',
                  [tokenId, d.runId, "owner", randomUUID()],
                );
                throw new Error("Token callback rollback fixture");
              },
            ),
            /rollback fixture/,
          );
          assert.equal(
            (
              await db.query("SELECT status FROM agent_runs WHERE id=$1", [
                d.runId,
              ])
            ).rows[0].status,
            "queued",
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM run_tokens WHERE id=$1",
                [tokenId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            await claimLocalRun(
              db,
              d.runId,
              deviceId,
              new Date(Date.now() + 60000),
              undefined,
              guard,
              async (tx) => {
                await tx.query(
                  'INSERT INTO run_tokens(id,"runId","userId","tokenHash","expiresAt") VALUES ($1,$2,$3,$4,now()+interval \'1 minute\')',
                  [tokenId, d.runId, "owner", randomUUID()],
                );
              },
            ),
            "claimed",
          );
          assert.equal(
            (
              await db.query(
                "SELECT count(*)::int n FROM run_tokens WHERE id=$1",
                [tokenId],
              )
            ).rows[0].n,
            1,
          );
          await terminal(d.runId, `review-${r.task.id}`);
          await reconcile("owner");
          assert.equal((await state(r.task.id)).task.stage, "verify");
        },
      );
      await t.test(
        "separate review/verify pass reaches approval only with paired original verifier chunks",
        async () => {
          const r = await pendingReview(),
            review = await start(r.task);
          const shot = randomUUID(), clip = randomUUID();
          const capture = (id: string, runId: string, kind: "image" | "video") => db.query(
            `INSERT INTO run_captures (id,"userId","runId",kind,"contentType",source,status,title,size,sha256,"storageKey") VALUES ($1,'owner',$2,$3,$4,'local','ready','Independent check capture',3,$5,$6)`,
            [id, runId, kind, kind === "image" ? "image/png" : "video/mp4", "c".repeat(64), `owner/captures/${id}`],
          );
          await terminal(review.runId, `review-${r.task.id}`);
          await capture(shot, review.runId, "image");
          await reconcile("owner");
          const verify = await start((await state(r.task.id)).task);
          await terminal(verify.runId, `verify-${r.task.id}`);
          await capture(clip, verify.runId, "video");
          await toolChunks(verify.runId);
          await reconcile("owner");
          const done = await state(r.task.id);
          assert.equal(done.task.stage, "approval");
          assert.equal(done.task.status, "pending");
          for (const [stage, captureId, kind] of [["review", shot, "screenshot"], ["verify", clip, "video"]]) {
            const refs = done.attempts.find(a => a.stage === stage)!.evidence as { artifact: string; kind: string }[];
            assert.deepEqual(refs.filter(e => e.artifact.startsWith("run-capture:")).map(e => [e.artifact, e.kind]), [[`run-capture:${captureId}`, kind]]);
          }
          const evidence = done.attempts.find((a) => a.stage === "verify")!
            .evidence as any[];
          assert.equal(
            evidence.filter((e) => e.artifact.startsWith("run-chunk:")).length,
            2,
          );
          assert.equal(
            new Set(
              done.attempts.filter((a) => a.runId).map((a) => a.sessionId),
            ).size,
            3,
          );
        },
      );
      for (const mode of [
        "model-only",
        "wrong-sha",
        "missing-chunks",
        "tool-error",
        "post-finish-chunks",
        "forged-failure",
      ] as const)
        await t.test(
          `reject ${mode} without advance or automatic repair`,
          async () => {
            const r = await pendingReview();
            let d = await start(r.task);
            if (
              mode === "missing-chunks" ||
              mode === "tool-error" ||
              mode === "post-finish-chunks"
            ) {
              await terminal(d.runId, `review-${r.task.id}`);
              await reconcile("owner");
              d = await start((await state(r.task.id)).task);
            }
            await terminal(
              d.runId,
              `negative-${r.task.id}`,
              mode === "forged-failure",
              (report) => {
                if (mode === "model-only" || mode === "forged-failure")
                  delete report.check;
                if (mode === "wrong-sha") report.check.sha = "b".repeat(40);
              },
            );
            if (mode === "tool-error") await toolChunks(d.runId, true);
            if (mode === "post-finish-chunks")
              await toolChunks(d.runId, false, true);
            await reconcile("owner");
            const result = await state(r.task.id);
            assert.equal(result.task.status, "blocked");
            assert.equal(
              result.attempts.filter((a) => a.stage === "execute").length,
              1,
            );
          },
        );
      for (const phase of ['review', 'verify'] as const) for (const machineState of ['running', 'paused'] as const)
        for (const kind of ['repository', 'deliverable'] as const)
        await t.test(kind + ' ' + phase + ' question continuation keeps its owned ' + machineState + ' VM, issue, candidate and original session without a parent runtime', async () => {
          const pending = await pendingReview(kind);
          let origin = await start(pending.task);
          if (phase === 'verify') {
            await terminal(origin.runId, 'review-' + pending.task.id);
            await reconcile('owner');
            origin = await start((await state(pending.task.id)).task);
          }
          let outputChunkId: string | undefined;
          if (kind === 'deliverable') {
            // The native checker already has the old empty collection. A fresh
            // host read can now see saved evidence, as after a reader upgrade.
            const producer = (await db.query(`SELECT r.* FROM factory_candidates c JOIN agent_runs r ON r.id=c."runId" WHERE c.id=$1`, [pending.task.candidateId])).rows[0];
            outputChunkId = randomUUID();
            // Stay inside the run window: JS Date drops PostgreSQL microseconds.
            await db.query(`INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") VALUES($1,$2,1,$3,$4),($5,$2,2,$6,$7)`,
              [randomUUID(), producer.id, JSON.stringify({ type: 'tool-input-available', toolName: 'shell', toolCallId: 'persisted-producer-command', input: { command: 'wc -c REPORT.md' } }), new Date(producer.startedAt.getTime() + 100),
                outputChunkId, JSON.stringify({ type: 'tool-output-available', toolCallId: 'persisted-producer-command', output: { exitCode: 0, output: '52 REPORT.md' } }), new Date(producer.finishedAt.getTime() - 100)]);
            const oldPrompt = (await db.query('SELECT prompt FROM agent_runs WHERE id=$1', [origin.runId])).rows[0].prompt;
            assert.match(oldPrompt, /"records":\[\],"inheritedRecords":\[\]/);
            assert.ok(!oldPrompt.includes(outputChunkId));
          }
          const childDevice = randomUUID(), childRepo = randomUUID(), connectionId = randomUUID(), credentialId = randomUUID();
          const nativeSession = 'original-question-' + origin.runId, sandboxId = 'retained-question-' + origin.runId;
          await db.query("INSERT INTO devices(id,\"ownerId\",name,kind,enabled,\"lastSeenAt\",harnesses) VALUES($1,'owner','Retained task','cloud',true,now()-interval '1 hour','[{\"harness\":\"codex\",\"installed\":true}]')", [childDevice]);
          await db.query("INSERT INTO device_repos(id,\"deviceId\",\"userId\",\"repoPath\",\"remoteUrl\",\"baseBranch\",\"verifyCommand\") VALUES($1,$2,'owner','/retained','/fixture/repo','main',$3)", [childRepo, childDevice, command]);
          await db.query("INSERT INTO byos_connections(id,\"ownerId\",\"workspaceId\",state,epoch,provider,\"secretName\",\"providerSubject\",\"secretDigest\") VALUES($1,'owner',$2,'connected',1,'codex','synthetic-retained-question-' || $1::uuid::text,'synthetic-subject',repeat('a',64))", [connectionId, billingWorkspaceId]);
          await db.query("INSERT INTO byos_bindings(id,\"ownerId\",\"workspaceId\",\"consumerId\",\"connectionId\",\"connectionRevision\",route,\"modelId\") VALUES($1,'owner',$2,$3,$4,1,'codex_cli','fixture-model')", [credentialId, billingWorkspaceId, agentId, connectionId]);
          const definition = freezeWorkerDefinition({ harness: 'codex', instructions: 'Frozen fixture', prompt: 'Original check', parent: null, executionId: null, model: 'fixture-model', subscription: { id: credentialId, modelId: 'fixture-model', route: 'codex_cli' } });
          await db.query("UPDATE agent_runs SET \"deviceId\"=$2,\"deviceRepoId\"=$3,\"agentDefinition\"=$4,status='stopped',\"stopReason\"='asked_human',\"sessionId\"=$5,report=$6 WHERE id=$1",
            [origin.runId, childDevice, childRepo, JSON.stringify(definition), nativeSession, JSON.stringify({ question: { questionId: randomUUID(), kind: 'decision', question: 'Which acceptance path?', options: ['A', 'B'] } })]);
          await db.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,\'owner\')', [origin.runId, coordinatorBot, billingWorkspaceId]);
          await db.query('INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","issueId","snapshotId","operationId",state,"sandboxId","deviceId","repoId") VALUES($1,$2,\'owner\',$3,$4,\'codex\',$5,$6,$7,$8,$9)',
            [origin.runId, billingWorkspaceId, coordinatorBot, pending.task.issueId, randomUUID(), machineState, sandboxId, childDevice, childRepo]);
          // This is the task-device reassignment normally performed when the
          // first check VM is created. No parent metadata or provider is mocked.
          await db.query("UPDATE factory_attempts SET output=jsonb_set(jsonb_set(output,'{check,deviceRepoId}',to_jsonb($2::text)),'{check,environment}',to_jsonb($3::text)) WHERE id=$1",
            [origin.task.attemptId, childRepo, 'device:' + childDevice]);
          const cloudDispatch = createFactoryDispatch(db, store, async (tx, owner, input, botId, context) => {
            const result = await queueCloudQuestionContinuation(tx, owner, input, botId, context);
            assert.ok(result, 'The normal cloud continuation must not use a new-run fallback');
            return result;
          });
          const cloudQuestions = createFactoryQuestions(db, authorize, store, cloudDispatch, assignment);
          const q = await cloudQuestions.record('owner', origin.runId);
          const browserSessionId = randomUUID();
          await db.query('INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES($1,\'owner\',$2,now()+interval \'1 hour\',now(),now())', [browserSessionId, randomUUID()]);
          const beforeRun = (await db.query('SELECT to_jsonb(r) AS run FROM agent_runs r WHERE id=$1', [origin.runId])).rows;
          const beforeCandidate = (await db.query('SELECT to_jsonb(c) AS candidate FROM factory_candidates c WHERE id=$1', [pending.task.candidateId])).rows;
          const answer = { reference: questionReference(q), answerId: randomUUID(), text: 'A' };
          // A retained VM relies on its actual worker capabilities, unlike a
          // fresh task whose official template supplies the harness.
          await db.query('UPDATE devices SET harnesses=\'[]\' WHERE id=$1', [childDevice]);
          const waitingBefore = await state(pending.task.id);
          const runsBefore = (await db.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [pending.task.issueId])).rows;
          try {
            await assert.rejects(cloudQuestions.answer({ source: 'human', userId: 'owner', sessionId: browserSessionId }, answer),
              (error: unknown) => error instanceof FactoryError && error.code === 'factoryCheckHarnessUnavailable');
            assert.deepEqual(await state(pending.task.id), waitingBefore);
            assert.deepEqual((await db.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [pending.task.issueId])).rows, runsBefore);
          } finally {
            await db.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [childDevice, JSON.stringify([{ harness: 'codex', installed: true }])]);
          }
          const resumed = await cloudQuestions.answer({ source: 'human', userId: 'owner', sessionId: browserSessionId }, answer);
          const run = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [resumed.continuationRunId])).rows[0];
          assert.equal(run.issueId, pending.task.issueId);
          assert.equal(run.botId, coordinatorBot);
          assert.equal(run.deviceId, childDevice);
          assert.equal(run.deviceRepoId, childRepo);
          assert.equal(run.questionContinuation.originSessionId, nativeSession);
          assert.equal(run.questionContinuation.requiredSandboxId, sandboxId);
          assert.equal(run.agentDefinition.definitionDigest, definition.definitionDigest);
          assert.deepEqual(run.agentDefinition.subscription, definition.subscription);
          if (outputChunkId) {
            assert.ok(run.questionContinuation.followUp.includes(outputChunkId));
            assert.match(run.questionContinuation.followUp, /52 REPORT.md/);
            assert.doesNotMatch(run.questionContinuation.followUp, /Original issue and standing instructions|Producing run report \(observations/);
          } else assert.doesNotMatch(run.questionContinuation.followUp, /Current host-recorded command evidence/);
          assert.equal((await state(pending.task.id)).task.candidateId, pending.task.candidateId);
          assert.deepEqual((await db.query('SELECT to_jsonb(r) AS run FROM agent_runs r WHERE id=$1', [origin.runId])).rows, beforeRun);
          assert.deepEqual((await db.query('SELECT to_jsonb(c) AS candidate FROM factory_candidates c WHERE id=$1', [pending.task.candidateId])).rows, beforeCandidate);
          assert.deepEqual((await db.query('SELECT state,"sandboxId" FROM thread_machines WHERE "runId"=$1', [origin.runId])).rows[0], { state: 'ended', sandboxId: null });
          assert.deepEqual((await db.query('SELECT state,"sandboxId","deviceId","repoId" FROM thread_machines WHERE "runId"=$1', [run.id])).rows[0], { state: machineState, sandboxId, deviceId: childDevice, repoId: childRepo });
          const tx = await db.connect();
          try {
            await tx.query('BEGIN');
            const actor = { userId: 'owner', workspaceId: billingWorkspaceId };
            const input = { botId: coordinatorBot, agentId, deviceRepoId: childRepo, runId: run.id, issueId: run.issueId };
            assert.equal(await cloudTaskTarget(tx, actor, input), null, 'A task VM cannot be used as a fresh parent runtime');
            assert.equal((await ownedCloudTaskTarget(tx, actor, input))?.deviceId, childDevice);
            for (const bad of [{ ...input, botId: randomUUID() }, { ...input, runId: origin.runId }, { ...input, runId: randomUUID() }, { ...input, agentId: randomUUID() }, { ...input, deviceRepoId: repoId }, { ...input, issueId: randomUUID() }])
              assert.equal(await ownedCloudTaskTarget(tx, actor, bad), null);
            assert.equal(await ownedCloudTaskTarget(tx, { ...actor, userId: 'other' }, input), null);
            assert.equal(await ownedCloudTaskTarget(tx, { ...actor, workspaceId: randomUUID() }, input), null);
            const otherBot = randomUUID();
            await tx.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,\'owner\',\'Other fixture bot\')', [otherBot, billingWorkspaceId]);
            for (const [sql, params] of [
              ['UPDATE computer_run_bindings SET "botId"=$2 WHERE "runId"=$1', [run.id, otherBot]],
              ['UPDATE thread_machines SET "botId"=$2 WHERE "runId"=$1', [run.id, otherBot]],
              ['UPDATE agent_runs SET "botId"=$2 WHERE id=$1', [run.id, otherBot]],
              ['UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [run.id, deviceId]],
              ['UPDATE agent_runs SET "deviceRepoId"=$2 WHERE id=$1', [run.id, repoId]],
              ['UPDATE thread_machines SET "deviceId"=$2 WHERE "runId"=$1', [run.id, deviceId]],
              ['UPDATE thread_machines SET "repoId"=$2 WHERE "runId"=$1', [run.id, repoId]],
              ['UPDATE devices SET enabled=false WHERE id=$1', [childDevice]],
              ["UPDATE thread_machines SET state='ended',\"sandboxId\"=NULL WHERE \"runId\"=$1", [run.id]],
            ] as const) {
              await tx.query('SAVEPOINT custody');
              await tx.query(sql, [...params]);
              assert.equal(await ownedCloudTaskTarget(tx, actor, input), null, sql);
              await tx.query('ROLLBACK TO SAVEPOINT custody');
            }
            // Admission preserves a paused/stale task VM. Its worker still has
            // to reconnect before claim; this is independent of parent state.
            const cloudClaim = createFactoryClaim(store, cloudQuestions, assignment);
            await tx.query('SAVEPOINT worker_not_ready');
            await assert.rejects(cloudClaim(tx, 'owner', childDevice, run.id, new Date(Date.now() + 60000).toISOString()),
              (error: unknown) => error instanceof FactoryError && error.code === 'factoryQuestionContinuationUnavailable');
            await tx.query('ROLLBACK TO SAVEPOINT worker_not_ready');
            await tx.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [childDevice]);
            await tx.query("UPDATE thread_machines SET state='running' WHERE \"runId\"=$1", [run.id]);
            const extras = await cloudClaim(tx, 'owner', childDevice, run.id, new Date(Date.now() + 60000).toISOString());
            assert.equal(extras.requireSessionResume, true);
            assert.equal(extras.resumeSessionId, nativeSession);
            assert.equal(extras.baseBranch, sha);
            assert.deepEqual(extras.factoryCheck, { stage: phase, inferCommand: false, reportOnly: kind === 'deliverable' });
            assert.equal(extras.verifyCommand, kind === 'deliverable' ? undefined : command);
            assert.equal((extras.policy as RunPolicy).readOnly, true);
            assert.equal(extras.followUp, run.questionContinuation.followUp, 'the actual native message receives the fresh host evidence');
            if (outputChunkId) {
              for (const drift of [
                { userId: 'other' }, { issueId: randomUUID() }, { candidateId: randomUUID() },
                { attemptId: randomUUID() }, { sourceEventId: randomUUID() },
              ]) await assert.rejects(appendFactoryCheckContinuationContext(tx, { ...resumed.task, ...drift }, run.id, 'Original answer'),
                { code: 'factoryCheckBindingMismatch' });
              for (const sources of [null, {}, [{ outputChunkId: randomUUID() }]]) {
                await tx.query('SAVEPOINT evidence_binding');
                await tx.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{check,questionCommandSources}',$2::jsonb) WHERE id=$1`,
                  [resumed.task.attemptId, JSON.stringify(sources)]);
                await assert.rejects(appendFactoryCheckContinuationContext(tx, resumed.task, run.id, 'Original answer'),
                  { code: 'factoryCheckBindingMismatch' }, 'malformed or mismatched citation sources must not be delivered');
                await tx.query('ROLLBACK TO SAVEPOINT evidence_binding');
              }
            }
          } finally { await tx.query('ROLLBACK'); tx.release(); }
          const replayed = await cloudQuestions.answer({ source: 'human', userId: 'owner', sessionId: browserSessionId }, answer);
          assert.equal(replayed.continuationRunId, run.id);
          assert.equal(replayed.replayed, true);
          assert.equal((await db.query('SELECT "questionContinuation" FROM agent_runs WHERE id=$1', [run.id])).rows[0].questionContinuation.followUp,
            run.questionContinuation.followUp, 'answer replay does not regenerate or append another collection');
          if (kind === 'deliverable' && machineState === 'paused') {
            await db.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',"sessionId"=$2,"finishedAt"=now() WHERE id=$1`, [run.id, nativeSession]);
            await cloudQuestions.settle('owner', run.id);
            const blocked = await cloudQuestions.read('owner', q.id);
            const recovery = { requestId: randomUUID(), ...blocked.recoverReference! };
            const failedBefore = (await db.query('SELECT to_jsonb(r) AS run FROM agent_runs r WHERE id=$1', [run.id])).rows;
            const answerBefore = (await db.query('SELECT answer,"answerFingerprint",result FROM factory_questions WHERE id=$1', [q.id])).rows;
            const recovered = await cloudQuestions.recover({ source: 'human', userId: 'owner', sessionId: browserSessionId }, recovery);
            const recoveryRun = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [recovered.continuationRunId])).rows[0];
            assert.ok(recoveryRun.questionContinuation.followUp.includes(outputChunkId!));
            assert.doesNotMatch(recoveryRun.questionContinuation.followUp, /Answer to execution question|Original issue and standing instructions/);
            assert.equal(recoveryRun.questionContinuation.originSessionId, nativeSession);
            assert.equal(recoveryRun.questionContinuation.requiredSandboxId, sandboxId);
            assert.equal(recoveryRun.deviceId, childDevice);
            assert.equal(recoveryRun.deviceRepoId, childRepo);
            assert.equal(recoveryRun.agentDefinition.definitionDigest, definition.definitionDigest);
            assert.deepEqual(recoveryRun.agentDefinition.subscription, definition.subscription);
            assert.equal(recovered.task.candidateId, pending.task.candidateId);
            assert.deepEqual((await db.query('SELECT to_jsonb(r) AS run FROM agent_runs r WHERE id=$1', [run.id])).rows, failedBefore);
            assert.deepEqual((await db.query('SELECT answer,"answerFingerprint",result FROM factory_questions WHERE id=$1', [q.id])).rows, answerBefore);
            const tx = await db.connect();
            try {
              await tx.query('BEGIN');
              await tx.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [childDevice]);
              await tx.query("UPDATE thread_machines SET state='running' WHERE \"runId\"=$1", [recoveryRun.id]);
              const extras = await createFactoryClaim(store, cloudQuestions, assignment)(tx, 'owner', childDevice, recoveryRun.id, new Date(Date.now() + 60000).toISOString());
              assert.equal(extras.followUp, recoveryRun.questionContinuation.followUp);
              assert.equal(extras.continuesRunId, run.id);
              assert.equal(extras.resumeSessionId, nativeSession);
              assert.equal(extras.requireSessionResume, true);
              assert.equal(extras.baseBranch, sha);
              assert.equal((extras.policy as RunPolicy).readOnly, true);
              assert.equal(extras.verifyCommand, undefined);
            } finally { await tx.query('ROLLBACK'); tx.release(); }
            const replay = await cloudQuestions.recover({ source: 'human', userId: 'owner', sessionId: browserSessionId }, recovery);
            assert.equal(replay.continuationRunId, recoveryRun.id);
            assert.equal(replay.replayed, true);
            assert.equal((await db.query('SELECT "questionContinuation" FROM agent_runs WHERE id=$1', [recoveryRun.id])).rows[0].questionContinuation.followUp,
              recoveryRun.questionContinuation.followUp);
            // Evidence delivery is not acceptance. This test stops at the
            // strict native claim and does not alter the existing recovery gate.
            assert.equal((await state(pending.task.id)).task.status, 'running');
            return;
          }
          await terminal(run.id, nativeSession);
          if (phase === 'verify' && kind === 'repository') await toolChunks(run.id);
          await reconcile('owner');
          assert.equal((await state(pending.task.id)).task.stage, phase === 'review' ? 'verify' : 'approval');
        });
      for (const kind of ['deliverable', 'report'] as const)
        for (const phase of ['review', 'verify'] as const)
          await t.test(`a ${kind} ${phase} question cannot turn an Owner explanation into a verification command`, async () => {
            const pending = await pendingReview(kind);
            let running = await start(pending.task);
            if (phase === 'verify') {
              await terminal(running.runId, `review-${pending.task.id}`);
              await reconcile('owner');
              running = await start((await state(pending.task.id)).task);
            }
            const origin = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [running.runId])).rows[0];
            const sessionId = `artifact-question-${running.runId}`, questionId = randomUUID();
            const report = { summary: 'Missing recorded evidence, not a missing repository command.',
              question: { questionId, kind: 'decision', purpose: 'verification_command',
                question: 'May I continue inspecting this candidate after the evidence becomes available?', options: [] } };
            await db.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,
              "startedAt"=now()-interval '1 second',"finishedAt"=now(),report=$3 WHERE id=$1`,
              [running.runId, sessionId, JSON.stringify(report)]);
            const recorded = await questions.record('owner', running.runId);
            const q = await questions.escalate('owner', { reference: questionReference(recorded), eventId: randomUUID(), reason: 'The Owner decides.' });
            assert.equal((q.request as any).handoff.purpose, 'verification_command', 'record retains the authentic handoff, including its mistake');
            const oldAttempt = (await db.query('SELECT * FROM factory_attempts WHERE id=$1', [running.task.attemptId])).rows[0];
            assert.deepEqual([oldAttempt.output.check.reportOnly, oldAttempt.output.check.inferCommand, oldAttempt.output.check.command],
              [true, false, null], 'the host configured the artifact check before the model asked');
            const browserSessionId = randomUUID();
            await db.query(`INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt")
              VALUES ($1,'owner',$2,now()+interval '1 hour',now(),now())`, [browserSessionId, randomUUID()]);
            const answer = { reference: questionReference(q), answerId: randomUUID(),
              text: phase === 'verify' && kind === 'report' ? 'Continue inspecting the same candidate.\nThis is an explanation, not a command.' : 'Continue inspecting the same candidate. This is an explanation, not a command.' };
            const post = (userId = 'owner') => handleFactoryQuestion(questions, {
              actor: { userId, sessionId: browserSessionId }, authorization: null, method: 'POST',
              questionId, origin: 'http://127.0.0.1', url: 'http://127.0.0.1', body: answer,
            });
            const snapshot = async () => (await db.query(`SELECT to_jsonb(t) AS task,to_jsonb(q) AS question,
              (SELECT count(*)::int FROM agent_runs WHERE "issueId"=t."issueId") AS runs,
              (SELECT count(*)::int FROM factory_events WHERE "taskId"=t.id) AS events,
              (SELECT "verifyCommand" FROM device_repos WHERE id=$2) AS command,
              (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s."remoteKey"),'[]'::jsonb) FROM repository_settings s WHERE "userId"='owner') AS settings
              FROM factory_tasks t JOIN factory_questions q ON q."taskId"=t.id AND q.id=$3 WHERE t.id=$1`,
              [running.task.id, repoId, questionId])).rows[0];
            const before = await snapshot();
            await assert.rejects(factoryCheckAssignment(db, 'owner', running.runId), { code: 'factoryCheckBindingMismatch' },
              'the normal claim reader must still reject waiting checks');
            assert.equal((await post('other')).status, 404);
            assert.deepEqual(await snapshot(), before);
            if (kind === 'report' && phase === 'review') {
              const rejects = [
                ['missing', null], ['contradictory inference', { ...oldAttempt.output.check, inferCommand: true }],
                ['not report-only', { ...oldAttempt.output.check, reportOnly: false }],
                ['unexpected command', { ...oldAttempt.output.check, command: 'node forbidden.mjs' }],
                ['wrong stage', { ...oldAttempt.output.check, stage: phase === 'review' ? 'verify' : 'review' }],
                ['wrong candidate', { ...oldAttempt.output.check, candidateId: randomUUID() }],
                ['wrong SHA', { ...oldAttempt.output.check, sha: 'b'.repeat(40) }],
                ['wrong repository', { ...oldAttempt.output.check, repository: '/another/repo' }],
                ['wrong device repository', { ...oldAttempt.output.check, deviceRepoId: randomUUID() }],
                ['wrong environment', { ...oldAttempt.output.check, environment: 'device:another' }],
                ['wrong epoch', { ...oldAttempt.output.check, requestEpoch: randomUUID() }],
                ['writable policy', { ...oldAttempt.output.check, policy: { ...oldAttempt.output.check.policy, readOnly: false } }],
              ] as const;
              for (const [label, check] of rejects) {
                await db.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [oldAttempt.id, JSON.stringify({ ...oldAttempt.output, check })]);
                try {
                  const response = await post();
                  assert.equal(response.status, 409, label);
                  assert.deepEqual(await snapshot(), before, `${label} must roll back without recording an answer or command`);
                } finally { await db.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [oldAttempt.id, JSON.stringify(oldAttempt.output)]); }
              }
              const otherWorkspaceId = randomUUID(), otherBotId = randomUUID();
              await db.query(`INSERT INTO mikka_workspaces(id,"userId",name,slug) VALUES($1,'owner','Another owned workspace',$2)`, [otherWorkspaceId, otherWorkspaceId]);
              await db.query(`INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,'owner','Other scope')`, [otherBotId, otherWorkspaceId]);
              await assert.rejects(db.query('UPDATE agent_runs SET "botId"=$2 WHERE id=$1', [running.runId, otherBotId]),
                { code: '23514', message: 'taskWorkspaceMismatch' }, 'same owner cannot bind the runtime to another workspace');
              assert.equal((await db.query('SELECT "botId" FROM agent_runs WHERE id=$1', [running.runId])).rows[0].botId, origin.botId);
              assert.deepEqual(await snapshot(), before, 'a rejected runtime transfer records no answer or command');
              await db.query("UPDATE factory_tasks SET status='running' WHERE id=$1", [running.task.id]);
              try { assert.equal((await post()).status, 409, 'not a waiting question'); }
              finally { await db.query("UPDATE factory_tasks SET status='waiting' WHERE id=$1", [running.task.id]); }
            }
            const response = await post();
            assert.equal(response.status, 200, JSON.stringify(response.body));
            const resumed = response.body as { continuationRunId: string; replayed: boolean };
            const after = await snapshot();
            assert.equal(after.command, before.command);
            assert.deepEqual(after.settings, before.settings, 'even a multiline Owner explanation never becomes repository settings');
            assert.deepEqual(after.question.request, before.question.request);
            assert.equal(after.question.originRunId, running.runId);
            assert.equal(after.question.originSessionId, sessionId);
            assert.equal(after.task.candidateId, before.task.candidateId);
            assert.equal(after.task.stage, phase);
            const child = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [resumed.continuationRunId])).rows[0];
            assert.equal(child.agentDefinition.definitionDigest, origin.agentDefinition.definitionDigest);
            assert.equal(child.questionContinuation.originSessionId, sessionId);
            assert.equal(child.questionContinuation.requireSessionResume, true);
            assert.deepEqual((await db.query('SELECT report FROM agent_runs WHERE id=$1', [running.runId])).rows[0].report, report);
            const replay = await post();
            assert.equal(replay.status, 200);
            assert.equal((replay.body as typeof resumed).continuationRunId, resumed.continuationRunId);
            assert.equal((replay.body as typeof resumed).replayed, true);
            assert.deepEqual(await snapshot(), after, 'same answer replay does not make a second run or update settings');
            const tx = await db.connect();
            try {
              await tx.query('BEGIN');
              const extras = await claim(tx, 'owner', deviceId, resumed.continuationRunId, new Date(Date.now()+60_000).toISOString());
              assert.equal(extras.requireSessionResume, true);
              assert.equal(extras.resumeSessionId, sessionId);
              assert.equal(extras.verifyCommand, undefined);
              assert.deepEqual(extras.factoryCheck, { stage: phase, inferCommand: false, reportOnly: true });
              await tx.query('ROLLBACK');
            } finally { await tx.query('ROLLBACK'); tx.release(); }
            await terminal(resumed.continuationRunId, sessionId);
            await reconcile('owner');
            assert.equal((await questions.read('owner', questionId)).status, 'resolved');
            const completed = await state(running.task.id);
            assert.equal(completed.task.candidateId, before.task.candidateId);
            assert.equal(completed.attempts.find(a => a.runId === running.runId)!.status, 'waiting', 'old waiting attempt is not rewritten as passed');
            assert.equal(completed.task.stage, phase === 'review' ? 'verify' : 'approval');
          });

      for (const phase of ["review", "verify"] as const)
        for (const failed of [false, true])
          await t.test(
            `${phase} trusted same-session human question resumes and ${failed ? "retains failure for the model recovery choice" : "advances"}`,
            async () => {
              const r = await pendingReview();
              let d = await start(r.task);
              if (phase === "verify") {
                await terminal(d.runId, `review-${r.task.id}`);
                await reconcile("owner");
                d = await start((await state(r.task.id)).task);
              }
              const missingCommand = phase === "verify" && !failed;
              if (missingCommand) {
                await db.query('UPDATE device_repos SET "verifyCommand"=NULL WHERE id=$1',[repoId]);
                await db.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{check,command}','null'::jsonb) || jsonb_build_object('check',(output->'check') || '{"command":null,"inferCommand":true}'::jsonb) WHERE id=$1`,[d.task.attemptId]);
              }
              const session = `question-${r.task.id}`,
                questionId = randomUUID();
              await db.query(
                `UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,report=$3 WHERE id=$1`,
                [
                  d.runId,
                  session,
                  JSON.stringify({
                    question: {
                      questionId,
                      kind: "decision",
                      ...(missingCommand ? { purpose: "verification_command" } : {}),
                      question: missingCommand ? "Reply with the exact verification command only." : "Which acceptance path?",
                      options: ["A", "B"],
                    },
                  }),
                ],
              );
              const q = await questions.record("owner", d.runId),
                browserSessionId = randomUUID();
              // The real human-answer guard requires its persisted, unexpired session.
              // This row/token is confined to this disposable test database, not OAuth.
              await db.query(
                `INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,'owner',$2,now()+interval '1 hour',now(),now())`,
                [browserSessionId, randomUUID()],
              );
              const server = createServer(async (req, res) => {
                try {
                  let body = "";
                  for await (const chunk of req) body += chunk;
                  const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
                  const result = await handleFactoryQuestion(questions, {
                    actor: { userId: "owner", sessionId: browserSessionId },
                    authorization: null,
                    method: req.method!,
                    questionId: q.id,
                    origin: req.headers.origin ?? null,
                    url: origin,
                    body: JSON.parse(body),
                  });
                  res.writeHead(result.status, {
                    "content-type": "application/json",
                  });
                  res.end(JSON.stringify(result.body));
                } catch (error) {
                  res.writeHead(500);
                  res.end(String(error));
                }
              });
              server.listen(0, "127.0.0.1");
              await once(server, "listening");
              let resumed: any;
              try {
                const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
                const response = await fetch(origin, {
                  method: "POST",
                  headers: { origin, "content-type": "application/json" },
                  body: JSON.stringify({
                    reference: questionReference(q),
                    answerId: randomUUID(),
                    text: missingCommand ? command : "A",
                  }),
                });
                const result = await response.json();
                assert.equal(response.status, 200, JSON.stringify(result));
                resumed = result;
                if (missingCommand) assert.equal((await db.query('SELECT "verifyCommand" FROM device_repos WHERE id=$1',[repoId])).rows[0].verifyCommand,command);
              } finally {
                server.close();
                await once(server, "close");
              }
              const tx = await db.connect();
              try {
                await tx.query("BEGIN");
                const extras = await claim(
                  tx,
                  "owner",
                  deviceId,
                  resumed.continuationRunId,
                  new Date(Date.now() + 60000).toISOString(),
                );
                assert.equal(extras.requireSessionResume, true);
                assert.equal(extras.resumeSessionId, session);
                assert.equal(extras.verifyCommand, command);
                assert.equal(Object.hasOwn(extras, 'factoryExecuteKind'), false);
                await tx.query("ROLLBACK");
              } finally {
                await tx.query("ROLLBACK");
                tx.release();
              }
              await terminal(resumed.continuationRunId, session, failed);
              if (phase === "verify")
                await toolChunks(resumed.continuationRunId, failed);
              await reconcile("owner");
              const result = await state(r.task.id);
              assert.equal(
                result.attempts.find((a) => a.runId === d.runId)!.status,
                "waiting",
              );
              if (failed) {
                assert.equal(result.task.stage, phase);
                assert.equal(result.task.status, "failed");
                const selected = await recover(
                  "owner",
                  {
                    binding: factoryBinding(result.task),
                    choice: "repair_code",
                    rationale:
                      "Synthetic model decision based on original failed command evidence",
                  },
                  undefined,
                );
                assert.equal(selected.task.stage, "execute");
                assert.equal(selected.task.status, "pending");
                assert.equal(selected.task.candidateId, null);
                const failedAttempt = result.attempts.find(
                  (a) => a.runId === resumed.continuationRunId,
                )!;
                assert.equal(failedAttempt.status, "failed");
                assert.equal(
                  (failedAttempt.output.completion as any).verify.exitCode,
                  17,
                );
                const repair = await start(selected.task);
                const {
                  rows: [run],
                } = await db.query(
                  'SELECT prompt,"agentDefinition" FROM agent_runs WHERE id=$1',
                  [repair.runId],
                );
                assert.match(run.prompt, new RegExp(failedAttempt.id));
                assert.match(run.prompt, /ACTUAL_FIXTURE_EXIT_17/);
                assert.ok(run.agentDefinition.promptDigest);
              } else
                assert.equal(
                  result.task.stage,
                  phase === "review" ? "verify" : "approval",
                );
            },
          );
      await t.test(
        "unadopted retry, cancel and access loss reject before claim and token callback",
        async () => {
          for (const mode of ["retry", "cancel", "access"] as const) {
            const r = await pendingReview(),
              d = await start(r.task);
            let id = d.runId;
            if (mode === "retry") {
              id = randomUUID();
              await db.query(
                `INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId",status,"retryOf") VALUES ($1,'owner',$2,$3,$4,'queued',$5)`,
                [id, r.task.issueId, agentId, deviceId, d.runId],
              );
            }
            if (mode === "cancel")
              await store.apply("owner", d.binding, randomUUID(), {
                action: "cancel",
                reason: "Cancel fixture",
              });
            if (mode === "access")
              await db.query('UPDATE issues SET "userId"=$2 WHERE id=$1', [
                r.task.issueId,
                "other",
              ]);
            let tokens = 0;
            const result = await claimLocalRun(
              db,
              id,
              deviceId,
              new Date(Date.now() + 60000),
              undefined,
              async (tx) => {
                try {
                  await claim(
                    tx,
                    "owner",
                    deviceId,
                    id,
                    new Date(Date.now() + 60000).toISOString(),
                  );
                  return true;
                } catch (error) {
                  if (error instanceof FactoryError) return false;
                  throw error;
                }
              },
              async () => {
                tokens++;
              },
            );
            assert.equal(result, "unavailable");
            assert.equal(tokens, 0);
          }
        },
      );
      await t.test(
        "repair bound retains original failed attempt without dispatching another executor",
        async () => {
          const r = await pendingReview(),
            d = await start(r.task);
          // Additional historical attempts are explicit fixtures; the real consumer counts them.
          for (let n = 2; n <= 4; n++)
            await db.query(
              `INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,reason) VALUES ($1,$2,'execute',$3,$4,'failed','Historical bounded repair fixture')`,
              [randomUUID(), r.task.id, n, n + 1],
            );
          await terminal(d.runId, `bounded-${r.task.id}`, true);
          await reconcile("owner");
          const result = await state(r.task.id);
          assert.equal(result.task.stage, "review");
          assert.equal(result.task.status, "failed");
          await assert.rejects(
            recover(
              "owner",
              {
                binding: factoryBinding(result.task),
                choice: "repair_code",
                rationale: "Synthetic model-selected repair",
              },
              undefined,
            ),
            (e) =>
              e instanceof FactoryError &&
              e.code === "factoryRecoveryBudgetExceeded",
          );
          assert.equal(
            result.attempts.filter((a) => a.stage === "execute").length,
            4,
          );
          assert.equal(
            (
              result.attempts.find((a) => a.runId === d.runId)!.output
                .completion as any
            ).verify.exitCode,
            17,
          );
        },
      );
      await t.test(
        "model-selected transient retry keeps SHA, immutable failure, fresh run/session and idempotent receipt",
        async () => {
          const r = await pendingReview(),
            d = await start(r.task);
          await terminal(d.runId, `failed-${r.task.id}`, true);
          await reconcile("owner");
          const failed = await state(r.task.id),
            original = failed.attempts.find((a) => a.runId === d.runId)!;
          assert.equal(failed.task.stage, "review");
          assert.equal(failed.task.status, "failed");
          const input = {
            binding: factoryBinding(failed.task),
            choice: "retry_check",
            rationale:
              "Synthetic model judges retry appropriate from original persisted evidence",
          };
          nullModel = true;
          assert.equal(
            (
              (await recoverRaw("owner", { binding: input.binding })) as {
                pending: boolean;
              }
            ).pending,
            true,
          );
          nullModel = false;
          await assert.rejects(
            recoverRaw("owner", {
              ...input,
              vision: "verified",
              permissions: "allow",
            }),
            (e) => e instanceof FactoryError && e.code === "factoryInvalid",
          );
          const judge = undefined,
            retry = await recover("owner", input, judge);
          assert.equal(retry.task.stage, "review");
          assert.equal(retry.task.candidateId, failed.task.candidateId);
          assert.deepEqual(
            retry.attempts.find((a) => a.id === original.id),
            original,
          );
          assert.deepEqual(await recover("owner", input, judge), retry);
          await assert.rejects(
            recoverRaw("owner", { ...input, choice: "repair_code" }),
            (e) => e instanceof FactoryError && e.code === "factoryInvalid",
          );
          const next = await start(retry.task);
          assert.notEqual(next.runId, d.runId);
          assert.equal(
            (
              await db.query(
                'SELECT "baseBranch" FROM agent_runs WHERE id=$1',
                [next.runId],
              )
            ).rows[0].baseBranch,
            sha,
          );
          await terminal(next.runId, `fresh-retry-${r.task.id}`);
          await reconcile("owner");
          const final = await state(r.task.id);
          assert.equal(final.task.stage, "verify");
          assert.equal(final.task.candidateId, failed.task.candidateId);
          assert.deepEqual(
            final.attempts.find((a) => a.id === original.id),
            original,
          );
        },
      );
      await t.test(
        "model recovery preserves cancellation, ownership and shared retry budget fences",
        async () => {
          const r = await pendingReview();
          let d = await start(r.task);
          for (let n = 0; n < 3; n++) {
            await terminal(d.runId, `budget-${r.task.id}-${n}`, true);
            await reconcile("owner");
            const failed = await state(r.task.id);
            const next = await recover(
              "owner",
              {
                binding: factoryBinding(failed.task),
                choice: "retry_check",
                rationale: "Explicit synthetic model retry choice",
              },
              undefined,
            );
            d = await start(next.task);
          }
          await terminal(d.runId, `budget-final-${r.task.id}`, true);
          await reconcile("owner");
          const failed = await state(r.task.id),
            input = {
              binding: factoryBinding(failed.task),
              choice: "retry_check",
              rationale: "Another model choice",
            };
          await assert.rejects(
            recover("owner", input, undefined),
            (e) =>
              e instanceof FactoryError &&
              e.code === "factoryRecoveryBudgetExceeded",
          );
          await assert.rejects(
            recover("other", input, undefined),
            (e) => e instanceof FactoryError && e.code === "factoryNotFound",
          );
          await store.apply(
            "owner",
            factoryBinding(failed.task),
            randomUUID(),
            { action: "cancel", reason: "Cancelled before recovery" },
          );
          await assert.rejects(
            recover("owner", input, undefined),
            (e) => e instanceof FactoryError && e.code === "factoryStopped",
          );
        },
      );
      for (const choice of ["retry_check", "repair_code"] as const)
        await t.test(
          `a recorded timeout stays blocked until the model chooses ${choice}`,
          async () => {
            const r = await pendingReview(),
              d = await start(r.task);
            await terminal(d.runId, `timeout-${r.task.id}`, true, (report) => {
              report.verify.exitCode = null;
              report.verify.signal = "SIGTERM";
              report.verify.timedOut = true;
            });
            await db.query(
              'UPDATE agent_runs SET "stopReason"=$2 WHERE id=$1',
              [d.runId, "timeout"],
            );
            await reconcile("owner");
            const blocked = await state(r.task.id);
            assert.equal(blocked.task.status, "blocked");
            assert.equal(blocked.task.stage, "review");
            const next = await recover(
              "owner",
              {
                binding: factoryBinding(blocked.task),
                choice,
                rationale:
                  "Synthetic model assesses the same timeout evidence and selects recovery",
              },
              undefined,
            );
            assert.equal(
              next.task.candidateId,
              choice === "retry_check" ? blocked.task.candidateId : null,
            );
            assert.equal(
              next.task.stage,
              choice === "retry_check" ? "review" : "execute",
            );
            assert.equal(next.task.status, "pending");
            const selectedRun = await start(next.task);
            assert.ok(selectedRun.runId);
          },
        );
      await t.test(
        "model-selected repair forwards a redacted excerpt and keeps the immutable original receipt",
        async () => {
          const r = await pendingReview(),
            d = await start(r.task);
          await terminal(d.runId, `redaction-${r.task.id}`, true, (report) => {
            report.verify.output =
              "ACTUAL_FIXTURE_EXIT_17 token=synthetic-private-fixture";
          });
          await reconcile("owner");
          const failed = await state(r.task.id),
            original = failed.attempts.find((a) => a.runId === d.runId)!;
          const selected = await recover(
            "owner",
            {
              binding: factoryBinding(failed.task),
              choice: "repair_code",
              rationale: "Synthetic model-selected source work",
            },
            undefined,
          );
          const repair = await start(selected.task),
            {
              rows: [run],
            } = await db.query("SELECT prompt FROM agent_runs WHERE id=$1", [
              repair.runId,
            ]);
          assert.match(run.prompt, /\[REDACTED\]/);
          assert.doesNotMatch(run.prompt, /synthetic-private-fixture/);
          assert.match(run.prompt, /ACTUAL_FIXTURE_EXIT_17/);
          assert.deepEqual(
            (await state(r.task.id)).attempts.find((a) => a.id === original.id),
            original,
          );
          const repairedRun = (await db.query('SELECT "continuesRunId" FROM agent_runs WHERE id=$1', [repair.runId])).rows[0];
          assert.equal(repairedRun.continuesRunId, failed.candidates.find(c => c.id === failed.task.candidateId)!.runId);
          await terminal(repair.runId, `model-repair-${r.task.id}`, false, report => { report.publish = { commit: sha }; report.sourceCommit = sha; });
          await addFactoryVisualEvidence(db,repair.runId);
          await reconcile.run('owner', repair.runId);
          const next = (await state(r.task.id)).task;
          assert.equal(next.stage, 'review');
          assert.equal(next.status, 'pending');
          assert.notEqual(next.candidateId, failed.task.candidateId);
          assert.ok((await start(next)).runId, 'ordinary model-selected repair still reaches the next independent check');
        },
      );

      // Use the real automatic consumer, store transition, dispatcher and
      // definition freeze. Provider-facing role selection and the local queue are fixtures.
      const originalRepairRequest = 'Only acceptance.txt: exact UTF-8 "mikka-production-20261101-847\\n\\n", 31 bytes. Keep all standing constraints.';
      const failedRepairClaim = 'Expected "mikka-production-acceptance-20261101-847\\n\\n", 42 bytes; actual file is 31 bytes.';
      let queuedRepairPrompt = originalRepairRequest;
      let lastQueueSelection: Record<string, unknown> | undefined;
      const queueModule = t.mock.module(new URL("../agent-runs.ts", import.meta.url).href, { namedExports: {
        queueFactoryRun: async (...args: Parameters<FactoryQueue>) => {
          lastQueueSelection = (args as unknown[])[6] as Record<string, unknown> | undefined;
          const queued = await queue(...args);
          await args[0].query('UPDATE agent_runs SET prompt=$2,"promptTaskStart"=0,"promptTaskLength"=char_length($2) WHERE id=$1', [queued.runId, queuedRepairPrompt]);
          return queued;
        },
      } });
      try {
        const { automaticFactoryDispatch } = await import("./automatic-dispatch");
        await t.test('approved spec starts a fresh executor role without planner read-only or continuation grants', async () => {
          const issueId=randomUUID(),sourceEventId=randomUUID(),specRepoId=randomUUID();
          await db.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState",scope) VALUES($1,'owner','Approved specification','{"type":"doc","content":[]}','todo','normal',$2,'bound','workspace')`,[issueId,billingWorkspaceId]);
          await db.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1::uuid,'owner',$2,'user_message',$1::uuid::text,'{"text":"Plan before implementation"}')`,[sourceEventId,coordinatorBot]);
          await db.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES($1,$2,'owner','v2/github.com/example/spec','https://github.com/example/spec.git')`,[specRepoId,deviceId]);
          const routed=await store.route('owner',{issueId,sourceEventId,eventId:randomUUID(),rationale:'Plan first',missingInformation:[],missingPermissions:[],needsSpec:true});
          const spec=await createFactoryDispatch(db,store,queue,defaultFactoryDispatchAdapters)('owner',{binding:factoryBinding(routed.task),agentId,deviceRepoId:specRepoId});
          await db.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='planner-fixture',"startedAt"=now()-interval '1 second',"finishedAt"=now(),report=$2,
            "agentDefinition"="agentDefinition" || '{"readOnly":true,"model":"planner-only"}'::jsonb WHERE id=$1`,[spec.runId,JSON.stringify({summary:'Approved plan',filesChanged:[],verify:{status:'not_run'},openQuestions:[],nextStep:null})]);
          await reconcile.run('owner',spec.runId);
          const planned=await store.read('owner',routed.task.id);
          let selections=0;
          const profileModule=t.mock.module(new URL('./agent-profile.ts',import.meta.url).href,{namedExports:{
            resolveAgentProfileDispatch:async (_pool:unknown,_scope:unknown,request:{stage:string})=>{
              selections++;assert.equal(request.stage,'execute');
              return {target:{kind:'device',agentId,deviceId,model:'fixture-executor',entry:{id:'fixture-role',harness:'codex',model:'fixture-executor',source:{kind:'api_key',keyId:randomUUID()}}}};
            },
          }});
          const fixtureWorkspace=(await import('drizzle-orm/node-postgres')).drizzle(db,{schema:await import('../db/workspace-schema')});
          const workspaceTransaction=t.mock.method((await import('../workspace-db')).workspaceDb,'transaction',fixtureWorkspace.transaction.bind(fixtureWorkspace));
          const workspaceSelect=t.mock.method((await import('../workspace-db')).workspaceDb,'select',fixtureWorkspace.select.bind(fixtureWorkspace));
          try {
            await modelDatabase!.run(()=>createFactorySpecApproval(db,store,automaticFactoryDispatch(db))({userId:'owner',sessionId:'fixture-browser'},{binding:{taskId:planned.task.id,revision:planned.task.revision},eventId:randomUUID()}));
          } finally {workspaceSelect.mock.restore();workspaceTransaction.mock.restore();profileModule.restore();}
          assert.equal(selections,1);
          assert.equal(lastQueueSelection?.model,'fixture-executor');
          assert.equal(lastQueueSelection?.readOnly,false);
          assert.equal(lastQueueSelection?.threadRunId,undefined);
          const current=await store.read('owner',planned.task.id);
          assert.equal(current.task.stage,'execute');assert.equal(current.task.status,'running');
          const runId=current.attempts.find(attempt=>attempt.id===current.task.attemptId)!.runId;
          const run=(await db.query('SELECT "continuesRunId",prompt,"promptTaskStart" FROM agent_runs WHERE id=$1',[runId])).rows[0];
          assert.equal(run.continuesRunId,null);
          assert.match(run.prompt,/Factory implementation owns validation/);
          // The thread’s task range moved past the prepended Factory guidance (lib/thread-prompt.ts).
          assert.ok(Array.from(run.prompt as string).slice(run.promptTaskStart).join('').startsWith(queuedRepairPrompt));
        });
        await t.test('saved Owner answer survives automatic repair and the new candidate checks through canonical same-epoch ancestry', async () => {
          const pending = await pendingReview();
          const candidate = pending.candidates.find(c => c.id === pending.task.candidateId)!;
          const producerAttempt = pending.attempts.find(a => a.runId === candidate.runId)!;
          const originId = randomUUID(), originAttemptId = randomUUID(), questionId = randomUUID(), questionEventId = randomUUID(), answerId = randomUUID();
          const originalTarget = 'Original issue target: exactly 56 bytes.';
          const expectedHash = createHash('sha256').update('x'.repeat(84) + '\n').digest('hex');
          const ownerText = `The answered target is exactly 85 bytes, SHA256 ${expectedHash}. Keep all other requirements. token=fixture-private`;
          const nativeSession = `execute-${pending.task.issueId}`;
          await db.query('UPDATE factory_attempts SET position=3 WHERE id=$1', [pending.task.attemptId]);
          await db.query(`UPDATE factory_attempts SET position=2,ordinal=2,output=output-'requestEpoch' WHERE id=$1`, [producerAttempt.id]);
          await db.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,"stopReason","sessionId","agentDefinition",prompt)
            SELECT $2,"userId","issueId","agentId","deviceId","deviceRepoId","botId",'stopped','asked_human',"sessionId","agentDefinition",'Original owner task' FROM agent_runs WHERE id=$1`, [candidate.runId, originId]);
          await db.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId","sessionId",reason)
            VALUES($1,$2,'execute',1,1,'waiting',$3,$4,'Owner answer required')`, [originAttemptId, pending.task.id, originId, nativeSession]);
          await db.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1::uuid,'owner',$2,'run_question',$1::text,'{}')`, [questionEventId, coordinatorBot]);
          const waiting = { taskId: pending.task.id, issueId: pending.task.issueId, attemptId: originAttemptId, candidateId: null, revision: 2 };
          const input = humanQuestionAnswerSchema.parse({ answerId, text: ownerText, reference: { questionId, questionRevision: 1, binding: waiting, originRunId: originId, originSessionId: nativeSession } });
          const answer = { source: 'human', userId: 'owner', input };
          await db.query(`INSERT INTO factory_questions(id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,context,request,status,revision,reason,"sourceEventId","answerId","answerSource",answer,"answerFingerprint","answeredAt","continuationRunId",result)
            VALUES($1,'owner',$2,$3,$4,'execute',$5,$6,1,$7,'external','Which target?','UNRELATED PRIVATE RFI CONTEXT','{}','resolved',3,'Answered',$8,$9,'human',$10,$11,now(),$12,$13)`,
            [questionId, pending.task.issueId, pending.task.id, originAttemptId, originId, nativeSession, JSON.stringify(waiting), questionEventId, answerId, JSON.stringify(answer), questionFingerprint(answer), candidate.runId, JSON.stringify({ continuationRunId: randomUUID() })]);
          await db.query('UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1', [candidate.runId, JSON.stringify({ questionId, originRunId: originId, originSessionId: nativeSession, requireSessionResume: true })]);
          const originalHistory = async () => (await db.query(`SELECT jsonb_build_object(
            'producer',(SELECT to_jsonb(r) FROM agent_runs r WHERE id=$1),
            'attempt',(SELECT to_jsonb(a) FROM factory_attempts a WHERE id=$2),
            'question',(SELECT to_jsonb(q) FROM factory_questions q WHERE id=$3)) AS value`, [candidate.runId, producerAttempt.id, questionId])).rows[0].value;
          const before = await originalHistory();
          const check = await start(pending.task);
          await terminal(check.runId, `failed-owner-answer-${pending.task.id}`, false, report => {
            report.criteria = [{ text: 'Expected 56 bytes; observed 85 bytes.', passed: false, evidence: 'Synthetic mismatched old target, not a new Owner instruction' }];
          });
          await toolChunks(check.runId);
          await reconcile.run('owner', check.runId);
          const failed = await state(pending.task.id);
          assert.equal(failed.task.status, 'failed');
          const failedAttempt = failed.attempts.find(a => a.id === failed.task.attemptId)!;
          const failedRun = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [check.runId])).rows[0];
          const finishId = factoryEventId('check-completion', check.runId);
          assert.equal((await db.query('SELECT result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [pending.task.id, finishId])).rows[0].result.task.status, 'failed');
          queuedRepairPrompt = originalTarget;
          const tx = await db.connect();
          try {
            await tx.query('BEGIN');
            const afterCommit = await automaticFactoryDispatch(db)(tx, store, failed.task, failedRun);
            assert.equal(typeof afterCommit, 'function');
            await tx.query('COMMIT');
          } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release(); queuedRepairPrompt = originalRepairRequest; }
          const repairing = await state(pending.task.id);
          assert.equal(repairing.task.candidateId, null, 'the normal repair transition clears the current candidate');
          const repairReceipt = (await db.query('SELECT request FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',
            [pending.task.id, factoryEventId('check-repair', failedAttempt.id)])).rows[0];
          assert.deepEqual(Object.keys(repairReceipt.request.binding).sort(), ['revision', 'taskId'], 'real lifecycle receipts omit legacy display binding fields');
          const repairAttempt = repairing.attempts.find(a => a.id === repairing.task.attemptId)!;
          const repairRun = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [repairAttempt.runId])).rows[0];
          const assertAnswer = (prompt: string) => {
            assert.match(prompt, /Saved Owner answer consumed by the earlier native execution and inherited through verified repair/);
            assert.ok(prompt.includes(`exactly 85 bytes, SHA256 ${expectedHash}`));
            assert.match(prompt, /supersedes conflicting original issue wording/);
            assert.doesNotMatch(prompt, /fixture-private|UNRELATED PRIVATE RFI CONTEXT/);
          };
          assertAnswer(repairRun.prompt);
          assert.ok(repairRun.prompt.indexOf('exactly 85 bytes') < repairRun.prompt.indexOf(originalTarget));
          assert.ok(repairRun.prompt.includes('Expected 56 bytes; observed 85 bytes.'), 'the incorrect finding remains failure evidence, not the target');
          assert.equal(repairRun.continuesRunId, candidate.runId);
          assert.equal(repairRun.questionContinuation, null, 'a new repair session does not impersonate the original native answer consumer');
          assert.equal(repairRun.agentDefinition.promptDigest, (await import('../agent-kit/definition')).digest(repairRun.prompt));
          await terminal(repairRun.id, `new-repair-session-${pending.task.id}`, false, report => { report.publish = { commit: sha }; report.sourceCommit = sha; });
          await addFactoryVisualEvidence(db,repairRun.id);
          await reconcile.run('owner', repairRun.id);
          const repaired = await state(pending.task.id);
          await addFactoryPublicationEvidence(db,repaired.task.id);
          assert.equal(repaired.task.stage, 'review');
          assert.equal(repaired.task.status, 'pending');
          assert.notEqual(repaired.task.candidateId, candidate.id);
          assert.equal(repaired.candidates.find(c => c.id === repaired.task.candidateId)!.runId, repairRun.id);
          for (const [label, sql, args] of [
            ['missing continuation', 'UPDATE agent_runs SET "continuesRunId"=NULL WHERE id=$1', [repairRun.id]],
            ['non-adjacent repair', 'UPDATE factory_attempts SET position=position+20 WHERE id=$1', [repairAttempt.id]],
            ['different failed candidate', 'UPDATE factory_attempts SET "candidateId"=$2 WHERE id=$1', [failedAttempt.id, repaired.task.candidateId]],
            ['old failed epoch', `UPDATE factory_attempts SET output=jsonb_set(output,'{requestEpoch}',to_jsonb($2::text)) WHERE id=$1`, [failedAttempt.id, randomUUID()]],
            ['missing repair receipt', 'DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [pending.task.id, factoryEventId('check-repair', failedAttempt.id)]],
            ['corrupt repair result', `UPDATE factory_events SET result=jsonb_set(result,'{task}','{}') WHERE "taskId"=$1 AND "eventId"=$2`, [pending.task.id, factoryEventId('check-repair', failedAttempt.id)]],
            ['wrong repair revision', `UPDATE factory_events SET request=jsonb_set(request,'{binding,revision}','999999') WHERE "taskId"=$1 AND "eventId"=$2`, [pending.task.id, factoryEventId('check-repair', failedAttempt.id)]],
            ['changed failed status', `UPDATE factory_attempts SET status='passed' WHERE id=$1`, [failedAttempt.id]],
            ['missing canonical finish', 'DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [pending.task.id, finishId]],
            ['corrupt canonical attempts', `UPDATE factory_events SET result=jsonb_set(result,'{attempts}','{}') WHERE "taskId"=$1 AND "eventId"=$2`, [pending.task.id, finishId]],
            ['invalid original answer', 'UPDATE factory_questions SET "answerFingerprint"=$2 WHERE id=$1', [questionId, 'wrong-fingerprint']],
            ['foreign original owner', 'UPDATE factory_questions SET "userId"=$2 WHERE id=$1', [questionId, 'other']],
            ['broken new native link', 'UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1', [repairRun.id, JSON.stringify({ questionId: randomUUID(), originRunId: originId, originSessionId: nativeSession, requireSessionResume: true })]],
          ] as const) {
            const guard = await db.connect();
            try {
              await guard.query('BEGIN');
              await guard.query(sql, [...args]);
              await assert.rejects(currentFactoryRequest(guard, repaired.task), (error: unknown) => error instanceof FactoryError && error.code === 'factorySourceMismatch', label);
            } finally { await guard.query('ROLLBACK'); guard.release(); }
          }
          for (const stage of ['review', 'verify'] as const) {
            const current = (await state(pending.task.id)).task;
            assert.equal(current.stage, stage);
            const independent = await start(current);
            const run = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [independent.runId])).rows[0];
            assertAnswer(run.prompt);
            assert.equal(run.agentDefinition.promptDigest, (await import('../agent-kit/definition')).digest(run.prompt));
            await terminal(run.id, `after-repair-${stage}-${pending.task.id}`, false, report => { report.verify = { status: 'not_run' }; });
            await reconcile.run('owner', run.id);
          }
          assert.equal((await state(pending.task.id)).task.stage, 'approval');
          assert.deepEqual(await originalHistory(), before, 'the native producer, original execute attempt and saved Owner answer are immutable');
          assert.deepEqual((await state(pending.task.id)).attempts.find(a => a.id === failedAttempt.id), failedAttempt);
          assert.deepEqual((await db.query('SELECT * FROM agent_runs WHERE id=$1', [check.runId])).rows[0], failedRun);
        });
        for (const stage of ["review", "verify"] as const) await t.test(
          `automatic ${stage} repair keeps original criteria separate from false findings and preserves immutable history`,
          async () => {
            let pending = await pendingReview();
            if (stage === "verify") {
              const review = await start(pending.task);
              await terminal(review.runId, `before-verify-${pending.task.id}`);
              await reconcile("owner");
              pending = await state(pending.task.id);
            }
            const check = await start(pending.task);
            await terminal(check.runId, `false-finding-${pending.task.id}`, false, report => {
              report.criteria = [{ text: failedRepairClaim, passed: false, evidence: 'Observed 31 bytes; token=synthetic-private-finding' }];
            });
            await toolChunks(check.runId);
            await reconcile("owner");
            const failed = await state(pending.task.id);
            assert.equal(failed.task.status, "failed");
            const failedAttempt = failed.attempts.find(a => a.id === failed.task.attemptId)!;
            assert.equal((failedAttempt.output.completion as { trustedFailureProvenance: boolean }).trustedFailureProvenance, true);
            const { rows: [oldRun] } = await db.query('SELECT * FROM agent_runs WHERE id=$1', [check.runId]);
            const oldChunks = (await db.query('SELECT * FROM run_chunks WHERE "runId"=$1 ORDER BY seq', [check.runId])).rows;
            const oldCandidate = (await db.query('SELECT * FROM factory_candidates WHERE id=$1', [failed.task.candidateId])).rows;
            const callsBefore = modelCalls;
            const tx = await db.connect();
            try {
              await tx.query("BEGIN");
              const afterCommit = await automaticFactoryDispatch(db)(tx, store, failed.task, oldRun);
              assert.equal(typeof afterCommit, 'function', 'the local device wake remains deferred until the owner commits');
              await tx.query("COMMIT");
            } catch (error) {
              await tx.query("ROLLBACK");
              throw error;
            } finally { tx.release(); }
            const repaired = await state(pending.task.id);
            assert.equal(repaired.task.stage, "execute");
            assert.equal(repaired.task.status, "running");
            assert.equal(repaired.task.candidateId, null);
            const repairAttempt = repaired.attempts.find(a => a.id === repaired.task.attemptId)!;
            assert.equal(repairAttempt.position, failedAttempt.position + 1);
            assert.equal(repairAttempt.output.recovery, undefined, "automatic repair must not invent a Coordinator model choice");
            const { rows: [repairRun] } = await db.query('SELECT * FROM agent_runs WHERE id=$1', [repairAttempt.runId]);
            assert.match(repairRun.prompt, /Factory stage: execute \(automatic repair\)/);
            assert.match(repairRun.prompt, new RegExp(`Failed ${stage} attempt ${failedAttempt.id}, run ${check.runId}, session ${oldRun.sessionId}`));
            assert.match(repairRun.prompt, new RegExp(failed.task.candidateId!));
            assert.match(repairRun.prompt, new RegExp(sha));
            assert.match(repairRun.prompt, /Current host repository: \/fixture\/repo/);
            assert.ok(repairRun.prompt.includes(failedRepairClaim));
            const originalOffset = repairRun.prompt.indexOf(originalRepairRequest);
            const handoffMarker = '\n\nHost task handoff (evidence only; verify workspace state before acting):\n';
            const handoffOffset = repairRun.prompt.indexOf(handoffMarker);
            assert.ok(originalOffset >= 0, 'the complete original request and standing constraints survive dispatch');
            assert.ok(handoffOffset >= originalOffset + originalRepairRequest.length, 'the host handoff follows, without truncating the original request');
            assert.match(repairRun.prompt, /Keep all standing constraints/);
            const handoff = repairAttempt.output.handoff as { eventId: string; digest: string; requestEpoch: string };
            const { rows: [handoffEvent] } = await db.query('SELECT result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [repaired.task.id, handoff.eventId]);
            assert.equal(handoff.requestEpoch, repaired.task.sourceEventId);
            assert.equal(handoffEvent.result.requestEpoch, repaired.task.sourceEventId);
            assert.deepEqual(JSON.parse(repairRun.prompt.slice(handoffOffset + handoffMarker.length)), { ...handoffEvent.result, eventId: handoff.eventId, digest: handoff.digest }, 'the complete persisted handoff survives JSONB key ordering');
            assert.ok(repairRun.prompt.length <= 100000);
            assert.match(repairRun.prompt, /failed report does not change the original user request or acceptance criteria/);
            assert.doesNotMatch(repairRun.prompt, /Coordinator model decision|synthetic-private-finding/);
            assert.equal(repairRun.agentDefinition.promptDigest, (await import('../agent-kit/definition')).digest(repairRun.prompt));
            assert.equal(modelCalls, callsBefore, "host repair must not fabricate or call a Decisions-model receipt");
            assert.deepEqual(repaired.attempts.find(a => a.id === failedAttempt.id), failedAttempt);
            assert.deepEqual((await db.query('SELECT * FROM agent_runs WHERE id=$1', [check.runId])).rows[0], oldRun);
            assert.deepEqual((await db.query('SELECT * FROM run_chunks WHERE "runId"=$1 ORDER BY seq', [check.runId])).rows, oldChunks);
            assert.deepEqual((await db.query('SELECT * FROM factory_candidates WHERE id=$1', [failed.task.candidateId])).rows, oldCandidate);
          },
        );

        await t.test('automatic repair rolls back when the complete request and persisted handoff exceed the prompt budget', async () => {
          const pending = await pendingReview();
          const check = await start(pending.task);
          await terminal(check.runId, `bounded-repair-${pending.task.id}`, true);
          await toolChunks(check.runId);
          await reconcile('owner');
          const failed = await state(pending.task.id);
          assert.equal(failed.task.status, 'failed');
          // The required request fits the repair brief itself. Its recorded host
          // handoff makes the complete dispatched prompt exceed the existing cap.
          await db.query('UPDATE issues SET content=$2 WHERE id=$1', [failed.task.issueId, JSON.stringify({ recordedConstraint: 'h'.repeat(9000) })]);
          const runsBefore = (await db.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [failed.task.issueId])).rows;
          const eventsBefore = (await db.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [failed.task.id])).rows;
          const oldRun = runsBefore.find(r => r.id === check.runId)!;
          queuedRepairPrompt = originalRepairRequest + 'x'.repeat(93000) + '\nFinal standing constraint: never change the exact target.';
          const tx = await db.connect();
          try {
            await tx.query('BEGIN');
            await assert.rejects(automaticFactoryDispatch(db)(tx, store, failed.task, oldRun),
              (error: unknown) => error instanceof FactoryError && error.code === 'factoryCheckBindingMismatch');
            const { rows: [uncommitted] } = await tx.query('SELECT prompt,"agentDefinition" FROM agent_runs WHERE "issueId"=$1 AND NOT(id=ANY($2::uuid[]))', [failed.task.issueId, runsBefore.map(r => r.id)]);
            assert.ok(uncommitted.prompt.endsWith(queuedRepairPrompt), 'failure occurs after complete repair configuration, before handoff truncation or freezing');
            assert.ok(uncommitted.prompt.length <= 100000);
            assert.equal(uncommitted.agentDefinition, null);
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
            queuedRepairPrompt = originalRepairRequest;
          }
          assert.deepEqual(await state(failed.task.id), failed, 'no repair attempt or task change commits');
          assert.deepEqual((await db.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [failed.task.issueId])).rows, runsBefore, 'no truncated or orphan run commits');
          assert.deepEqual((await db.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [failed.task.id])).rows, eventsBefore, 'handoff and dispatch receipts roll back together');
        });

        await t.test('a new authenticated request epoch does not inherit the adjacent old failed check or repository binding', async () => {
          const pending = await pendingReview();
          const check = await start(pending.task);
          await terminal(check.runId, `old-epoch-${pending.task.id}`, true);
          await toolChunks(check.runId);
          await reconcile('owner');
          const failed = await state(pending.task.id);
          assert.equal(failed.task.status, 'failed');
          // Exercise the legacy backfill as well as the explicit epoch fence.
          await db.query(`UPDATE factory_attempts SET output=output-'requestEpoch' WHERE id=$1`, [failed.task.attemptId]);
          await db.query(`UPDATE coordinator_events SET payload=jsonb_set(payload,'{text}',$2::jsonb) WHERE id=$1`, [failed.task.sourceEventId, JSON.stringify('Standing constraint: never change unrelated files.')]);
          const sourceEventId = randomUUID(), nextRepoId = randomUUID();
          const currentRequest = 'Use /fixture/new-repo for this new request, with an exact 44 byte target.';
          await db.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload)
            VALUES($1::uuid,'owner',$2,$3,'user_message',$1::text,$4)`, [sourceEventId, coordinatorBot, failed.task.issueId, JSON.stringify({ source: 'thread_continuation', previousRunId: check.runId, text: currentRequest })]);
          await db.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","verifyCommand") VALUES($1,$2,'owner','/fixture/new-repo',$3)`, [nextRepoId, deviceId, command]);
          const tx = await db.connect();
          let current: FactoryTask;
          try {
            await tx.query('BEGIN');
            current = await (await import('./request-epoch')).advanceFactoryRequest(tx, await store.lockTask(tx, 'owner', failed.task.id), sourceEventId);
            await tx.query('COMMIT');
          } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release(); }
          const oldAttempt = (await state(current.id)).attempts.find(a => a.id === failed.task.attemptId)!;
          assert.equal(oldAttempt.output.requestEpoch, failed.task.sourceEventId);
          const next = await dispatch('owner', { binding: factoryBinding(current), agentId, deviceRepoId: nextRepoId });
          const { rows: [run] } = await db.query('SELECT * FROM agent_runs WHERE id=$1', [next.runId]);
          assert.equal(run.deviceRepoId, nextRepoId);
          assert.ok(run.prompt.includes(currentRequest));
          assert.match(run.prompt, /Standing constraint: never change unrelated files/);
          assert.doesNotMatch(run.prompt, /Factory stage: execute \(automatic repair\)|Fixed candidate of failed check/);
          assert.match(run.prompt, /Host task handoff/);
          assert.equal(run.agentDefinition.promptDigest, (await import('../agent-kit/definition')).digest(run.prompt));
          const finalState = await state(current.id);
          assert.deepEqual(finalState.attempts.find(a => a.id === oldAttempt.id), oldAttempt);
          assert.equal((finalState.attempts.find(a => a.id === current.attemptId)!.output.handoff as { requestEpoch: string }).requestEpoch, sourceEventId);
        });
      } finally { queueModule.restore(); }

      async function failedReview() {
        const r = await pendingReview(),
          d = await start(r.task);
        await terminal(d.runId, "receipt-v2-" + r.task.id, true);
        await reconcile("owner");
        return { snapshot: await state(r.task.id), runId: d.runId };
      }
      for (const mode of [
        "null",
        "refusal",
        "defer",
        "request-digest",
        "image-digest",
        "generation",
        "model",
        "time",
        "vision",
      ] as const)
        await t.test(
          "shared invocation " +
            mode +
            " retains the original observation pending",
          async () => {
            const { snapshot } = await failedReview(),
              input = { binding: factoryBinding(snapshot.task) };
            const initialCalls = modelCalls;
            chosenAction = mode === "defer" ? "defer" : "retry_check";
            nullModel = mode === "null";
            if (mode === "refusal")
              replyAnswers = [{ type: "refusal", name: "recovery" }];
            mutateReceipt = (result) => {
              if (mode === "request-digest")
                result.execution.requestDigest = "0".repeat(64);
              if (mode === "image-digest")
                result.execution.imageDigests = ["0".repeat(64)];
              if (mode === "generation")
                result.execution.providerGenerationId = "";
              if (mode === "model")
                result.execution.modelId = "untrusted" as typeof DECISION_MODEL;
              if (mode === "time")
                result.execution.startedAt = "1970-01-01T00:00:00.000Z";
              if (mode === "vision")
                result.execution.vision =
                  "verified" as typeof result.execution.vision;
            };
            try {
              const outcome = await recoverRaw("owner", input);
              assert.ok("pending" in outcome);
              assert.equal(outcome.pending, true);
              assert.deepEqual(await state(snapshot.task.id), snapshot);
              assert.equal(modelCalls, initialCalls + 1);
            } finally {
              nullModel = false;
              replyAnswers = undefined;
              mutateReceipt = undefined;
            }
          },
        );
      await t.test(
        "zero confidence is retained without a programmed human fallback; replay never reinfers",
        async () => {
          const { snapshot } = await failedReview(),
            input = { binding: factoryBinding(snapshot.task) },
            count = modelCalls;
          chosenAction = "retry_check";
          replyConfidence = 0;
          try {
            const next = await recoverRaw(
              "owner",
              input,
              "actual-test-context",
            );
            assert.ok("task" in next);
            assert.equal(next.task.stage, "review");
            assert.equal(next.task.status, "pending");
            const data = next.attempts.find(
              (a) => a.id === next.task.attemptId,
            )!.output.recovery as any;
            assert.equal(data.answer.confidence, 0);
            assert.equal(data.execution.modelId, DECISION_MODEL);
            assert.equal(data.execution.vision, "no-image-input");
            assert.ok(
              data.execution.providerGenerationId.startsWith(
                "fixture_generation_",
              ),
            );
            assert.equal(data.sdkToolCallId, "actual-test-context");
            const recreated = createFactoryCheckRecovery(db, store, {
              invoke: modelInvoke,
            });
            assert.deepEqual(await recreated("owner", input), next);
            assert.equal(modelCalls, count + 1);
          } finally {
            replyConfidence = undefined;
          }
        },
      );
      await t.test(
        "concurrent request observes a bounded reservation without holding SQL during inference",
        async () => {
          const { snapshot } = await failedReview(),
            input = { binding: factoryBinding(snapshot.task) };
          let release!: () => void, started!: () => void;
          const wait = new Promise<void>((resolve) => {
              release = resolve;
            }),
            ready = new Promise<void>((resolve) => {
              started = resolve;
            });
          chosenAction = "retry_check";
          const count = modelCalls;
          beforeModel = async () => {
            started();
            await wait;
          };
          const first = recoverRaw("owner", input);
          try {
            await ready;
            const second = await recoverRaw("owner", input);
            assert.ok("pending" in second);
            assert.equal(second.reason, "decision_in_progress");
            assert.equal(modelCalls, count + 1);
          } finally {
            release();
            beforeModel = undefined;
          }
          const winner = await first;
          assert.ok("task" in winner);
          assert.equal(winner.task.stage, "review");
          assert.deepEqual(await recoverRaw("owner", input), winner);
          assert.equal(modelCalls, count + 1);
        },
      );
      for (const mode of ["cancel", "revoke-access", "new-binding"] as const)
        await t.test(
          "actual model return cannot apply after " + mode,
          async () => {
            const { snapshot } = await failedReview(),
              input = { binding: factoryBinding(snapshot.task) };
            chosenAction = "retry_check";
            beforeModel = async () => {
              if (mode === "revoke-access")
                await db.query('UPDATE issues SET "userId"=$2 WHERE id=$1', [
                  snapshot.task.issueId,
                  "other",
                ]);
              else
                await store.apply(
                  "owner",
                  input.binding,
                  randomUUID(),
                  mode === "cancel"
                    ? {
                        action: "cancel",
                        reason: "Cancelled during model call",
                      }
                    : {
                        action: "repair",
                        reason: "A concurrent trusted test change",
                      },
                );
            };
            try {
              await assert.rejects(
                recoverRaw("owner", input),
                (e) =>
                  e instanceof FactoryError &&
                  e.code ===
                    (mode === "cancel"
                      ? "factoryStopped"
                      : mode === "revoke-access"
                        ? "factoryNotFound"
                        : "factoryStale"),
              );
            } finally {
              beforeModel = undefined;
            }
            const {
              rows: [row],
            } = await db.query(
              "SELECT stage,status FROM factory_tasks WHERE id=$1",
              [snapshot.task.id],
            );
            assert.equal(
              row.status,
              mode === "cancel"
                ? "cancelled"
                : mode === "new-binding"
                  ? "pending"
                  : "failed",
            );
            assert.equal(
              row.stage,
              mode === "new-binding" ? "execute" : "review",
            );
          },
        );
      const png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      for (const mode of [
        "valid",
        "missing",
        "foreign-session",
        "wrong-sha",
        "future-time",
        "changed-during-call",
      ] as const)
        await t.test(
          "actual shared image request " +
            mode +
            " binds pixels and original provenance",
          async () => {
            const { snapshot, runId } = await failedReview(),
              input = { binding: factoryBinding(snapshot.task) },
              chunkId = randomUUID();
            await db.query(
              'INSERT INTO run_chunks(id,"runId",seq,chunk,"createdAt") SELECT $1,id,99,$3,"finishedAt" FROM agent_runs WHERE id=$2',
              [
                chunkId,
                runId,
                JSON.stringify({
                  type: "file",
                  mediaType: "image/png",
                  url: png,
                }),
              ],
            );
            const collector: NonNullable<
              FactoryCheckRecoveryDependencies["collectImages"]
            > = async (tx, observation) => {
              const {
                rows: [chunk],
              } = await tx.query(
                'SELECT chunk,"createdAt" FROM run_chunks WHERE id=$1 AND "runId"=$2',
                [chunkId, observation.run.id],
              );
              return {
                requiresVisual: true,
                images:
                  mode === "missing"
                    ? []
                    : [
                        {
                          image: { dataUrl: chunk.chunk.url, detail: "high" },
                          artifact: "run-chunk:" + chunkId,
                          runId,
                          sessionId:
                            mode === "foreign-session"
                              ? "foreign"
                              : observation.run.sessionId,
                          candidateId: observation.candidate.id,
                          sha:
                            mode === "wrong-sha"
                              ? "b".repeat(40)
                              : observation.candidate.sha,
                          observedAt:
                            mode === "future-time"
                              ? new Date(Date.now() + 60000).toISOString()
                              : chunk.createdAt.toISOString(),
                        },
                      ],
              };
            };
            const withImages = createFactoryCheckRecovery(db, store, {
              invoke: modelInvoke,
              collectImages: collector,
            });
            const count = modelCalls;
            chosenAction = "retry_check";
            if (mode === "changed-during-call") {
              beforeModel = async () => {
                await db.query("UPDATE run_chunks SET chunk=$2 WHERE id=$1", [
                  chunkId,
                  JSON.stringify({
                    type: "file",
                    mediaType: "image/png",
                    url: png.replace("RZk", "RZl"),
                  }),
                ]);
              };
              try {
                await assert.rejects(
                  withImages("owner", input),
                  (e) => e instanceof FactoryError && e.code === "factoryStale",
                );
              } finally {
                beforeModel = undefined;
              }
              assert.deepEqual(await state(snapshot.task.id), snapshot);
              return;
            }
            const outcome = await withImages("owner", input);
            if (mode === "valid") {
              assert.ok("task" in outcome);
              const receipt = outcome.attempts.find(
                (a) => a.id === outcome.task.attemptId,
              )!.output.recovery as any;
              assert.equal(receipt.execution.vision, "image-input-submitted");
              assert.deepEqual(receipt.execution.imageDigests, [
                createHash("sha256")
                  .update(Buffer.from(png.split(",")[1], "base64"))
                  .digest("hex"),
              ]);
              assert.equal(
                receipt.imageSources[0].artifact,
                "run-chunk:" + chunkId,
              );
              assert.equal(receipt.imageSources[0].sha, sha);
              assert.equal(receipt.imageSources[0].runId, runId);
              assert.equal(
                receipt.sdkToolCallId,
                undefined,
                "REST does not fabricate an SDK ID",
              );
              const request = networkRequests.at(-1) as any;
              assert.equal(
                request.input[0].content.find(
                  (part: any) => part.type === "input_image",
                ).image_url,
                png,
              );
              assert.equal(
                request.input[0].content.find(
                  (part: any) => part.type === "input_image",
                ).detail,
                "high",
              );
              assert.equal(modelCalls, count + 1);
            } else {
              assert.ok("pending" in outcome);
              assert.equal(outcome.reason, "visual_evidence_unavailable");
              assert.equal(modelCalls, count);
              assert.deepEqual(await state(snapshot.task.id), snapshot);
            }
          },
        );
      await t.test("recovery requires a positive real balance and records actual cost without reserving funds",async()=>{
        const {snapshot}=await failedReview(),binding=factoryBinding(snapshot.task);
        const before=networkRequests.length;
        const{rows:[allowance]}=await db.query('SELECT remaining FROM hosted_allowances WHERE "workspaceId"=$1',[billingWorkspaceId]);
        await db.query('UPDATE hosted_allowances SET remaining=0 WHERE "workspaceId"=$1',[billingWorkspaceId]);
        try {
          const blocked=await recoverRaw("owner",{binding});
          assert.ok("pending" in blocked);assert.equal(blocked.reason,"model_unavailable");
          assert.equal(networkRequests.length,before,"exhausted balance must make zero provider requests");
          assert.deepEqual(await state(snapshot.task.id),snapshot);
        } finally {
          await db.query('UPDATE hosted_allowances SET remaining=$2 WHERE "workspaceId"=$1',[billingWorkspaceId,allowance.remaining]);
        }
        const recovered=await recover("owner",{binding,choice:"retry_check"});
        assert.equal(recovered.task.stage,"review");
        assert.equal(networkRequests.length,before+1,"positive balance restores the real loopback request");
        const{rows:[receipt]}=await db.query(`SELECT state,"costMicroUsd","reservedFree","reservedPurchased","reservedUnpaid"
          FROM hosted_usage WHERE "workspaceId"=$1 ORDER BY "createdAt" DESC LIMIT 1`,[billingWorkspaceId]);
        assert.equal(receipt.state,"settled");assert.equal(Number(receipt.costMicroUsd),1);
        assert.deepEqual([receipt.reservedFree,receipt.reservedPurchased,receipt.reservedUnpaid].map(Number),[0,0,0]);
        assert.equal((await usage.balance(billingWorkspaceId)).free,Number(allowance.remaining)-1);
      });
      await modelDatabase!.run(() => exerciseFactoryRecoveryEntry(t, {
        db, botId: coordinatorBot, failedReview, png, sha, modelInvoke,
        callCount: () => modelCalls,
        chooseRetry: () => { chosenAction = "retry_check"; },
        latestRequest: () => networkRequests.at(-1),
      }));
      await t.test(
        "unavailable model calls exhaust only their invocation budget, with no fixed recovery",
        async () => {
          const { snapshot } = await failedReview(),
            input = { binding: factoryBinding(snapshot.task) },
            count = modelCalls;
          nullModel = true;
          try {
            for (let n = 0; n < 4; n++) {
              const result = await recoverRaw("owner", input);
              assert.ok("pending" in result);
            }
            assert.equal(modelCalls, count + 3);
            assert.deepEqual(await state(snapshot.task.id), snapshot);
          } finally {
            nullModel = false;
          }
        },
      );
      await t.test('first-use cloud single-review flow keeps its task VM without waking or installing a parent', async () => {
        const { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction } = await import('./transaction');
        const names = ['WORKSPACE_SECRETS_KEY', 'MIKKA_CLOUD_COMPUTER_TASKS', 'MIKKA_BYOS_ENABLED', 'NEXT_PUBLIC_POSTHOG_KEY'] as const;
        const saved = new Map(names.map(name => [name, process.env[name]]));
        process.env.WORKSPACE_SECRETS_KEY = createHash('sha256').update(randomUUID()).digest('hex');
        process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1';
        process.env.MIKKA_BYOS_ENABLED = '1';
        delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
        const { fakeThreadMachines } = await import('../../tests/support/thread-machine-fake');
        const machines = await fakeThreadMachines(db, [{ harness: 'codex', installed: true, toolApproval: true }]);
        const { factoryAutomaticRuntime, automaticFactoryDispatch } = await import('./automatic-dispatch');
        const { ensureBotCloudRuntime } = await import('../computer/auto-runtime');
        const { threadMachineProvider } = await import('../cloud-computer/thread-machines');
        const { chooseCloudRunModel } = await import('../computer/run-model');
        const { queueCloudRun } = await import('../computer/queue-run');
        const { ensureDeviceRepository } = await import('../device-repositories');
        const { setE2BKey } = await import('../secrets/e2b');
        const { addApiKey } = await import('../model-api-keys');
        const { changeOrder } = await import('../model-order');
        const { workspacePool } = await import('../workspace-db');
        assert.equal(workspacePool.options.connectionString, isolated.toString(), 'membership uses this suite\'s isolated loopback database');
        const taskCreate = threadMachineProvider.create;
        const createdTaskRuns: string[] = [];
        threadMachineProvider.create = async (...args) => {
          assert.equal(typeof args[2].runId, 'string');
          createdTaskRuns.push(args[2].runId);
          return taskCreate(...args);
        };
        const queuedHandoffs: string[] = [];
        factoryAutomaticRuntime.enqueue = async (_pool, _actor, _previous, runId) => {
          assert.equal((await db.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0]?.status, 'queued');
          queuedHandoffs.push(runId);
        };
        const providerCount = networkRequests.length;
        try {
          await modelDatabase!.run(async () => {
            const userId = `fresh-check-${randomUUID()}`, workspaceId = randomUUID(), botId = randomUUID();
            const actor = { userId, workspaceId }, scope = { ownerId: userId, workspaceId, botId };
            // APP and Workspace use independent real pools against this one
            // isolated database, so authority rows are inserted exactly once.
            await db.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Fresh check',$2,true,now(),now())`, [userId, `${userId}@example.invalid`]);
            await db.query('INSERT INTO mikka_workspaces(id,"userId",name,slug) VALUES($1,$2,\'Fresh check\',$3)', [workspaceId, userId, `fresh-${workspaceId}`]);
            await db.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,'Fresh check',$3,'admin','active')`, [workspaceId, userId, `${userId}@example.invalid`]);
            await db.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,\'Fresh task Bot\')', [botId, workspaceId, userId]);
            await setE2BKey(userId, workspaceId, { apiKey: `e2b-offline-fixture-${randomUUID()}` }, { verify: async () => ({ ok: true }) });
            const key = await addApiKey(db, userId, { provider: 'deepseek', apiKey: `sk-offline-fixture-${randomUUID()}` },
              { fetch: (async () => Response.json({ data: [{ id: 'deepseek-flash' }] })) as typeof fetch });
            await changeOrder(db, scope, { kind: 'location', location: 'cloud' });
            await changeOrder(db, scope, { kind: 'add', entries: [{ harness: 'codex', model: 'deepseek-flash', source: { kind: 'api_key', keyId: key.id } }] });
            const runtime = await ensureBotCloudRuntime(db, actor, botId, { harness: 'codex' });
            assert.ok(runtime);
            const otherBot = randomUUID();
            await db.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,\'Other owned Bot\')', [otherBot, workspaceId, userId]);
            assert.ok(await ensureBotCloudRuntime(db, actor, otherBot, { harness: 'codex' }));
            const parent = async () => (await db.query(`SELECT to_jsonb(m) AS machine,to_jsonb(d) AS device FROM cloud_machines m JOIN devices d ON d.id=m."deviceId"
              WHERE m."ownerId"=$1 AND m."workspaceId"=$2`, [userId, workspaceId])).rows[0];
            const beforeParent = await parent(), parentId = beforeParent.device.id;
            assert.deepEqual([beforeParent.machine.state, beforeParent.machine.sandboxId, beforeParent.machine.runtimeReady,
              beforeParent.device.lastSeenAt, beforeParent.device.harnesses], ['sleeping', null, false, null, []]);
            const remote = 'https://github.com/mikka-ci/fresh-cloud-check-fixture.git';
            const repository = await ensureDeviceRepository(userId, parentId, remote);
            await db.query('UPDATE device_repos SET "verifyCommand"=$2 WHERE id=$1', [repository.id, command]);
            const selected = await chooseCloudRunModel(db, scope, runtime.agentId, 'codex', undefined, 'task');
            assert.ok(!('error' in selected), JSON.stringify(selected));
            const cloudStore = createFactoryStore(db, authorize, botId, { independent: factoryCheckIndependent, gates: factoryCheckGates });
            const initialDispatch = createFactoryDispatch(db, cloudStore, (tx, _user, input, _bot, context) => queueCloudRun(db, actor, {
              botId, issueId: input.issueId, agentId: runtime.agentId, deviceRepoId: repository.id,
              title: 'Fresh cloud check', body: 'Offline real admission fixture', readOnly: true, ...selected,
            }, tx, context));
            const issueId = randomUUID(), sourceEventId = randomUUID();
            await db.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState",scope) VALUES($1,$2,'Fresh check','{}','todo','normal',$3,'bound','workspace')`, [issueId, userId, workspaceId]);
            await db.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,'user_message',$1::text,'{"text":"Fresh cloud check"}')`, [sourceEventId, userId, botId]);
            let current = await cloudStore.route(userId, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Fresh task fixture', missingInformation: [], missingPermissions: [], needsSpec: false });
            const execute = await initialDispatch(userId, { binding: factoryBinding(current.task), agentId: runtime.agentId, deviceRepoId: repository.id });
            const producerWorker = await machines.start(actor, execute.runId);
            assert.notEqual(producerWorker.deviceId, parentId);
            await terminal(execute.runId, `producer-${issueId}`, false, report => {
              report.publish = { commit: sha };
              report.safePoint = { session: 'exited', checkpoint: 'unavailable', observedAt: new Date().toISOString() };
            });
            await addFactoryVisualEvidence(db,execute.runId);
            current = await cloudStore.apply(userId, execute.binding, randomUUID(), { action: 'candidate', runId: execute.runId,
              candidate: { sha, repository: remote, environment: `device:${producerWorker.deviceId}`, scope: `issue:${issueId}` } });
            current = await cloudStore.apply(userId, factoryBinding(current.task), randomUUID(), { action: 'finish', status: 'passed', reason: 'Offline worker report fixture',
              evidence: [{ artifact: `run-report:${execute.runId}`, kind: 'report', runId: execute.runId, sessionId: `producer-${issueId}`,
                candidateId: current.task.candidateId, sha, environment: `device:${producerWorker.deviceId}`, recordedAt: new Date().toISOString() }], output: {} });
            await addFactoryPublicationEvidence(db,current.task.id);
            current = await cloudStore.apply(userId, factoryBinding(current.task), randomUUID(), { action: 'advance', stage: 'review', reason: 'Independent check' });
            const candidateBefore = (await db.query('SELECT to_jsonb(c) AS value FROM factory_candidates c WHERE id=$1', [current.task.candidateId])).rows[0].value;
            const automatic = automaticFactoryDispatch(db);
            const cloudQuestions = createFactoryQuestions(db, authorize, cloudStore, initialDispatch, assignment);
            const cloudReconcile = createFactoryReconciler(db, cloudStore, cloudQuestions, { review: reconcileFactoryCheck, verify: reconcileFactoryCheck }, botId);
            for (const stage of ['review'] as const) {
              assert.equal(current.task.stage, stage);
              assert.equal(current.task.status, 'pending');
              const before = await cloudStore.read(userId, current.task.id);
              const beforeRuns = (await db.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [issueId])).rows;
              const producer = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [execute.runId])).rows[0];
              // These actual dispatch refusals must roll back the whole queue.
              for (const [sql, params, code] of [
                ['UPDATE devices SET enabled=false WHERE id=$1', [parentId], 'factoryCheckHarnessUnavailable'],
                ['UPDATE agents SET harness=\'claude_code\' WHERE id=$1', [runtime.agentId], 'factoryCheckHarnessUnavailable'],
                ['UPDATE factory_candidates SET repository=\'/wrong/repository\' WHERE id=$1', [current.task.candidateId], 'factoryEvidenceMismatch'],
              ] as const) {
                const tx = await db.connect();
                try {
                  await beginFactoryTransaction(tx);
                  await tx.query('UPDATE factory_tasks SET reason=\'Uncommitted caller change\' WHERE id=$1', [current.task.id]);
                  await tx.query(sql, [...params]);
                  await assert.rejects(automatic(tx, cloudStore, current.task, producer),
                    (error: unknown) => error instanceof FactoryError ? error.code === code : error instanceof Error && error.message === code, sql);
                } finally { await rollbackFactoryTransaction(tx); tx.release(); }
                assert.deepEqual(await parent(), beforeParent, 'automatic dispatch must not commit the caller\'s disabled parent before rejecting');
                assert.deepEqual(await cloudStore.read(userId, current.task.id), before);
                assert.deepEqual((await db.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [issueId])).rows, beforeRuns);
              }
              const tx = await db.connect();
              let afterCommit: (() => Promise<void>) | void;
              try {
                await beginFactoryTransaction(tx);
                afterCommit = await automatic(tx, cloudStore, current.task, producer);
                assert.equal(typeof afterCommit, 'function', 'the real automatic dispatcher must reach the independent fresh task');
                const runId = (await tx.query('SELECT "runId" FROM factory_attempts WHERE id=$1', [current.task.attemptId])).rows[0].runId;
                const freshTargetInput: Parameters<typeof cloudTaskTarget>[2] = { botId, agentId: runtime.agentId, deviceRepoId: repository.id };
                assert.equal(await cloudTaskTarget(tx, { ...actor, workspaceId: billingWorkspaceId }, freshTargetInput), null);
                assert.equal(await cloudTaskTarget(tx, { ...actor, userId: 'owner' }, freshTargetInput), null);
                await assert.rejects(configureFactoryCheck(tx, { ...before.task, userId: 'owner' }, runId),
                  (error: unknown) => error instanceof FactoryError && error.code === 'factoryEvidenceMismatch');
                // The fresh-template exception grants no other Bot, Agent,
                // workspace, owner or repository authority to this queue.
                for (const [sql, params, code] of [
                  ['UPDATE agents SET harness=\'claude_code\' WHERE id=$1', [runtime.agentId], 'factoryCheckHarnessUnavailable'],
                  ['UPDATE computer_run_bindings SET "botId"=$2 WHERE "runId"=$1', [runId, otherBot], 'factoryCheckHarnessUnavailable'],
                  ['UPDATE agent_runs SET "questionContinuation"=jsonb_build_object(\'originRunId\',$2::text,\'originSessionId\',$3::text,\'requireSessionResume\',true) WHERE id=$1', [runId, execute.runId, `producer-${issueId}`], 'factoryCheckHarnessUnavailable'],
                  ['UPDATE agent_runs SET "deviceRepoId"=$2 WHERE id=$1', [runId, repoId], 'factoryEvidenceMismatch'],
                ] as const) {
                  await tx.query('SAVEPOINT capability_fence');
                  await tx.query(sql, [...params]);
                  await assert.rejects(configureFactoryCheck(tx, before.task, runId),
                    (error: unknown) => error instanceof FactoryError && error.code === code, sql);
                  await tx.query('ROLLBACK TO SAVEPOINT capability_fence');
                }
                await commitFactoryTransaction(tx);
              } catch (error) { await rollbackFactoryTransaction(tx); throw error; } finally { tx.release(); }
              await afterCommit!();
              current = await cloudStore.read(userId, current.task.id);
              const attempt = current.attempts.find(item => item.id === current.task.attemptId)!;
              const checkRun = (await db.query('SELECT * FROM agent_runs WHERE id=$1', [attempt.runId])).rows[0];
              assert.equal(checkRun.deviceId, parentId, 'queue binds enabled metadata before independent task startup');
              assert.equal(checkRun.agentDefinition.model, 'deepseek-flash');
              assert.deepEqual(checkRun.agentDefinition.apiKey, { keyId: key.id, model: 'deepseek-flash' });
              assert.equal(checkRun.agentDefinition.readOnly, true);
              assert.equal(checkRun.kind, 'acceptance');
              assert.equal(checkRun.baseBranch, sha);
              assert.equal((attempt.output.check as { stage: string }).stage, stage);
              // The fixture captures the durable enqueue above. Execute its
              // real prior-stage handoff before starting the queued review.
              await factoryAutomaticRuntime.park(db, actor, execute.runId, checkRun.id);
              const worker = await machines.start(actor, checkRun.id);
              assert.notEqual(worker.deviceId, parentId);
              assert.equal(worker.deviceId, producerWorker.deviceId, 'independent stages retain their task VM');
              assert.notEqual(worker.token, producerWorker.token, 'the next stage receives a fresh worker credential');
              await terminal(checkRun.id, `${stage}-${issueId}`);
              assert.notEqual((await db.query('SELECT "sessionId" FROM agent_runs WHERE id=$1', [checkRun.id])).rows[0].sessionId,
                `producer-${issueId}`, 'the independent review has its own native session on the same VM');
              await cloudReconcile.run(userId, checkRun.id);
              current = await cloudStore.read(userId, current.task.id);
              assert.equal(current.task.stage, 'approval');
              assert.deepEqual((await db.query('SELECT to_jsonb(c) AS value FROM factory_candidates c WHERE id=$1', [current.task.candidateId])).rows[0].value, candidateBefore);
              assert.deepEqual(await parent(), beforeParent, 'parent state, heartbeat and empty capability report are unchanged');
            }
            assert.equal(queuedHandoffs.length, 1);
            assert.equal(current.task.route.flowVersion, 2);
            assert.equal(current.attempts.filter(attempt => attempt.stage === 'review').length, 1);
            assert.equal(current.attempts.filter(attempt => attempt.stage === 'verify').length, 0);
            assert.deepEqual(createdTaskRuns, [execute.runId], 'the producer creates one task VM and the single-review stage reuses it');
            const taskDecisions = networkRequests.slice(providerCount) as { model?: unknown }[];
            assert.ok(taskDecisions.every(request => request.model === DECISION_MODEL),
              'only the existing loopback Decision fixture runs; the global fetch guard rejects every external coding provider');
          });
        } finally {
          machines.restore();
          // This suite retains its isolated database, including the actual
          // computer bindings. Do not delete their owner as if Workspace rows
          // still lived alone in a second shared database.
          for (const name of names) { const value = saved.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        }
      });
      await t.test('the owner Artifact reader retains its report task hint and media without exposing them to another reader', async () => {
        assert.ok(acceptanceReaderFixture, 'the real persisted acceptance report fixture must have been created');
        // Artifact writes import Coordinator workflow consumers too. Read only
        // after all queue/native module-mock scenarios so those imports cannot
        // cache the real consumers before their test fixtures are installed.
        const { readArtifact } = await import('../artifacts/store');
        const { taskId, artifactId, captureId } = acceptanceReaderFixture;
        // Membership lives in this suite's isolated database, just like the
        // artifact. Keep the real membership SQL on that same fixture adapter.
        const fixtureWorkspace=(await import('drizzle-orm/node-postgres')).drizzle(db,{schema:await import('../db/workspace-schema')});
        const workspaceRead=t.mock.method((await import('../workspace-db')).workspaceDb,'select',fixtureWorkspace.select.bind(fixtureWorkspace));
        try {
          const [ownedArtifact, foreignArtifact] = await modelDatabase!.run(() => Promise.all([
            readArtifact('owner',artifactId),readArtifact('other',artifactId),
          ]));
          assert.equal(ownedArtifact?.id,artifactId,'the corresponding real Artifact remains present');
          assert.equal(ownedArtifact?.acceptanceTaskId,taskId,'the owner can find the report task independently of its initial run');
          assert.equal(ownedArtifact?.media?.[0].captureId,captureId);
          assert.equal(foreignArtifact,null,'the task hint is not available to another artifact reader');
        } finally { workspaceRead.mock.restore(); }
      });
    } finally {
      if (installedGatewayFixture) delete process.env.AI_GATEWAY_API_KEY;
      await modelDatabase?.close();
      await closeWorkspaceDatabase?.();
      await pool?.end();
      await (await import("../db")).pool.end();
      // Retain this database. Closing clients does not delete the database.
      // Preserve existing local resources; hosted CI owns its disposable service.
      await admin.end();
    }
  },
);

test('isolated PG: producer command records bind owner/session/candidate and retain actual results, never self-reported success', async () => {
  assert.equal(process.env.REQUIRE_DB, '1')
  const dbUrl = process.env.E2E_DATABASE_URL
  assert.ok(dbUrl)
  assert.equal(process.env.DATABASE_URL, dbUrl)
  assert.equal(process.env.MIKKA_DATABASE_URL, dbUrl)
  assertE2eTarget(dbUrl)
  const admin = new Pool({ connectionString: dbUrl, max: 1 })
  const schema = 'producer_observations_' + randomUUID().replaceAll('-', '')
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const db = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}`, max: 1 })
  try {
    // Isolated real SQL/provenance boundaries; the native events themselves
    // are synthetic fixtures, not a live provider acceptance.
    await db.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"sessionId" text,status text,"startedAt" timestamptz,"finishedAt" timestamptz,report jsonb);
      CREATE TABLE factory_tasks (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"candidateId" uuid,"sourceEventId" uuid,"botId" uuid,stage text);
      CREATE TABLE factory_attempts (id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid,stage text);
      CREATE TABLE factory_candidates (id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid,kind text,sha text);
      CREATE TABLE factory_events ("taskId" uuid,"eventId" uuid,request jsonb,result jsonb,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE run_chunks (id uuid PRIMARY KEY,"runId" uuid,seq int,chunk jsonb,"createdAt" timestamptz)`)
    const task = { id: randomUUID(), userId: 'fixture-owner', issueId: randomUUID() }
    const producer = { runId: randomUUID(), sessionId: 'native-fixture-session' }
    const candidate = { id: randomUUID(), executionSha: 'b'.repeat(40), producerExecution: producer }
    await db.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,$4,'succeeded',now()-interval '20 seconds',now()-interval '2 seconds',$5)`, [producer.runId, task.userId, task.issueId, producer.sessionId, JSON.stringify({ deliverableCommit: candidate.executionSha })])
    await db.query('INSERT INTO factory_tasks (id,"userId","issueId") VALUES ($1,$2,$3)', [task.id, task.userId, task.issueId])
    await db.query(`INSERT INTO factory_candidates VALUES ($1,$2,$3,'deliverable',NULL)`, [candidate.id, task.id, producer.runId])
    const insert = async (seq: number, chunk: unknown, timing = "now()-interval '10 seconds'") => db.query(`INSERT INTO run_chunks VALUES ($1,$2,$3,$4,${timing})`, [randomUUID(), producer.runId, seq, JSON.stringify(chunk)])
    await insert(1, { type: 'tool-input-available', toolName: 'bash', toolCallId: 'head', input: { command: 'git rev-parse HEAD' } })
    await insert(2, { type: 'tool-output-available', toolCallId: 'head', output: { exitCode: 0, output: 'a'.repeat(40) } })
    await insert(3, { type: 'tool-input-available', toolName: 'Bash', toolCallId: 'scope', input: { command: 'git diff --check && git status --short' } })
    await insert(4, { type: 'tool-output-available', toolCallId: 'scope', output: { exitCode: 7, output: ' M DELIVERY.txt\npassword=private-must-not-appear' } })
    await insert(5, { type: 'tool-input-available', toolName: 'bash', toolCallId: 'unpaired', input: { command: 'unpaired observation' } })
    await insert(6, { type: 'tool-output-available', toolCallId: 'different-call', output: { exitCode: 0, output: 'not a matching result' } })
    await insert(7, { type: 'tool-input-available', toolName: 'bash', toolCallId: 'late', input: { command: 'outside the finished native run' } })
    await insert(8, { type: 'tool-output-available', toolCallId: 'late', output: { exitCode: 0 } }, 'now()')
    const raw = await producerCommandObservations(db, task, candidate)
    const observed = JSON.parse(raw)
    assert.equal(observed.records.length, 2)
    assert.equal(observed.producerSessionId, producer.sessionId)
    assert.equal(observed.candidateSha, candidate.executionSha)
    assert.equal(observed.records[0].output.output, 'a'.repeat(40), 'the producer pre-retention HEAD stays unchanged')
    assert.equal(observed.records[1].output.exitCode, 7, 'failed native output is not converted to success')
    assert.doesNotMatch(raw, /private-must-not-appear|not a matching result|outside the finished native run/)
    for (const [scope, bound] of [
      [{ ...task, userId: 'other-owner' }, candidate],
      [{ ...task, issueId: randomUUID() }, candidate],
      [task, { ...candidate, id: randomUUID() }],
      [task, { ...candidate, executionSha: 'c'.repeat(40) }],
      [task, { ...candidate, producerExecution: { ...producer, sessionId: 'different-session' } }],
    ] as const) assert.deepEqual(JSON.parse(await producerCommandObservations(db, scope, bound)).records, [])
    await insert(9, { type: 'tool-input-available', toolName: 'bash', toolCallId: 'large', input: { command: 'x'.repeat(4100) + 'password=hidden-large-secret' } })
    await insert(10, { type: 'tool-output-available', toolCallId: 'large', output: { exitCode: 0, output: 'x'.repeat(6100) + 'password=hidden-large-secret' } })
    const limited = JSON.parse(await producerCommandObservations(db, task, candidate))
    const large = limited.records.at(-1)
    assert.deepEqual([large.input, large.output, large.inputTruncated, large.outputTruncated], [null, null, true, true])
    assert.doesNotMatch(JSON.stringify(limited), /hidden-large-secret/)
    for (let i = 0; i < 34; i++) {
      await insert(11 + 2 * i, { type: 'tool-input-available', toolName: 'bash', toolCallId: `many-${i}`, input: { command: 'x'.repeat(900) } })
      await insert(12 + 2 * i, { type: 'tool-output-available', toolCallId: `many-${i}`, output: { exitCode: 0 } })
    }
    const bounded = await producerCommandObservations(db, task, candidate)
    assert.ok(bounded.length < 24200)
    assert.match(bounded, /"earlierRecordsOmitted":true/)
    assert.match(bounded, /Producer command observations truncated; missing observations cannot establish a pass/)
  } finally {
    await db.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})

