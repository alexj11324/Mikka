import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import {
  factoryCheckIndependent,
  FACTORY_CHECK_ANCESTRY_CONTRACT_VERSION,
} from "./check-independence";
import { fixture } from "./test-support/check-ancestry-fixture";

// Only the already-authorized Actions ephemeral service. No application/cloud
// fallback and no local CI impersonation. Rows are a synthetic reader projection,
// not a #192 migration or an alternative Factory state-machine implementation.
const connectionString = process.env.E2E_DATABASE_URL;
if (!connectionString)
  throw new Error(
    "Factory ancestry DB contract needs the isolated CI database",
  );
const target = new URL(connectionString);
if (
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.REQUIRE_DB !== "1" ||
  !["postgres:", "postgresql:"].includes(target.protocol) ||
  target.hostname !== "127.0.0.1" ||
  target.port !== "5432" ||
  target.pathname !== "/mikka_e2e" ||
  target.search ||
  target.hash ||
  process.env.MIKKA_DATABASE_URL !== connectionString ||
  process.env.DATABASE_URL !== connectionString
)
  throw new Error(
    "Refusing non-Actions/non-isolated Factory ancestry database",
  );

type Graph = ReturnType<typeof fixture>;
function fresh(stage: string, failed: boolean, depth = 2): Graph {
  const ids = new Map<string, string>();
  // Re-key only explicit synthetic UUIDs; keep all origin/result edges identical.
  return JSON.parse(
    JSON.stringify(fixture(depth, failed, stage)).replace(
      /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g,
      (value) => {
        if (!ids.has(value)) ids.set(value, randomUUID());
        return ids.get(value)!;
      },
    ),
  ) as Graph;
}
const binding = (f: Graph) => ({
  taskId: f.task.id,
  issueId: f.task.issueId,
  attemptId: f.task.attemptId,
  candidateId: f.task.candidateId,
  revision: 1,
});

