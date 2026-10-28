import { assertRetainedMigrationBootstrap } from '../../scripts/test-retention.mjs'
if(process.env.CI==='true'||process.env.FACTORY_LOCAL_DB_TESTS==='1'||Object.keys(process.env).some(name=>/^(FACTORY_|IMPROVEMENT_TEST_|DISPATCH_|RUN_DISPATCH_)/.test(name)&&process.env[name])) assertRetainedMigrationBootstrap()
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { FactoryError } from "./contract";
import { createFactoryStore, type FactoryTask } from "./store";
import { createFactoryDispatch } from "./dispatch";
import { factoryDispatchDatabase } from "./transaction";
import { insertRunOnce } from "../run-dispatch";
import { approvalGate, publishGate, createFactoryApprovals } from "./approval";
import { createLocalPublicationAdapter } from "./local-publication";
import {
  createFactoryCheckClaim,
  factoryCheckAssignment,
  isFactoryCheckRun,
} from "./checks";
import { createFactoryMonitor, monitorGate } from "./monitor";
import { createLocalMonitorProbe } from "./monitor-probe";

const local = process.env.FACTORY_MONITOR_DISPATCH_TEST_URL;
const dbURL =
  local ??
  (process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true"
    ? process.env.E2E_DATABASE_URL
    : undefined);
