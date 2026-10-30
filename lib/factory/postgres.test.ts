import { factoryTestLifecycle } from "../../tests/helpers/factory-test-authority";
import { isolatedPostgresURL } from "../../tests/helpers/isolated-postgres.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import {
  FACTORY_STAGES,
  FactoryError,
  type FactoryBinding,
  type FactoryChange,
} from "./contract";
import { handleFactory } from "./http";
import { createFactoryStore, type FactoryTask } from "./store";
import { createFactoryDispatch } from "./dispatch";
import { factoryDispatchDatabase } from "./transaction";
import { createExecutionClaim } from "./execution-claim";
import { createFactoryReconciler } from "./reconcile";
import { insertRunOnce } from "../run-dispatch";
import { runPrompt } from "../run-prompt";
import { tiptapToText } from "../tiptap-text";
import { digest } from "../agent-kit/definition";

const localDB = process.env.FACTORY_TEST_DATABASE_URL;
if (localDB) {
  const url = new URL(localDB);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55493");
  assert.equal(url.pathname, "/factory193");
}
const dbURL =
  localDB ??
  (process.env.FACTORY_LOCAL_DB_TESTS === "1" ||
  (process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true")
    ? process.env.E2E_DATABASE_URL
    : undefined);
if (dbURL && !localDB) {
  const url = new URL(dbURL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/mikka_e2e");
}
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

test(
  "PG17: routing, 10-way replay/CAS, actual SQL rollback/reconnect, attempts, candidate fences and API isolation",
  { skip: !dbURL, timeout: 120000 },
  async () => {
    const fixtureURL = await isolatedPostgresURL(dbURL!);
    const schema = `factory_192_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: fixtureURL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: fixtureURL,
      max: 12,
      options: `-c search_path=${schema}`,
    });
    const authorize = async (
      userId: string,
      issueId: string,
      tx: import("pg").PoolClient,
    ) => {
      const { rows } = await tx.query(
        "SELECT id FROM issues WHERE id=$1 AND \"userId\"=$2 AND content #>> '{attrs,mikka,deletedAt}' IS NULL FOR SHARE",
        [issueId, userId],
      );
      return rows.length === 1;
    };
    const store = createFactoryStore(pool, authorize, null, factoryTestLifecycle);
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
      )) {
        await pool.query(await readFile(new URL(file, dir), "utf8"));
      }
      const migration = await readFile(
        new URL("20261029044003_factory_192_stages.sql", dir),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
      const issueId = randomUUID(),
        otherIssueId = randomUUID(),
        agentId = randomUUID();
      const issueBody = "Describe the fixture change and its acceptance criterion";
      const instructions = "Keep the fixture plan within the original issue scope";
      await pool.query(
        `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Factory test',$3,'todo','normal'),($2,'other','Foreign issue','{}','todo','normal')`,
        [issueId, otherIssueId, JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: issueBody }] }] })],
      );
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness,instructions) VALUES ($1,'owner','Factory fixture','codex',$2)`,
        [agentId, instructions],
      );
      const source = async (owner = "owner") => {
        const id = randomUUID();
        await pool.query(
          'INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,\'user_message\',$3,\'{"text":"fixture request"}\')',
          [id, owner, `factory-fixture:${id}`],
        );
        return id;
      };
      const route = async (extra = {}) =>
        store.route("owner", {
          issueId,
          eventId: randomUUID(),
          sourceEventId: await source(),
          rationale: "Explicit fixture request",
          ...extra,
        });
      let state = await route();
      assert.equal(state.task.stage, "execute");
      assert.equal(state.task.status, "pending");
      await rejects(() => createFactoryStore(pool, authorize).apply("owner", binding(state.task), randomUUID(), {
        action: "finish", status: "blocked", reason: "No lifecycle consumer installed", evidence: [], output: {},
      }), "factoryTransitionUnavailable");
      const initial = binding(state.task);
      await rejects(
        () => store.read("other", state.task.id),
        "factoryNotFound",
      );
      await rejects(
        () =>
          store.apply(
            "owner",
            { ...initial, issueId: otherIssueId },
            randomUUID(),
            { action: "cancel", reason: "foreign" },
          ),
        "factoryNotFound",
      );
      await rejects(
        () =>
          store.route("owner", {
            issueId,
            eventId: randomUUID(),
            sourceEventId: randomUUID(),
            rationale: "missing",
          }),
        "factorySourceMismatch",
      );
      const otherSource = await source("other");
      await rejects(
        () =>
          store.route("owner", {
            issueId,
            eventId: randomUUID(),
            sourceEventId: otherSource,
            rationale: "foreign",
          }),
        "factorySourceMismatch",
      );
      const ambiguous = await route({
        missingInformation: ["Which target?"],
        missingPermissions: ["Target write grant"],
      });
      assert.equal(ambiguous.task.stage, "clarify");
      assert.equal(ambiguous.task.status, "waiting");
      assert.deepEqual(ambiguous.task.route.missingInformation, [
        "Which target?",
      ]);
      const resolved = await store.apply(
        "owner",
        binding(ambiguous.task),
        randomUUID(),
        {
          action: "resolve",
          sourceEventId: await source(),
          rationale:
            "Answered target; dispatch must still enforce actual grants",
          missingInformation: [],
          missingPermissions: [],
          needsSpec: false,
        },
      );
      assert.equal(resolved.task.stage, "execute");
      assert.equal(resolved.attempts.length, 2);
      assert.equal(resolved.attempts[0].status, "passed");
      const spec = await route({ needsSpec: true });
      assert.equal(spec.task.stage, "spec");
      const deviceId = randomUUID(),
        repoId = randomUUID();
      await pool.query(
        "INSERT INTO devices (id,\"ownerId\",name) VALUES ($1,'owner','CI fixture device')",
        [deviceId],
      );
      await pool.query(
        'INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,\'owner\',\'/fixture/repo\',\'https://example.invalid/fixture.git\')',
        [repoId, deviceId],
      );
      const dispatcher = createFactoryDispatch(
        pool,
        store,
        async (tx, userId, input, botId, context) => {
          const { rows: [issue] } = await tx.query('SELECT title,content FROM issues WHERE id=$1 AND "userId"=$2', [input.issueId, userId]);
          const { rows: [agent] } = await tx.query('SELECT instructions FROM agents WHERE id=$1 AND "userId"=$2', [input.agentId, userId]);
          assert.ok(issue && agent);
          return insertRunOnce(factoryDispatchDatabase(tx), userId, { ...input, requestKey: `factory:${context.attemptId}` }, {
            deviceId,
            baseBranch: "main",
            botId,
            prompt: runPrompt(issue.title, tiptapToText(issue.content), agent.instructions, input.note),
          });
        },
      );
      const planningNote = "Plan the fixture change before implementation";
      const planned = await dispatcher("owner", {
        binding: binding(spec.task),
        agentId,
        deviceRepoId: repoId,
        note: planningNote,
      });
      const planRun = (
        await pool.query('SELECT kind,prompt,"agentDefinition","dispatchKey" FROM agent_runs WHERE id=$1', [
          planned.runId,
        ])
      ).rows[0];
      assert.equal(planRun.kind, "plan");
      assert.equal(planRun.prompt, runPrompt("Factory test", issueBody, instructions, planningNote));
      assert.equal(planRun.agentDefinition.promptDigest, digest(planRun.prompt));
      assert.equal(planRun.agentDefinition.instructions, instructions);
      assert.equal(planRun.dispatchKey, `factory:${spec.task.attemptId}`);
      await pool.query(
        'UPDATE agent_runs SET status=\'succeeded\',"stopReason"=\'submitted\',"sessionId"=$2,report=$3,"finishedAt"=now() WHERE id=$1',
        [
          planned.runId,
          `plan-${randomUUID()}`,
          JSON.stringify({
            summary: "Persisted planning fixture output",
            verify: { status: "not_run" },
          }),
        ],
      );
      const reconcile = createFactoryReconciler(pool, store);
      await reconcile("owner");
      const plannedState = await store.read("owner", spec.task.id);
      assert.equal(plannedState.task.stage, "execute");
      assert.equal(plannedState.task.candidateId, null);
      await test("execution claim fences cancelled, revoked, stale and unadopted retry bindings", async () => {
        const claim = createExecutionClaim(pool, authorize);
        for (const mode of [
          "cancel",
          "revoke",
          "retry",
          "stale",
          "allowed",
          "race",
        ]) {
          const fixtureIssue = randomUUID();
          await pool.query(
            `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Claim fixture','{}','todo','normal')`,
            [fixtureIssue],
          );
          const initial = await route({
            issueId: fixtureIssue,
            needsSpec: mode !== "revoke",
          });
          const queued = await dispatcher("owner", {
            binding: binding(initial.task),
            agentId,
            deviceRepoId: repoId,
          });
          let state = await store.read("owner", initial.task.id);
          let runId = queued.runId;
          if (mode === "retry") {
            runId = randomUUID();
            await pool.query(
              `UPDATE agent_runs SET status='failed',"stopReason"='device_lost' WHERE id=$1`,
              [queued.runId],
            );
            await pool.query(
              `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"retryOf") VALUES ($1,'owner',$2,$3,$4,$5,'queued',$6)`,
              [runId, fixtureIssue, agentId, deviceId, repoId, queued.runId],
            );
            await rejects(
              () =>
                claim(
                  "owner",
                  deviceId,
                  runId,
                  new Date(Date.now() + 90000).toISOString(),
                ),
              "factoryRunMismatch",
            );
          }
          if (["cancel", "revoke", "retry"].includes(mode))
            await store.apply("owner", binding(state.task), randomUUID(), {
              action: mode === "revoke" ? "revoke" : "cancel",
              reason: "Fixture stop before claim",
            });
          if (mode === "stale")
            await store.apply("owner", binding(state.task), randomUUID(), {
              action: "finish",
              status: "blocked",
              reason: "Fixture old epoch",
              evidence: [],
              output: {},
            });
          const invoke = () =>
            claim(
              "owner",
              deviceId,
              runId,
              new Date(Date.now() + 90000).toISOString(),
            );
          if (mode === "race") {
            const tx = await pool.connect();
            await tx.query("BEGIN");
            await store.apply(
              "owner",
              binding(state.task),
              randomUUID(),
              {
                action: "cancel",
                reason: "Cancel owns task lock before claim",
              },
              tx,
            );
            const waiting = invoke().then(
              () => "claimed",
              (e) => e.code,
            );
            const blocker = (await tx.query("SELECT pg_backend_pid() AS pid"))
              .rows[0].pid;
            let blocked = false;
            for (let poll = 0; poll < 100 && !blocked; poll++) {
              blocked = (
                await pool.query(
                  "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked",
                  [blocker],
                )
              ).rows[0].blocked;
              if (!blocked)
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await tx.query("COMMIT");
            tx.release();
            assert.equal(
              blocked,
              true,
              "claim actually waited on the cancellation task lock",
            );
            assert.equal(await waiting, "factoryStopped");
          } else if (mode === "allowed") {
            assert.equal((await invoke()).length, 1);
            assert.equal((await invoke()).length, 0);
          } else {
            await rejects(invoke, "factoryStopped");
          }
          if (mode !== "allowed")
            assert.equal(
              (
                await pool.query(`SELECT status FROM agent_runs WHERE id=$1`, [
                  runId,
                ])
              ).rows[0].status,
              "queued",
            );
          state = await store.read("owner", initial.task.id);
          if (!["cancelled", "revoked"].includes(state.task.status))
            await store.apply("owner", binding(state.task), randomUUID(), {
              action: "cancel",
              reason: "Fixture cleanup",
            });
        }
      });
      const dispatchTask = await route();
      const dispatchInput = {
        binding: binding(dispatchTask.task),
        agentId,
        deviceRepoId: repoId,
        note: "same operation",
      };
      const queued = await Promise.all(
        Array.from({ length: 10 }, () => dispatcher("owner", dispatchInput)),
      );
      assert.equal(new Set(queued.map((r) => r.runId)).size, 1);
      assert.equal(queued.filter((r) => !r.replayed).length, 1);
      const beforeConflictingReplay = await store.read("owner", dispatchTask.task.id);
      const dispatchRunCount = Number((await pool.query('SELECT count(*) FROM agent_runs WHERE "issueId"=$1', [issueId])).rows[0].count);
      // The composed dispatcher rejects a changed request at its own receipt
      // boundary, before it can reach the downstream queue's key check.
      await rejects(
        () =>
          dispatcher("owner", { ...dispatchInput, note: "changed request" }),
        "factoryReplayMismatch",
      );
      assert.deepEqual(await store.read("owner", dispatchTask.task.id), beforeConflictingReplay);
      assert.equal(Number((await pool.query('SELECT count(*) FROM agent_runs WHERE "issueId"=$1', [issueId])).rows[0].count), dispatchRunCount);
      let dispatched = await store.read("owner", dispatchTask.task.id);
      await store.apply("owner", binding(dispatched.task), randomUUID(), {
        action: "cancel",
        reason: "Cancel dispatched fixture",
      });
      await rejects(() => dispatcher("owner", dispatchInput), "factoryStopped");
      await pool.query("UPDATE agent_runs SET status='cancelled' WHERE id=$1", [
        queued[0].runId,
      ]);
      // Abort after #191 inserted the run but before stage-event commit.
      const dispatchRollback = await route();
      await pool.query(
        `CREATE FUNCTION factory_dispatch_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected dispatch interruption'; END $$`,
      );
      await pool.query(
        "CREATE TRIGGER factory_inject_dispatch BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION factory_dispatch_fail()",
      );
      await assert.rejects(
        () =>
          dispatcher("owner", {
            ...dispatchInput,
            binding: binding(dispatchRollback.task),
          }),
        /injected dispatch/,
      );
      await pool.query(
        "DROP TRIGGER factory_inject_dispatch ON factory_events",
      );
      assert.equal(
        (
          await pool.query('SELECT id FROM agent_runs WHERE "dispatchKey"=$1', [
            `factory:${dispatchRollback.task.attemptId}`,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (await store.read("owner", dispatchRollback.task.id)).attempts[0].runId,
        null,
      );
      const dispatchedRetry = await dispatcher("owner", {
        ...dispatchInput,
        binding: binding(dispatchRollback.task),
      });
      const completionSha = "c".repeat(40),
        completionSession = `complete-${randomUUID()}`;
      await pool.query(
        'UPDATE agent_runs SET status=\'succeeded\',"stopReason"=\'submitted\',"sessionId"=$2,report=$3,"finishedAt"=now() WHERE id=$1',
        [
          dispatchedRetry.runId,
          completionSession,
          JSON.stringify({
            summary: "CI completion fixture",
            verify: { status: "passed" },
            publish: { commit: completionSha },
          }),
        ],
      );
      assert.equal((await reconcile("owner")).recovered, 1);
      dispatched = await store.read("owner", dispatchRollback.task.id);
      assert.equal(dispatched.task.stage, "review");
      assert.equal(dispatched.task.status, "pending");
      assert.equal(dispatched.candidates[0].sha, completionSha);
      assert.equal(dispatched.attempts[0].sessionId, completionSession);
      assert.equal((await reconcile("owner")).recovered, 0);
      const afterCompletionCount = (await pool.query("SELECT count(*) FROM agent_runs")).rows[0].count;
      await rejects(
        () => dispatcher("owner", {
            ...dispatchInput,
            binding: binding(dispatchRollback.task),
          }),
        "factoryStale",
      );
      assert.equal((await pool.query("SELECT count(*) FROM agent_runs")).rows[0].count, afterCompletionCount);
      const lost = await route();
      const lostRun = await dispatcher("owner", {
        ...dispatchInput,
        binding: binding(lost.task),
      });
      const childId = randomUUID(),
        childSession = `retry-${randomUUID()}`;
      await pool.query(
        "UPDATE agent_runs SET status='failed',\"stopReason\"='device_lost',error='fixture lost device',\"sessionId\"=$2 WHERE id=$1",
        [lostRun.runId, `lost-${randomUUID()}`],
      );
      await pool.query(
        `INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"stopReason","sessionId",report,"retryOf",attempt,"finishedAt",kind,"baseBranch","agentDefinition") SELECT $1,'owner',$2,$3,$4,$5,'succeeded','submitted',$6,$7,$8,2,clock_timestamp(),kind,"baseBranch","agentDefinition" FROM agent_runs WHERE id=$8`,
        [
          childId,
          issueId,
          agentId,
          deviceId,
          repoId,
          childSession,
          JSON.stringify({
            summary: "existing retry fixture",
            verify: { status: "passed" },
            publish: { commit: completionSha },
          }),
          lostRun.runId,
        ],
      );
      const runCountBeforeRecovery = (
        await pool.query("SELECT count(*) FROM agent_runs")
      ).rows[0].count;
      await reconcile("owner");
      const retried = await store.read("owner", lost.task.id);
      assert.equal(retried.task.stage, "review");
      assert.equal(retried.attempts[0].runId, lostRun.runId);
      assert.equal(retried.attempts[0].status, "failed");
      assert.equal(retried.attempts[1].runId, childId);
      assert.equal(retried.attempts[1].sessionId, childSession);
      assert.equal(
        (await pool.query("SELECT count(*) FROM agent_runs")).rows[0].count,
        runCountBeforeRecovery,
      );
      const external = await route(),
        externalRun = randomUUID();
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        await tx.query(
          `INSERT INTO agent_runs (id,"userId","issueId","agentId",status) VALUES ($1,'owner',$2,$3,'queued')`,
          [externalRun, issueId, agentId],
        );
        await store.apply(
          "owner",
          binding(external.task),
          randomUUID(),
          { action: "bind_run", runId: externalRun },
          tx,
        );
        await tx.query("ROLLBACK");
      } finally {
        tx.release();
      }
      assert.equal(
        (
          await pool.query("SELECT id FROM agent_runs WHERE id=$1", [
            externalRun,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (await store.read("owner", external.task.id)).attempts[0].runId,
        null,
      );
      const finish: FactoryChange = {
        action: "finish",
        status: "passed",
        reason: "Unsubstantiated claim",
        evidence: [],
        output: {},
      };
      await rejects(
        () => store.apply("owner", initial, randomUUID(), finish),
        "factoryEvidenceRequired",
      );
      const eid = randomUUID(),
        blocked: FactoryChange = {
          action: "finish",
          status: "blocked",
          reason: "No authorized Harness",
          evidence: [],
          output: {},
        };
      const ten = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.apply("owner", initial, eid, blocked),
        ),
      );
      assert.ok(ten.every((s) => s.task.revision === 2));
      assert.equal((await store.read("owner", state.task.id)).task.revision, 2);
      await rejects(
        () =>
          store.apply("owner", initial, eid, {
            ...blocked,
            reason: "changed replay",
          }),
        "factoryReplayMismatch",
      );
      await rejects(
        () => store.apply("owner", initial, randomUUID(), blocked),
        "factoryStale",
      );
      state = await store.read("owner", state.task.id);
      const recoveryBinding = binding(state.task);
      const races = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          store.apply("owner", recoveryBinding, randomUUID(), {
            action: "retry",
            reason: "Authorization restored",
          }),
        ),
      );
      assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
      state = await store.read("owner", state.task.id);
      assert.equal(state.attempts.length, 2);
      assert.equal(state.attempts[0].reason, "No authorized Harness");
      assert.equal(state.attempts[1].reason, "Authorization restored");
      await rejects(
        () => store.apply("owner", recoveryBinding, randomUUID(), blocked),
        "factoryStale",
      );
      // Actual PG error after state writes but before event ledger commit: all writes must roll back.
      await pool.query(
        `CREATE FUNCTION factory_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected precommit interruption'; END $$`,
      );
      await pool.query(
        "CREATE TRIGGER factory_inject BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION factory_fail_event()",
      );
      const before = await store.read("owner", state.task.id),
        rollbackEventId = randomUUID();
      await assert.rejects(
        () =>
          store.apply("owner", binding(state.task), rollbackEventId, blocked),
        /injected precommit/,
      );
      await pool.query("DROP TRIGGER factory_inject ON factory_events");
      assert.deepEqual(await store.read("owner", state.task.id), before);
      state = await store.apply(
        "owner",
        binding(state.task),
        rollbackEventId,
        blocked,
      );
      // After-commit interruption: close all connections; another store replays durable result.
      const reopened = new Pool({
        connectionString: fixtureURL,
        max: 2,
        options: `-c search_path=${schema}`,
      });
      try {
        const recovered = createFactoryStore(reopened, authorize, null, factoryTestLifecycle);
        const replayed = await recovered.apply(
          "owner",
          binding(before.task),
          rollbackEventId,
          blocked,
        );
        assert.equal(replayed.task.attemptId, state.task.attemptId);
        assert.equal(replayed.task.revision, state.task.revision);
        assert.equal(replayed.attempts.length, 2);
      } finally {
        await reopened.end();
      }
      state = await store.apply("owner", binding(state.task), randomUUID(), {
        action: "retry",
        reason: "Resume fixture run",
      });
      const runId = randomUUID(),
        sessionId = `session-${randomUUID()}`,
        sha = "a".repeat(40);
      await pool.query(
        `INSERT INTO agent_runs (id,"userId","issueId","agentId",status,"sessionId") VALUES ($1,'owner',$2,$3,'running',$4)`,
        [runId, issueId, agentId, sessionId],
      );
      state = await store.apply("owner", binding(state.task), randomUUID(), {
        action: "bind_run",
        runId,
      });
      await rejects(
        () =>
          store.apply("owner", binding(state.task), randomUUID(), {
            action: "retry",
            reason: "duplicate active run",
          }),
        "factoryTransition",
      );
      const oldCandidateBinding = binding(state.task);
      state = await store.apply("owner", oldCandidateBinding, randomUUID(), {
        action: "candidate",
        runId,
        candidate: {
          sha,
          repository: "fixture/repo",
          environment: "ci-pg17",
          scope: "backend fixture",
        },
      });
      await rejects(() => store.apply("owner", binding(state.task), randomUUID(), {
        action: "candidate", runId,
        candidate: { sha: "b".repeat(40), repository: "fixture/repo", environment: "ci-pg17", scope: "backend fixture" },
      }), "factoryTransition");
      assert.equal((await store.read("owner", state.task.id)).task.candidateId, state.task.candidateId);
      await rejects(
        () => store.apply("owner", oldCandidateBinding, randomUUID(), finish),
        "factoryStale",
      );
      await pool.query(
        "UPDATE agent_runs SET status='succeeded',\"stopReason\"='submitted',report=$2 WHERE id=$1",
        [
          runId,
          JSON.stringify({
            summary: "fixture report",
            verify: { status: "passed" },
            publish: { commit: sha },
          }),
        ],
      );
      const evidence = {
        artifact: `run-report:${runId}`,
        kind: "report" as const,
        runId,
        sessionId,
        candidateId: state.task.candidateId,
        sha,
        environment: "ci-pg17",
        recordedAt: new Date().toISOString(),
      };
      await rejects(
        () =>
          store.apply("owner", binding(state.task), randomUUID(), {
            ...finish,
            evidence: [{ ...evidence, sha: "b".repeat(40) }],
          }),
        "factoryEvidenceMismatch",
      );
      await rejects(
        () =>
          store.apply("owner", binding(state.task), randomUUID(), {
            ...finish,
            evidence: [
              { ...evidence, artifact: "https://invented.invalid/log" },
            ],
          }),
        "factoryArtifactMissing",
      );
      const captureId = randomUUID();
      await pool.query(`INSERT INTO run_captures (id,"userId","runId",kind,"contentType",source,status,title,size,sha256,"storageKey","createdAt","updatedAt") VALUES ($1,'owner',$2,'image','image/png','local','ready','Captured result',3,$3,$4,$5,$5)`,
        [captureId, runId, "c".repeat(64), `owner/captures/${captureId}`, evidence.recordedAt]);
      const capture = { ...evidence, artifact: `run-capture:${captureId}`, kind: "screenshot" as const };
      const rejectCapture = () => rejects(() => store.apply("owner", binding(state.task), randomUUID(), { ...finish, evidence: [capture] }), "factoryArtifactMissing");
      await rejects(() => store.apply("owner", binding(state.task), randomUUID(), { ...finish, evidence: [{ ...capture, artifact: `run-capture:${randomUUID()}` }] }), "factoryArtifactMissing");
      await pool.query(`UPDATE run_captures SET kind='video' WHERE id=$1`, [captureId]);
      await rejectCapture();
      await pool.query(`UPDATE run_captures SET kind='image',status='failed' WHERE id=$1`, [captureId]);
      await rejectCapture();
      await pool.query(`UPDATE run_captures SET status='ready',"userId"='other' WHERE id=$1`, [captureId]);
      await rejectCapture();
      const otherRun = (await pool.query('SELECT id FROM agent_runs WHERE id<>$1 LIMIT 1', [runId])).rows[0];
      assert.ok(otherRun);
      await pool.query(`UPDATE run_captures SET "userId"='owner',"runId"=$2 WHERE id=$1`, [captureId, otherRun.id]);
      await rejectCapture();
      await pool.query('UPDATE run_captures SET "runId"=$2 WHERE id=$1', [captureId, runId]);
      state = await store.apply("owner", binding(state.task), randomUUID(), {
        ...finish,
        evidence: [evidence, capture],
      });
      assert.equal(state.task.status, "passed");
      state = await store.apply("owner", binding(state.task), randomUUID(), {
        action: "advance",
        stage: "review",
        reason: "Independent reviewer needed",
      });
      await rejects(
        () =>
          store.apply("owner", binding(state.task), randomUUID(), {
            ...finish,
            evidence: [evidence],
          }),
        "factoryIndependentRunRequired",
      );
      const reviewRun = randomUUID();
      await pool.query(
        `INSERT INTO agent_runs (id,"userId","issueId","agentId",kind,status,"sessionId") VALUES ($1,'owner',$2,$3,'acceptance','running',$4)`,
        [reviewRun, issueId, agentId, `independent-review-${randomUUID()}`],
      );
      state = await store.apply("owner", binding(state.task), randomUUID(), { action: "bind_run", runId: reviewRun });
      await pool.query(`UPDATE agent_runs SET status='failed',"finishedAt"=clock_timestamp() WHERE id=$1`, [reviewRun]);
      state = await store.apply("owner", binding(state.task), randomUUID(), {
        action: "finish",
        status: "failed",
        reason: "Fixture review fault",
        evidence: [],
        output: { failedCriteria: ["fixture"] },
      });
      state = await store.apply("owner", binding(state.task), randomUUID(), {
        action: "repair",
        reason: "New candidate required",
      });
      assert.equal(state.task.candidateId, null);
      assert.equal(state.task.stage, "execute");
      assert.equal(state.candidates.length, 1);
      const activeRun = randomUUID();
      await pool.query(
        `INSERT INTO agent_runs (id,"userId","issueId","agentId",status) VALUES ($1,'owner',$2,$3,'running')`,
        [activeRun, issueId, agentId],
      );
      state = await store.apply("owner", binding(state.task), randomUUID(), {
        action: "bind_run",
        runId: activeRun,
      });
      const http = (userId: string | null, method = "GET", body?: unknown) =>
        handleFactory(store, {
          userId,
          method,
          taskId: state.task.id,
          url: "https://preview.invalid/api/factory",
          origin: "https://preview.invalid",
          body,
        });
      assert.equal((await http("other")).status, 404);
      assert.equal((await http("owner")).status, 200);
      const cancelBinding = binding(state.task),
        cancelId = randomUUID();
      assert.equal(
        (
          await http("owner", "POST", {
            binding: cancelBinding,
            eventId: cancelId,
            action: "cancel",
            reason: "Owner cancelled",
          })
        ).status,
        200,
      );
      assert.ok(
        (
          await pool.query(
            'SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1',
            [activeRun],
          )
        ).rows[0].stopRequestedAt,
      );
      assert.equal(
        (
          await http("owner", "POST", {
            binding: cancelBinding,
            eventId: cancelId,
            action: "cancel",
            reason: "Owner cancelled",
          })
        ).status,
        409,
      );
      await rejects(
        () => store.apply("owner", cancelBinding, randomUUID(), blocked),
        "factoryStopped",
      );
      const revoked = await route();
      await store.apply("owner", binding(revoked.task), randomUUID(), {
        action: "revoke",
        reason: "Grant withdrawn",
      });
      await rejects(
        () =>
          store.apply("owner", binding(revoked.task), randomUUID(), blocked),
        "factoryStopped",
      );
      // Seed each stage, not a successful gate. Inject a real PG precommit
      // error and reconnect to read/replay its committed wait checkpoint.
      const phaseEvidence = [];
      for (const stage of FACTORY_STAGES) {
        let phase = await route();
        await pool.query("UPDATE factory_tasks SET stage=$2 WHERE id=$1", [
          phase.task.id,
          stage,
        ]);
        await pool.query("UPDATE factory_attempts SET stage=$2 WHERE id=$1", [
          phase.task.attemptId,
          stage,
        ]);
        phase = await store.read("owner", phase.task.id);
        const runs = ["spec", "execute", "review", "verify", "monitor"].includes(stage);
        const phaseRun = runs ? randomUUID() : null,
          phaseSession = runs ? `phase-${randomUUID()}` : null;
        if (phaseRun) {
          await pool.query(
            `INSERT INTO agent_runs (id,"userId","issueId","agentId",kind,status,"sessionId") VALUES ($1,'owner',$2,$3,$5,'running',$4)`,
            [phaseRun, issueId, agentId, phaseSession, stage === "spec" ? "plan" : stage === "execute" ? "implement" : "acceptance"],
          );
          phase = await store.apply("owner", binding(phase.task), randomUUID(), { action: "bind_run", runId: phaseRun });
        }
        const phaseBinding = binding(phase.task),
          phaseEvent = randomUUID();
        const wait: FactoryChange = {
          action: "finish",
          status: "waiting",
          reason: `${stage}: waiting for actual consumer`,
          evidence: [],
          output: { checkpoint: stage },
        };
        await pool.query(
          "CREATE TRIGGER factory_inject BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION factory_fail_event()",
        );
        const beforePhase = await store.read("owner", phase.task.id);
        await assert.rejects(
          () => store.apply("owner", phaseBinding, phaseEvent, wait),
          /injected precommit/,
        );
        await pool.query("DROP TRIGGER factory_inject ON factory_events");
        assert.deepEqual(await store.read("owner", phase.task.id), beforePhase);
        phase = await store.apply("owner", phaseBinding, phaseEvent, wait);
        const reconnect = new Pool({
          connectionString: fixtureURL,
          max: 1,
          options: `-c search_path=${schema}`,
        });
        try {
          const recovered = createFactoryStore(reconnect, authorize, null, factoryTestLifecycle);
          const again = await recovered.apply(
            "owner",
            phaseBinding,
            phaseEvent,
            wait,
          );
          assert.equal(again.task.stage, stage);
          assert.equal(again.task.attemptId, phaseBinding.attemptId);
          assert.equal(again.attempts[0].runId, phaseRun);
          assert.equal(again.attempts[0].sessionId, phaseSession);
          assert.deepEqual(again.attempts[0].output, { checkpoint: stage });
          assert.equal(again.task.revision, phase.task.revision);
        } finally {
          await reconnect.end();
        }
        phaseEvidence.push({
          stage,
          taskId: phase.task.id,
          attemptId: phase.task.attemptId,
          runId: phaseRun,
          eventId: phaseEvent,
        });
      }
      const deletedAgent = randomUUID(),
        deletedRun = randomUUID();
      await pool.query(
        "INSERT INTO agents (id,\"userId\",name,harness) VALUES ($1,'owner','Deleted fixture agent','codex')",
        [deletedAgent],
      );
      await pool.query(
        'INSERT INTO agent_runs (id,"userId","issueId","agentId",status) VALUES ($1,\'owner\',$2,$3,\'running\')',
        [deletedRun, issueId, deletedAgent],
      );
      const deletedRunTask = await route();
      await store.apply("owner", binding(deletedRunTask.task), randomUUID(), {
        action: "bind_run",
        runId: deletedRun,
      });
      await pool.query("DELETE FROM agents WHERE id=$1", [deletedAgent]);
      assert.equal(
        (
          await pool.query("SELECT id FROM agent_runs WHERE id=$1", [
            deletedRun,
          ])
        ).rowCount,
        0,
      );
      await reconcile("owner");
      const missingRun = await store.read("owner", deletedRunTask.task.id);
      assert.equal(missingRun.task.status, "blocked");
      assert.equal(missingRun.attempts[0].runId, deletedRun);
      assert.match(missingRun.task.reason, /unavailable/);
      const removed = await route();
      await pool.query(
        'UPDATE issues SET content=\'{"attrs":{"mikka":{"deletedAt":"2026-10-25T00:00:00Z"}}}\'::jsonb WHERE id=$1',
        [issueId],
      );
      await rejects(
        () => store.read("owner", removed.task.id),
        "factoryNotFound",
      );
      await rejects(
        () =>
          store.apply("owner", binding(removed.task), randomUUID(), blocked),
        "factoryNotFound",
      );
      console.log(
        JSON.stringify({
          issue: 192,
          schema,
          taskId: state.task.id,
          runId,
          activeRun,
          sessionId,
          eventId: eid,
          rollbackEventId,
          candidateIds: state.candidates.map((c: { id: string }) => c.id),
          phaseEvidence,
          note: "isolated PG fixture evidence; not real Mikka/Harness acceptance",
        }),
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