// A real loopback HTTP consumer of the actual predicate. Authentication and
// assignment records are explicit fixtures; no real OAuth, claim/token issuer,
// provider, finish/repair implementation or monitor business gate is substituted.
test(
  "isolated PG17 + HTTP consumes v2 ancestry for pass/fail without granting a result",
  { timeout: 120000 },
  async (t) => {
    const schema = `factory193_contract_${randomUUID().replaceAll("-", "")}`;
    const appName = `factory193_consumer_${randomUUID()}`;
    const admin = new Pool({ connectionString, max: 1 });
    assert.match(schema, /^factory193_contract_[a-f0-9]+$/);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString,
      max: 12,
      application_name: appName,
      options: `-c search_path=${schema}`,
    });
    let calls = 0;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      assert.equal(
        (
          await pool.query("SHOW server_version_num")
        ).rows[0].server_version_num.slice(0, 2),
        "17",
      );
      // Exact columns read by v2, in a fresh schema. No shared/application table or
      // migration is changed. Keep the schema until the existing CI service ends.
      await pool.query(`
      CREATE TABLE factory_tasks(id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"sourceEventId" uuid,stage text,status text,revision int,"attemptId" uuid,"candidateId" uuid);
      CREATE TABLE fixture_access("taskId" uuid PRIMARY KEY,"userId" text,allowed boolean);
      CREATE TABLE factory_candidates(id uuid PRIMARY KEY,"taskId" uuid,sha text,repository text,environment text);
      CREATE TABLE agent_runs(id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"sessionId" text,kind text,"retryOf" uuid,status text,"stopReason" text,"stopRequestedAt" timestamptz,"agentId" uuid,"deviceId" uuid,"deviceRepoId" uuid,"baseBranch" text,"questionContinuation" jsonb);
      CREATE TABLE factory_attempts(id uuid PRIMARY KEY,"taskId" uuid,stage text,ordinal int,position int,status text,"candidateId" uuid,"runId" uuid UNIQUE,"sessionId" text,output jsonb);
      CREATE TABLE factory_questions(id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"taskId" uuid,"attemptId" uuid,"candidateId" uuid,stage text,"originRunId" uuid,"originSessionId" text,"originRevision" int,"waitingBinding" jsonb,status text,"answerId" uuid,"answerSource" text,"answerFingerprint" text,"answeredAt" timestamptz,"continuationRunId" uuid UNIQUE,result jsonb);
    `);
      async function seed(f: Graph) {
        const tx = await pool.connect();
        try {
          await tx.query("BEGIN");
          const q = f.task;
          await tx.query(
            `INSERT INTO factory_tasks VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8)`,
            [
              q.id,
              q.userId,
              q.issueId,
              q.sourceEventId,
              q.stage,
              q.status,
              q.attemptId,
              q.candidateId,
            ],
          );
          await tx.query("INSERT INTO fixture_access VALUES ($1,$2,true)", [
            q.id,
            q.userId,
          ]);
          await tx.query(
            "INSERT INTO factory_candidates VALUES ($1,$2,$3,$4,$5)",
            [
              q.candidateId,
              q.id,
              "a".repeat(40),
              "fixture/repository",
              `device:${f.attempts[0].run.deviceId}`,
            ],
          );
          for (const a of f.attempts) {
            const r = a.run;
            await tx.query(
              `INSERT INTO agent_runs VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
              [
                r.id,
                r.userId,
                r.issueId,
                r.sessionId,
                r.kind,
                r.retryOf,
                r.status,
                r.stopReason,
                r.stopRequestedAt,
                r.agentId,
                r.deviceId,
                r.deviceRepoId,
                r.baseBranch,
                JSON.stringify(r.questionContinuation),
              ],
            );
            const check = {
              stage: a.stage,
              candidateId: a.candidateId,
              sha: r.baseBranch,
              repository: "fixture/repository",
              environment: `device:${r.deviceId}`,
              command: "synthetic frozen command",
              deviceRepoId: r.deviceRepoId,
            };
            await tx.query(
              `INSERT INTO factory_attempts VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                a.id,
                a.taskId,
                a.stage,
                a.ordinal,
                a.position,
                a.status,
                a.candidateId,
                a.runId,
                a.sessionId,
                JSON.stringify({ check }),
              ],
            );
          }
          for (const row of f.questions)
            await tx.query(
              `INSERT INTO factory_questions VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
              [
                row.id,
                row.userId,
                row.issueId,
                row.taskId,
                row.attemptId,
                row.candidateId,
                row.stage,
                row.originRunId,
                row.originSessionId,
                row.originRevision,
                JSON.stringify(row.waitingBinding),
                row.status,
                row.answerId,
                row.answerSource,
                row.answerFingerprint,
                row.answeredAt,
                row.continuationRunId,
                JSON.stringify(row.result),
              ],
            );
          await tx.query("COMMIT");
        } catch (error) {
          await tx.query("ROLLBACK");
          throw error;
        } finally {
          tx.release();
        }
      }
      server = createServer(async (req, res) => {
        const reply = (status: number, value: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        // Deliberately synthetic actor selector, NOT production authentication.
        const actor = req.headers["x-fixture-actor"];
        if (actor !== "fixture-owner" && actor !== "foreign-fixture-owner") {
          reply(401, { error: "fixtureActorRequired" });
          return;
        }
        const tx = await pool.connect();
        try {
          let bytes = "";
          for await (const chunk of req) bytes += String(chunk);
          const body = JSON.parse(bytes) as {
            binding: ReturnType<typeof binding>;
            runId: string;
          };
          await tx.query("BEGIN");
          const task = (
            await tx.query(
              "SELECT * FROM factory_tasks WHERE id=$1 FOR UPDATE",
              [body.binding.taskId],
            )
          ).rows[0];
          const access = (
            await tx.query(
              'SELECT * FROM fixture_access WHERE "taskId"=$1 FOR SHARE',
              [body.binding.taskId],
            )
          ).rows[0];
          if (
            !task ||
            task.userId !== actor ||
            !access?.allowed ||
            access.userId !== actor
          ) {
            await tx.query("ROLLBACK");
            reply(403, { error: "currentAccessDenied" });
            return;
          }
          if (
            task.status !== "running" ||
            task.issueId !== body.binding.issueId ||
            task.attemptId !== body.binding.attemptId ||
            task.candidateId !== body.binding.candidateId ||
            task.revision !== body.binding.revision
          ) {
            await tx.query("ROLLBACK");
            reply(409, { error: "bindingStoppedOrStale" });
            return;
          }
          const row = (
            await tx.query(
              `SELECT a.*,r.id AS "boundRunId",r."userId" AS "runOwner",r."issueId" AS "runIssue",r."baseBranch",r.kind,r.status AS "runStatus",r."stopRequestedAt",r."retryOf",r."deviceId",r."deviceRepoId",c.sha,c.repository,c.environment
          FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId"
          WHERE a.id=$1 AND a."taskId"=$2 FOR UPDATE OF r`,
              [task.attemptId, task.id],
            )
          ).rows[0];
          const check = row?.output?.check;
          if (
            !row ||
            row.boundRunId !== body.runId ||
            row.runOwner !== actor ||
            row.runIssue !== task.issueId ||
            row.status !== "running" ||
            row.stage !== task.stage ||
            row.candidateId !== task.candidateId ||
            row.stopRequestedAt ||
            row.retryOf ||
            row.kind !== "acceptance" ||
            !["succeeded", "failed"].includes(row.runStatus) ||
            check?.stage !== task.stage ||
            check.candidateId !== task.candidateId ||
            check.sha !== row.sha ||
            row.baseBranch !== row.sha ||
            check.repository !== row.repository ||
            check.environment !== row.environment ||
            check.environment !== `device:${row.deviceId}` ||
            check.deviceRepoId !== row.deviceRepoId
          ) {
            await tx.query("ROLLBACK");
            reply(409, { error: "frozenAssignmentRejected" });
            return;
          }
          calls++;
          const independent = await factoryCheckIndependent(
            tx,
            task,
            row.boundRunId,
          );
          await tx.query("COMMIT");
          reply(independent ? 200 : 409, {
            independent,
            observedOutcome: row.runStatus,
            contractVersion: FACTORY_CHECK_ANCESTRY_CONTRACT_VERSION,
            authority: "ancestry_only",
          });
        } catch (error) {
          await tx.query("ROLLBACK");
          reply(500, {
            error: error instanceof Error ? error.message : "fixture error",
          });
        } finally {
          tx.release();
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/independence`;
      const request = (
        f: Graph,
        actor = "fixture-owner",
        override: Record<string, unknown> = {},
      ) =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-fixture-actor": actor,
          },
          body: JSON.stringify({
            binding: binding(f),
            runId: f.runId,
            ...override,
          }),
        });
      for (const stage of ["review", "verify", "monitor"])
        for (const failed of [false, true])
          await t.test(
            `${stage} ${failed ? "failure" : "pass"} consumes real PG rows over HTTP`,
            async () => {
              for (const depth of [0, 1, 2]) {
                const f = fresh(stage, failed, depth);
                await seed(f);
                const response = await request(f);
                assert.equal(response.status, 200);
                assert.deepEqual(await response.json(), {
                  independent: true,
                  observedOutcome: failed ? "failed" : "succeeded",
                  contractVersion: 2,
                  authority: "ancestry_only",
                });
                assert.deepEqual(
                  (
                    await pool.query(
                      "SELECT status,revision FROM factory_tasks WHERE id=$1",
                      [f.task.id],
                    )
                  ).rows[0],
                  { status: "running", revision: 1 },
                  "ancestry must never promote a result",
                );
              }
            },
          );
      const corruptions: Record<
        string,
        { sql: string; args: (f: Graph) => unknown[] }
      > = {
        "foreign question owner": {
          sql: `UPDATE factory_questions SET "userId"='foreign' WHERE id=$1`,
          args: (f) => [f.questions[0].id],
        },
        "foreign question task": {
          sql: `UPDATE factory_questions SET "taskId"=$2 WHERE id=$1`,
          args: (f) => [f.questions[0].id, randomUUID()],
        },
        "changed candidate": {
          sql: `UPDATE factory_questions SET "candidateId"=$2 WHERE id=$1`,
          args: (f) => [f.questions[0].id, randomUUID()],
        },
        "changed phase": {
          sql: `UPDATE factory_questions SET stage='review' WHERE id=$1`,
          args: (f) => [f.questions[0].id],
        },
        "origin run owner": {
          sql: `UPDATE agent_runs SET "userId"='foreign' WHERE id=$1`,
          args: (f) => [f.attempts[0].runId],
        },
        "origin session": {
          sql: `UPDATE agent_runs SET "sessionId"='foreign' WHERE id=$1`,
          args: (f) => [f.attempts[0].runId],
        },
        "origin run edge": {
          sql: `UPDATE factory_questions SET "originRunId"=$2 WHERE id=$1`,
          args: (f) => [f.questions[0].id, randomUUID()],
        },
        "waiting revision": {
          sql: `UPDATE factory_questions SET "originRevision"="originRevision"+1 WHERE id=$1`,
          args: (f) => [f.questions[0].id],
        },
        "resumed attempt": {
          sql: `UPDATE factory_questions SET result=jsonb_set(result,'{task,attemptId}',to_jsonb($2::text)) WHERE id=$1`,
          args: (f) => [f.questions[0].id, randomUUID()],
        },
        "accepted answer missing": {
          sql: `UPDATE factory_questions SET "answerFingerprint"=NULL WHERE id=$1`,
          args: (f) => [f.questions[0].id],
        },
        "question not resolved": {
          sql: `UPDATE factory_questions SET status='resuming' WHERE id=$1`,
          args: (f) => [f.questions[0].id],
        },
        "cancelled question": {
          sql: `UPDATE factory_questions SET status='cancelled' WHERE id=$1`,
          args: (f) => [f.questions[0].id],
        },
        "revoked ancestor": {
          sql: `UPDATE factory_attempts SET status='revoked' WHERE id=$1`,
          args: (f) => [f.attempts[0].id],
        },
        "stopped origin": {
          sql: `UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1`,
          args: (f) => [f.attempts[0].runId],
        },
        "missing run metadata": {
          sql: `UPDATE agent_runs SET "questionContinuation"=NULL WHERE id=$1`,
          args: (f) => [f.runId],
        },
        "fresh session fallback": {
          sql: `UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{requireSessionResume}','false') WHERE id=$1`,
          args: (f) => [f.runId],
        },
        "retry child": {
          sql: `UPDATE agent_runs SET "retryOf"=$2 WHERE id=$1`,
          args: (f) => [f.runId, f.attempts[0].runId],
        },
        "device changed": {
          sql: `UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1`,
          args: (f) => [f.attempts[0].runId, randomUUID()],
        },
        "repository changed": {
          sql: `UPDATE agent_runs SET "deviceRepoId"=$2 WHERE id=$1`,
          args: (f) => [f.attempts[0].runId, randomUUID()],
        },
        "fixed SHA changed": {
          sql: `UPDATE agent_runs SET "baseBranch"=$2 WHERE id=$1`,
          args: (f) => [f.attempts[0].runId, "b".repeat(40)],
        },
      };
      for (const [name, mutation] of Object.entries(corruptions))
        for (const failed of [false, true])
          await t.test(
            `monitor ${failed ? "failure" : "pass"} rejects ${name} in actual PG/HTTP`,
            async () => {
              const f = fresh("monitor", failed);
              await seed(f);
              await pool.query(mutation.sql, mutation.args(f));
              const response = await request(f);
              assert.equal(response.status, 409);
              const body = (await response.json()) as { independent?: boolean };
              assert.notEqual(body.independent, true);
            },
          );
      await t.test(
        "read-only repeated concurrent consumption is deterministic",
        async () => {
          const f = fresh("monitor", true);
          await seed(f);
          const replies = await Promise.all(
            Array.from({ length: 10 }, () => request(f)),
          );
          for (const response of replies) {
            assert.equal(response.status, 200);
            assert.equal(
              ((await response.json()) as { observedOutcome: string })
                .observedOutcome,
              "failed",
            );
          }
          assert.deepEqual(
            (
              await pool.query(
                "SELECT status,revision FROM factory_tasks WHERE id=$1",
                [f.task.id],
              )
            ).rows[0],
            { status: "running", revision: 1 },
          );
        },
      );
      for (const denied of [
        "foreign owner",
        "stale candidate",
        "unbound retry run",
      ])
        await t.test(`consumer refuses ${denied} before ancestry`, async () => {
          const f = fresh("monitor", false);
          await seed(f);
          const before = calls;
          const override =
            denied === "stale candidate"
              ? { binding: { ...binding(f), candidateId: randomUUID() } }
              : denied === "unbound retry run"
                ? { runId: randomUUID() }
                : {};
          const response = await request(
            f,
            denied === "foreign owner"
              ? "foreign-fixture-owner"
              : "fixture-owner",
            override,
          );
          assert.equal(response.status, denied === "foreign owner" ? 403 : 409);
          assert.equal(calls, before);
        });
      async function waitForBlockedReader() {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const result = await admin.query(
            `SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'`,
            [appName],
          );
          if (result.rowCount) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Expected real PostgreSQL task-row lock contention");
      }
      for (const action of ["cancel", "revoke access"])
        await t.test(
          `HTTP transaction observes ${action} winning the task fence`,
          async () => {
            const f = fresh("monitor", false);
            await seed(f);
            const control: PoolClient = await pool.connect();
            let committed = false;
            try {
              await control.query("BEGIN");
              await control.query(
                "SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE",
                [f.task.id],
              );
              if (action === "cancel")
                await control.query(
                  `UPDATE factory_tasks SET status='cancelled' WHERE id=$1`,
                  [f.task.id],
                );
              else
                await control.query(
                  'UPDATE fixture_access SET allowed=false WHERE "taskId"=$1',
                  [f.task.id],
                );
              const before = calls,
                pending = request(f);
              await waitForBlockedReader();
              await control.query("COMMIT");
              committed = true;
              const response = await pending;
              assert.equal(response.status, action === "cancel" ? 409 : 403);
              assert.equal(calls, before);
            } finally {
              if (!committed) await control.query("ROLLBACK");
              control.release();
            }
          },
        );
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      await pool.end();
      await admin.end();
      console.log(
        "Retained isolated reader-projection fixtures until existing CI service teardown; no application migrations or provider calls",
      );
    }
  },
);
