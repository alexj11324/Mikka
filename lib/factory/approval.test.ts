import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdtemp, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { betterAuth } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import {
  FactoryError,
  type FactoryBinding,
  type FactoryEvidence,
} from "./contract";
import { approvalGate, publishGate, createFactoryApprovals } from "./approval";
import { handleFactoryApproval } from "./approval-http";
import { approvalRequest } from "./approval-contract";
import { createFactoryStore, type FactoryTask } from "./store";
import { redactArtifact } from "./evidence";
import { factoryBrowserHuman } from "./browser-human";

const binding = (task: FactoryTask): FactoryBinding => ({
  taskId: task.id,
  issueId: task.issueId,
  attemptId: task.attemptId,
  revision: task.revision,
  candidateId: task.candidateId,
});
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(
    fn,
    (e: unknown) => e instanceof FactoryError && e.code === code,
  );

test("approval schema cannot accept a client-supplied human identity", () => {
  assert.equal(
    approvalRequest.safeParse({
      actor: { userId: "owner", sessionId: "human" },
    }).success,
    false,
  );
  assert.deepEqual(
    redactArtifact({
      token: "fixture-only",
      text: "Bearer fixture-only secret=fixture-only",
      nested: { apiKey: "fixture-only" },
    }),
    {
      token: "[REDACTED]",
      text: "[REDACTED] secret=[REDACTED]",
      nested: { apiKey: "[REDACTED]" },
    },
  );
});

