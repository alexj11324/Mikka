import { isolatedPostgresURL } from "../../tests/helpers/isolated-postgres.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
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
import { createFactoryTestAuthority } from "../../tests/helpers/factory-test-authority";
import { handleFactoryApproval } from "./approval-http";
import { approvalRequest } from "./approval-contract";
import { createFactoryStore, type FactoryTask } from "./store";
import { redactArtifact } from "./evidence";
import { factoryBrowserHuman } from "./browser-human";
import { createLocalPublicationAdapter } from "./local-publication";
import { readFactoryPublicationReceipt } from "./publication-receipt";
import { readFactoryPublicationReceiptV2 } from "./publication-receipt";
import { vercelProtocolFixture } from "../../tests/helpers/factory-vercel";
import {
  createVercelPublicationAdapter,
  MIKKA_VERCEL,
  vercelTarget,
} from "./vercel-publication";
import { PublicationDeferred } from "./publication-operation";
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

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

const dbURL = disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined;

test(
  "PG17 approval/publish contract: real SQL, HTTP handler, isolated filesystem effect; upstream identities/results/policy receipts are fixtures",
  { skip: !dbURL, timeout: 120000 },
  async (t) => {
    const fixtureURL = await isolatedPostgresURL(dbURL!);
    const schema = `factory_194_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: fixtureURL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: fixtureURL,
      max: 14,
      options: `-c search_path=${schema}`,
    });
    const directory = await mkdtemp(join(tmpdir(), "mikka-194-"));
    const targetDirectory = join(directory, "target");
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
    const policyFixture = createFactoryTestAuthority();
    const { approvals: createFactoryApprovals, gates: { approval: approvalGate, publish: publishGate } } = policyFixture;
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
      createLocalPublicationAdapter({
        root: targetDirectory,
        target: "local-isolated-filesystem",
        repository: "fixture/Mikka",
        environment: "local-contract",
        candidateEnvironment: "local-contract",
      }),
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
          new URL("20261029044004_factory_194_approvals.sql", dir),
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
      async function prepare(
        stopStage = "approval",
        candidateEnvironment = "local-contract",
        repository = "fixture/Mikka",
      ) {
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
            `INSERT INTO agent_runs (id,"userId","issueId","agentId",kind,status,"sessionId","startedAt") VALUES ($1,$2,$3,$4,$6,'running',$5,clock_timestamp())`,
            [runId, actor.userId, issueId, agentId, sessionId, stage === "execute" ? "implement" : "acceptance"],
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
                repository,
                environment: candidateEnvironment,
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
            environment: candidateEnvironment,
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
      async function request(s: Awaited<ReturnType<typeof prepare>>, overrides: Record<string, unknown> = {}) {
        const e = await service.evidence(actor, s.task.id);
        return policyFixture.request(actor.userId, {
          binding: e.binding,
          eventId: randomUUID(),
          candidate: e.manifest.candidate,
          action: "deploy_preview" as const,
          target: "local-isolated-filesystem",
          targetEnvironment: "local-contract",
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          evidenceDigest: e.evidenceDigest,
          ...overrides,
        }, e);
      }
      const publication = (a: Awaited<ReturnType<typeof service.approve>>) => ({
        ...a,
        eventId: randomUUID(),
        action: "deploy_preview" as const,
        target: "local-isolated-filesystem",
        targetEnvironment: "local-contract",
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

      await t.test('one browser approve starts one publication; concurrent replays and legacy publish reuse the same result', async () => {
        const state = await prepare(), req = await request(state);
        const responses = await Promise.all(Array.from({ length: 10 }, () => handleFactoryApproval(local, httpReq(state.task.id, { method: 'POST', body: { operation: 'approve', input: req } }))));
        assert.ok(responses.some(response => response.status === 200), JSON.stringify(responses));
        assert.ok(responses.every(response => response.status === 200 || (response.status === 409 && (response.body as { nextOperation?: string }).nextOperation === 'reconcile')), JSON.stringify(responses));
        const results = responses.map(response => response.body as { approvalId: string; publicationId: string; binding: FactoryBinding });
        assert.equal(new Set(results.map(result => result.publicationId)).size, 1);
        assert.equal((await store.read(actor.userId, state.task.id)).task.status, 'passed');
        assert.equal((await pool.query('SELECT count(*)::int n FROM factory_publications WHERE "taskId"=$1', [state.task.id])).rows[0].n, 1);
        const finished = results.find(result => result.approvalId)!;
        const legacy = await local.publish(actor, publication({ approvalId: finished.approvalId, binding: finished.binding }));
        assert.equal(legacy?.publicationId, finished.publicationId);
      });

      await t.test('reservation SQL failure rolls back the approval, lifecycle events and publish transition together', async () => {
        const state = await prepare(), req = await request(state);
        await pool.query(`CREATE FUNCTION reject_approval_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reservation write failed'; END $$; CREATE TRIGGER reject_approval_reservation BEFORE INSERT ON factory_publications FOR EACH ROW WHEN (NEW."taskId"='${state.task.id}'::uuid) EXECUTE FUNCTION reject_approval_reservation()`);
        try {
          await assert.rejects(() => local.approve(actor, req), /reservation write failed/);
          assert.equal((await store.read(actor.userId, state.task.id)).task.revision, state.task.revision);
          assert.equal((await pool.query('SELECT count(*)::int n FROM factory_approvals WHERE "taskId"=$1', [state.task.id])).rows[0].n, 0);
          assert.equal((await pool.query('SELECT count(*)::int n FROM factory_publications WHERE "taskId"=$1', [state.task.id])).rows[0].n, 0);
          assert.equal((await pool.query('SELECT count(*)::int n FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [state.task.id, req.eventId])).rows[0].n, 0);
        } finally { await pool.query('DROP TRIGGER reject_approval_reservation ON factory_publications; DROP FUNCTION reject_approval_reservation()'); }
      });

      await t.test('confirmed publication failure returns the same candidate to approval and a new approval can retry', async () => {
        const adapter = createLocalPublicationAdapter({ root: targetDirectory, target: 'local-isolated-filesystem', repository: 'fixture/Mikka', environment: 'local-contract', candidateEnvironment: 'local-contract' });
        const failing = createFactoryApprovals(pool, authorize, store, [{ ...adapter, execute: async input => { throw new PublicationDeferred(input.idempotencyKey, 'failed'); } }]);
        const state = await prepare(), req = await request(state);
        await assert.rejects(() => failing.approveAndPublish(actor, req), (error: unknown) => error instanceof PublicationDeferred && error.state === 'failed');
        const retryable = await store.read(actor.userId, state.task.id);
        assert.equal(retryable.task.stage, 'approval');
        assert.equal(retryable.task.status, 'pending');
        assert.equal(retryable.task.candidateId, state.task.candidateId);
        const completed = await local.approveAndPublish(actor, await request(retryable)) as { publicationId: string };
        const publications = (await pool.query('SELECT id,status FROM factory_publications WHERE "taskId"=$1 ORDER BY "createdAt"', [state.task.id])).rows;
        assert.deepEqual(publications.map(row => row.status), ['failed', 'succeeded']);
        assert.equal(publications[1].id, completed.publicationId);
      });

      await t.test('a lost response after the durable effect claim never allows a second execution', async () => {
        const state = await prepare(), req = await request(state), approved = await local.approve(actor, req), input = publication(approved);
        let failCommit = true, effects = 0;
        const crashPool = new Proxy(pool, { get(target, key) {
          if (key === 'connect') return async () => {
            const client = await pool.connect();
            return new Proxy(client, { get(connection, field) {
              if (field === 'query') return async (...args: any[]) => {
                const result = await (connection.query as any)(...args);
                if (failCommit && args[0] === 'COMMIT') { failCommit = false; throw new Error('lost effect-claim response'); }
                return result;
              };
              const value = Reflect.get(connection, field);
              return typeof value === 'function' ? value.bind(connection) : value;
            } });
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        const adapter = { action: input.action, target: input.target, environment: input.targetEnvironment, execute: async () => { effects++; throw new Error('must not execute'); } };
        await assert.rejects(() => createFactoryApprovals(crashPool, authorize, store, [adapter]).publish(actor, input), /lost effect-claim response/);
        assert.equal((await local.ledger(actor, state.task.id)).publications[0].status, 'uncertain');
        await rejects(() => createFactoryApprovals(pool, authorize, store, [adapter]).publish(actor, input), 'factoryPublicationUncertain');
        assert.equal(effects, 0);
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
            "factoryIndependentRunRequired",
          );
        },
      );
      await t.test(
        "cookie-only HTTP, owner, exact candidate/scope and legacy timestamp compatibility",
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
          for (const expiresAt of [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 90000000).toISOString()]) {
            const separate = await prepare();
            assert.ok((await service.approve(actor, await request(separate, { expiresAt }))).approvalId);
          }
          const result = await handleFactoryApproval(
            local,
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
        "#193-shaped device provenance and a separately approved local destination remain distinct",
        async () => {
          const deviceEnvironment = `device:${randomUUID()}`;
          const s = await prepare("approval", deviceEnvironment),
            req = await request(s);
          assert.equal(req.candidate.environment, deviceEnvironment);
          assert.notEqual(req.targetEnvironment, deviceEnvironment);
          const a = await service.approve(actor, req),
            p = publication(a);
          const deviceTarget = createFactoryApprovals(pool, authorize, store, [
            createLocalPublicationAdapter({
              root: join(directory, "device-target"),
              target: p.target,
              environment: p.targetEnvironment,
              candidateEnvironment: deviceEnvironment,
              repository: req.candidate.repository,
            }),
          ]);
          await rejects(
            () =>
              deviceTarget.publish(actor, {
                ...p,
                targetEnvironment: deviceEnvironment,
              }),
            "factoryPublicationUnavailable",
          );
          const published = await deviceTarget.publish(actor, p);
          assert.equal(
            published?.receipt.verifiedTarget.environment,
            req.targetEnvironment,
          );
          const tx = await pool.connect();
          try {
            const handoff = await readFactoryPublicationReceipt(
              tx,
              actor.userId,
              s.task.id,
              s.task.candidateId!,
            );
            assert.equal(handoff.candidate.environment, deviceEnvironment);
            assert.equal(handoff.targetEnvironment, req.targetEnvironment);
            assert.equal(
              handoff.verifiedTarget.environment,
              req.targetEnvironment,
            );
            sources.push({
              taskId: s.task.id,
              candidateId: s.task.candidateId,
              publicationId: published?.publicationId,
              candidateEnvironment: deviceEnvironment,
              targetEnvironment: req.targetEnvironment,
              layer:
                "#193 device shape fixture, real local target write/readback",
            });
          } finally {
            tx.release();
          }
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
          await pool.query(
            `UPDATE agent_runs SET report=jsonb_set(report,'{summary}','"changed"') WHERE id=$1`,
            [e.evidence[0].runId],
          );
          await service.artifact(actor, s.task.id, e.evidence[0].artifact);
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
        "approval event reuse cannot start an effect; grant revoke is obsolete and task STOP remains authoritative",
        async () => {
          const s = await prepare(),
            req = await request(s),
            a = await service.approve(actor, req),
            p = publication(a),
            publications = async () =>
              (
                await pool.query(
                  'SELECT 1 FROM factory_publications WHERE "taskId"=$1',
                  [s.task.id],
                )
              ).rowCount;
          // factory_events already holds this eventId: rejected before the reservation and the effect.
          await rejects(
            () => local.publish(actor, { ...p, eventId: req.eventId }),
            "factoryReplayMismatch",
          );
          assert.equal(await publications(), 1);
          const revoke = { binding: a.binding, eventId: req.eventId, approvalId: a.approvalId };
          await rejects(() => service.revoke(actor, revoke), 'factoryPublicationAlreadyClaimed');
          assert.equal((await service.approve(actor, req)).approvalId, a.approvalId);
          const stopped = await store.apply(actor.userId, a.binding, randomUUID(), { action: 'cancel', reason: 'Stop the task' });
          assert.equal(stopped.task.status, 'cancelled');
          await rejects(() => local.publish(actor, p), 'factoryStopped');
          assert.equal(await publications(), 1);
        },
      );
      await t.test(
        "missing approval, changed action/target/evidence, current session and task STOP remain enforced",
        async () => {
          const s = await prepare(),
            req = await request(s),
            a = await service.approve(actor, req),
            p = publication(a);
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
          await rejects(
            () =>
              local.publish(actor, {
                ...p,
                targetEnvironment: "other-environment",
              }),
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
                environment: p.targetEnvironment,
                execute: async () => {
                  wrongEffects++;
                  throw new Error("must-not-run");
                },
              },
              {
                action: p.action,
                target: "foreign",
                environment: p.targetEnvironment,
                execute: async () => {
                  wrongEffects++;
                  throw new Error("must-not-run");
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
          assert.equal((await service.approve(actor, req)).approvalId, a.approvalId);
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
          await rejects(() => service.revoke(actor, { binding: a.binding, eventId: randomUUID(), approvalId: a.approvalId }), 'factoryPublicationAlreadyClaimed');
          await store.apply(actor.userId, a.binding, randomUUID(), { action: 'cancel', reason: 'Stop publication' });
          await rejects(() => local.publish(actor, p), 'factoryStopped');
          assert.equal((await pool.query('SELECT count(*)::int n FROM factory_publications WHERE "taskId"=$1', [s.task.id])).rows[0].n, 1);
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
            "factoryStale",
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
                  revision: otherApproval.binding.revision + 1,
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
          const priorFiles = (await readdir(targetDirectory)).length;
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
          assert.equal((await readdir(targetDirectory)).length, priorFiles + 1);
          assert.equal(
            (await store.read(actor.userId, s.task.id)).task.status,
            "passed",
          );
          const replay = await local.publish(actor, p);
          const published = JSON.parse(
            await readFile(
              join(targetDirectory, `${replay?.publicationId}.json`),
              "utf8",
            ),
          );
          assert.deepEqual(published.candidate, approvalReq.candidate);
          assert.equal(published.target, p.target);
          assert.ok(
            replay?.receipt.reference.startsWith(
              `local-artifact:${replay.publicationId}:sha256:`,
            ),
          );
          const tx = await pool.connect();
          try {
            await tx.query("BEGIN");
            const handoff = await readFactoryPublicationReceipt(
              tx,
              actor.userId,
              s.task.id,
              s.task.candidateId!,
            );
            assert.equal(handoff.publicationId, replay?.publicationId);
            assert.equal(handoff.action, p.action);
            assert.equal(handoff.target, p.target);
            assert.equal(handoff.targetEnvironment, p.targetEnvironment);
            assert.deepEqual(handoff.candidate, approvalReq.candidate);
            assert.equal(handoff.verifiedTarget.kind, "local-artifact");
            assert.equal(
              handoff.verifiedTarget.environment,
              approvalReq.candidate.environment,
            );
            await rejects(
              () =>
                readFactoryPublicationReceipt(
                  tx,
                  "foreign",
                  s.task.id,
                  s.task.candidateId!,
                ),
              "factoryPublicationReceiptRequired",
            );
            await tx.query("COMMIT");
          } finally {
            tx.release();
          }
          assert.equal(
            replay?.publicationId,
            (await service.ledger(actor, s.task.id)).publications[0].id,
          );
          await rejects(
            () => local.publish(actor, { ...p, approvalId: randomUUID() }),
            "factoryStale",
          );
          assert.equal((await readdir(targetDirectory)).length, priorFiles + 1);
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
          const monitorRunId = randomUUID();
          await pool.query(
            `INSERT INTO agent_runs (id,"userId","issueId","agentId",kind,status,"sessionId","startedAt") VALUES ($1,$2,$3,$4,'acceptance','running',$5,clock_timestamp())`,
            [monitorRunId, actor.userId, issueId, agentId, `fixture-monitor-${randomUUID()}`],
          );
          repaired = await store.apply(actor.userId, binding(repaired.task), randomUUID(), {
            action: "bind_run", runId: monitorRunId,
          });
          await pool.query(
            `UPDATE agent_runs SET status='failed',"stopReason"='error',"finishedAt"=clock_timestamp() WHERE id=$1`,
            [monitorRunId],
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
              environment: p.targetEnvironment,
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
            connectionString: fixtureURL,
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
                  environment: p.targetEnvironment,
                  execute: async () => {
                    calls++;
                    throw new Error("must-not-run");
                  },
                },
              ],
            );
            await rejects(
              () => recovered.publish(actor, p),
              "factoryPublicationUncertain",
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
          const uncertainPath = join(directory, "effect-before-rollback");
          const effect = createFactoryApprovals(pool, authorize, store, [
            createLocalPublicationAdapter({
              root: uncertainPath,
              target: p.target,
              repository: "fixture/Mikka",
              environment: "local-contract",
              candidateEnvironment: "local-contract",
            }),
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
            "factoryPublicationUncertain",
          );
          assert.equal((await readdir(uncertainPath)).length, 1);
        },
      );
      await t.test(
        "Vercel HTTP protocol + PG17 durable pending/uncertain reconciliation (not cloud deployment)",
        async (t) => {
          for (const window of [
            "queued",
            "lost-response",
            "sql-rollback",
          ] as const)
            await t.test(window, async () => {
              const f = await vercelProtocolFixture();
              try {
                const environment =
                  window === "sql-rollback"
                    ? ("production" as const)
                    : ("preview" as const);
                const action =
                  environment === "production"
                    ? ("deploy_production" as const)
                    : ("deploy_preview" as const);
                const target = vercelTarget({ ...MIKKA_VERCEL, environment });
                const adapter = createVercelPublicationAdapter(
                  { ...MIKKA_VERCEL, environment },
                  f.client,
                );
                const provider = createFactoryApprovals(
                  pool,
                  authorize,
                  store,
                  [adapter],
                );
                const s = await prepare(
                  "approval",
                  `device:${randomUUID()}`,
                  MIKKA_VERCEL.repository,
                );
                const approvalReq = await request(s, {
                  action,
                  target,
                  targetEnvironment: environment,
                });
                const a = await provider.approve(actor, approvalReq);
                const p = {
                  ...publication(a),
                  action,
                  target,
                  targetEnvironment: environment,
                };
                f.state.readyState = window === "queued" ? "BUILDING" : "READY";
                f.state.dropCreateResponse = window === "lost-response";
                if (window === "sql-rollback")
                  await pool.query(
                    `CREATE TRIGGER reject_194 BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION reject_194_event()`,
                  );
                try {
                  const response = await handleFactoryApproval(
                    provider,
                    httpReq(s.task.id, {
                      method: "POST",
                      body: { operation: "publish", input: p },
                    }),
                  );
                  assert.notEqual(window, "sql-rollback");
                  assert.equal(
                    response.status,
                    window === "queued" ? 202 : 409,
                  );
                } catch (e) {
                  if (window !== "sql-rollback") throw e;
                  assert.match(String(e), /injected rollback/);
                } finally {
                  if (window === "sql-rollback")
                    await pool.query(
                      "DROP TRIGGER reject_194 ON factory_events",
                    );
                }
                assert.equal(f.posts(), 1);
                assert.equal(
                  (await store.read(actor.userId, s.task.id)).task.status,
                  "pending",
                );
                const ledger = await provider.ledger(actor, s.task.id),
                  operation = ledger.publications[0];
                assert.equal(
                  operation.status,
                  window === "queued" ? "reserved" : "uncertain",
                );
                assert.deepEqual({ ...operation.request, eventId: p.eventId }, p);
                await rejects(
                  () => provider.publish(actor, p),
                  window === "queued" ? "factoryPublicationPending" : "factoryPublicationUncertain",
                );
                await rejects(
                  () =>
                    provider.reconcile(actor, {
                      ...p,
                      publicationId: operation.id,
                      receipt: { reference: "https://forged.example" },
                    }),
                  "factoryInvalid",
                );
                for (const d of f.deployments.values()) d.readyState = "READY";
                // Constructing a fresh service simulates an application reconnect/restart;
                // operation identity and the trusted checkpoint come from SQL only.
                const reconnect = createFactoryApprovals(
                  pool,
                  authorize,
                  store,
                  [adapter],
                );
                const outcomes = await Promise.all(
                  Array.from({ length: 5 }, () =>
                    reconnect.reconcile(actor, {
                      ...p,
                      publicationId: operation.id,
                    }),
                  ),
                );
                assert.ok(
                  outcomes.every((r) => r.publicationId === operation.id),
                );
                assert.equal(f.posts(), 1);
                assert.equal(
                  (await store.read(actor.userId, s.task.id)).task.status,
                  "passed",
                );
                const tx = await pool.connect();
                try {
                  const receipt = await readFactoryPublicationReceiptV2(
                    tx,
                    actor.userId,
                    s.task.id,
                    p.binding.candidateId!,
                  );
                  assert.equal(receipt.version, 2);
                  assert.equal(receipt.action, action);
                  assert.equal(receipt.targetEnvironment, environment);
                  assert.ok(
                    Date.parse(receipt.verifiedTarget.observedAt) <= Date.parse(receipt.publishedAt),
                    "the real publication commit follows its target observation",
                  );
                  assert.equal(
                    receipt.verifiedTarget.provider?.publicationId,
                    operation.id,
                  );
                  if (environment === "production")
                    await rejects(
                      () =>
                        readFactoryPublicationReceipt(
                          tx,
                          actor.userId,
                          s.task.id,
                          p.binding.candidateId!,
                        ),
                      "factoryPublicationReceiptRequired",
                    );
                } finally {
                  tx.release();
                }
              } finally {
                await f.close();
              }
            });
          await t.test(
            "legacy expiry cannot interrupt approved publication; current session expiry still blocks POST",
            async () => {
              const f = await vercelProtocolFixture();
              try {
                const adapter = createVercelPublicationAdapter(
                    { ...MIKKA_VERCEL, environment: "production" },
                    f.client,
                  ),
                  provider = createFactoryApprovals(pool, authorize, store, [
                    adapter,
                  ]);
                f.state.projectDelayMs = 1000;
                for (const field of ["approval", "session"]) {
                  const before = f.posts();
                  const s = await prepare(
                    "approval",
                    `device:${randomUUID()}`,
                    MIKKA_VERCEL.repository,
                  );
                  const req = await request(s, {
                    action: "deploy_production" as const,
                    target: adapter.target,
                    targetEnvironment: "production",
                    ...(field === "approval" ? { expiresAt: new Date(Date.now() + 500).toISOString() } : {}),
                  });
                  const a = await provider.approve(actor, req),
                    p = {
                      ...publication(a),
                      action: req.action,
                      target: req.target,
                      targetEnvironment: req.targetEnvironment,
                    };
                  if (field === "session")
                    await pool.query(
                      'UPDATE "session" SET "expiresAt"=now()+interval \'500 milliseconds\' WHERE id=$1',
                      [actor.sessionId],
                    );
                  try {
                    if (field === 'approval') {
                      assert.ok(await provider.publish(actor, p));
                      assert.equal(f.posts(), before + 1);
                    } else {
                      await rejects(() => provider.publish(actor, p), 'factoryHumanRequired');
                      assert.equal(f.posts(), before);
                    }
                  } finally {
                    await pool.query(
                      'UPDATE "session" SET "expiresAt"=now()+interval \'1 hour\' WHERE id=$1',
                      [actor.sessionId],
                    );
                  }
                }
              } finally {
                await f.close();
              }
            },
          );
          await t.test(
            "task STOP and stale revision block reconciliation; legacy expiry does not hide the provider result",
            async () => {
              const f = await vercelProtocolFixture();
              try {
                const adapter = createVercelPublicationAdapter(
                    { ...MIKKA_VERCEL, environment: "preview" },
                    f.client,
                  ),
                  provider = createFactoryApprovals(pool, authorize, store, [
                    adapter,
                  ]);
                for (const invalid of ["expired", "revoked", "stale"]) {
                  const s = await prepare(
                      "approval",
                      `device:${randomUUID()}`,
                      MIKKA_VERCEL.repository,
                    ),
                    target = adapter.target;
                  const a = await provider.approve(actor, await request(s, {
                    target,
                    targetEnvironment: "preview",
                  }));
                  const p = {
                    ...publication(a),
                    target,
                    targetEnvironment: "preview",
                  };
                  f.state.readyState = "QUEUED";
                  await assert.rejects(
                    () => provider.publish(actor, p),
                    (e) => e instanceof PublicationDeferred,
                  );
                  const ledger = await provider.ledger(actor, s.task.id),
                    id = ledger.publications[0].id,
                    before = f.requests.length;
                  if (invalid === "expired") {
                    // Expiry gates only a new reservation: reconcile still reads the provider, never POSTs.
                    await pool.query(
                      "UPDATE factory_approvals SET \"expiresAt\"=now()-interval '1 minute' WHERE id=$1",
                      [a.approvalId],
                    );
                    await assert.rejects(
                      () =>
                        provider.reconcile(actor, { ...p, publicationId: id }),
                      (e) => e instanceof PublicationDeferred,
                    );
                    assert.ok(f.requests.length > before);
                    assert.equal(f.posts(), 1);
                    continue;
                  }
                  if (invalid === "revoked") {
                    await rejects(() => provider.revoke(actor, {
                      binding: p.binding,
                      eventId: randomUUID(),
                      approvalId: a.approvalId,
                    }), 'factoryPublicationAlreadyClaimed');
                    await store.apply(actor.userId, p.binding, randomUUID(), { action: 'revoke', reason: 'Stop task' });
                  }
                  else
                    await pool.query(
                      "UPDATE factory_tasks SET revision=revision+1 WHERE id=$1",
                      [s.task.id],
                    );
                  await rejects(
                    () =>
                      provider.reconcile(actor, { ...p, publicationId: id }),
                    invalid === "stale"
                      ? "factoryStale"
                      : "factoryStopped",
                  );
                  assert.equal(f.requests.length, before);
                  assert.equal(f.posts(), invalid === "revoked" ? 2 : 3);
                }
              } finally {
                await f.close();
              }
            },
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
              const result = await handleFactoryApproval(local, {
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
            } catch (error) {
              // Preserve failure classification without printing session/token bodies.
              console.error(
                "isolated-auth-fixture",
                error instanceof Error ? error.name : typeof error,
                error && typeof error === "object" && "code" in error
                  ? String(error.code)
                  : "no-code",
              );
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
            if (signin.status !== 200) {
              const body = (await signin.json().catch(() => null)) as {
                code?: unknown;
              } | null;
              assert.fail(
                `Isolated sign-in HTTP ${signin.status}; code=${typeof body?.code === "string" ? body.code : "unclassified"}`,
              );
            }
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
            const input = policyFixture.request(actor.userId, {
              binding: e.binding,
              eventId: randomUUID(),
              candidate: e.manifest.candidate,
              evidenceDigest: e.evidenceDigest,
              action: "deploy_preview",
              target: "local-isolated-filesystem",
              targetEnvironment: "local-contract",
              expiresAt: new Date(Date.now() + 600000).toISOString(),
            }, e);
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
            const published = await fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify({
                operation: "publish",
                input: {
                  approvalId: approval.approvalId,
                  binding: approval.binding,
                  action: input.action,
                  target: input.target,
                  targetEnvironment: input.targetEnvironment,
                  eventId: randomUUID(),
                },
              }),
            });
            assert.equal(published.status, 200);
            const publication = await published.json();
            assert.match(publication.receipt.reference, /^local-artifact:/);
            assert.equal(
              publication.receipt.verifiedTarget.sha,
              input.candidate.sha,
            );
            assert.deepEqual(
              JSON.parse(
                await readFile(
                  join(targetDirectory, `${publication.publicationId}.json`),
                  "utf8",
                ),
              ).candidate,
              input.candidate,
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
              publicationId: publication.publicationId,
              eventId: input.eventId,
              request:
                "HTTP cookie read/approve/local-publish/readback/sign-out",
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
