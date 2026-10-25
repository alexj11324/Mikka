import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { registerHooks } from "node:module";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { FactoryError, type FactoryBinding } from "./contract";
import {
  createFactoryStore,
  type FactoryTask,
  type FactorySnapshot,
} from "./store";
import {
  createFactoryMonitor,
  monitorGate,
  type MonitorInput,
} from "./monitor";
import {
  monitorFingerprint,
  normalizeMonitorFailure,
} from "./monitor-fingerprint";

test("fingerprints strip volatile IDs and secret output; owner/workspace/component/candidate environment isolate failures", () => {
  const base = {
    userId: "one",
    workspaceKey: "workspace:a",
    repository: "repo",
    environment: "preview:fixed",
    component: "backend",
    check: "health",
    failure:
      "failed request 123 token=secret-value https://user:pass@example.invalid/?key=secret",
  };
  const fingerprint = monitorFingerprint(base).fingerprint;
  assert.equal(
    monitorFingerprint({
      ...base,
      failure:
        "failed request 456 token=another https://other.invalid/?token=xyz",
    }).fingerprint,
    fingerprint,
  );
  for (const key of [
    "userId",
    "workspaceKey",
    "repository",
    "environment",
    "component",
    "check",
  ] as const)
    assert.notEqual(
      monitorFingerprint({ ...base, [key]: "other" }).fingerprint,
      fingerprint,
    );
  assert.doesNotMatch(
    normalizeMonitorFailure(base.failure),
    /secret-value|user:pass|example.invalid/,
  );
  assert.notEqual(
    monitorFingerprint({ ...base, failure: "database unavailable" })
      .fingerprint,
    fingerprint,
  );
});

// Explicit disposable loopback target only. Never read DATABASE_URL/credentials or impersonate CI.
const target = process.env.FACTORY_MONITOR_TEST_URL;
if (target) {
  const url = new URL(target);
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(
    url.pathname === "/mikka_monitor_195" ||
      (process.env.CI === "true" &&
        process.env.GITHUB_ACTIONS === "true" &&
        url.pathname === "/mikka_e2e"),
  );
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
    (error: unknown) => error instanceof FactoryError && error.code === code,
  );

