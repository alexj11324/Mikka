import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import {
  FACTORY_STAGES,
  FactoryError,
  type FactoryBinding,
  type FactoryStage,
  type FactoryStatus,
} from "./contract";
import { handleFactory } from "./http";
import { createFactoryStore, type FactoryTask } from "./store";

// Only an explicitly opted-in, disposable local PG or the existing CI PG service.
const localURL = process.env.FACTORY_CYCLE_TEST_URL;
const dbURL =
  localURL ??
  (process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true"
    ? process.env.E2E_DATABASE_URL
    : undefined);
if (dbURL) {
  const url = new URL(dbURL);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/mikka_e2e");
  if (localURL) assert.equal(url.username, "factorycycle192");
}
const binding = (task: FactoryTask): FactoryBinding => ({
  taskId: task.id,
  issueId: task.issueId,
  attemptId: task.attemptId,
  revision: task.revision,
  candidateId: task.candidateId,
});
const retry = {
  action: "retry",
  reason: "Next scheduled observation",
} as const;
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(
    fn,
    (error: unknown) => error instanceof FactoryError && error.code === code,
  );

test(
  "PG17 monitor cycles: immutable history, CAS/replay, rollback, owner/candidate/stop fences",
  {
    skip: !dbURL,
    timeout: 120000,
  },
  async (t) => {
    const schema = `factory_cycle_${randomUUID().replaceAll("-", "")}`;
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
      tx: PoolClient,
    ) => {
      const { rows } = await tx.query(
        `SELECT id FROM issues WHERE id=$1 AND "userId"=$2 AND content #>> '{attrs,mikka,deletedAt}' IS NULL FOR SHARE`,
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
        (await readdir(dir)).filter((name) => name.endsWith(".sql")),
      ))
        await pool.query(await readFile(new URL(file, dir), "utf8"));
      const agentId = randomUUID();
      await pool.query(
        `INSERT INTO agents (id,"userId",name,harness) VALUES ($1,'owner','Monitor state fixture','codex')`,
        [agentId],
      );
      // Explicit fixture seeding tests the state boundary; it is not Harness acceptance.
      const fixture = async (
        stage: FactoryStage = "monitor",
        status: FactoryStatus = "passed",
      ) => {
        const issueId = randomUUID(),
          sourceId = randomUUID(),
          runId = randomUUID(),
          candidateId = randomUUID();
        await pool.query(
          `INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Monitor cycle fixture','{}','todo','normal')`,
          [issueId],
        );
        await pool.query(
          `INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"fixture"}')`,
          [sourceId, sourceId],
        );
        const routed = await store.route("owner", {
          issueId,
          sourceEventId: sourceId,
          eventId: randomUUID(),
          rationale: "Explicit fixture route",
        });
        await pool.query(
          `INSERT INTO agent_runs (id,"userId","issueId","agentId",status,"sessionId","finishedAt") VALUES ($1,'owner',$2,$3,'succeeded',$4,now())`,
          [runId, issueId, agentId, `fixture-${randomUUID()}`],
        );
        await pool.query(
          `INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,'alexj11324/Mikka','isolated-fixture','fixture only',$4)`,
          [candidateId, routed.task.id, "a".repeat(40), runId],
        );
        await pool.query(
          `UPDATE factory_attempts SET stage=$2,status=$3,ordinal=2,position=5,"candidateId"=$4,"runId"=$5,"sessionId"='old-session-fixture',output='{"old":true}',evidence='[{"old":true}]',"finishedAt"=now() WHERE id=$1`,
          [routed.task.attemptId, stage, status, candidateId, runId],
        );
        await pool.query(
          `UPDATE factory_tasks SET stage=$2,status=$3,revision=7,"candidateId"=$4 WHERE id=$1`,
          [routed.task.id, stage, status, candidateId],
        );
        return (await store.read("owner", routed.task.id)).task;
      };
      const attemptRow = async (id: string) =>
        (
          await pool.query(
            `SELECT row_to_json(a) AS value FROM factory_attempts a WHERE id=$1`,
            [id],
          )
        ).rows[0].value;
      const counts = async (id: string) =>
        (
          await pool.query(
            `SELECT (SELECT count(*)::int FROM factory_attempts WHERE "taskId"=$1) AS attempts,(SELECT count(*)::int FROM factory_events WHERE "taskId"=$1) AS events,(SELECT revision FROM factory_tasks WHERE id=$1) AS revision`,
            [id],
          )
        ).rows[0];
      const apply = (task: FactoryTask, eventId = randomUUID()) =>
        store.apply("owner", binding(task), eventId, retry);

      await t.test(
        "same candidate, new clean attempt; old passed row unchanged; no new run",
        async () => {
          const task = await fixture(),
            old = await attemptRow(task.attemptId);
          const runCount = (await pool.query("SELECT count(*) FROM agent_runs"))
            .rows[0].count;
          const next = await apply(task),
            current = await attemptRow(next.task.attemptId);
          assert.equal(next.task.stage, "monitor");
          assert.equal(next.task.status, "pending");
          assert.equal(next.task.candidateId, task.candidateId);
          assert.equal(next.task.revision, task.revision + 1);
          assert.notEqual(next.task.attemptId, task.attemptId);
          assert.equal(current.ordinal, old.ordinal + 1);
          assert.equal(current.position, old.position + 1);
          assert.equal(current.candidateId, task.candidateId);
          assert.equal(current.runId, null);
          assert.equal(current.sessionId, null);
          assert.equal(current.finishedAt, null);
          assert.deepEqual(current.output, {});
          assert.deepEqual(current.evidence, []);
          assert.deepEqual(await attemptRow(task.attemptId), old);
          assert.equal(
            (await pool.query("SELECT count(*) FROM agent_runs")).rows[0].count,
            runCount,
          );
          await rejects(
            () =>
              store.apply("owner", binding(task), randomUUID(), {
                action: "finish",
                status: "passed",
                reason: "Late old observation",
                evidence: [],
                output: {},
              }),
            "factoryStale",
          );
          await rejects(
            () =>
              store.apply("owner", binding(next.task), randomUUID(), {
                action: "finish",
                status: "passed",
                reason: "No current validator",
                evidence: [],
                output: {},
              }),
            "factoryConsumerGateRequired",
          );
        },
      );

      await t.test(
        "10 identical retries replay once, new event CAS once; mismatched replay rejected",
        async () => {
          const task = await fixture(),
            eventId = randomUUID();
          const results = await Promise.all(
            Array.from({ length: 10 }, () => apply(task, eventId)),
          );
          assert.equal(
            new Set(results.map((state) => state.task.attemptId)).size,
            1,
          );
          assert.deepEqual(await counts(task.id), {
            attempts: 2,
            events: 2,
            revision: 8,
          });
          await rejects(
            () =>
              store.apply("owner", binding(task), eventId, {
                ...retry,
                reason: "Changed request",
              }),
            "factoryReplayMismatch",
          );
          await rejects(
            () =>
              store.apply(
                "owner",
                { ...binding(task), candidateId: randomUUID() },
                eventId,
                retry,
              ),
            "factoryReplayMismatch",
          );
          const competing = await fixture();
          const settled = await Promise.allSettled(
            Array.from({ length: 10 }, () => apply(competing)),
          );
          assert.equal(
            settled.filter((result) => result.status === "fulfilled").length,
            1,
          );
          for (const result of settled)
            if (result.status === "rejected") {
              assert.ok(result.reason instanceof FactoryError);
              assert.equal(result.reason.code, "factoryStale");
            }
          assert.deepEqual(await counts(competing.id), {
            attempts: 2,
            events: 2,
            revision: 8,
          });
        },
      );

      await t.test(
        "wrong owner/issue/candidate and inconsistent candidate never write",
        async () => {
          const task = await fixture(),
            before = await counts(task.id);
          await rejects(
            () => store.apply("other", binding(task), randomUUID(), retry),
            "factoryNotFound",
          );
          await rejects(
            () =>
              store.apply(
                "owner",
                { ...binding(task), issueId: randomUUID() },
                randomUUID(),
                retry,
              ),
            "factoryNotFound",
          );
          for (const candidateId of [randomUUID(), null])
            await rejects(
              () =>
                store.apply(
                  "owner",
                  { ...binding(task), candidateId },
                  randomUUID(),
                  retry,
                ),
              "factoryStale",
            );
          assert.deepEqual(await counts(task.id), before);
          await pool.query(
            `UPDATE factory_tasks SET "candidateId"=NULL WHERE id=$1`,
            [task.id],
          );
          await rejects(
            () => apply({ ...task, candidateId: null }),
            "factoryTransition",
          );
          await pool.query(
            `UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1`,
            [task.id, task.candidateId],
          );
          await pool.query(
            `UPDATE factory_attempts SET "candidateId"=NULL WHERE id=$1`,
            [task.attemptId],
          );
          await rejects(() => apply(task), "factoryTransition");
          assert.deepEqual(await counts(task.id), before);
        },
      );

      await t.test(
        "cancel/revoke before or after cycle block replay; live issue revocation blocks access",
        async () => {
          for (const action of ["cancel", "revoke"] as const) {
            const task = await fixture(),
              old = await attemptRow(task.attemptId);
            const stopped = await store.apply(
              "owner",
              binding(task),
              randomUUID(),
              { action, reason: "Explicit stop" },
            );
            await rejects(() => apply(stopped.task), "factoryStopped");
            assert.deepEqual(await attemptRow(task.attemptId), old);
            const cycled = await fixture(),
              eventId = randomUUID();
            const next = await apply(cycled, eventId);
            await store.apply("owner", binding(next.task), randomUUID(), {
              action,
              reason: "Stop current cycle",
            });
            await rejects(() => apply(cycled, eventId), "factoryStopped");
            assert.deepEqual(await counts(cycled.id), {
              attempts: 2,
              events: 3,
              revision: 9,
            });
          }
          const revoked = await fixture(),
            eventId = randomUUID();
          await apply(revoked, eventId);
          await pool.query(
            `UPDATE issues SET "userId"='new-owner' WHERE id=$1`,
            [revoked.issueId],
          );
          await rejects(() => apply(revoked, eventId), "factoryNotFound");
          const deleted = await fixture(),
            before = await counts(deleted.id);
          await pool.query(
            `UPDATE issues SET content='{"attrs":{"mikka":{"deletedAt":"2026-10-25T00:00:00Z"}}}' WHERE id=$1`,
            [deleted.issueId],
          );
          await rejects(() => apply(deleted), "factoryNotFound");
          assert.deepEqual(await counts(deleted.id), before);
        },
      );

      await t.test(
        "other passed stages, passed repair, active observation and inconsistent attempt rejected",
        async () => {
          for (const stage of FACTORY_STAGES.filter(
            (stage) => stage !== "monitor",
          )) {
            const task = await fixture(stage),
              before = await counts(task.id);
            await rejects(() => apply(task), "factoryTransition");
            assert.deepEqual(await counts(task.id), before);
          }
          const task = await fixture(),
            before = await counts(task.id);
          await rejects(
            () =>
              store.apply("owner", binding(task), randomUUID(), {
                action: "repair",
                reason: "Repair passed",
              }),
            "factoryTransition",
          );
          for (const status of ["pending", "running"] as const) {
            const active = await fixture("monitor", status);
            await rejects(() => apply(active), "factoryTransition");
          }
          await pool.query(
            `UPDATE agent_runs SET status='running' WHERE id=(SELECT "runId" FROM factory_attempts WHERE id=$1)`,
            [task.attemptId],
          );
          await rejects(() => apply(task), "factoryRunStillActive");
          await pool.query(
            `UPDATE agent_runs SET status='succeeded' WHERE id=(SELECT "runId" FROM factory_attempts WHERE id=$1)`,
            [task.attemptId],
          );
          for (const [stage, status] of [
            ["verify", "passed"],
            ["monitor", "failed"],
          ]) {
            await pool.query(
              `UPDATE factory_attempts SET stage=$2,status=$3 WHERE id=$1`,
              [task.attemptId, stage, status],
            );
            await rejects(() => apply(task), "factoryTransition");
          }
          assert.deepEqual(await counts(task.id), before);
          for (const status of ["failed", "blocked", "waiting"] as const) {
            const failed = await fixture("monitor", status);
            assert.equal((await apply(failed)).task.status, "pending");
          }
        },
      );

      await t.test(
        "real precommit interruption and caller rollback leave no new attempt; reconnect replay survives",
        async () => {
          const task = await fixture(),
            before = await counts(task.id),
            old = await attemptRow(task.attemptId),
            eventId = randomUUID();
          await pool.query(
            `CREATE FUNCTION reject_cycle_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cycle precommit interruption'; END $$`,
          );
          await pool.query(
            `CREATE TRIGGER reject_cycle_event BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION reject_cycle_event()`,
          );
          await assert.rejects(
            () => apply(task, eventId),
            /injected cycle precommit interruption/,
          );
          assert.deepEqual(await counts(task.id), before);
          assert.deepEqual(await attemptRow(task.attemptId), old);
          await pool.query("DROP TRIGGER reject_cycle_event ON factory_events");
          const tx = await pool.connect();
          try {
            await tx.query("BEGIN");
            await store.apply("owner", binding(task), eventId, retry, tx);
            await tx.query("ROLLBACK");
          } finally {
            tx.release();
          }
          assert.deepEqual(await counts(task.id), before);
          const committed = await apply(task, eventId);
          const reconnect = new Pool({
            connectionString: dbURL,
            max: 1,
            options: `-c search_path=${schema}`,
          });
          try {
            const replayed = await createFactoryStore(
              reconnect,
              authorize,
            ).apply("owner", binding(task), eventId, retry);
            assert.equal(replayed.task.attemptId, committed.task.attemptId);
            assert.equal(replayed.task.revision, 8);
          } finally {
            await reconnect.end();
          }
          assert.deepEqual(await counts(task.id), {
            attempts: 2,
            events: 2,
            revision: 8,
          });
        },
      );

      await t.test(
        "existing control API exposes retry with session, origin and status fences",
        async () => {
          const task = await fixture(),
            eventId = randomUUID();
          const request = {
            userId: "owner",
            method: "POST",
            taskId: task.id,
            origin: "https://fixture.invalid",
            url: `https://fixture.invalid/api/factory/tasks/${task.id}`,
            body: { binding: binding(task), eventId, ...retry },
          };
          assert.equal(
            (await handleFactory(store, { ...request, userId: null })).status,
            401,
          );
          assert.equal(
            (await handleFactory(store, { ...request, userId: "other" }))
              .status,
            404,
          );
          assert.equal(
            (
              await handleFactory(store, {
                ...request,
                origin: "https://foreign.invalid",
              })
            ).status,
            403,
          );
          assert.equal((await handleFactory(store, request)).status, 200);
          assert.equal((await handleFactory(store, request)).status, 200);
          assert.equal(
            (
              await handleFactory(store, {
                ...request,
                body: { ...request.body, eventId: randomUUID() },
              })
            ).status,
            409,
          );
          assert.deepEqual(await counts(task.id), {
            attempts: 2,
            events: 2,
            revision: 8,
          });
        },
      );
    } finally {
      await pool.end();
      if (process.env.RETAIN_SYNTHETIC_RECORDS !== "1") await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
