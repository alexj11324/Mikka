import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import {
  createFactoryApprovalGates,
  createFactoryApprovals,
  type PublicationAdapter,
} from "../../lib/factory/approval";
import type {
  FactoryApprovalStore,
  FactoryTask,
} from "../../lib/factory/approval-dependencies";
import {
  FactoryError,
  type FactoryBinding,
  type FactoryActor,
  approvalRequest,
} from "../../lib/factory/approval-contract";
import type { z } from "zod";
import {
  createVercelPublicationAdapter,
  MIKKA_VERCEL,
} from "../../lib/factory/vercel-publication";
import { vercelProtocolFixture } from "./factory-vercel";
import { factory194Target } from "./factory194-target";

export const binding = (t: FactoryTask): FactoryBinding => ({
  taskId: t.id,
  issueId: t.issueId,
  attemptId: t.attemptId,
  revision: t.revision,
  candidateId: t.candidateId,
});
/** A test-only #192 port substitute. It is not an alternative production store,
 * independent Harness evidence, real OAuth approval or cloud provider acceptance. */
export async function factory194Fixture(connectionString: string) {
  const config = factory194Target(
    connectionString,
    process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true",
  );
  const admin = new Pool({ ...config, max: 1 }),
    schema = `factory194_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    ...config,
    max: 12,
    options: `-c search_path=${schema}`,
  });
  await pool.query(`
    CREATE TABLE issues (id uuid PRIMARY KEY,"userId" text,title text,content jsonb,revision integer,scope text NOT NULL DEFAULT 'personal',"scopeVersion" integer NOT NULL DEFAULT 1);
    CREATE TABLE coordinator_events (id uuid PRIMARY KEY,"userId" text,"botId" uuid,"issueId" uuid,kind text,payload jsonb);
    CREATE TABLE "session" (id text PRIMARY KEY,"userId" text,"expiresAt" timestamptz);
    CREATE TABLE account (id text,"userId" text,"providerId" text);
    CREATE TABLE "user" (id text PRIMARY KEY,name text);
    CREATE TABLE factory_tasks (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"attemptId" uuid,"candidateId" uuid,revision integer,stage text,status text,"botId" uuid,"sourceEventId" uuid,"scopeVersion" integer);
    CREATE TABLE factory_candidates (id uuid PRIMARY KEY,"taskId" uuid,sha text,repository text,environment text,scope text,UNIQUE("taskId",id));
    CREATE TABLE factory_attempts (id uuid PRIMARY KEY,"taskId" uuid,"candidateId" uuid,stage text,position integer,"runId" uuid,"sessionId" text,status text,evidence jsonb,output jsonb,"finishedAt" timestamptz,UNIQUE("taskId",id));
    CREATE TABLE factory_events ("taskId" uuid,"eventId" uuid,request jsonb NOT NULL DEFAULT '{}',result jsonb NOT NULL DEFAULT '{}',PRIMARY KEY("taskId","eventId"));
    CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"sessionId" text,status text,"stopRequestedAt" timestamptz,report jsonb,"startedAt" timestamptz,"finishedAt" timestamptz,"stopReason" text);
    ALTER TABLE agent_runs ADD COLUMN "deviceId" uuid, ADD COLUMN "agentDefinition" jsonb, ADD COLUMN "leaseExpiresAt" timestamptz, ADD COLUMN kind text NOT NULL DEFAULT 'implement', ADD COLUMN "botId" uuid;
    CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,enabled boolean);
    CREATE TABLE run_tokens (id uuid PRIMARY KEY,"runId" uuid,"userId" text,"tokenHash" text,"revokedAt" timestamptz,"expiresAt" timestamptz);
    CREATE TABLE run_chunks (id uuid PRIMARY KEY,"runId" uuid,chunk jsonb,"createdAt" timestamptz,seq integer NOT NULL DEFAULT 1);
  `);
  await pool.query(
    await readFile(
      new URL("../fixtures/factory194-ledgers.sql", import.meta.url),
      "utf8",
    ),
  );
  const actor = {
    userId: "synthetic-owner",
    sessionId: "synthetic-browser-session",
  };
  await pool.query(
    `INSERT INTO "session" VALUES ($1,$2,now()+interval '1 hour');`,
    [actor.sessionId, actor.userId],
  );
  await pool.query(
    `INSERT INTO account VALUES ('synthetic-github',$1,'github')`,
    [actor.userId],
  );
  const permission = { allowed: true };
  // Separate upstream Bot/source fence: issue authorization cannot replace it.
  const source = { allowed: true };
  const authorize = async (userId: string, issueId: string, tx: PoolClient) =>
    permission.allowed &&
    Boolean(
      (
        await tx.query(
          'SELECT id FROM factory_tasks WHERE "issueId"=$1 AND "userId"=$2',
          [issueId, userId],
        )
      ).rowCount,
    );
  const approvalRequestForHuman = (input: z.infer<typeof approvalRequest>) => input;
  const gates = createFactoryApprovalGates();
  function makeStore(installedGates = gates): FactoryApprovalStore {
    return {
      async lockTask(tx, userId, taskId) {
        const {
          rows: [task],
        } = await tx.query<FactoryTask>(
          'SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE',
          [taskId, userId],
        );
        if (
          !task ||
          !source.allowed ||
          !(await authorize(userId, task.issueId, tx))
        )
          throw new FactoryError("factoryNotFound");
        return task;
      },
      async apply(userId, b, eventId, change, tx) {
        const {
          rows: [task],
        } = await tx.query<FactoryTask>(
          'SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE',
          [b.taskId, userId],
        );
        if (!task || task.revision !== b.revision)
          throw new FactoryError("factoryStale");
        await tx.query(
          'INSERT INTO factory_events ("taskId","eventId") VALUES ($1,$2)',
          [task.id, eventId],
        );
        if (change.action === 'retry_publication') {
          const attemptId = randomUUID();
          await tx.query(`UPDATE factory_attempts SET status='failed',"finishedAt"=clock_timestamp() WHERE id=$1`, [task.attemptId]);
          await tx.query(`INSERT INTO factory_attempts(id,"taskId","candidateId",stage,position,status,evidence,output) VALUES($1,$2,$3,'approval',99,'pending','[]','{}')`, [attemptId,task.id,task.candidateId]);
          return { task: (await tx.query<FactoryTask>(`UPDATE factory_tasks SET stage='approval',status='pending',"attemptId"=$2,revision=revision+1 WHERE id=$1 RETURNING *`, [task.id,attemptId])).rows[0] };
        }
        if (change.action === "finish" && change.status === "failed") {
          // Contract substitute for #192: failing never needs a consumer gate.
          await tx.query(
            "UPDATE factory_attempts SET status='failed',\"finishedAt\"=clock_timestamp() WHERE id=$1",
            [task.attemptId],
          );
          return {
            task: (
              await tx.query<FactoryTask>(
                "UPDATE factory_tasks SET status='failed',revision=revision+1 WHERE id=$1 RETURNING *",
                [task.id],
              )
            ).rows[0],
          };
        }
        if (change.action === "repair") {
          assert.equal(task.status, "failed");
          const attempt = randomUUID();
          await tx.query(
            `INSERT INTO factory_attempts (id,"taskId","candidateId",stage,position,status,evidence,output) VALUES ($1,$2,NULL,'execute',5,'pending','[]','{}')`,
            [attempt, task.id],
          );
          return {
            task: (
              await tx.query<FactoryTask>(
                "UPDATE factory_tasks SET stage='execute',status='pending',\"candidateId\"=NULL,revision=revision+1,\"attemptId\"=$2 WHERE id=$1 RETURNING *",
                [task.id, attempt],
              )
            ).rows[0],
          };
        }
        if (change.action === "finish") {
          const gate =
            task.stage === "approval"
              ? installedGates.approval
              : installedGates.publish;
          assert.equal(await gate(tx, task, {}, change), true);
          await tx.query(
            "UPDATE factory_attempts SET status='passed',output=$2,\"finishedAt\"=clock_timestamp() WHERE id=$1",
            [task.attemptId, JSON.stringify(change.output)],
          );
          return {
            task: (
              await tx.query<FactoryTask>(
                "UPDATE factory_tasks SET status='passed',revision=revision+1 WHERE id=$1 RETURNING *",
                [task.id],
              )
            ).rows[0],
          };
        }
        assert.equal(task.stage, "approval");
        assert.equal(task.status, "passed");
        const attempt = randomUUID();
        await tx.query(
          `INSERT INTO factory_attempts (id,"taskId","candidateId",stage,position,status,evidence,output) VALUES ($1,$2,$3,'publish',4,'pending','[]','{}')`,
          [attempt, task.id, task.candidateId],
        );
        return {
          task: (
            await tx.query<FactoryTask>(
              "UPDATE factory_tasks SET stage='publish',status='pending',revision=revision+1,\"attemptId\"=$2 WHERE id=$1 RETURNING *",
              [task.id, attempt],
            )
          ).rows[0],
        };
      },
    };
  }
  const store = makeStore();
  const provider = await vercelProtocolFixture(),
    adapter = createVercelPublicationAdapter(
      { ...MIKKA_VERCEL, environment: "preview" },
      provider.client,
    );
  const service = (
    adapters: PublicationAdapter[] = [adapter],
  ) =>
    createFactoryApprovals(
      pool,
      authorize,
      store,
      adapters,
    );
  async function prepare(executionActor: FactoryActor = actor) {
    const task: FactoryTask = {
      id: randomUUID(),
      userId: actor.userId,
      issueId: randomUUID(),
      attemptId: randomUUID(),
      candidateId: randomUUID(),
      revision: 8,
      stage: "approval",
      status: "pending",
    };
    const candidate = {
      sha: "a".repeat(40),
      repository: MIKKA_VERCEL.repository,
      environment: `device:${randomUUID()}`,
      scope: "synthetic upstream approval contract",
    };
    const sourceEventId = randomUUID();
    await pool.query('INSERT INTO issues (id,"userId",title,content,revision) VALUES($1,$2,$3,$4,1)', [
      task.issueId,
      task.userId,
      "Synthetic publication task",
      JSON.stringify({
        type: "doc",
        content: [
          {
            type: "text",
            text: "Validate explicit isolated backend behavior, no live provider",
          },
        ],
      }),
    ]);
    await pool.query(
      "INSERT INTO coordinator_events VALUES($1,$2,NULL,$3,'user_message',$4)",
      [
        sourceEventId,
        task.userId,
        task.issueId,
        JSON.stringify({ text: "Synthetic authorized originating request" }),
      ],
    );
    await pool.query(
      'INSERT INTO factory_tasks (id,"userId","issueId","attemptId","candidateId",revision,stage,status,"sourceEventId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        task.id,
        task.userId,
        task.issueId,
        task.attemptId,
        task.candidateId,
        task.revision,
        task.stage,
        task.status,
        sourceEventId,
      ],
    );
    await pool.query(
      "INSERT INTO factory_candidates VALUES ($1,$2,$3,$4,$5,$6)",
      [
        task.candidateId,
        task.id,
        candidate.sha,
        candidate.repository,
        candidate.environment,
        candidate.scope,
      ],
    );
    for (const [position, stage] of ["execute", "review", "verify"].entries()) {
      const runId = randomUUID(),
        sessionId = `synthetic-${stage}-${randomUUID()}`,
        recordedAt = new Date().toISOString();
      const evidence = {
        artifact: `run-report:${runId}`,
        kind: "report",
        runId,
        sessionId,
        candidateId: task.candidateId,
        sha: candidate.sha,
        environment: candidate.environment,
        recordedAt,
      };
      await pool.query(
        `INSERT INTO agent_runs (id,"userId","issueId","sessionId",status,"stopRequestedAt",report,"startedAt","finishedAt","stopReason") VALUES ($1,$2,$3,$4,'succeeded',NULL,$5,$6,$6,'submitted')`,
        [
          runId,
          task.userId,
          task.issueId,
          sessionId,
          JSON.stringify({
            summary: "Synthetic upstream result, no Harness invocation",
            publish: { commit: candidate.sha },
            verify: { status: "passed" },
          }),
          recordedAt,
        ],
      );
      await pool.query(
        `INSERT INTO factory_attempts VALUES ($1,$2,$3,$4,$5,$6,$7,'passed',$8,'{}',$9)`,
        [
          randomUUID(),
          task.id,
          task.candidateId,
          stage,
          position,
          runId,
          sessionId,
          JSON.stringify([evidence]),
          recordedAt,
        ],
      );
    }
    await pool.query(
      `INSERT INTO factory_attempts (id,"taskId","candidateId",stage,position,status,evidence,output) VALUES ($1,$2,$3,'approval',3,'pending','[]','{}')`,
      [task.attemptId, task.id, task.candidateId],
    );
    const e = await service().evidence(executionActor, task.id);
    const approval = {
      binding: binding(task),
      eventId: randomUUID(),
      candidate,
      action: "deploy_preview" as const,
      target: adapter.target,
      targetEnvironment: "preview",
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      evidenceDigest: e.evidenceDigest,
    };
    Object.assign(approval, approvalRequestForHuman(approval));
    const approve = () => service().approve(executionActor, approval);
    const publication = async () => ({
      ...(await approve()),
      eventId: randomUUID(),
      action: approval.action,
      target: approval.target,
      targetEnvironment: approval.targetEnvironment,
    });
    return { task, candidate, approval, approve, publication };
  }
  return {
    permission,
    source,
    store,
    makeStore,
    authorize,
    approvalRequestForHuman,
    pool,
    actor,
    provider,
    adapter,
    service,
    prepare,
    async close() {
      await provider.close();
      await pool.end();
      console.info("Factory194 retained schema", schema);
      await admin.end();
    },
  };
}
