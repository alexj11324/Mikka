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
    const reconcileFor = () => createFactoryReconciler(pool, store, questions);
    const issueId = randomUUID(), sourceEventId = randomUUID();
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{}','todo','normal')`, [issueId]);
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId]);
    const routed = await store.route("owner", { issueId, sourceEventId, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
    const d = await dispatch("owner", { binding: factoryBinding(routed.task), agentId, deviceRepoId: repoId });
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [d.runId]);

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
      assert.equal(await reconcileFactoryAfterCompletion(pool, "owner", d.runId, reconcileFor), 1);
      const after = await store.read("owner", routed.task.id);
      assert.equal(after.task.stage, "review");
    });

    await t.test("firing the hook again (and the preparePrompt fallback) does not advance twice", async () => {
      const before = await store.read("owner", routed.task.id);
      const events = (await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [routed.task.id])).rows[0].n;
      await Promise.all([1, 2, 3].map(() => reconcileFactoryAfterCompletion(pool, "owner", d.runId, reconcileFor)));
      await reconcileFor()("owner"); // the Coordinator-turn fallback
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
    await pool.end();
    await admin.end();
  }
});
