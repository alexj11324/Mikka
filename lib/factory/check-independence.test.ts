import { executePoolMigration } from "../../scripts/search-migrations.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { FactoryError, type FactoryBinding } from "./contract";
import { createFactoryStore, type FactoryTask } from "./store";
import { createFactoryDispatch } from "./dispatch";
import { createFactoryReconciler } from "./reconcile";
import { factoryCheckGates } from "./checks";
import { approvalEvidence } from "./evidence";
import { factoryDispatchDatabase } from "./transaction";
import { insertRunOnce } from "../run-dispatch";
import { createFactoryQuestions, questionReference } from "./questions/store";

const local = process.env.FACTORY_TEST_DATABASE_URL;
const dbURL =
  local ??
  (process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true"
    ? process.env.E2E_DATABASE_URL
    : undefined);
if (dbURL) {
  const url = new URL(dbURL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, local ? "/factory193" : "/mikka_e2e");
  if (local) assert.equal(url.port, "55493");
}
const binding = (t: FactoryTask): FactoryBinding => ({
  taskId: t.id,
  issueId: t.issueId,
  attemptId: t.attemptId,
  revision: t.revision,
  candidateId: t.candidateId,
});

test(
  "PG17 check question ancestry (synthetic provider reports, real store/dispatch/gates)",
  { skip: !dbURL, timeout: 120000 },
  async (t) => {
    const schema = `check_questions_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: dbURL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: dbURL,
      max: 12,
      options: `-c search_path=${schema}`,
    });
    const denied = new Set<string>();
    try {
      const dir = new URL("../../drizzle/", import.meta.url);
      for (const file of orderMigrations(
        (await readdir(dir)).filter((n) => n.endsWith(".sql")),
      ))
        await executePoolMigration(pool, file, await readFile(new URL(file, dir), "utf8"));
      const deviceId = randomUUID(),
        agentId = randomUUID(),
        repoId = randomUUID();
      await pool.query(
        `INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','PG fixture',now(),'[{"harness":"codex","installed":true}]')`,
        [deviceId],
      );
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture','codex',$2)`,
        [agentId, deviceId],
      );
      await pool.query(
        `INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","verifyCommand") VALUES ($1,$2,'owner','/fixture/repo','https://example.invalid/factory.git','node acceptance.mjs')`,
        [repoId, deviceId],
      );
      const authorize = async (user: string, issue: string) =>
        user === "owner" && !denied.has(issue);
      const store = createFactoryStore(pool, authorize, factoryCheckGates);
      const dispatch = createFactoryDispatch(pool, store, (tx, user, input) =>
        insertRunOnce(factoryDispatchDatabase(tx), user, input, {
          deviceId,
          baseBranch: "main",
          prompt: "Synthetic provider fixture",
        }),
      );
      const questions = createFactoryQuestions(
        pool,
        authorize,
        store,
        dispatch,
      );
      const reconcile = createFactoryReconciler(pool, store, questions);
      const queue = (task: FactoryTask) =>
        dispatch("owner", {
          binding: binding(task),
          agentId,
          deviceRepoId: repoId,
        });
      const complete = async (
        runId: string,
        sha: string,
        options: {
          failed?: boolean;
          sessionId?: string;
          checkSha?: string;
          selfReport?: boolean;
          command?: string;
          noCriteria?: boolean;
          timeout?: boolean;
          noRuntime?: boolean;
          finding?: boolean;
          noTimes?: boolean;
        } = {},
      ) => {
        const run = (
          await pool.query(`SELECT * FROM agent_runs WHERE id=$1`, [runId])
        ).rows[0];
        const report = {
          summary: "Explicit fixture report; not real Harness acceptance",
          filesChanged: [],
          openQuestions: [],
          nextStep: null,
          verify: {
            status: options.failed ? "failed" : "passed",
            command: options.command ?? "node acceptance.mjs",
            output: options.failed
              ? "AssertionError: expected 2, received 1 (fixture)"
              : "fixture command passed",
            exitCode: options.failed ? 1 : 0,
            signal: null,
            timedOut: false,
          },
          ...(run.kind === "acceptance"
            ? options.selfReport
              ? {}
              : { check: { sha: options.checkSha ?? sha, readOnly: true } }
            : {
                publish: {
                  commit: sha,
                  branch: "fixture",
                  pushed: false,
                  remote: null,
                },
              }),
          criteria: options.noCriteria
            ? []
            : [
                {
                  text: "Expected response",
                  passed: !options.finding,
                  evidence: options.finding
                    ? "ORIGINAL_REVIEW_EVIDENCE: missing owner check at fixture.ts:7"
                    : "Fixture observation",
                },
              ],
        };
        const sessionId =
          options.sessionId ?? `fixture-session-${randomUUID()}`;
        await pool.query(
          `UPDATE agent_runs SET status=$2,"stopReason"=$3,"sessionId"=$4,report=$5,"startedAt"=CASE WHEN $6 THEN NULL ELSE coalesce("startedAt",now()) END,"finishedAt"=now() WHERE id=$1`,
          [
            runId,
            options.failed || options.timeout ? "failed" : "succeeded",
            options.timeout ? "timeout" : "submitted",
            sessionId,
            JSON.stringify(report),
            options.noTimes ?? false,
          ],
        );
        if (run.kind === "acceptance" && !options.noRuntime) {
          const toolCallId = randomUUID();
          await pool.query(
            `INSERT INTO run_chunks (id,"runId",seq,chunk) VALUES ($1,$2,1,$3),($4,$2,2,$5)`,
            [
              randomUUID(),
              runId,
              JSON.stringify({
                type: "tool-input-available",
                toolCallId,
                toolName: "bash",
                input: { command: "/bin/bash -lc 'node acceptance.mjs'" },
              }),
              randomUUID(),
              JSON.stringify({
                type: "tool-output-available",
                toolCallId,
                output: {
                  exitCode: options.failed ? 1 : 0,
                  output: "Explicit fixture runtime observation",
                },
              }),
            ],
          );
        }
        // Persist terminal time after the fixture adapter's chunks, as in the
        // normal completion path. Downstream evidence keeps truthful ordering.
        await pool.query(
          `UPDATE agent_runs SET "finishedAt"=clock_timestamp() WHERE id=$1`,
          [runId],
        );
        return { report, sessionId };
      };

      const sha = "1".repeat(40);
      const fixture = async (stage: "review" | "verify") => {
        const issueId = randomUUID(),
          sourceEventId = randomUUID();
        await pool.query(
          `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Independent check fixture','{}','todo','normal')`,
          [issueId],
        );
        await pool.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{}')`,
          [sourceEventId, `fixture:${sourceEventId}`],
        );
        const initial = await store.route("owner", {
          issueId,
          sourceEventId,
          eventId: randomUUID(),
          rationale: "Explicit test request",
        });
        const execute = await queue(initial.task);
        await complete(execute.runId, sha);
        await reconcile("owner");
        let state = await store.read("owner", initial.task.id);
        if (stage === "verify") {
          const review = await queue(state.task);
          await complete(review.runId, sha);
          await reconcile("owner");
          state = await store.read("owner", state.task.id);
        }
        assert.equal(state.task.stage, stage);
        const origin = await queue(state.task);
        const session = `check-session-${randomUUID()}`;
        return {
          taskId: state.task.id,
          issueId,
          originRunId: origin.runId,
          session,
          executeRunId: execute.runId,
        };
      };
      const ask = async (runId: string, session: string) => {
        await pool.query(
          `UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,report=$3,"finishedAt"=now() WHERE id=$1`,
          [
            runId,
            session,
            JSON.stringify({
              question: {
                questionId: randomUUID(),
                kind: "context",
                question: "What is the issue title?",
                options: [],
              },
            }),
          ],
        );
        const question = await questions.record("owner", runId);
        const answer = await questions.answer(
          { source: "orchestrator", userId: "owner" },
          {
            reference: questionReference(question),
            answerId: randomUUID(),
            facts: [{ kind: "issue", quote: "Independent check fixture" }],
          },
        );
        await questions.claimContinuation(
          "owner",
          deviceId,
          answer.continuationRunId,
          new Date(Date.now() + 90000).toISOString(),
        );
        return { question, answer };
      };
      for (const stage of ["review", "verify"] as const) {
        for (const failed of [false, true])
          await t.test(
            `${stage} ${failed ? "finding retains failed evidence and opens repair" : "pass advances"} through two exact question ancestors`,
            async () => {
              const f = await fixture(stage);
              const first = await ask(f.originRunId, f.session);
              // A resumed session may ask another question before it submits.
              await pool.query(
                `UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2 WHERE id=$1`,
                [first.answer.continuationRunId, f.session],
              );
              await questions.settle("owner", first.answer.continuationRunId);
              const second = await ask(
                first.answer.continuationRunId,
                f.session,
              );
              await complete(second.answer.continuationRunId, sha, {
                sessionId: f.session,
                failed,
              });
              await reconcile("owner");
              const state = await store.read("owner", f.taskId);
              assert.equal(
                state.task.stage,
                failed ? "execute" : stage === "review" ? "verify" : "approval",
              );
              assert.equal(state.task.status, "pending");
              const finished = state.attempts.at(-2)!;
              assert.equal(finished.status, failed ? "failed" : "passed");
              assert.equal(finished.runId, second.answer.continuationRunId);
              assert.equal(finished.sessionId, f.session);
              assert.ok(finished.evidence.length > 0);
              assert.equal(
                (await questions.read("owner", first.question.id)).status,
                "resolved",
              );
              assert.equal(
                (await questions.read("owner", second.question.id)).status,
                "resolved",
              );
              if (stage === "verify" && !failed) {
                const tx = await pool.connect();
                try {
                  await tx.query("BEGIN");
                  const inventory = await approvalEvidence(tx, state.task);
                  const verify = inventory.manifest.artifacts.filter(
                    (a) => a.stage === "verify",
                  );
                  assert.ok(verify.length > 1);
                  assert.ok(
                    verify.every(
                      (a) =>
                        a.runId === second.answer.continuationRunId &&
                        a.sessionId === f.session,
                    ),
                  );
                  assert.equal(
                    new Set(
                      inventory.manifest.artifacts.map((a) => a.sessionId),
                    ).size,
                    3,
                  );
                } finally {
                  await tx.query("ROLLBACK");
                  tx.release();
                }
              }
              if (failed) {
                assert.equal(state.task.candidateId, null);
                assert.match(JSON.stringify(finished.output), /AssertionError/);
                assert.match(
                  JSON.stringify(finished.evidence),
                  new RegExp(second.answer.continuationRunId),
                );
              }
              await reconcile("owner");
              assert.deepEqual(await store.read("owner", f.taskId), state);
            },
          );
      }
      const mutations: Record<
        string,
        (
          f: Awaited<ReturnType<typeof fixture>>,
          q: Awaited<ReturnType<typeof ask>>,
        ) => Promise<unknown>
      > = {
        "question owner": (f, q) =>
          pool.query(
            `UPDATE factory_questions SET "userId"='foreign' WHERE id=$1`,
            [q.question.id],
          ),
        "question issue": async (f, q) => {
          const id = randomUUID();
          await pool.query(
            `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Foreign issue','{}','todo','normal')`,
            [id],
          );
          await pool.query(
            `UPDATE factory_questions SET "issueId"=$2 WHERE id=$1`,
            [q.question.id, id],
          );
        },
        "question phase": (f, q) =>
          pool.query(
            `UPDATE factory_questions SET stage='review' WHERE id=$1`,
            [q.question.id],
          ),
        "question candidate": async (f, q) => {
          const id = randomUUID();
          await pool.query(
            `INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId") SELECT $1,"taskId",sha,repository,environment,scope,"runId" FROM factory_candidates WHERE id=$2`,
            [id, q.question.candidateId],
          );
          await pool.query(
            `UPDATE factory_questions SET "candidateId"=$2 WHERE id=$1`,
            [q.question.id, id],
          );
        },
        "result task fence": (f, q) =>
          pool.query(
            `UPDATE factory_questions SET result=jsonb_set(result,'{task,id}',to_jsonb($2::text)) WHERE id=$1`,
            [q.question.id, randomUUID()],
          ),
        "result candidate fence": (f, q) =>
          pool.query(
            `UPDATE factory_questions SET result=jsonb_set(result,'{task,candidateId}',to_jsonb($2::text)) WHERE id=$1`,
            [q.question.id, randomUUID()],
          ),
        "metadata permits fresh session": (f, q) =>
          pool.query(
            `UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{requireSessionResume}','false') WHERE id=$1`,
            [q.answer.continuationRunId],
          ),
        "unrelated same-phase session reuse": (f, _q) =>
          pool.query(
            `UPDATE factory_attempts SET stage='verify',ordinal=99,"sessionId"=$2 WHERE "runId"=$1`,
            [f.executeRunId, f.session],
          ),
        "origin attempt phase": (f, q) =>
          pool.query(
            `UPDATE factory_attempts SET stage='review',ordinal=99 WHERE id=$1`,
            [q.question.attemptId],
          ),
        "origin attempt candidate": (f, q) =>
          pool.query(
            `UPDATE factory_attempts SET "candidateId"=NULL WHERE id=$1`,
            [q.question.attemptId],
          ),
        "origin owner": (f, _q) =>
          pool.query(`UPDATE agent_runs SET "userId"='foreign' WHERE id=$1`, [
            f.originRunId,
          ]),
        "origin session": (f, _q) =>
          pool.query(
            `UPDATE agent_runs SET "sessionId"='foreign-session' WHERE id=$1`,
            [f.originRunId],
          ),
        "origin run edge": (f, q) =>
          pool.query(
            `UPDATE factory_questions SET "originRunId"=$2 WHERE id=$1`,
            [q.question.id, f.executeRunId],
          ),
        "origin cancellation": (f, _q) =>
          pool.query(
            `UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1`,
            [f.originRunId],
          ),
        "question cancelled": (f, q) =>
          pool.query(
            `UPDATE factory_questions SET status='cancelled' WHERE id=$1`,
            [q.question.id],
          ),
        "question revoked ancestor": (f, q) =>
          pool.query(
            `UPDATE factory_attempts SET status='revoked' WHERE id=$1`,
            [q.question.attemptId],
          ),
        "result attempt fence": (f, q) =>
          pool.query(
            `UPDATE factory_questions SET result=jsonb_set(result,'{task,attemptId}',to_jsonb($2::text)) WHERE id=$1`,
            [q.question.id, q.question.attemptId],
          ),
        "waiting revision fence": (f, q) =>
          pool.query(
            `UPDATE factory_questions SET "originRevision"="originRevision"+1 WHERE id=$1`,
            [q.question.id],
          ),
        "ordinary retry edge": async (f, q) => {
          const values=[q.answer.continuationRunId,f.originRunId];
          // The audit lineage guard now rejects normal reparenting first.
          await assert.rejects(pool.query(`UPDATE agent_runs SET "retryOf"=$2 WHERE id=$1`,values),/security_audit_lineage_invalid/);
          // Controlled owner-only fixture corruption still exercises the
          // independent Factory reader gate; no production guard is relaxed.
          const tx=await pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query('ALTER TABLE agent_runs DISABLE TRIGGER security_audit_transition');
            await tx.query(`UPDATE agent_runs SET "retryOf"=$2 WHERE id=$1`,values);
            await tx.query('ALTER TABLE agent_runs ENABLE TRIGGER security_audit_transition');
            await tx.query('COMMIT');
          } catch(error) { await tx.query('ROLLBACK'); throw error; }
          finally { tx.release(); }
        },
        "missing metadata": (f, q) =>
          pool.query(
            `UPDATE agent_runs SET "questionContinuation"=NULL WHERE id=$1`,
            [q.answer.continuationRunId],
          ),
        "metadata different question": (f, q) =>
          pool.query(
            `UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{questionId}',to_jsonb($2::text)) WHERE id=$1`,
            [q.answer.continuationRunId, randomUUID()],
          ),
        "new session with metadata removed": (f, q) =>
          pool.query(
            `UPDATE agent_runs SET "questionContinuation"=NULL,"sessionId"='new-session' WHERE id=$1`,
            [q.answer.continuationRunId],
          ),
        "cross-phase session reuse outside ancestors": (f, _q) =>
          pool.query(`UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1`, [
            f.executeRunId,
            f.session,
          ]),
      };
      for (const [name, mutate] of Object.entries(mutations))
        for (const failed of [false, true])
          await t.test(
            `reject ${name} (${failed ? "failed" : "passed"} report)`,
            async () => {
              const f = await fixture("verify"),
                q = await ask(f.originRunId, f.session);
              await complete(q.answer.continuationRunId, sha, {
                sessionId: f.session,
                failed,
              });
              await questions.settle("owner", q.answer.continuationRunId);
              await mutate(f, q);
              await reconcile("owner");
              const state = await store.read("owner", f.taskId);
              assert.equal(state.task.stage, "verify");
              assert.equal(state.task.status, "blocked");
              assert.match(
                state.task.reason,
                /factoryIndependentRunRequired|factoryCheckBindingMismatch/,
              );
              assert.equal(
                state.attempts.at(-1)!.runId,
                q.answer.continuationRunId,
              );
            },
          );
      for (const action of ["cancel", "revoke"] as const)
        await t.test(`${action} stops a resolved continuation`, async () => {
          const f = await fixture("review"),
            q = await ask(f.originRunId, f.session);
          await complete(q.answer.continuationRunId, sha, {
            sessionId: f.session,
          });
          await questions.settle("owner", q.answer.continuationRunId);
          const state = await store.read("owner", f.taskId);
          await store.apply("owner", binding(state.task), randomUUID(), {
            action,
            reason: "Test stop",
          });
          await reconcile("owner");
          const stopped = await store.read("owner", f.taskId);
          assert.equal(stopped.task.stage, "review");
          assert.equal(
            stopped.task.status,
            action === "cancel" ? "cancelled" : "revoked",
          );
        });
      await t.test(
        "current authorization is rechecked before any continuation finish",
        async () => {
          const f = await fixture("verify"),
            q = await ask(f.originRunId, f.session);
          await complete(q.answer.continuationRunId, sha, {
            sessionId: f.session,
          });
          await questions.settle("owner", q.answer.continuationRunId);
          const before = await store.read("owner", f.taskId);
          denied.add(f.issueId);
          await assert.rejects(
            () =>
              store.apply("owner", binding(before.task), randomUUID(), {
                action: "finish",
                status: "passed",
                reason: "Must reauthorize",
                evidence: [],
                output: {},
              }),
            (e: unknown) =>
              e instanceof FactoryError && e.code === "factoryNotFound",
          );
          assert.deepEqual(await reconcile("owner"), { recovered: 0 });
          const raw = (
            await pool.query(
              `SELECT stage,status FROM factory_tasks WHERE id=$1`,
              [f.taskId],
            )
          ).rows[0];
          assert.deepEqual(raw, { stage: "verify", status: "running" });
        },
      );
    } finally {
      // Preserve the isolated schema and evidence for review; no automatic deletion.
      console.log(`Retained PG fixture schema: ${schema}`);
      await pool.end();
      await admin.end();
    }
  },
);
