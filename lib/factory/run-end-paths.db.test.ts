// QA #449: the real cancel and thread-end paths finalize the Factory task.
// Real migrations, app pool, run-control, completion transaction and Factory
// runtime over a disposable *_e2e PG. No module mocks.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";

const url = process.env.E2E_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(u.hostname), "loopback only");
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/, "database name must end in _e2e");
} else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("cancel and thread end reach a terminal run, then afterRunEnded finalizes the Factory task", { skip: !url, timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `fac_runend_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const saved = { m: process.env.MIKKA_DATABASE_URL, d: process.env.DATABASE_URL, r: process.env.MIKKA_FACTORY_ROUTING_ENABLED, l: process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED };
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  let appPool: { end: () => Promise<void> } | null = null;
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    // The application pool binds at import: point it at this database first.
    process.env.MIKKA_DATABASE_URL = process.env.DATABASE_URL = target.toString();
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = "1";
    const db = await import("../db");
    appPool = db.pool;
    const { requestRunStop } = await import("../agent-runs");
    const { persistRunCompletion } = await import("../run-publications");
    const { threadMachineAction } = await import("../cloud-computer/thread-machines");
    const { createFactoryStore } = await import("./store");
    const { createFactoryDispatch, factoryBinding } = await import("./dispatch");
    const { factoryCheckIndependent } = await import("./check-independence");

    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','runend@example.invalid',true,now(),now())`);
    const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), workspaceId = randomUUID();
    await pool.query(`INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Disposable',now(),'[{"harness":"codex","installed":true}]')`, [deviceId]);
    await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture','codex',$2)`, [agentId, deviceId]);
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,'owner','/fixture/repo')`, [repoId, deviceId]);
    const authorize = async (user: string, issue: string, tx: PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1;
    const store = createFactoryStore(pool, authorize, null, { independent: factoryCheckIndependent });
    const dispatch = createFactoryDispatch(pool, store, async (tx, userId, input, botId) => {
      const runId = randomUUID();
      await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','Fixture')`, [runId, userId, input.issueId, input.agentId, deviceId, input.deviceRepoId, botId]);
      return { runId };
    }, { configure: { execute: async () => {} }, freeze: async (tx, _task, id) => { await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id, JSON.stringify({ schemaVersion: 1, definitionDigest: "fixture", harness: "codex" })]); } });
    const runningTask = async () => {
      const issueId = randomUUID(), src = randomUUID();
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal')`, [issueId]);
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [src, src]);
      const r = await store.route("owner", { issueId, sourceEventId: src, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
      const run = await dispatch("owner", { binding: factoryBinding(r.task), agentId, deviceRepoId: repoId });
      await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now() WHERE id=$1`, [run.runId]);
      return { taskId: r.task.id, runId: run.runId };
    };
    const task = async (id: string) => (await pool.query('SELECT stage,status FROM factory_tasks WHERE id=$1', [id])).rows[0];
    const runStatus = async (id: string) => (await pool.query('SELECT status FROM agent_runs WHERE id=$1', [id])).rows[0].status;

    await t.test("cancel: the stop request alone is not an end; the daemon's stopped write finalizes the task", async () => {
      const c = await runningTask();
      await requestRunStop("owner", c.runId);
      assert.equal(await runStatus(c.runId), "running", "stop is requested, not yet acknowledged");
      assert.deepEqual(await task(c.taskId), { stage: "execute", status: "running" });
      assert.ok(await persistRunCompletion("owner", c.runId, { stopReason: "cancelled" }));
      assert.equal(await runStatus(c.runId), "cancelled");
      assert.deepEqual(await task(c.taskId), { stage: "execute", status: "cancelled" });
      // A replayed acknowledgement does not move the task again.
      const before = (await pool.query('SELECT revision FROM factory_tasks WHERE id=$1', [c.taskId])).rows[0].revision;
      await persistRunCompletion("owner", c.runId, { stopReason: "cancelled" });
      assert.equal((await pool.query('SELECT revision FROM factory_tasks WHERE id=$1', [c.taskId])).rows[0].revision, before);
    });

    await t.test("stopping a queued run ends it as stopped and finalizes the task (no daemon ack)", async () => {
      const q = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='queued',"startedAt"=NULL WHERE id=$1`, [q.runId]);
      await requestRunStop("owner", q.runId);
      const row = (await pool.query('SELECT status,"finishedAt","stopRequestedAt" FROM agent_runs WHERE id=$1', [q.runId])).rows[0];
      assert.equal(row.status, "stopped");
      assert.ok(row.finishedAt && row.stopRequestedAt);
      assert.deepEqual(await task(q.taskId), { stage: "execute", status: "cancelled" });
      // Already terminal: a second stop is rejected and moves nothing.
      await assert.rejects(requestRunStop("owner", q.runId), /runChainEnded/); // BE-18: an ended chain is a 409, not a 404
    });

    await t.test("a queued cloud run with a thread machine binding only records the stop request", async () => {
      const b = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='queued',"startedAt"=NULL WHERE id=$1`, [b.runId]);
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","snapshotId","operationId",state) VALUES ($1,$2,'owner','pending',$3,'starting')`, [b.runId, workspaceId, randomUUID()]);
      await requestRunStop("owner", b.runId);
      const row = (await pool.query('SELECT status,"finishedAt","stopRequestedAt" FROM agent_runs WHERE id=$1', [b.runId])).rows[0];
      assert.equal(row.status, "queued", "machine-bound queued run is not ended directly");
      assert.equal(row.finishedAt, null);
      assert.ok(row.stopRequestedAt);
      assert.deepEqual(await task(b.taskId), { stage: "execute", status: "running" });
      assert.equal((await pool.query('SELECT state FROM thread_machines WHERE "runId"=$1', [b.runId])).rows[0].state, "starting");
    });

    await t.test("stop on an ended earlier attempt reaches the queued latest: stopped, and afterRunEnded runs under the latest's own runId (BE-18)", async () => {
      const q = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='queued',"startedAt"=NULL,"createdAt"=now() WHERE id=$1`, [q.runId]);
      const origin = randomUUID();
      await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId",status,prompt,"createdAt","finishedAt") SELECT $1,'owner',"issueId","agentId","deviceId",'succeeded','Origin',now()-interval '1 hour',now() FROM agent_runs WHERE id=$2`, [origin, q.runId]);
      await pool.query(`UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1`, [q.runId, JSON.stringify({ originRunId: origin })]);
      assert.deepEqual(await requestRunStop("owner", origin), { stoppedRunIds: [q.runId] });
      assert.equal(await runStatus(q.runId), "stopped");
      assert.equal(await runStatus(origin), "succeeded");
      assert.deepEqual(await task(q.taskId), { stage: "execute", status: "cancelled" });
    });

    await t.test("ending a thread machine stops a Factory run and finalizes its task", async () => {
      const m = await runningTask();
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","snapshotId","operationId",state) VALUES ($1,$2,'owner','fixture-snapshot',$3,'paused')`, [m.runId, workspaceId, randomUUID()]);
      assert.deepEqual(await threadMachineAction(pool, { userId: "owner", workspaceId }, m.runId, "end"), { runId: m.runId, state: "ended" });
      assert.equal(await runStatus(m.runId), "stopped");
      assert.deepEqual(await task(m.taskId), { stage: "execute", status: "cancelled" });
    });
  } finally {
    for (const [k, v] of [["MIKKA_DATABASE_URL", saved.m], ["DATABASE_URL", saved.d], ["MIKKA_FACTORY_ROUTING_ENABLED", saved.r], ["MIKKA_FACTORY_LIFECYCLE_ENABLED", saved.l]] as const)
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await appPool?.end();
    // Loaded transitively by the run-stop path; it binds to the same database.
    await (globalThis as { workspacePool?: { end: () => Promise<void> } }).workspacePool?.end();
    await pool.end();
    // pool.end() resolves before the backends exit; wait before the FORCE drop.
    for (let i = 0; i < 100 && (await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [database])).rowCount; i++)
      await new Promise((r) => setTimeout(r, 50));
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