test(
  "PG17 monitor: real transactions, concurrent dedupe, original issue, restart/rollback, fences, repair and recovery",
  { skip: !target, timeout: 120_000 },
  async (t) => {
    // Only resolve Next's compile-time marker; use actual document/Yjs/SQL behavior.
    const marker = registerHooks({
      resolve(specifier, context, next) {
        return next(
          specifier === "server-only"
            ? "next/dist/compiled/server-only/empty.js"
            : specifier,
          context,
        );
      },
    });
    const { appendMonitorEvidence } = await import("./monitor-evidence");
    const { loadIssueDocument, readIssueThreads } =
      await import("../linear-sync/document");
    marker.deregister();
    const schema = `monitor_195_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: target, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    let pool = new Pool({
      connectionString: target,
      max: 16,
      options: `-c search_path=${schema}`,
    });
    const scopes = new Map<string, string>();
    const denied = new Set<string>();
    const authorize = async (
      userId: string,
      issueId: string,
      tx: PoolClient,
    ) => {
      const { rows } = await tx.query(
        'SELECT id FROM issues WHERE id=$1 AND "userId"=$2 FOR SHARE',
        [issueId, userId],
      );
      return rows.length === 1 && !denied.has(issueId);
    };
    // Explicit fixture gate substitutes only the parallel, unavailable #193/#194 consumers.
    // This proves #195's transaction layer; it is not independent review/approval or Harness acceptance.
    const fixtureGates = {
      review: async () => true,
      verify: async () => true,
      approval: async () => true,
      publish: async () => true,
      monitor: monitorGate,
    };
    let store = createFactoryStore(pool, authorize, fixtureGates);
    let appendCount = 0;
    let failAppend = false;
    const makeMonitor = () =>
      createFactoryMonitor(
        pool,
        store,
        authorize,
        async (owner, issue) => scopes.get(issue) ?? `personal:${owner}`,
        async (tx, notice) => {
          if (failAppend) throw new Error("injected rollback before commit");
          await appendMonitorEvidence(tx, notice);
          appendCount++;
        },
      );
    let monitor = makeMonitor();
    const agentId = randomUUID();
    const sha = "1".repeat(40);
    const source = async (
      userId: string,
      issueId: string,
      runId: string | null = null,
      kind = "user_message",
    ) => {
      const id = randomUUID();
      await pool.query(
        'INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload) VALUES ($1,$2,$3,$4,$5,$6,\'{}\')',
        [id, userId, kind, `fixture:${id}`, issueId, runId],
      );
      return id;
    };
    const issue = async (owner = "owner", workspace = "workspace:a") => {
      const id = randomUUID();
      await pool.query(
        'INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,\'Monitor layer fixture\',\'{"type":"doc","content":[{"type":"paragraph"}]}\',\'todo\',\'normal\')',
        [id, owner],
      );
      scopes.set(id, workspace);
      return id;
    };
    const run = async (owner: string, issueId: string) => {
      const id = randomUUID();
      await pool.query(
        'INSERT INTO agent_runs (id,"userId","issueId","agentId",status,"sessionId") VALUES ($1,$2,$3,$4,\'queued\',$5)',
        [id, owner, issueId, agentId, `session:${id}`],
      );
      return id;
    };
    const complete = async (
      id: string,
      failure: string | null = null,
      commit = sha,
    ) => {
      const report = {
        summary: "Explicit PG layer fixture",
        filesChanged: [],
        verify: {
          status: failure ? "failed" : "passed",
          command: "check backend health",
          output: failure ?? "health check passed",
        },
        openQuestions: [],
        nextStep: null,
        publish: { branch: "fixture", commit, pushed: true, remote: null },
      };
      await pool.query(
        'UPDATE agent_runs SET status=$2,"stopReason"=\'submitted\',report=$3,"finishedAt"=clock_timestamp() WHERE id=$1',
        [id, failure ? "failed" : "succeeded", JSON.stringify(report)],
      );
      return report;
    };
    const evidence = async (task: FactoryTask, runId: string) => ({
      artifact: `run-report:${runId}`,
      kind: "report" as const,
      runId,
      sessionId: `session:${runId}`,
      candidateId: task.candidateId,
      sha,
      environment: "preview:fixture",
      recordedAt: new Date().toISOString(),
    });
    const toMonitor = async (
      owner: string,
      issueId: string,
      failure: string | null = "HTTP 503 request 123 token=fixture-secret",
      initial?: FactorySnapshot,
    ) => {
      let state =
        initial ??
        (await store.route(owner, {
          issueId,
          eventId: randomUUID(),
          sourceEventId: await source(owner, issueId),
          rationale: "Explicit isolated fixture",
        }));
      const execute = await run(owner, issueId);
      state = await store.apply(owner, binding(state.task), randomUUID(), {
        action: "bind_run",
        runId: execute,
      });
      await complete(execute);
      state = await store.apply(owner, binding(state.task), randomUUID(), {
        action: "candidate",
        runId: execute,
        candidate: {
          sha,
          repository: "fixture-repository",
          environment: "preview:fixture",
          scope: "backend-health",
        },
      });
      state = await store.apply(owner, binding(state.task), randomUUID(), {
        action: "finish",
        status: "passed",
        reason: "fixture execute",
        evidence: [await evidence(state.task, execute)],
        output: {},
      });
      for (const stage of [
        "review",
        "verify",
        "approval",
        "publish",
      ] as const) {
        state = await store.apply(owner, binding(state.task), randomUUID(), {
          action: "advance",
          stage,
          reason: "fixture progression",
        });
        const id = await run(owner, issueId);
        state = await store.apply(owner, binding(state.task), randomUUID(), {
          action: "bind_run",
          runId: id,
        });
        await complete(id);
        state = await store.apply(owner, binding(state.task), randomUUID(), {
          action: "finish",
          status: "passed",
          reason: "fixture gate only",
          evidence: [await evidence(state.task, id)],
          output: {},
        });
      }
      state = await store.apply(owner, binding(state.task), randomUUID(), {
        action: "advance",
        stage: "monitor",
        reason: "fixture monitor",
      });
      const id = await run(owner, issueId);
      state = await store.apply(owner, binding(state.task), randomUUID(), {
        action: "bind_run",
        runId: id,
      });
      await complete(id, failure);
      return {
        task: state.task,
        input: {
          binding: binding(state.task),
          sourceEventId: await source(owner, issueId, id, "run_finished"),
        } satisfies MonitorInput,
        runId: id,
      };
    };
    try {
      assert.match(
        (await pool.query("SHOW server_version")).rows[0].server_version,
        /^17\./,
      );
      const dir = new URL("../../drizzle/", import.meta.url);
      for (const name of orderMigrations(
        (await readdir(dir)).filter((n) => n.endsWith(".sql")),
      ))
        await pool.query(await readFile(new URL(name, dir), "utf8"));
      await pool.query(
        await readFile(
          new URL("20261025014500_factory_195_monitor.sql", dir),
          "utf8",
        ),
      );
      await pool.query(
        "INSERT INTO agents (id,\"userId\",name,harness) VALUES ($1,'owner','Fixture agent','codex')",
        [agentId],
      );
      const issueId = await issue();
      const teamId = randomUUID();
      await pool.query(
        `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture owner','owner@example.invalid',false,now(),now())`,
      );
      await pool.query(
        "INSERT INTO linear_team_syncs (id,\"ownerId\",\"linearTeamId\",\"linearTeamKey\",\"linearTeamName\") VALUES ($1,'owner','fixture-team','FIX','Fixture team')",
        [teamId],
      );
      await pool.query("UPDATE issues SET scope='workspace' WHERE id=$1", [
        issueId,
      ]);
      await pool.query(
        'INSERT INTO linear_issue_links (id,"issueId","ownerId","teamSyncId","linearIssueId","linearIdentifier") VALUES ($1,$2,\'owner\',$3,\'fixture-remote-issue\',\'FIX-195\')',
        [randomUUID(), issueId, teamId],
      );
      const first = await toMonitor("owner", issueId);
      await t.test(
        "ten concurrent replays retain one observation and one original logical issue",
        async () => {
          const results = await Promise.all(
            Array.from({ length: 10 }, () =>
              monitor.consume("owner", first.input),
            ),
          );
          assert.equal(results.filter((r) => !r.replayed).length, 1);
          assert.equal(new Set(results.map((r) => r.incidentId)).size, 1);
          assert.ok(
            results.every((r) => r.issueId === issueId && r.occurrences === 1),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT deliveries FROM factory_monitor_observations",
              )
            ).rows[0].deliveries,
            10,
          );
          assert.equal(appendCount, 1);
          const document = (
            await pool.query(
              'SELECT state FROM issue_documents WHERE "issueId"=$1',
              [issueId],
            )
          ).rows[0];
          const doc = loadIssueDocument(document.state, { type: "doc" });
          const threads = readIssueThreads(doc);
          assert.equal(threads.length, 1);
          assert.equal(threads[0].messages.length, 1);
          assert.match(
            threads[0].messages[0].body,
            new RegExp(first.input.sourceEventId),
          );
          assert.doesNotMatch(
            threads[0].messages[0].body,
            /fixture-secret|HTTP 503/,
          );
          doc.destroy();
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM linear_sync_outbox WHERE \"issueId\"=$1 AND status='queued'",
                [issueId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT "linearIssueId" FROM linear_issue_links WHERE "issueId"=$1',
                [issueId],
              )
            ).rows[0].linearIssueId,
            "fixture-remote-issue",
          );
          assert.equal(
            (await store.read("owner", first.task.id)).task.status,
            "failed",
          );
          await rejects(
            () =>
              monitor.consume("owner", {
                ...first.input,
                binding: { ...first.input.binding, revision: 999 },
              }),
            "factoryReplayMismatch",
          );
          const serialized = JSON.stringify(
            (await pool.query("SELECT * FROM factory_monitor_observations"))
              .rows,
          );
          assert.doesNotMatch(serialized, /fixture-secret|HTTP 503/);
        },
      );
      await t.test(
        "ten distinct failures reuse original issue, despite originating from other tasks",
        async () => {
          const inputs = await Promise.all(
            Array.from({ length: 10 }, async (_, i) =>
              toMonitor(
                "owner",
                issueId,
                `HTTP 503 request ${i} token=another-fixture`,
              ),
            ),
          );
          const results = await Promise.all(
            inputs.map((x) => monitor.consume("owner", x.input)),
          );
          assert.equal(new Set(results.map((r) => r.incidentId)).size, 1);
          assert.equal(
            (
              await pool.query(
                "SELECT occurrences FROM factory_monitor_incidents",
              )
            ).rows[0].occurrences,
            11,
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM issues")).rows[0]
              .n,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM coordinator_events WHERE \"dedupeKey\" LIKE 'factory-monitor:%'",
              )
            ).rows[0].n,
            11,
          );
        },
      );
      await t.test(
        "owner, workspace, stale candidate, echo, cancellation and authorization fail closed",
        async () => {
          await rejects(
            () => monitor.consume("other", first.input),
            "factoryNotFound",
          );
          const secondIssue = await issue("owner", "workspace:b");
          const second = await toMonitor("owner", secondIssue);
          await rejects(
            () =>
              monitor.consume("owner", {
                ...second.input,
                binding: { ...second.input.binding, candidateId: randomUUID() },
              }),
            "factoryStale",
          );
          const result = await monitor.consume("owner", second.input);
          assert.notEqual(
            result.incidentId,
            (
              await pool.query(
                'SELECT id FROM factory_monitor_incidents WHERE "issueId"=$1',
                [issueId],
              )
            ).rows[0].id,
          );
          const foreign = await toMonitor("other", await issue("other"));
          const foreignResult = await monitor.consume("other", foreign.input);
          assert.notEqual(result.incidentId, foreignResult.incidentId);
          const echo = await toMonitor("owner", issueId);
          const echoId = await source(
            "owner",
            issueId,
            echo.runId,
            "run_blocked",
          );
          await rejects(
            () =>
              monitor.consume("owner", {
                ...echo.input,
                sourceEventId: echoId,
              }),
            "factoryMonitorSourceMismatch",
          );
          await store.apply("owner", binding(echo.task), randomUUID(), {
            action: "cancel",
            reason: "user cancel",
          });
          await rejects(
            () => monitor.consume("owner", echo.input),
            "factoryStopped",
          );
          denied.add(issueId);
          await rejects(
            () => monitor.consume("owner", first.input),
            "factoryNotFound",
          );
          denied.delete(issueId);
          const revoked = await toMonitor("owner", issueId);
          const stopped = await store.apply(
            "owner",
            binding(revoked.task),
            randomUUID(),
            { action: "revoke", reason: "Permission revoked" },
          );
          await rejects(
            () => monitor.consume("owner", revoked.input),
            "factoryStopped",
          );
          await rejects(
            () =>
              store.apply("owner", binding(stopped.task), randomUUID(), {
                action: "repair",
                reason: "must not repair after revocation",
              }),
            "factoryStopped",
          );
        },
      );
      await t.test(
        "crash before commit rolls back observation, issue count, stage and notice; reconnect replays committed result",
        async () => {
          const sample = await toMonitor("owner", issueId);
          const before = (
            await pool.query(
              "SELECT sum(occurrences)::int AS n FROM factory_monitor_incidents",
            )
          ).rows[0].n;
          failAppend = true;
          await assert.rejects(
            () => monitor.consume("owner", sample.input),
            /injected rollback/,
          );
          failAppend = false;
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM factory_monitor_observations WHERE "sourceEventId"=$1',
                [sample.input.sourceEventId],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (await store.read("owner", sample.task.id)).task.status,
            "running",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT sum(occurrences)::int AS n FROM factory_monitor_incidents",
              )
            ).rows[0].n,
            before,
          );
          const committed = await monitor.consume("owner", sample.input);
          await pool.end();
          pool = new Pool({
            connectionString: target,
            max: 16,
            options: `-c search_path=${schema}`,
          });
          store = createFactoryStore(pool, authorize, fixtureGates);
          monitor = makeMonitor();
          assert.deepEqual(await monitor.consume("owner", sample.input), {
            ...committed,
            replayed: true,
          });
        },
      );
      await t.test(
        "same candidate recovery requires all independent and approved publication evidence",
        async () => {
          const good = await toMonitor("owner", issueId, null);
          await pool.query(
            "UPDATE factory_attempts SET status='blocked' WHERE \"taskId\"=$1 AND stage='verify'",
            [good.task.id],
          );
          assert.equal(
            (await monitor.consume("owner", good.input)).outcome,
            "blocked",
          );
          assert.equal(
            (await store.read("owner", good.task.id)).task.status,
            "blocked",
          );
          assert.ok(
            (
              await pool.query(
                "SELECT id FROM factory_monitor_incidents WHERE \"issueId\"=$1 AND status='open'",
                [issueId],
              )
            ).rows.length,
          );
          for (const tamper of [
            "sha",
            "session",
            "missing-verification-run",
          ] as const) {
            const invalid = await toMonitor("owner", issueId, null);
            if (tamper === "sha")
              await complete(invalid.runId, null, "2".repeat(40));
            if (tamper === "session")
              await pool.query(
                'UPDATE agent_runs SET "sessionId"=(SELECT "sessionId" FROM factory_attempts WHERE "taskId"=$2 AND stage=\'verify\') WHERE id=$1',
                [invalid.runId, invalid.task.id],
              );
            if (tamper === "missing-verification-run")
              await pool.query(
                'DELETE FROM agent_runs WHERE id=(SELECT "runId" FROM factory_attempts WHERE "taskId"=$1 AND stage=\'verify\')',
                [invalid.task.id],
              );
            assert.equal(
              (await monitor.consume("owner", invalid.input)).outcome,
              "blocked",
              tamper,
            );
          }
          const failedTask = (await store.read("owner", first.task.id)).task;
          const repair = await store.apply(
            "owner",
            binding(failedTask),
            randomUUID(),
            { action: "repair", reason: "Repair original monitor incident" },
          );
          assert.equal(repair.task.stage, "execute");
          assert.equal(repair.task.candidateId, null);
          assert.notEqual(repair.task.attemptId, failedTask.attemptId);
          assert.ok(
            repair.attempts.some(
              (a) => a.stage === "monitor" && a.status === "failed",
            ),
          );
          const recovered = await toMonitor("owner", issueId, null, repair);
          assert.equal(recovered.task.id, first.task.id);
          assert.equal(
            (await monitor.consume("owner", recovered.input)).outcome,
            "passed",
          );
          assert.equal(
            (await store.read("owner", recovered.task.id)).task.status,
            "passed",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM factory_monitor_incidents WHERE \"issueId\"=$1 AND status='open'",
                [issueId],
              )
            ).rows[0].n,
            0,
          );
          // #195 never closes or hides the actual issue.
          assert.equal(
            (
              await pool.query("SELECT status FROM issues WHERE id=$1", [
                issueId,
              ])
            ).rows[0].status,
            "todo",
          );
        },
      );
      await t.test(
        "Coordinator reconciliation consumes durable pending records without a new dispatch or wake",
        async () => {
          await toMonitor("owner", issueId, "new defect: database offline");
          const before = (
            await pool.query("SELECT count(*)::int AS n FROM agent_runs")
          ).rows[0].n;
          assert.ok((await monitor.reconcile("owner")).observed >= 1);
          assert.equal((await monitor.reconcile("owner")).observed, 0);
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM agent_runs"))
              .rows[0].n,
            before,
          );
        },
      );
      t.diagnostic(
        JSON.stringify({
          environment: "isolated local Docker postgres:17",
          schema,
          agentId,
          originalIssueId: issueId,
          taskId: first.task.id,
          runId: first.runId,
          sourceEventId: first.input.sourceEventId,
          candidateId: first.task.candidateId,
          fixtureGates: [193, 194],
          realHarnessAcceptance: false,
        }),
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
