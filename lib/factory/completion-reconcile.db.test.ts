// BE-9: run completion drives Factory reconcile without a Coordinator turn.
// Real migrations, store, dispatch and reconciler over a disposable *_e2e PG.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { createFactoryStore } from "./store";
import { createFactoryDispatch, factoryBinding, type FactoryQueue } from "./dispatch";
import { createFactoryQuestions } from "./questions/store";
import { createFactoryReconciler } from "./reconcile";
import { factoryCheckIndependent } from "./check-independence";
import { reconcileFactoryAfterCompletion } from "../run-completion-effects";
import { orchestratorSettings } from "@mikka/protocol/orchestrator";

const url = process.env.E2E_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(u.hostname), "loopback only");
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/, "database name must end in _e2e");
} else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("run completion enters review without the Coordinator; replays do not advance twice", { skip: !url, timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `fac_complete_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.toString(), max: 8 });
  const flags = { r: process.env.MIKKA_FACTORY_ROUTING_ENABLED, l: process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED };
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','complete@example.invalid',true,now(),now())`);
    const authorize = async (user: string, issue: string, tx: PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1;
    const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID();
    await pool.query(`INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Disposable',now(),'[{"harness":"codex","installed":true}]')`, [deviceId]);
    await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture','codex',$2)`, [agentId, deviceId]);
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,'owner','/fixture/repo')`, [repoId, deviceId]);
    const store = createFactoryStore(pool, authorize, null, { independent: factoryCheckIndependent });
    const queue: FactoryQueue = async (tx, userId, input, botId) => {
      const runId = randomUUID();
      await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','Fixture')`, [runId, userId, input.issueId, input.agentId, deviceId, input.deviceRepoId, botId]);
      return { runId };
    };
    const dispatch = createFactoryDispatch(pool, store, queue, { configure: { execute: async () => {} }, freeze: async (tx, _task, id) => { await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id, JSON.stringify({ schemaVersion: 1, definitionDigest: "fixture", harness: "codex" })]); } });
    const questions = createFactoryQuestions(pool, authorize, store, dispatch);
    const sweep = createFactoryReconciler(pool, store, questions);
    const reconcileFor = () => (userId: string, runId: string) => sweep.run(userId, runId);
    const issueId = randomUUID(), sourceEventId = randomUUID();
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal')`, [issueId]);
    /** A routed task on its own issue whose execute attempt is bound to a running run. */
    const runningTask = async (iss?: string) => {
      const ownIssue = iss ?? randomUUID(), src = randomUUID();
      if (!iss) await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal')`, [ownIssue]);
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [src, src]);
      const r = await store.route("owner", { issueId: ownIssue, sourceEventId: src, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
      const run = await dispatch("owner", { binding: factoryBinding(r.task), agentId, deviceRepoId: repoId });
      await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [run.runId]);
      return { task: r.task, runId: run.runId };
    };
    const succeed = (runId: string) => pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='s1',report=$2,"startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp() WHERE id=$1`, [runId, JSON.stringify({ publish: { commit: "b".repeat(40) }, verify: { status: "passed" }, summary: "done" })]);
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId]);
    const routed = await store.route("owner", { issueId, sourceEventId, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
    const d = await dispatch("owner", { binding: factoryBinding(routed.task), agentId, deviceRepoId: repoId });
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [d.runId]);
    const other = await runningTask();
    const otherBefore = (await store.read("owner", other.task.id)).task;
    const pick = (x: { stage: string; status: string; revision: number; attemptId: string | null }) => ({ stage: x.stage, status: x.status, revision: x.revision, attemptId: x.attemptId });

    await t.test("flags off: no SQL, no transition", async () => {
      delete process.env.MIKKA_FACTORY_ROUTING_ENABLED; delete process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED;
      let queried = 0;
      assert.equal(await reconcileFactoryAfterCompletion({ query: async () => { queried++; return { rows: [] }; } }, "owner", d.runId, reconcileFor), 0);
      assert.equal(queried, 0);
    });
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = "1"; process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = "1";

    await t.test("completed run moves execute → review via the completion hook alone", async () => {
      const report = { publish: { commit: "b".repeat(40) }, verify: { status: "passed" }, summary: "done" };
      await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='s1',report=$2,"startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp() WHERE id=$1`, [d.runId, JSON.stringify(report)]);
      // A3: the run's ready captures become evidence by reference; failed or unfinished ones do not.
      const shot = randomUUID(), clip = randomUUID(), broken = randomUUID();
      const capture = (id: string, kind: string, type: string, status: string) => pool.query(
        `INSERT INTO run_captures (id,"userId","runId",kind,"contentType",source,status,title,size,sha256,"storageKey","inlineContent","updatedAt") VALUES ($1,'owner',$2,$3,$4,'local',$5,$6,3,$7,$8,'\\x010203',clock_timestamp())`,
        [id, d.runId, kind, type, status, `capture ${id.slice(0, 4)}`, "c".repeat(64), `owner/captures/${id}`]);
      await capture(shot, "image", "image/png", "ready");
      await capture(clip, "video", "video/mp4", "ready");
      await capture(broken, "image", "image/png", "failed");
      assert.equal(await reconcileFactoryAfterCompletion(pool, "owner", d.runId, reconcileFor), 1);
      const after = await store.read("owner", routed.task.id);
      assert.equal(after.task.stage, "review");
      const { rows: [execute] } = await pool.query(`SELECT evidence FROM factory_attempts WHERE "taskId"=$1 AND stage='execute' AND status='passed'`, [routed.task.id]);
      assert.deepEqual(execute.evidence.map((e: { artifact: string; kind: string }) => [e.artifact, e.kind]),
        [[`run-report:${d.runId}`, "report"], [`run-capture:${shot}`, "screenshot"], [`run-capture:${clip}`, "video"]]);
      // The unrelated running task (its own run still running) did not move.
      assert.deepEqual(pick((await store.read("owner", other.task.id)).task), pick(otherBefore));
    });

    await t.test("an old run's completion after the attempt was replaced does not move the task", async () => {
      const stale = await runningTask();
      await succeed(stale.runId); // the old run ends; its completion hook is delayed
      // Meanwhile the attempt is replaced (finish failed + retry → fresh execute attempt, no run yet).
      let cur = (await store.read("owner", stale.task.id)).task;
      const failed = await store.apply("owner", factoryBinding(cur), randomUUID(), { action: "finish", status: "failed", reason: "replaced", evidence: [], output: {} });
      await store.apply("owner", factoryBinding(failed.task), randomUUID(), { action: "retry", reason: "replaced" });
      cur = (await store.read("owner", stale.task.id)).task;
      assert.equal(await reconcileFactoryAfterCompletion(pool, "owner", stale.runId, reconcileFor), 1);
      const after = (await store.read("owner", stale.task.id)).task;
      assert.deepEqual({ stage: after.stage, status: after.status, attemptId: after.attemptId, revision: after.revision }, { stage: cur.stage, status: cur.status, attemptId: cur.attemptId, revision: cur.revision });
    });

    await t.test("attempt replaced between selection and lock: the stale item is skipped (QA 5)", async () => {
      const race = await runningTask();
      await succeed(race.runId);
      let fresh = "";
      // Same pool, but the moment `.run` has selected its pending items, the attempt is
      // replaced and the replacement's own run also finishes (its hook not yet fired).
      const racing = new Proxy(pool, { get(target, key) {
        if (key !== "query") { const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v; }
        return async (text: string, params?: unknown[]) => {
          const res = await target.query(text, params);
          if (!fresh && typeof text === "string" && text.includes('AS "attemptId"')) {
            const cur = (await store.read("owner", race.task.id)).task;
            const failed = await store.apply("owner", factoryBinding(cur), randomUUID(), { action: "finish", status: "failed", reason: "replaced", evidence: [], output: {} });
            const retried = await store.apply("owner", factoryBinding(failed.task), randomUUID(), { action: "retry", reason: "replaced" });
            fresh = (await dispatch("owner", { binding: factoryBinding(retried.task), agentId, deviceRepoId: repoId })).runId;
            await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [fresh]);
            await succeed(fresh);
          }
          return res;
        };
      } }) as typeof pool;
      const racer = createFactoryReconciler(racing, store, questions);
      await racer.run("owner", race.runId);
      assert.ok(fresh);
      const after = (await store.read("owner", race.task.id)).task;
      assert.equal(after.stage, "execute", "old run's completion must not advance the replacement attempt");
      assert.notEqual(after.attemptId, race.task.attemptId);
    });

    await t.test("a failed run is a visible failure that re-enters the capped retry loop", async () => {
      const f = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='boom',"finishedAt"=clock_timestamp() WHERE id=$1`, [f.runId]);
      await reconcileFactoryAfterCompletion(pool, "owner", f.runId, reconcileFor);
      const after = (await store.read("owner", f.task.id)).task;
      assert.deepEqual({ stage: after.stage, status: after.status }, { stage: "execute", status: "pending" });
      assert.notEqual(after.attemptId, f.task.attemptId);
      const { rows: [old] } = await pool.query(`SELECT status, output FROM factory_attempts WHERE id=$1`, [f.task.attemptId]);
      assert.equal(old.status, "failed");
      assert.equal(old.output?.reasonCode, "run_failed");
    });

    await t.test("G2: reconciling one finished run does not move another task whose run also finished", async () => {
      const a = await runningTask(), b = await runningTask();
      await succeed(a.runId); await succeed(b.runId); // b's hook has not fired yet
      const bBefore = pick((await store.read("owner", b.task.id)).task);
      await reconcileFactoryAfterCompletion(pool, "owner", a.runId, reconcileFor);
      assert.equal((await store.read("owner", a.task.id)).task.stage, "review");
      assert.deepEqual(pick((await store.read("owner", b.task.id)).task), bBefore, "reconcile.run must stay scoped to its own run binding");
    });

    await t.test("G3: past maxFixAttempts a failed run stays failed with repair_budget_exhausted and no new attempt", async () => {
      const max = orchestratorSettings({}).maxFixAttempts;
      let cur = await runningTask();
      for (let i = 0; i < max; i++) {
        await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='boom',"finishedAt"=clock_timestamp() WHERE id=$1`, [cur.runId]);
        await reconcileFactoryAfterCompletion(pool, "owner", cur.runId, reconcileFor);
        const task = (await store.read("owner", cur.task.id)).task;
        assert.deepEqual({ stage: task.stage, status: task.status }, { stage: "execute", status: "pending" }, `retry ${i + 1} of ${max}`);
        const runId = (await dispatch("owner", { binding: factoryBinding(task), agentId, deviceRepoId: repoId })).runId;
        await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [runId]);
        cur = { task: (await store.read("owner", cur.task.id)).task, runId };
      }
      const attempts = (await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [cur.task.id])).rows[0].n;
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='boom',"finishedAt"=clock_timestamp() WHERE id=$1`, [cur.runId]);
      await reconcileFactoryAfterCompletion(pool, "owner", cur.runId, reconcileFor);
      const after = (await store.read("owner", cur.task.id)).task;
      assert.deepEqual({ stage: after.stage, status: after.status, attemptId: after.attemptId }, { stage: "execute", status: "failed", attemptId: cur.task.attemptId });
      assert.equal((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [cur.task.attemptId])).rows[0].output?.reasonCode, "repair_budget_exhausted");
      assert.equal((await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [cur.task.id])).rows[0].n, attempts, "no further attempt");
    });

    await t.test("G4: a failed run that already has a run-level retry child stays failed; no second loop", async () => {
      const f = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='boom',"finishedAt"=clock_timestamp() WHERE id=$1`, [f.runId]);
      await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"retryOf") SELECT $1,"userId","issueId","agentId","deviceId","deviceRepoId",'queued','Fixture',id FROM agent_runs WHERE id=$2`, [randomUUID(), f.runId]);
      const attempts = (await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [f.task.id])).rows[0].n;
      await reconcileFactoryAfterCompletion(pool, "owner", f.runId, reconcileFor);
      const after = (await store.read("owner", f.task.id)).task;
      assert.deepEqual({ status: after.status, attemptId: after.attemptId }, { status: "failed", attemptId: f.task.attemptId });
      assert.equal((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [f.task.attemptId])).rows[0].output?.reasonCode, "run_failed");
      assert.equal((await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [f.task.id])).rows[0].n, attempts);
    });

    await t.test("firing the hook again (and the preparePrompt fallback) does not advance twice", async () => {
      const before = await store.read("owner", routed.task.id);
      const events = (await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [routed.task.id])).rows[0].n;
      await Promise.all([1, 2, 3].map(() => reconcileFactoryAfterCompletion(pool, "owner", d.runId, reconcileFor)));
      await sweep("owner"); // the Coordinator-turn fallback
      const after = await store.read("owner", routed.task.id);
      assert.equal(after.task.stage, before.task.stage);
      assert.equal(after.task.revision, before.task.revision);
      assert.equal(after.task.candidateId, before.task.candidateId);
      assert.equal((await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [routed.task.id])).rows[0].n, events);
    });

    await t.test("reconcile failure is swallowed and left to the fallback", async () => {
      const n = await reconcileFactoryAfterCompletion(pool, "owner", d.runId, () => async () => { throw Object.assign(new Error("boom secret-ish"), { code: "40P01" }); });
      assert.equal(n, 0);
    });
  } finally {
    if (flags.r === undefined) delete process.env.MIKKA_FACTORY_ROUTING_ENABLED; else process.env.MIKKA_FACTORY_ROUTING_ENABLED = flags.r;
    if (flags.l === undefined) delete process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED; else process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = flags.l;
    // pg-pool resolves end() once clients are asked to close, not once their
    // backends are gone; wait for that before the FORCE drop so it never
    // terminates a still-closing socket (an uncaught 57P01 after the test).
    await pool.end();
    for (let i = 0; i < 100 && (await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [database])).rowCount; i++) await new Promise((r) => setTimeout(r, 50));
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
