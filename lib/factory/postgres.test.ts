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

const dbURL =
  process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true"
    ? process.env.E2E_DATABASE_URL
    : undefined;
if (dbURL) {
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
    const schema = `factory_192_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: dbURL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: dbURL,
      max: 12,
      options: `-c search_path=${schema}`,
    });
    const authorize = async (
      userId: string,
      issueId: string,
      tx: import("pg").PoolClient,
    ) => {
      const { rows } = await tx.query(
        "SELECT id FROM issues WHERE id=$1 AND \"userId\"=$2 AND status<>'deleted' FOR SHARE",
        [issueId, userId],
      );
      return rows.length === 1;
    };
    const store = createFactoryStore(pool, authorize);
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
        new URL("20261025010001_factory_192_stages.sql", dir),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
      const issueId = randomUUID(),
        otherIssueId = randomUUID(),
        agentId = randomUUID();
      await pool.query(
        `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Factory test','{}','todo','normal'),($2,'other','Foreign issue','{}','todo','normal')`,
        [issueId, otherIssueId],
      );
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness) VALUES ($1,'owner','Factory fixture','codex')`,
        [agentId],
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
        connectionString: dbURL,
        max: 2,
        options: `-c search_path=${schema}`,
      });
      try {
        const recovered = createFactoryStore(reopened, authorize);
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
      state = await store.apply("owner", binding(state.task), randomUUID(), {
        action: "candidate",
        runId,
        candidate: {
          sha,
          repository: "fixture/repo",
          environment: "ci-pg17",
          scope: "backend fixture",
        },
      });
      const oldCandidateBinding = binding(state.task);
      state = await store.apply("owner", binding(state.task), randomUUID(), {
        action: "candidate",
        runId,
        candidate: {
          sha: "b".repeat(40),
          repository: "fixture/repo",
          environment: "ci-pg17",
          scope: "backend fixture",
        },
      });
      await rejects(
        () => store.apply("owner", oldCandidateBinding, randomUUID(), finish),
        "factoryStale",
      );
      await pool.query(
        "UPDATE agent_runs SET status='succeeded',report=$2 WHERE id=$1",
        [
          runId,
          JSON.stringify({
            summary: "fixture report",
            publish: { commit: "b".repeat(40) },
          }),
        ],
      );
      const evidence = {
        artifact: `run-report:${runId}`,
        kind: "report" as const,
        runId,
        sessionId,
        candidateId: state.task.candidateId,
        sha: "b".repeat(40),
        environment: "ci-pg17",
        recordedAt: new Date().toISOString(),
      };
      await rejects(
        () =>
          store.apply("owner", binding(state.task), randomUUID(), {
            ...finish,
            evidence: [{ ...evidence, sha }],
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
      state = await store.apply("owner", binding(state.task), randomUUID(), {
        ...finish,
        evidence: [evidence],
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
        "factoryConsumerGateRequired",
      );
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
      assert.equal(state.candidates.length, 2);
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
        const phaseRun = randomUUID(),
          phaseSession = `phase-${randomUUID()}`;
        await pool.query(
          `INSERT INTO agent_runs (id,"userId","issueId","agentId",status,"sessionId") VALUES ($1,'owner',$2,$3,'running',$4)`,
          [phaseRun, issueId, agentId, phaseSession],
        );
        phase = await store.apply("owner", binding(phase.task), randomUUID(), {
          action: "bind_run",
          runId: phaseRun,
        });
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
          connectionString: dbURL,
          max: 1,
          options: `-c search_path=${schema}`,
        });
        try {
          const recovered = createFactoryStore(reconnect, authorize);
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
          note: "isolated CI fixture evidence; not real Mikka/Harness acceptance",
        }),
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