if (dbURL) {
  const url = new URL(dbURL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/mikka_e2e");
  if (local) assert.equal(url.username, "factorydispatch192");
}
const binding = (t: FactoryTask) => ({
  taskId: t.id,
  issueId: t.issueId,
  attemptId: t.attemptId,
  revision: t.revision,
  candidateId: t.candidateId,
});
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(
    fn,
    (e: unknown) => e instanceof FactoryError && e.code === code,
  );

test(
  "PG17 normal monitor dispatch: actual local publication receipt, readonly claim, queue replay/rollback and closed boundaries",
  { skip: !dbURL, timeout: 120000 },
  async (t) => {
    const schema = `monitor_dispatch_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: dbURL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: dbURL,
      max: 12,
      options: `-c search_path=${schema}`,
    });
    const root = await mkdtemp(join(tmpdir(), "factory-monitor-dispatch-"));
    const actor = { userId: "owner", sessionId: randomUUID() };
    const deviceId = randomUUID(),
      repoId = randomUUID(),
      agentId = randomUUID();
    const repository = "fixture/Mikka",
      target = "local-monitor-dispatch",
      environment = "local-monitor-acceptance";
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
    }).trim();
    const denied = new Set<string>();
    const authorize = async (owner: string, issue: string, tx: PoolClient) =>
      (
        await tx.query(
          `SELECT id FROM issues WHERE id=$1 AND "userId"=$2 AND content #>> '{attrs,mikka,deletedAt}' IS NULL FOR SHARE`,
          [issue, owner],
        )
      ).rowCount === 1 && !denied.has(issue);
    const store = createFactoryStore(pool, authorize, {
      approval: approvalGate,
      publish: publishGate,
      monitor: monitorGate,
    });
    const service = createFactoryApprovals(pool, authorize, store, [
      createLocalPublicationAdapter({
        root,
        target,
        repository,
        environment,
        candidateEnvironment: `device:${deviceId}`,
      }),
    ]);
    const dispatch = createFactoryDispatch(pool, store, (tx, owner, input) =>
      insertRunOnce(factoryDispatchDatabase(tx), owner, input, {
        deviceId,
        baseBranch: "main",
        prompt: "Explicit local Harness fixture",
      }),
    );
    const claim = createFactoryCheckClaim(pool, authorize);
    const monitor = createFactoryMonitor(
      pool,
      store,
      authorize,
      async () => "personal:owner",
      async () => {},
      [createLocalMonitorProbe({ root, target, repository, environment })],
    );
    const input = (task: FactoryTask) => ({
      binding: binding(task),
      agentId,
      deviceRepoId: repoId,
    });
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
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture owner','monitor-dispatch@example.invalid',true,now(),now())`,
      );
      await pool.query(
        `INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,'owner',$2,now()+interval '1 hour',now(),now())`,
        [actor.sessionId, `fixture-${randomUUID()}`],
      );
      await pool.query(
        `INSERT INTO account (id,"userId","providerId","accountId","createdAt","updatedAt") VALUES ($1,'owner','github','fixture-identity',now(),now())`,
        [randomUUID()],
      );
      await pool.query(
        `INSERT INTO devices (id,"ownerId",name,enabled,"lastSeenAt",harnesses) VALUES ($1,'owner','Fixture device',true,now(),'[{"harness":"codex","installed":true}]')`,
        [deviceId],
      );
      await pool.query(
        `INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","verifyCommand") VALUES ($1,$2,'owner',$3,$4,'git rev-parse HEAD')`,
        [
          repoId,
          deviceId,
          new URL("../..", import.meta.url).pathname,
          repository,
        ],
      );
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture agent','codex',$2)`,
        [agentId, deviceId],
      );
      const source = async (issueId: string, runId: string | null = null) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload) VALUES ($1,'owner',$2,$3,$4,$5,'{}')`,
          [id, runId ? "run_finished" : "user_message", id, issueId, runId],
        );
        return id;
      };
      const report = () => ({
        summary:
          "Harness conclusions are fixtures; actual local publication/probe",
        filesChanged: [],
        check: { sha, readOnly: true },
        verify: {
          status: "passed",
          command: "git rev-parse HEAD",
          exitCode: 0,
          signal: null,
          timedOut: false,
          output: sha,
        },
        openQuestions: [],
        nextStep: null,
        publish: {
          branch: "fixture",
          commit: sha,
          pushed: false,
          remote: null,
        },
      });
      // Only upstream conclusions and identity are seeded. 194 approval/evidence/publisher and the receipt reader execute normally.
      const fixture = async () => {
        const issueId = randomUUID();
        await pool.query(
          `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Monitor dispatch fixture','{}','todo','normal')`,
          [issueId],
        );
        const state = await store.route("owner", {
          issueId,
          sourceEventId: await source(issueId),
          eventId: randomUUID(),
          rationale: "Explicit local fixture",
        });
        const candidateId = randomUUID(),
          runIds = [randomUUID(), randomUUID(), randomUUID()];
        for (const id of runIds)
          await pool.query(
            `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"stopReason","sessionId","startedAt","finishedAt",report) VALUES ($1,'owner',$2,$3,$4,$5,'succeeded','submitted',$6,now()-interval '2 seconds',now(),$7)`,
            [
              id,
              issueId,
              agentId,
              deviceId,
              repoId,
              `session:${id}`,
              JSON.stringify(report()),
            ],
          );
        await pool.query(
          `INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,$4,$5,'backend-health',$6)`,
          [
            candidateId,
            state.task.id,
            sha,
            repository,
            `device:${deviceId}`,
            runIds[0],
          ],
        );
        for (const [index, stage] of [
          "execute",
          "review",
          "verify",
        ].entries()) {
          const id = index === 0 ? state.task.attemptId : randomUUID(),
            runId = runIds[index];
          const evidence = JSON.stringify([
            {
              artifact: `run-report:${runId}`,
              kind: "report",
              runId,
              sessionId: `session:${runId}`,
              candidateId,
              sha,
              environment: `device:${deviceId}`,
              recordedAt: new Date().toISOString(),
            },
          ]);
          if (index === 0)
            await pool.query(
              `UPDATE factory_attempts SET status='passed',"candidateId"=$2,"runId"=$3,"sessionId"=$4,evidence=$5,"finishedAt"=now() WHERE id=$1`,
              [id, candidateId, runId, `session:${runId}`, evidence],
            );
          else
            await pool.query(
              `INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"candidateId","runId","sessionId",reason,evidence,"finishedAt") VALUES ($1,$2,$3,1,$4,'passed',$5,$6,$7,'Upstream fixture',$8,now())`,
              [
                id,
                state.task.id,
                stage,
                index + 1,
                candidateId,
                runId,
                `session:${runId}`,
                evidence,
              ],
            );
        }
        const approvalAttempt = randomUUID();
        await pool.query(
          `INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"candidateId",reason) VALUES ($1,$2,'approval',1,4,'pending',$3,'Actual approval path')`,
          [approvalAttempt, state.task.id, candidateId],
        );
        await pool.query(
          `UPDATE factory_tasks SET stage='approval',status='pending',revision=5,"candidateId"=$2,"attemptId"=$3 WHERE id=$1`,
          [state.task.id, candidateId, approvalAttempt],
        );
        const evidence = await service.evidence(actor, state.task.id);
        const approval = await service.approve(actor, {
          binding: evidence.binding,
          eventId: randomUUID(),
          candidate: evidence.manifest.candidate,
          action: "deploy_preview",
          target,
          targetEnvironment: environment,
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          evidenceDigest: evidence.evidenceDigest,
          evidenceReadId: evidence.evidenceReadId,
        });
        const published = await service.publish(actor, {
          ...approval,
          eventId: randomUUID(),
          action: "deploy_preview",
          target,
          targetEnvironment: environment,
        });
      assert.ok(published, "Actual publisher must return a verified receipt");
        const current = await store.read("owner", state.task.id);
        const ready = await store.apply(
          "owner",
          binding(current.task),
          randomUUID(),
          {
            action: "advance",
            stage: "monitor",
            reason: "Actual local publication is complete",
          },
        );
        return {
          task: ready.task,
          approvalId: approval.approvalId,
          publicationId: published.publicationId,
        };
      };
      const queued = async (task: FactoryTask) =>
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1 AND "dispatchKey" IS NOT NULL`,
            [task.issueId],
          )
        ).rows[0].n;

      await t.test(
        "normal pending dispatch and ten replays create one receipt-bound readonly run; real probe consumes and next cycle dispatches",
        async () => {
          const fixtureState = await fixture(),
            task = fixtureState.task;
          const results = await Promise.all(
            Array.from({ length: 10 }, () => dispatch("owner", input(task))),
          );
          assert.equal(new Set(results.map((r) => r.runId)).size, 1);
          assert.equal(await queued(task), 1);
          const result = results[0];
          const run = (
            await pool.query(`SELECT * FROM agent_runs WHERE id=$1`, [
              result.runId,
            ])
          ).rows[0];
          assert.equal(run.kind, "acceptance");
          assert.equal(run.baseBranch, sha);
          const current = await store.read("owner", task.id);
          assert.equal(current.task.revision, task.revision + 1);
          assert.equal(current.task.status, "running");
          const metadata = current.attempts.find(
            (a) => a.id === task.attemptId,
          )!.output.monitorDispatch as {
            publication: { publicationId: string };
          };
          assert.equal(
            metadata.publication.publicationId,
            fixtureState.publicationId,
          );
          assert.equal(
            await isFactoryCheckRun(pool, "owner", result.runId),
            true,
          );
          const assignment = await claim(
            "owner",
            deviceId,
            result.runId,
            new Date(Date.now() + 60000).toISOString(),
          );
          assert.equal(assignment.policy.readOnly, true);
          assert.equal(assignment.policy.permissions.git_push, "deny");
          assert.equal(assignment.baseBranch, sha);
          await pool.query(
            `UPDATE agent_runs SET status='running',"sessionId"=$2 WHERE id=$1`,
            [result.runId, `session:${result.runId}`],
          );
          const audit = await monitor.probeRun("owner", result.runId);
          assert.equal(audit?.exitCode, 0);
          await pool.query(
            `UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"finishedAt"=clock_timestamp(),report=$2 WHERE id=$1`,
            [result.runId, JSON.stringify(report())],
          );
          const finished = await monitor.consume("owner", {
            binding: binding(current.task),
            sourceEventId: await source(task.issueId, result.runId),
          });
          assert.equal(finished.outcome, "passed");
          const passed = await store.read("owner", task.id);
          await rejects(
            () => dispatch("owner", input(task)),
            "factoryTransition",
          );
          const next = await store.apply(
            "owner",
            binding(passed.task),
            randomUUID(),
            { action: "retry", reason: "Next observation" },
          );
          const second = await dispatch("owner", input(next.task));
          assert.notEqual(second.runId, result.runId);
          assert.equal(await queued(task), 2);
          assert.deepEqual(
            (await store.read("owner", task.id)).attempts.find(
              (a) => a.id === task.attemptId,
            ),
            passed.attempts.find((a) => a.id === task.attemptId),
          );
        },
      );

      await t.test(
        "missing/uncertain/revoked/changed receipt and malformed publish evidence fail before queue",
        async () => {
          for (const tamper of [
            "missing",
            "uncertain",
            "revoked",
            "sha",
            "environment",
            "publish-output",
          ]) {
            const f = await fixture();
            if (tamper === "missing")
              await pool.query(
                `UPDATE factory_publications SET receipt=NULL WHERE id=$1`,
                [f.publicationId],
              );
            if (tamper === "uncertain")
              await pool.query(
                `UPDATE factory_publications SET status='uncertain' WHERE id=$1`,
                [f.publicationId],
              );
            if (tamper === "revoked")
              await pool.query(
                `UPDATE factory_approvals SET "revokedAt"=now() WHERE id=$1`,
                [f.approvalId],
              );
            if (tamper === "sha")
              await pool.query(
                `UPDATE factory_publications SET receipt=jsonb_set(receipt,'{verifiedTarget,sha}',to_jsonb($2::text)) WHERE id=$1`,
                [f.publicationId, "b".repeat(40)],
              );
            if (tamper === "environment")
              await pool.query(
                `UPDATE factory_publications SET receipt=jsonb_set(receipt,'{verifiedTarget,environment}','"local-other"') WHERE id=$1`,
                [f.publicationId],
              );
            if (tamper === "publish-output")
              await pool.query(
                `UPDATE factory_attempts SET output='{}' WHERE "taskId"=$1 AND stage='publish'`,
                [f.task.id],
              );
            await assert.rejects(
              () => dispatch("owner", input(f.task)),
              (e) => e instanceof FactoryError,
            );
            assert.equal(await queued(f.task), 0);
          }
        },
      );

      await t.test(
        "wrong owner/candidate, cancel/revoke, terminal stages and current authorization remain closed",
        async () => {
          const f = await fixture();
          await rejects(
            () => dispatch("other", input(f.task)),
            "factoryNotFound",
          );
          await rejects(
            () =>
              dispatch("owner", {
                ...input(f.task),
                binding: { ...binding(f.task), candidateId: randomUUID() },
              }),
            "factoryStale",
          );
          denied.add(f.task.issueId);
          await rejects(
            () => dispatch("owner", input(f.task)),
            "factoryNotFound",
          );
          denied.delete(f.task.issueId);
          assert.equal(await queued(f.task), 0);
          await pool.query(
            `UPDATE issues SET content='{"attrs":{"mikka":{"deletedAt":"2026-10-25T00:00:00Z"}}}' WHERE id=$1`,
            [f.task.issueId],
          );
          await rejects(
            () => dispatch("owner", input(f.task)),
            "factoryNotFound",
          );
          for (const action of ["cancel", "revoke"] as const) {
            const stopped = await fixture();
            await store.apply("owner", binding(stopped.task), randomUUID(), {
              action,
              reason: "Explicit stop",
            });
            await rejects(
              () => dispatch("owner", input(stopped.task)),
              "factoryStopped",
            );
            assert.equal(await queued(stopped.task), 0);
          }
          for (const status of ["passed", "failed", "blocked", "waiting"]) {
            const terminal = await fixture();
            await pool.query(`UPDATE factory_tasks SET status=$2 WHERE id=$1`, [
              terminal.task.id,
              status,
            ]);
            await rejects(
              () => dispatch("owner", input(terminal.task)),
              "factoryTransition",
            );
            assert.equal(await queued(terminal.task), 0);
          }
        },
      );

      await t.test(
        "wrong repository/agent, replaced candidate and tampered claim metadata cannot execute",
        async () => {
          const wrongRepo = randomUUID(),
            wrongAgent = randomUUID();
          await pool.query(
            `INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","verifyCommand") VALUES ($1,$2,'owner','/other','other/repo','git rev-parse HEAD')`,
            [wrongRepo, deviceId],
          );
          await pool.query(
            `INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'other','Foreign fixture','codex',$2)`,
            [wrongAgent, deviceId],
          );
          for (const override of [
            { deviceRepoId: wrongRepo },
            { agentId: wrongAgent },
          ]) {
            const f = await fixture();
            await rejects(
              () => dispatch("owner", { ...input(f.task), ...override }),
              "factoryEvidenceMismatch",
            );
            assert.equal(await queued(f.task), 0);
          }
          const f = await fixture(),
            dispatched = await dispatch("owner", input(f.task));
          await pool.query(
            `UPDATE factory_attempts SET output=jsonb_set(output,'{monitorDispatch,publication,publicationId}',to_jsonb($2::text)) WHERE id=$1`,
            [f.task.attemptId, randomUUID()],
          );
          await rejects(
            () =>
              claim(
                "owner",
                deviceId,
                dispatched.runId,
                new Date(Date.now() + 60000).toISOString(),
              ),
            "factoryCheckBindingMismatch",
          );
          const replaced = await fixture();
          await dispatch("owner", input(replaced.task));
          const replacement = randomUUID();
          await pool.query(
            `INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId") SELECT $1,"taskId",sha,repository,environment,scope,"runId" FROM factory_candidates WHERE id=$2`,
            [replacement, replaced.task.candidateId],
          );
          await pool.query(
            `UPDATE factory_tasks SET "candidateId"=$2,revision=revision+1 WHERE id=$1`,
            [replaced.task.id, replacement],
          );
          await pool.query(
            `UPDATE factory_attempts SET "candidateId"=$2 WHERE id=$1`,
            [replaced.task.attemptId, replacement],
          );
          await rejects(
            () => dispatch("owner", input(replaced.task)),
            "factoryStale",
          );
          assert.equal(await queued(replaced.task), 1);
        },
      );

      await t.test(
        "claim and replay recheck approval revocation; consumed approval expiry does not invent a new grant",
        async () => {
          const f = await fixture();
          await pool.query(
            `UPDATE factory_approvals SET "expiresAt"=now()-interval '1 second' WHERE id=$1`,
            [f.approvalId],
          );
          const result = await dispatch("owner", input(f.task));
          await pool.query(
            `UPDATE factory_approvals SET "revokedAt"=now() WHERE id=$1`,
            [f.approvalId],
          );
          await rejects(
            () =>
              claim(
                "owner",
                deviceId,
                result.runId,
                new Date(Date.now() + 60000).toISOString(),
              ),
            "factoryPublicationReceiptRequired",
          );
          await rejects(
            () => dispatch("owner", input(f.task)),
            "factoryPublicationReceiptRequired",
          );
          assert.equal(
            (
              await pool.query(`SELECT status FROM agent_runs WHERE id=$1`, [
                result.runId,
              ])
            ).rows[0].status,
            "queued",
          );
        },
      );

      await t.test(
        "real SQL interruption rolls queue/metadata/binding back; reconnect replay returns same committed run",
        async () => {
          const f = await fixture();
          await pool.query(
            `CREATE FUNCTION reject_monitor_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected monitor dispatch interruption'; END $$`,
          );
          await pool.query(
            `CREATE TRIGGER reject_monitor_dispatch BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION reject_monitor_dispatch()`,
          );
          await assert.rejects(
            () => dispatch("owner", input(f.task)),
            /injected monitor dispatch interruption/,
          );
          assert.equal(await queued(f.task), 0);
          const state = await store.read("owner", f.task.id);
          assert.equal(state.task.revision, f.task.revision);
          assert.deepEqual(
            state.attempts.find((a) => a.id === f.task.attemptId)!.output,
            {},
          );
          await pool.query(
            "ALTER TABLE factory_events DISABLE TRIGGER reject_monitor_dispatch",
          );
          const result = await dispatch("owner", input(f.task));
          const other = new Pool({
            connectionString: dbURL,
            options: `-c search_path=${schema}`,
          });
          try {
            const restarted = createFactoryDispatch(
              other,
              createFactoryStore(other, authorize),
              (tx, owner, request) =>
                insertRunOnce(factoryDispatchDatabase(tx), owner, request, {
                  deviceId,
                  baseBranch: "main",
                  prompt: "Explicit local Harness fixture",
                }),
            );
            assert.equal(
              (await restarted("owner", input(f.task))).runId,
              result.runId,
            );
            assert.equal(await queued(f.task), 1);
          } finally {
            await other.end();
          }
          assert.equal(
            (await factoryCheckAssignment(pool, "owner", result.runId)).policy
              .readOnly,
            true,
          );
        },
      );
    } finally {
      await pool.end();
      // Retain this test-owned schema and its records for audit.
      await admin.end();
    // Retain this test-owned directory and its files for audit.
    }
  },
);