const dbURL =
  process.env.FACTORY_LOCAL_DB_TESTS === "1" ||
  (process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true")
    ? process.env.E2E_DATABASE_URL
    : undefined;
if (dbURL) {
  const url = new URL(dbURL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/mikka_e2e");
}

test(
  "PG17 approval/publish contract: real SQL, HTTP handler, isolated filesystem effect; upstream identities/results are fixtures",
  { skip: !dbURL, timeout: 120000 },
  async (t) => {
    const schema = `factory_194_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: dbURL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: dbURL,
      max: 14,
      options: `-c search_path=${schema}`,
    });
    const directory = await mkdtemp(join(tmpdir(), "mikka-194-"));
    const effectPath = join(directory, "local-effects.jsonl");
    const authorize = async (
      userId: string,
      issueId: string,
      tx: import("pg").PoolClient,
    ) =>
      Boolean(
        (
          await tx.query(
            "SELECT id FROM issues WHERE id=$1 AND \"userId\"=$2 AND content #>> '{attrs,mikka,deletedAt}' IS NULL FOR SHARE",
            [issueId, userId],
          )
        ).rowCount,
      );
    // #193 is deliberately absent. These gates are contract fixtures, not
    // independent review/verification evidence or a completion claim.
    const store = createFactoryStore(pool, authorize, {
      review: async () => true,
      verify: async () => true,
      approval: approvalGate,
      publish: publishGate,
    });
    const service = createFactoryApprovals(pool, authorize, store);
    const local = createFactoryApprovals(pool, authorize, store, [
      {
        action: "deploy_preview",
        target: "local-isolated-filesystem",
        execute: async (input) => {
          await appendFile(effectPath, `${JSON.stringify(input)}\n`);
          return { reference: `local-file:${input.idempotencyKey}` };
        },
      },
    ]);
    const actor = {
      userId: "fixture-owner",
      sessionId: "fixture-browser-session",
    };
    const issueId = randomUUID(),
      agentId = randomUUID();
    const sources: unknown[] = [];
    try {
      assert.equal(
        (
          await pool.query("SHOW server_version_num")
        ).rows[0].server_version_num.slice(0, 2),
        "17",
      );
      const dir = new URL("../../drizzle/", import.meta.url);
      for (const file of orderMigrations(
        (await readdir(dir)).filter((n) => n.endsWith(".sql")),
      ))
        await pool.query(await readFile(new URL(file, dir), "utf8"));
      await pool.query(
        await readFile(
          new URL("20261025013403_factory_194_approvals.sql", dir),
          "utf8",
        ),
      );
      await pool.query(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('fixture-owner','Fixture','fixture@example.invalid',true,now(),now())`,
      );
      await pool.query(
        `INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,'non-credential-fixture',now()+interval '1 hour',now(),now())`,
        [actor.sessionId, actor.userId],
      );
      await pool.query(
        `INSERT INTO account (id,"userId","providerId","accountId","createdAt","updatedAt") VALUES ('fixture-account',$1,'github','fixture-github-id',now(),now())`,
        [actor.userId],
      );
      await pool.query(
        `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Approval fixture','{}','todo','normal')`,
        [issueId, actor.userId],
      );
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,'Fixture upstream','codex')`,
        [agentId, actor.userId],
      );
      async function prepare(stopStage = "approval") {
        const sourceEventId = randomUUID();
        await pool.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,'{"text":"contract fixture"}')`,
          [sourceEventId, actor.userId, `fixture:${sourceEventId}`],
        );
        let s = await store.route(actor.userId, {
          issueId,
          eventId: randomUUID(),
          sourceEventId,
          rationale: "Contract fixture",
        });
        const sha = randomUUID().replaceAll("-", "").padEnd(40, "0");
        for (const stage of ["execute", "review", "verify"] as const) {
          if (stopStage === stage) return s;
          const runId = randomUUID(),
            sessionId = `fixture-${stage}-${randomUUID()}`;
          await pool.query(
            `INSERT INTO agent_runs (id,"userId","issueId","agentId",status,"sessionId","startedAt") VALUES ($1,$2,$3,$4,'running',$5,clock_timestamp())`,
            [runId, actor.userId, issueId, agentId, sessionId],
          );
          s = await store.apply(actor.userId, binding(s.task), randomUUID(), {
            action: "bind_run",
            runId,
          });
          if (stage === "execute")
            s = await store.apply(actor.userId, binding(s.task), randomUUID(), {
              action: "candidate",
              runId,
              candidate: {
                sha,
                repository: "fixture/Mikka",
                environment: "local-contract",
                scope: "fixture backend",
              },
            });
          await pool.query(
            `UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',report=$2,"finishedAt"=clock_timestamp() WHERE id=$1`,
            [
              runId,
              JSON.stringify({
                summary: `Fixture ${stage} result`,
                verify: {
                  status: "passed",
                  command: "fixture-only",
                  output: "Contract fixture; no Harness invocation",
                },
                publish: { commit: sha },
              }),
            ],
          );
          const evidence: FactoryEvidence = {
            artifact: `run-report:${runId}`,
            kind: "report",
            runId,
            sessionId,
            candidateId: s.task.candidateId,
            sha,
            environment: "local-contract",
            recordedAt: new Date().toISOString(),
          };
          // PostgreSQL has microseconds; use a server-derived, later timestamp.
          evidence.recordedAt = (
            await pool.query(
              "SELECT clock_timestamp()+interval '1 second' AS now",
            )
          ).rows[0].now.toISOString();
          s = await store.apply(actor.userId, binding(s.task), randomUUID(), {
            action: "finish",
            status: "passed",
            reason: "Upstream contract fixture only",
            evidence: [evidence],
            output: {},
          });
          s = await store.apply(actor.userId, binding(s.task), randomUUID(), {
            action: "advance",
            stage:
              stage === "execute"
                ? "review"
                : stage === "review"
                  ? "verify"
                  : "approval",
            reason: "Contract fixture",
          });
        }
        return s;
      }
      async function request(s: Awaited<ReturnType<typeof prepare>>) {
        const e = await service.evidence(actor, s.task.id);
        return {
          binding: e.binding,
          eventId: randomUUID(),
          candidate: e.manifest.candidate,
          action: "deploy_preview" as const,
          target: "local-isolated-filesystem",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          evidenceDigest: e.evidenceDigest,
          evidenceReadId: e.evidenceReadId,
        };
      }
      const publication = (a: Awaited<ReturnType<typeof service.approve>>) => ({
        ...a,
        eventId: randomUUID(),
        action: "deploy_preview" as const,
        target: "local-isolated-filesystem",
      });
      const httpReq = (taskId: string, extra = {}) => ({
        actor,
        authorization: null,
        method: "GET",
        taskId,
        origin: "https://fixture.invalid",
        url: `https://fixture.invalid/api/factory/tasks/${taskId}/approval`,
        ...extra,
      });

      await t.test(
        "missing review/verify and absent gates stay closed",
        async () => {
          const s = await prepare("review");
          await rejects(
            () => service.evidence(actor, s.task.id),
            "factoryTransition",
          );
          const closed = createFactoryStore(pool, authorize, {
            approval: approvalGate,
            publish: publishGate,
          });
          await rejects(
            () =>
              closed.apply(actor.userId, binding(s.task), randomUUID(), {
                action: "finish",
                status: "passed",
                reason: "Cannot bypass #193",
                evidence: [],
                output: {},
              }),
            "factoryConsumerGateRequired",
          );
        },
      );
      await t.test(
        "cookie-only HTTP, owner, read receipt, exact candidate/scope and expiry",
        async () => {
          const s = await prepare(),
            req = await request(s);
          assert.equal(
            (
              await handleFactoryApproval(
                service,
                httpReq(s.task.id, { actor: null }),
              )
            ).status,
            401,
          );
          assert.equal(
            (
              await handleFactoryApproval(
                service,
                httpReq(s.task.id, { authorization: "Bearer fixture-worker" }),
              )
            ).status,
            401,
          );
          assert.equal(
            (
              await handleFactoryApproval(
                service,
                httpReq(s.task.id, {
                  method: "POST",
                  origin: "https://foreign.invalid",
                }),
              )
            ).status,
            403,
          );
          await rejects(
            () =>
              service.approve(
                { userId: "foreign", sessionId: actor.sessionId },
                req,
              ),
            "factoryNotFound",
          );
          await rejects(
            () => service.approve({ ...actor, sessionId: "worker-token" }, req),
            "factoryHumanRequired",
          );
          await rejects(
            () =>
              service.approve(actor, { ...req, evidenceReadId: randomUUID() }),
            "factoryEvidenceMismatch",
          );
          await rejects(
            () =>
              service.approve(actor, {
                ...req,
                candidate: { ...req.candidate, sha: "e".repeat(40) },
              }),
            "factoryEvidenceMismatch",
          );
          await rejects(
            () =>
              service.approve(actor, {
                ...req,
                candidate: { ...req.candidate, environment: "production" },
              }),
            "factoryEvidenceMismatch",
          );
          await rejects(
            () =>
              service.approve(actor, {
                ...req,
                candidate: { ...req.candidate, scope: "other" },
              }),
            "factoryEvidenceMismatch",
          );
          await rejects(
            () =>
              service.approve(actor, {
                ...req,
                expiresAt: new Date(Date.now() - 1000).toISOString(),
              }),
            "factoryApprovalExpiry",
          );
          await rejects(
            () =>
              service.approve(actor, {
                ...req,
                expiresAt: new Date(Date.now() + 90000000).toISOString(),
              }),
            "factoryApprovalExpiry",
          );
          const result = await handleFactoryApproval(
            service,
            httpReq(s.task.id, {
              method: "POST",
              body: { operation: "approve", input: req },
            }),
          );
          assert.equal(result.status, 200);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*) FROM factory_approvals WHERE "taskId"=$1',
                [s.task.id],
              )
            ).rows[0].count,
            "1",
          );
        },
      );
      await t.test(
        "10 concurrent identical approvals produce one ledger and one advance; altered replay rejects",
        async () => {
          const s = await prepare(),
            req = await request(s);
          const all = await Promise.all(
            Array.from({ length: 10 }, () => service.approve(actor, req)),
          );
          assert.equal(new Set(all.map((a) => a.approvalId)).size, 1);
          assert.equal(
            (await store.read(actor.userId, s.task.id)).task.revision,
            req.binding.revision + 2,
          );
          await rejects(
            () => service.approve(actor, { ...req, target: "other" }),
            "factoryReplayMismatch",
          );
          sources.push({
            taskId: s.task.id,
            candidateId: s.task.candidateId,
            sha: req.candidate.sha,
            upstream: s.attempts
              .filter((a) => a.runId)
              .map((a) => ({
                stage: a.stage,
                runId: a.runId,
                sessionId: a.sessionId,
              })),
            approvalId: all[0].approvalId,
            eventId: req.eventId,
          });
        },
      );
      await t.test(
        "raw artifact readback and missing/changed provenance",
        async () => {
          const s = await prepare(),
            e = await service.evidence(actor, s.task.id);
          const raw = await service.artifact(
            actor,
            s.task.id,
            e.evidence[0].artifact,
          );
          assert.equal(
            (raw.raw as { summary: string }).summary,
            "Fixture execute result",
          );
          await rejects(
            () =>
              service.artifact(
                actor,
                s.task.id,
                "https://example.invalid/fake.png",
              ),
            "factoryArtifactMissing",
          );
          const req = await request(s);
          await pool.query(
            `UPDATE agent_runs SET report=jsonb_set(report,'{summary}','"changed"') WHERE id=$1`,
            [e.evidence[0].runId],
          );
          await rejects(
            () => service.approve(actor, req),
            "factoryEvidenceMismatch",
          );
          await pool.query(
            `UPDATE factory_attempts SET "sessionId"='executor-session' WHERE "taskId"=$1 AND stage IN ('execute','review')`,
            [s.task.id],
          );
          await rejects(
            () => service.evidence(actor, s.task.id),
            "factoryIndependentEvidenceRequired",
          );
        },
      );
      await t.test(
        "no approval, wrong action/target, expiration, revocation and session sign-out cause no effect",
        async () => {
          const s = await prepare(),
            req = await request(s),
            a = await service.approve(actor, req),
            p = publication(a);
          await rejects(
            () =>
              service.revoke(actor, {
                binding: a.binding,
                eventId: req.eventId,
                approvalId: a.approvalId,
              }),
            "factoryReplayMismatch",
          );
          await rejects(
            () => local.publish(actor, { ...p, eventId: req.eventId }),
            "factoryReplayMismatch",
          );
          await rejects(
            () => local.publish(actor, { ...p, approvalId: randomUUID() }),
            "factoryApprovalInvalid",
          );
          await rejects(
            () => local.publish(actor, { ...p, action: "merge" }),
            "factoryPublicationUnavailable",
          );
          await rejects(
            () => local.publish(actor, { ...p, target: "foreign" }),
            "factoryPublicationUnavailable",
          );
          let wrongEffects = 0;
          const wrongRegistered = createFactoryApprovals(
            pool,
            authorize,
            store,
            [
              {
                action: "merge",
                target: p.target,
                execute: async () => {
                  wrongEffects++;
                  return { reference: "must-not-run" };
                },
              },
              {
                action: p.action,
                target: "foreign",
                execute: async () => {
                  wrongEffects++;
                  return { reference: "must-not-run" };
                },
              },
            ],
          );
          await rejects(
            () => wrongRegistered.publish(actor, { ...p, action: "merge" }),
            "factoryApprovalInvalid",
          );
          await rejects(
            () => wrongRegistered.publish(actor, { ...p, target: "foreign" }),
            "factoryApprovalInvalid",
          );
          assert.equal(wrongEffects, 0);
          await rejects(
            () => service.publish(actor, p),
            "factoryPublicationUnavailable",
          );
          await rejects(
            () => local.publish(actor, { ...p, action: "deploy_production" }),
            "factoryPublicationUnavailable",
          );
          await pool.query(
            `UPDATE factory_attempts SET status='failed' WHERE "taskId"=$1 AND stage='verify'`,
            [s.task.id],
          );
          await rejects(
            () => local.publish(actor, p),
            "factoryIndependentEvidenceRequired",
          );
          await pool.query(
            `UPDATE factory_attempts SET status='passed' WHERE "taskId"=$1 AND stage='verify'`,
            [s.task.id],
          );
          await pool.query(
            `UPDATE issues SET content='{"attrs":{"mikka":{"deletedAt":"2026-10-25T00:00:00Z"}}}' WHERE id=$1`,
            [issueId],
          );
          await rejects(() => local.publish(actor, p), "factoryNotFound");
          await pool.query(`UPDATE issues SET content='{}' WHERE id=$1`, [
            issueId,
          ]);
          await pool.query(
            "UPDATE factory_approvals SET \"expiresAt\"=now()-interval '1 second' WHERE id=$1",
            [a.approvalId],
          );
          await rejects(
            () => local.publish(actor, p),
            "factoryApprovalInvalid",
          );
          await rejects(
            () => service.approve(actor, req),
            "factoryApprovalInvalid",
          );
          await pool.query(
            "UPDATE factory_approvals SET \"expiresAt\"=now()+interval '1 hour' WHERE id=$1",
            [a.approvalId],
          );
          await pool.query(
            'UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',
            [actor.sessionId],
          );
          await rejects(() => local.publish(actor, p), "factoryHumanRequired");
          await pool.query(
            'UPDATE "session" SET "expiresAt"=now()+interval \'1 hour\' WHERE id=$1',
            [actor.sessionId],
          );
          await service.revoke(actor, {
            binding: a.binding,
            eventId: randomUUID(),
            approvalId: a.approvalId,
          });
          await rejects(
            () => local.publish(actor, p),
            "factoryApprovalInvalid",
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*) FROM factory_publications WHERE "taskId"=$1',
                [s.task.id],
              )
            ).rows[0].count,
            "0",
          );
          await assert.rejects(
            () => readFile(effectPath),
            (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
          );
        },
      );
      await t.test(
        "failed attempt/retry, replacement candidate and task revocation invalidate old approval",
        async () => {
          const s = await prepare(),
            a = await service.approve(actor, await request(s)),
            p = publication(a);
          let failed = await store.apply(
            actor.userId,
            a.binding,
            randomUUID(),
            {
              action: "finish",
              status: "blocked",
              reason: "Actual failure fence fixture",
              evidence: [],
              output: {},
            },
          );
          failed = await store.apply(
            actor.userId,
            binding(failed.task),
            randomUUID(),
            { action: "retry", reason: "Fresh attempt" },
          );
          await rejects(() => local.publish(actor, p), "factoryStale");
          await rejects(
            () => local.publish(actor, { ...p, binding: binding(failed.task) }),
            "factoryApprovalInvalid",
          );
          await store.apply(actor.userId, binding(failed.task), randomUUID(), {
            action: "revoke",
            reason: "Stop task",
          });
          await rejects(() => local.publish(actor, p), "factoryStopped");
          assert.equal(
            (await service.ledger(actor, s.task.id)).approvals[0].id,
            a.approvalId,
          );
          const other = await prepare(),
            otherApproval = await service.approve(actor, await request(other));
          await rejects(
            () =>
              local.publish(actor, {
                ...publication(otherApproval),
                binding: {
                  ...otherApproval.binding,
                  candidateId: randomUUID(),
                },
              }),
            "factoryStale",
          );
        },
      );
      await t.test(
        "approval + stage transitions roll back atomically on event write failure",
        async () => {
          const s = await prepare(),
            req = await request(s);
          await pool.query(
            `CREATE FUNCTION reject_194_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected rollback'; END $$`,
          );
          await pool.query(
            `CREATE TRIGGER reject_194 BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION reject_194_event()`,
          );
          await assert.rejects(
            () => service.approve(actor, req),
            /injected rollback/,
          );
          await pool.query("DROP TRIGGER reject_194 ON factory_events");
          assert.equal(
            (await store.read(actor.userId, s.task.id)).task.stage,
            "approval",
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*) FROM factory_approvals WHERE "taskId"=$1',
                [s.task.id],
              )
            ).rows[0].count,
            "0",
          );
          await service.approve(actor, req);
        },
      );
      await t.test(
        "10 concurrent publication requests perform exactly one actual local effect",
        async () => {
          const s = await prepare(),
            approvalReq = await request(s),
            a = await service.approve(actor, approvalReq),
            p = publication(a);
          const all = await Promise.allSettled(
            Array.from({ length: 10 }, () => local.publish(actor, p)),
          );
          assert.ok(all.filter((x) => x.status === "fulfilled").length >= 1);
          assert.equal(
            new Set(
              all
                .filter((x) => x.status === "fulfilled")
                .map((x) => x.value?.publicationId),
            ).size,
            1,
          );
          assert.equal(
            (await readFile(effectPath, "utf8")).trim().split("\n").length,
            1,
          );
          assert.equal(
            (await store.read(actor.userId, s.task.id)).task.status,
            "passed",
          );
          const replay = await local.publish(actor, p);
          assert.equal(
            replay?.publicationId,
            (await service.ledger(actor, s.task.id)).publications[0].id,
          );
          await rejects(
            () => local.publish(actor, { ...p, approvalId: randomUUID() }),
            "factoryReplayMismatch",
          );
          assert.equal(
            (await readFile(effectPath, "utf8")).trim().split("\n").length,
            1,
          );
          sources.push({
            taskId: s.task.id,
            candidateId: s.task.candidateId,
            approvalId: a.approvalId,
            publicationId: (
              all.find(
                (x) => x.status === "fulfilled",
              ) as PromiseFulfilledResult<{ publicationId: string }>
            ).value.publicationId,
            eventId: p.eventId,
          });
          // Real #192 repair/new-candidate transitions; the old approval cannot be
          // rebound to either the new SHA or the new scope.
          let repaired = await store.read(actor.userId, s.task.id);
          repaired = await store.apply(
            actor.userId,
            binding(repaired.task),
            randomUUID(),
            {
              action: "advance",
              stage: "monitor",
              reason: "Contract fixture monitoring",
            },
          );
          repaired = await store.apply(
            actor.userId,
            binding(repaired.task),
            randomUUID(),
            {
              action: "finish",
              status: "failed",
              reason: "Contract fixture fault",
              evidence: [],
              output: {},
            },
          );
          repaired = await store.apply(
            actor.userId,
            binding(repaired.task),
            randomUUID(),
            { action: "repair", reason: "Fresh implementation candidate" },
          );
          const repairRunId = randomUUID();
          await pool.query(
            `INSERT INTO agent_runs (id,"userId","issueId","agentId",status,"sessionId") VALUES ($1,$2,$3,$4,'running','fixture-repair')`,
            [repairRunId, actor.userId, issueId, agentId],
          );
          repaired = await store.apply(
            actor.userId,
            binding(repaired.task),
            randomUUID(),
            { action: "bind_run", runId: repairRunId },
          );
          repaired = await store.apply(
            actor.userId,
            binding(repaired.task),
            randomUUID(),
            {
              action: "candidate",
              runId: repairRunId,
              candidate: {
                sha: "f".repeat(40),
                repository: "fixture/Mikka",
                environment: "local-contract",
                scope: "new scope after repair",
              },
            },
          );
          await rejects(() => local.publish(actor, p), "factoryStale");
          await rejects(
            () =>
              service.approve(actor, {
                ...approvalReq,
                binding: binding(repaired.task),
                eventId: randomUUID(),
              }),
            "factoryTransition",
          );
        },
      );
      await t.test(
        "unknown adapter outcome is durable and never retried across reconnect",
        async () => {
          const s = await prepare(),
            a = await service.approve(actor, await request(s)),
            p = publication(a);
          let calls = 0;
          const uncertain = createFactoryApprovals(pool, authorize, store, [
            {
              action: "deploy_preview",
              target: p.target,
              execute: async () => {
                calls++;
                throw new Error("uncertain local outcome");
              },
            },
          ]);
          await assert.rejects(
            () => uncertain.publish(actor, p),
            /uncertain local outcome/,
          );
          const reconnected = new Pool({
            connectionString: dbURL,
            max: 1,
            options: `-c search_path=${schema}`,
          });
          try {
            const recovered = createFactoryApprovals(
              reconnected,
              authorize,
              createFactoryStore(reconnected, authorize),
              [
                {
                  action: "deploy_preview",
                  target: p.target,
                  execute: async () => {
                    calls++;
                    return { reference: "must-not-run" };
                  },
                },
              ],
            );
            await rejects(
              () => recovered.publish(actor, p),
              "factoryPublicationAlreadyClaimed",
            );
            assert.equal(calls, 1);
            assert.equal(
              (
                await reconnected.query(
                  'SELECT status FROM factory_publications WHERE "taskId"=$1',
                  [s.task.id],
                )
              ).rows[0].status,
              "uncertain",
            );
          } finally {
            await reconnected.end();
          }
        },
      );
      await t.test(
        "effect followed by failed SQL commit remains uncertain, with no automatic duplicate",
        async () => {
          const s = await prepare(),
            a = await service.approve(actor, await request(s)),
            p = publication(a);
          const uncertainPath = join(directory, "effect-before-rollback.jsonl");
          const effect = createFactoryApprovals(pool, authorize, store, [
            {
              action: p.action,
              target: p.target,
              execute: async (input) => {
                await appendFile(uncertainPath, `${JSON.stringify(input)}\n`);
                return { reference: `local-file:${input.idempotencyKey}` };
              },
            },
          ]);
          await pool.query(
            `CREATE TRIGGER reject_194 BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION reject_194_event()`,
          );
          try {
            await assert.rejects(
              () => effect.publish(actor, p),
              /injected rollback/,
            );
          } finally {
            await pool.query("DROP TRIGGER reject_194 ON factory_events");
          }
          assert.equal(
            (
              await pool.query(
                'SELECT status FROM factory_publications WHERE "taskId"=$1',
                [s.task.id],
              )
            ).rows[0].status,
            "uncertain",
          );
          assert.equal(
            (await store.read(actor.userId, s.task.id)).task.status,
            "pending",
          );
          await rejects(
            () => effect.publish(actor, p),
            "factoryPublicationAlreadyClaimed",
          );
          assert.equal(
            (await readFile(uncertainPath, "utf8")).trim().split("\n").length,
            1,
          );
        },
      );
      await t.test(
        "real HTTP + Better Auth + PG cookie authentication (synthetic account, no human OAuth acceptance)",
        async () => {
          await pool.query(
            `INSERT INTO account (id,"userId","providerId","accountId",password,"createdAt","updatedAt") VALUES ('fixture-credential',$1,'credential',$1,$2,now(),now())`,
            [actor.userId, await hashPassword("disposable-contract-password")],
          );
          const s = await prepare();
          let origin = "";
          const makeAuth = (baseURL: string) =>
            betterAuth({
              database: pool,
              baseURL,
              secret: randomUUID() + randomUUID(),
              emailAndPassword: { enabled: true },
              logger: { disabled: true },
            });
          let sessionAuth: ReturnType<typeof makeAuth>;
          const server = createServer(async (req, res) => {
            try {
              const parts = [];
              for await (const part of req) parts.push(part);
              const body = Buffer.concat(parts).toString();
              const request = new Request(`${origin}${req.url}`, {
                method: req.method,
                headers: req.headers as Record<string, string>,
                ...(body ? { body } : {}),
              });
              if (req.url?.startsWith("/api/auth/")) {
                const response = await sessionAuth.handler(request);
                res.writeHead(response.status, {
                  "Content-Type": "application/json",
                  "Set-Cookie": response.headers.getSetCookie(),
                });
                res.end(await response.text());
                return;
              }
              const authenticated = await factoryBrowserHuman(
                request,
                (headers) =>
                  sessionAuth.api.getSession({
                    headers,
                    query: { disableCookieCache: true },
                  }),
              );
              const result = await handleFactoryApproval(service, {
                actor: authenticated,
                authorization: request.headers.get("authorization"),
                method: request.method,
                taskId: s.task.id,
                origin: request.headers.get("origin"),
                url: request.url,
                body: body ? JSON.parse(body) : undefined,
              });
              res.writeHead(result.status, {
                "Content-Type": "application/json",
                "Cache-Control": "private, no-store",
              });
              res.end(JSON.stringify(result.body));
            } catch {
              res.writeHead(500);
              res.end("local fixture failure");
            }
          });
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
          sessionAuth = makeAuth(origin);
          try {
            const endpoint = `${origin}/api/factory/tasks/${s.task.id}/approval`;
            assert.equal((await fetch(endpoint)).status, 401);
            const signin = await fetch(`${origin}/api/auth/sign-in/email`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Origin: origin },
              body: JSON.stringify({
                email: "fixture@example.invalid",
                password: "disposable-contract-password",
              }),
            });
            assert.equal(signin.status, 200);
            const cookie = signin.headers
              .getSetCookie()
              .map((v) => v.split(";")[0])
              .join("; ");
            assert.ok(cookie);
            const headers = {
              Cookie: cookie,
              Origin: origin,
              "Content-Type": "application/json",
            };
            assert.equal(
              (
                await fetch(endpoint, {
                  headers: {
                    ...headers,
                    Authorization: "Bearer fixture-worker",
                  },
                })
              ).status,
              401,
            );
            assert.equal(
              (
                await fetch(endpoint, {
                  headers: {
                    ...headers,
                    Cookie: "better-auth.session_token=unsigned-fixture",
                  },
                })
              ).status,
              401,
            );
            const read = await fetch(endpoint, { headers });
            assert.equal(read.status, 200);
            const e = await read.json();
            const input = {
              binding: e.binding,
              eventId: randomUUID(),
              candidate: e.manifest.candidate,
              evidenceDigest: e.evidenceDigest,
              evidenceReadId: e.evidenceReadId,
              action: "deploy_preview",
              target: "local-isolated-filesystem",
              expiresAt: new Date(Date.now() + 600000).toISOString(),
            };
            assert.equal(
              (
                await fetch(endpoint, {
                  method: "POST",
                  headers: { ...headers, Origin: "https://foreign.invalid" },
                  body: JSON.stringify({ operation: "approve", input }),
                })
              ).status,
              403,
            );
            const approved = await fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify({ operation: "approve", input }),
            });
            assert.equal(approved.status, 200);
            const approval = await approved.json();
            assert.equal(
              (
                await pool.query(
                  'SELECT "userId" FROM factory_approvals WHERE id=$1',
                  [approval.approvalId],
                )
              ).rows[0].userId,
              actor.userId,
            );
            // Actual sign-out invalidates this session, not the unrelated fixture session.
            assert.equal(
              (
                await fetch(`${origin}/api/auth/sign-out`, {
                  method: "POST",
                  headers,
                  body: "{}",
                })
              ).status,
              200,
            );
            assert.equal((await fetch(endpoint, { headers })).status, 401);
            sources.push({
              taskId: s.task.id,
              approvalId: approval.approvalId,
              eventId: input.eventId,
              request: "HTTP cookie read/approve/sign-out",
              origin: "loopback ephemeral port",
              auth: "real Better Auth with synthetic credential/OAuth-link fixtures; not actual human",
            });
          } finally {
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          }
        },
      );
      console.log(
        JSON.stringify({
          issue: 194,
          layer: "local-pg17-contract-fixtures",
          environment:
            "isolated Docker PG17 + local temp filesystem; no Preview, OAuth human, CC/Codex or production",
          timestamp: new Date().toISOString(),
          sources,
        }),
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
