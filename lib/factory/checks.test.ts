import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { FactoryError, type FactoryBinding } from "./contract";
import { createFactoryStore, type FactoryTask } from "./store";
import { createFactoryDispatch } from "./dispatch";
import { createFactoryReconciler } from "./reconcile";
import {
  createFactoryCheckClaim,
  factoryCheckAssignment,
  factoryCheckGates,
  isFactoryCheckRun,
} from "./checks";
import { factoryDispatchDatabase } from "./transaction";
import { insertRunOnce } from "../run-dispatch";

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
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(
    fn,
    (e: unknown) => e instanceof FactoryError && e.code === code,
  );

test(
  "PG17 check integration: atomic dispatch, frozen commands, independent provenance, repair/new SHA, restart and closed downstream gates (fixture run reports)",
  { skip: !dbURL, timeout: 120000 },
  async () => {
    const schema = `factory_193_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: dbURL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: dbURL,
      max: 12,
      options: `-c search_path=${schema}`,
    });
    try {
      const dir = new URL("../../drizzle/", import.meta.url);
      for (const file of orderMigrations(
        (await readdir(dir)).filter((n) => n.endsWith(".sql")),
      ))
        await pool.query(await readFile(new URL(file, dir), "utf8"));
      const issueId = randomUUID(),
        agentId = randomUUID(),
        deviceId = randomUUID(),
        repoId = randomUUID();
      await pool.query(
        `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Independent check fixture','{}','todo','normal')`,
        [issueId],
      );
      await pool.query(
        `INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Isolated PG fixture',now(),'[{"harness":"codex","installed":true,"version":"fixture"}]')`,
        [deviceId],
      );
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture Codex','codex',$2)`,
        [agentId, deviceId],
      );
      await pool.query(
        `INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl","verifyCommand") VALUES ($1,$2,'owner','/fixture/repo','https://example.invalid/factory.git','node acceptance.mjs')`,
        [repoId, deviceId],
      );
      const authorize = async (user: string, issue: string) =>
        user === "owner" && issue === issueId;
      const store = createFactoryStore(pool, authorize, factoryCheckGates);
      const dispatcher = createFactoryDispatch(pool, store, (tx, user, input) =>
        insertRunOnce(factoryDispatchDatabase(tx), user, input, {
          deviceId,
          baseBranch: "main",
          prompt: "Fixture issue with explicit criterion",
        }),
      );
      const reconcile = createFactoryReconciler(pool, store);
      const route = async () => {
        const sourceEventId = randomUUID();
        await pool.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{}')`,
          [sourceEventId, `fixture:${sourceEventId}`],
        );
        return store.route("owner", {
          issueId,
          sourceEventId,
          eventId: randomUUID(),
          rationale: "Explicit fixture request",
        });
      };
      const dispatch = (task: FactoryTask) =>
        dispatcher("owner", {
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
        return { report, sessionId };
      };
      const sha1 = "1".repeat(40),
        sha2 = "2".repeat(40);
      const initial = await route();
      const implement = await dispatch(initial.task);
      await complete(implement.runId, sha1);
      await reconcile("owner");
      let state = await store.read("owner", initial.task.id);
      assert.equal(state.task.stage, "review");
      const reviewBinding = binding(state.task);
      const reviews = await Promise.all(
        Array.from({ length: 10 }, () => dispatch(state.task)),
      );
      assert.equal(new Set(reviews.map((r) => r.runId)).size, 1);
      const review = reviews[0];
      assert.notEqual(review.runId, implement.runId);
      const assignment = await factoryCheckAssignment(
        pool,
        "owner",
        review.runId,
      );
      assert.equal(assignment.baseBranch, sha1);
      assert.equal(assignment.policy.readOnly, true);
      const claim = createFactoryCheckClaim(pool, authorize);
      assert.equal(await isFactoryCheckRun(pool, "owner", review.runId), true);
      const claims = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          claim(
            "owner",
            deviceId,
            review.runId,
            new Date(Date.now() + 90000).toISOString(),
          ),
        ),
      );
      assert.equal(claims.filter((r) => r.status === "fulfilled").length, 1);

      await rejects(
        () => factoryCheckAssignment(pool, "foreign", review.runId),
        "factoryCheckBindingMismatch",
      );
      await pool.query(
        `UPDATE device_repos SET "verifyCommand"='mutated command' WHERE id=$1`,
        [repoId],
      );
      assert.equal(
        (await factoryCheckAssignment(pool, "owner", review.runId))
          .verifyCommand,
        "node acceptance.mjs",
      );
      await pool.query(
        `UPDATE device_repos SET "verifyCommand"='node acceptance.mjs' WHERE id=$1`,
        [repoId],
      );
      await complete(review.runId, sha1);
      await reconcile("owner");
      state = await store.read("owner", state.task.id);
      assert.equal(state.task.stage, "verify");
      await rejects(
        () =>
          store.apply("owner", reviewBinding, randomUUID(), {
            action: "finish",
            status: "passed",
            reason: "stale",
            evidence: [],
            output: {},
          }),
        "factoryStale",
      );
      const verify = await dispatch(state.task);
      await complete(verify.runId, sha1, { failed: true });
      // Fresh reconciler simulates process restart reading durable run state.
      await createFactoryReconciler(
        pool,
        createFactoryStore(pool, authorize, factoryCheckGates),
      )("owner");
      state = await store.read("owner", state.task.id);
      assert.equal(state.task.stage, "execute");
      assert.equal(state.task.candidateId, null);
      const failure = state.attempts.find((a) => a.stage === "verify")!;
      assert.equal(failure.status, "failed");
      assert.equal((failure.output.completion as any).verify.exitCode, 1);
      assert.equal(failure.evidence.length, 3);
      const repair = await dispatch(state.task);
      const repairRun = (
        await pool.query(`SELECT prompt FROM agent_runs WHERE id=$1`, [
          repair.runId,
        ])
      ).rows[0];
      assert.match(repairRun.prompt, /AssertionError: expected 2/);
      assert.match(repairRun.prompt, new RegExp(verify.runId));
      await complete(repair.runId, sha2);
      await reconcile("owner");
      state = await store.read("owner", state.task.id);
      assert.equal(state.task.stage, "review");
      assert.notEqual(state.task.candidateId, review.task.candidateId);
      for (const stage of ["review", "verify"]) {
        assert.equal(state.task.stage, stage);
        const check = await dispatch(state.task);
        assert.equal(
          (await factoryCheckAssignment(pool, "owner", check.runId)).baseBranch,
          sha2,
        );
        await complete(check.runId, sha2);
        await reconcile("owner");
        state = await store.read("owner", state.task.id);
      }
      assert.equal(state.task.stage, "approval");
      assert.equal(state.task.status, "pending");
      await rejects(
        () =>
          store.apply("owner", binding(state.task), randomUUID(), {
            action: "finish",
            status: "passed",
            reason: "must stay closed",
            evidence: [],
            output: {},
          }),
        "factoryConsumerGateRequired",
      );
      const total = state.attempts.length;
      await reconcile("owner");
      assert.equal(
        (await store.read("owner", state.task.id)).attempts.length,
        total,
      );

      // Every bad receipt/session is rejected and retained as blocked, never implicitly passed.
      for (const options of [
        { checkSha: sha2 },
        { selfReport: true },
        { sessionId: "reused" },
        { command: "different" },
        { noCriteria: true },
        { timeout: true },
        { noTimes: true },
      ]) {
        const t = await route(),
          impl = await dispatch(t.task);
        await complete(impl.runId, sha1, { sessionId: "reused" });
        await reconcile("owner");
        const s = await store.read("owner", t.task.id),
          check = await dispatch(s.task);
        await complete(check.runId, sha1, options);
        await reconcile("owner");
        const blocked = await store.read("owner", t.task.id);
        assert.equal(blocked.task.stage, "review");
        assert.equal(blocked.task.status, "blocked");
        await reconcile("owner");
        assert.equal(
          (await store.read("owner", t.task.id)).attempts.length,
          blocked.attempts.length,
        );
      }
      // Automatic repair is bounded; a person sees the original failure and takeover reason.
      const bounded = await route();
      let boundedState = bounded;
      for (let round = 0; round < 4; round++) {
        const sha = String(round + 4).repeat(40);
        const execute = await dispatch(boundedState.task);
        await complete(execute.runId, sha);
        await reconcile("owner");
        boundedState = await store.read("owner", bounded.task.id);
        const check = await dispatch(boundedState.task);
        await complete(check.runId, sha, { failed: true });
        await reconcile("owner");
        boundedState = await store.read("owner", bounded.task.id);
        assert.equal(boundedState.task.stage, round < 3 ? "execute" : "review");
      }
      assert.equal(boundedState.task.status, "failed");
      assert.match(
        boundedState.task.reason,
        /repair limit reached; manual takeover/,
      );
      const unchanged = await route();
      let same = unchanged;
      const firstExecute = await dispatch(same.task);
      await complete(firstExecute.runId, sha1);
      await reconcile("owner");
      same = await store.read("owner", same.task.id);
      const bad = await dispatch(same.task);
      await complete(bad.runId, sha1, { failed: true });
      await reconcile("owner");
      same = await store.read("owner", same.task.id);
      const unchangedRepair = await dispatch(same.task);
      await complete(unchangedRepair.runId, sha1);
      await reconcile("owner");
      same = await store.read("owner", same.task.id);
      await rejects(
        () => dispatch(same.task),
        "factoryCheckUnchangedCandidate",
      );
      assert.equal(
        (await store.read("owner", same.task.id)).task.status,
        "blocked",
      );

      const findingTask = await route();
      const findingImpl = await dispatch(findingTask.task);
      await complete(findingImpl.runId, sha1);
      await reconcile("owner");
      let found = await store.read("owner", findingTask.task.id);
      const findingReview = await dispatch(found.task);
      await complete(findingReview.runId, sha1, { finding: true });
      await reconcile("owner");
      found = await store.read("owner", found.task.id);
      assert.equal(found.task.stage, "execute");
      const findingRepair = await dispatch(found.task);
      assert.match(
        (
          await pool.query(`SELECT prompt FROM agent_runs WHERE id=$1`, [
            findingRepair.runId,
          ])
        ).rows[0].prompt,
        /ORIGINAL_REVIEW_EVIDENCE/,
      );
      await pool.query(`UPDATE agent_runs SET status='cancelled' WHERE id=$1`, [
        findingRepair.runId,
      ]);

      const cancelled = await route();
      const cancelledExecute = await dispatch(cancelled.task);
      await complete(cancelledExecute.runId, sha1);
      await reconcile("owner");
      const cancelState = await store.read("owner", cancelled.task.id);
      const cancelledCheck = await dispatch(cancelState.task);
      await store.apply("owner", binding(cancelledCheck.task), randomUUID(), {
        action: "cancel",
        reason: "Withdrawn during claim",
      });
      await rejects(
        () =>
          claim(
            "owner",
            deviceId,
            cancelledCheck.runId,
            new Date(Date.now() + 90000).toISOString(),
          ),
        "factoryCheckBindingMismatch",
      );
      assert.equal(
        (
          await pool.query(`SELECT status FROM agent_runs WHERE id=$1`, [
            cancelledCheck.runId,
          ])
        ).rows[0].status,
        "queued",
      );
      await pool.query(`UPDATE agent_runs SET status='cancelled' WHERE id=$1`, [
        cancelledCheck.runId,
      ]);

      const inspectionOnly = await route();
      const inspectImpl = await dispatch(inspectionOnly.task);
      await complete(inspectImpl.runId, sha1);
      await reconcile("owner");
      let inspected = await store.read("owner", inspectionOnly.task.id);
      const inspectReview = await dispatch(inspected.task);
      await complete(inspectReview.runId, sha1);
      await reconcile("owner");
      inspected = await store.read("owner", inspected.task.id);
      const inspection = await dispatch(inspected.task);
      await complete(inspection.runId, sha1, { noRuntime: true });
      await reconcile("owner");
      inspected = await store.read("owner", inspected.task.id);
      assert.equal(inspected.task.stage, "verify");
      assert.equal(inspected.task.status, "blocked");

      const noHarness = await route();
      const harnessImpl = await dispatch(noHarness.task);
      await complete(harnessImpl.runId, sha1);
      await reconcile("owner");
      const noHarnessState = await store.read("owner", noHarness.task.id);
      await pool.query(`UPDATE devices SET harnesses='[]' WHERE id=$1`, [
        deviceId,
      ]);
      await rejects(
        () => dispatch(noHarnessState.task),
        "factoryCheckHarnessUnavailable",
      );
      const noHarnessBlocked = await store.read("owner", noHarness.task.id);
      assert.equal(noHarnessBlocked.task.status, "blocked");
      assert.match(
        noHarnessBlocked.task.reason,
        /factoryCheckHarnessUnavailable/,
      );
      await pool.query(
        `UPDATE devices SET harnesses='[{"harness":"codex","installed":true,"version":"fixture"}]' WHERE id=$1`,
        [deviceId],
      );

      const missing = await route(),
        impl = await dispatch(missing.task);
      await complete(impl.runId, sha1);
      await reconcile("owner");
      const pending = await store.read("owner", missing.task.id);
      await pool.query(
        `UPDATE device_repos SET "verifyCommand"=NULL WHERE id=$1`,
        [repoId],
      );
      await rejects(
        () => dispatch(pending.task),
        "factoryCheckCommandRequired",
      );
      assert.equal(
        (await store.read("owner", pending.task.id)).task.status,
        "blocked",
      );
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS n FROM agent_runs WHERE "dispatchKey"=$1`,
            [`factory:${pending.task.id}:${pending.task.attemptId}`],
          )
        ).rows[0].n,
        0,
      );
      // Runtime identities belong only in an explicitly selected private local artifact.
      if (
        process.env.GITHUB_ACTIONS !== "true" &&
        process.env.FACTORY_EVIDENCE_OUT
      ) {
        await mkdir(process.env.FACTORY_EVIDENCE_OUT, { recursive: true });
        await writeFile(
          join(process.env.FACTORY_EVIDENCE_OUT, "factory-checks-pg17.json"),
          JSON.stringify(
            {
              layer: "real PG17 with explicit fixture Harness reports",
              schema,
              taskId: state.task.id,
              candidates: state.candidates,
              attempts: state.attempts.map((a) => ({
                id: a.id,
                stage: a.stage,
                status: a.status,
                runId: a.runId,
                sessionId: a.sessionId,
              })),
              failedCommand: failure.output,
              preview: "deployment denied/pending; no retry",
              finalAcceptance: false,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
