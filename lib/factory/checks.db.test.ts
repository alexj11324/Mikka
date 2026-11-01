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
        Object.hasOwn(process.env, "DECISION_GATEWAY_API_KEY"),
        false,
        "Offline tests must not inherit a provider credential",
      );
      process.env.DECISION_GATEWAY_API_KEY = "synthetic-offline-fixture";
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
        for (const prerequisite of ["harness", "command"] as const) {
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
              const code = prerequisite === "harness"
                ? "factoryCheckHarnessUnavailable" : "factoryCheckCommandRequired";
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
                      question: "Which acceptance path?",
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
                    text: "A",
                  }),
                });
                const result = await response.json();
                assert.equal(response.status, 200, JSON.stringify(result));
                resumed = result;
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
      if (installedGatewayFixture) delete process.env.DECISION_GATEWAY_API_KEY;
      await modelDatabase?.close();
      await pool?.end();
      await (await import("../db")).pool.end();
      // Retain this database. Closing clients does not delete the database.
      // Preserve existing local resources; hosted CI owns its disposable service.
      await admin.end();
    }
  },
);
