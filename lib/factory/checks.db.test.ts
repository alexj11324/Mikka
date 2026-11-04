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
import { hostedBillingScope } from "../abuse/context";
import { HostedUsageStore } from "../abuse/store";
import { exerciseFactoryRecoveryEntry } from "../../tests/support/factory-recovery-entry-fixture";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { freezeWorkerDefinition } from "../agent-kit/worker";
import { claimLocalRun } from "../computer/claim";
import { FactoryError } from "./contract";
import { createFactoryStore, type FactoryTask } from "./store";
import {
  createFactoryDispatch,
  factoryBinding,
  type FactoryQueue,
} from "./dispatch";
import { createFactoryClaim } from "./claim";
import { createFactoryQuestions, questionReference } from "./questions/store";
import { handleFactoryQuestion } from "./questions/http";
import { createFactoryReconciler } from "./reconcile";
import { factoryCheckIndependent } from "./check-independence";
import { observeFactoryCheckDispatch } from "./check-dispatch";
import {
  configureFactoryCheck,
  producerCommandObservations,
  factoryCheckAssignment,
  factoryCheckGates,
  factoryRepairBrief,
} from "./checks";
import { reconcileFactoryCheck } from "./reconcile-check";
import {
  createFactoryCheckRecovery,
  type FactoryCheckRecoveryDependencies,
} from "./check-recovery";

test(
  "actual migrated PG/HTTP: review/verify receipt consumers and bounded repair",
  { timeout: 120000 },
  async (t) => {
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
      const db = pool;
      modelDatabase = createRequestDatabaseScope(isolated.toString());
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
      const store = createFactoryStore(db, authorize, coordinatorBot, {
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
          review: (tx, task, id) =>
            configureFactoryCheck(tx, task, id, selectedPolicy),
          verify: (tx, task, id) =>
            configureFactoryCheck(tx, task, id, selectedPolicy),
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
      async function pendingReview() {
        const issueId = randomUUID(),
          sourceEventId = randomUUID();
        await db.query(
          `INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Check fixture','{}','todo','normal')`,
          [issueId],
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
              verify: { status: "passed" },
            }),
          ],
        );
        state = await store.apply("owner", execute.binding, randomUUID(), {
          action: "candidate",
          runId: execute.runId,
          candidate: {
            sha,
            repository: "/fixture/repo",
            environment: `device:${deviceId}`,
            scope: `issue:${issueId}`,
          },
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
                sha,
                environment: `device:${deviceId}`,
                recordedAt: new Date().toISOString(),
              },
            ],
            output: {},
          },
        );
        return store.apply("owner", factoryBinding(state.task), randomUUID(), {
          action: "advance",
          stage: "review",
          reason: "Independent review",
        });
      }
      const start = async (task: FactoryTask) =>
        dispatch("owner", {
          binding: factoryBinding(task),
          agentId,
          deviceRepoId: repoId,
        });
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
        },
      );

      // Use the real automatic consumer, store transition, dispatcher and
      // definition freeze. Only the provider-facing local queue is a fixture.
      const originalRepairRequest = 'Only acceptance.txt: exact UTF-8 "mikka-production-20261101-847\\n\\n", 31 bytes. Keep all standing constraints.';
      const failedRepairClaim = 'Expected "mikka-production-acceptance-20261101-847\\n\\n", 42 bytes; actual file is 31 bytes.';
      let queuedRepairPrompt = originalRepairRequest;
      const queueModule = t.mock.module(new URL("../agent-runs.ts", import.meta.url).href, { namedExports: {
        queueFactoryRun: async (...args: Parameters<FactoryQueue>) => {
          const queued = await queue(...args);
          await args[0].query('UPDATE agent_runs SET prompt=$2 WHERE id=$1', [queued.runId, queuedRepairPrompt]);
          return queued;
        },
      } });
      try {
        const { automaticFactoryDispatch } = await import("./automatic-dispatch");
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
            VALUES($1,'owner',$2,$3,'user_message',$1::text,$4)`, [sourceEventId, coordinatorBot, failed.task.issueId, JSON.stringify({ source: 'thread_continuation', previousRunId: check.runId, text: currentRequest })]);
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
      await exerciseFactoryRecoveryEntry(t, {
        db, botId: coordinatorBot, failedReview, png, sha, modelInvoke,
        callCount: () => modelCalls,
        chooseRetry: () => { chosenAction = "retry_check"; },
        latestRequest: () => networkRequests.at(-1),
      });
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
    } finally {
      if (installedGatewayFixture) delete process.env.AI_GATEWAY_API_KEY;
      await modelDatabase?.close();
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
      CREATE TABLE factory_tasks (id uuid PRIMARY KEY,"userId" text,"issueId" uuid);
      CREATE TABLE factory_candidates (id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid,kind text,sha text);
      CREATE TABLE run_chunks (id uuid PRIMARY KEY,"runId" uuid,seq int,chunk jsonb,"createdAt" timestamptz)`)
    const task = { id: randomUUID(), userId: 'fixture-owner', issueId: randomUUID() }
    const producer = { runId: randomUUID(), sessionId: 'native-fixture-session' }
    const candidate = { id: randomUUID(), executionSha: 'b'.repeat(40), producerExecution: producer }
    await db.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,$4,'succeeded',now()-interval '20 seconds',now()-interval '2 seconds',$5)`, [producer.runId, task.userId, task.issueId, producer.sessionId, JSON.stringify({ deliverableCommit: candidate.executionSha })])
    await db.query('INSERT INTO factory_tasks VALUES ($1,$2,$3)', [task.id, task.userId, task.issueId])
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
