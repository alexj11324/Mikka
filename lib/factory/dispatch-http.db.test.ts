// BE-10: POST /api/factory/tasks handler over the real dispatch + store on a disposable *_e2e PG.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { createFactoryStore } from "./store";
import { createFactoryDispatch, factoryBinding, type FactoryQueue } from "./dispatch";
import { factoryCheckIndependent } from "./check-independence";
import { handleFactoryDispatch } from "./dispatch-http";

const url = process.env.E2E_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(u.hostname), "loopback only");
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/, "database name must end in _e2e");
} else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("POST /api/factory/tasks dispatches once, replays idempotently and is owner-only", { skip: !url, timeout: 180000 }, async () => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `fac_tasks_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.toString(), max: 8 });
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
    const issueId = randomUUID(), sourceEventId = randomUUID();
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{}','todo','normal')`, [issueId]);
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId]);
    const routed = await store.route("owner", { issueId, sourceEventId, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
    const req = (userId: string, body: unknown) => ({ userId, origin: "https://app.example", url: "https://app.example/api/factory/tasks", body, enabled: true });
    const body = { binding: factoryBinding(routed.task), agentId, deviceRepoId: repoId };
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('intruder','X','x@example.invalid',true,now(),now())`);
    const other = await handleFactoryDispatch(async () => dispatch, req("intruder", body));
    assert.equal(other.status, 404);
    const bad = await handleFactoryDispatch(async () => dispatch, req("owner", { ...body, extra: 1 }));
    assert.equal(bad.status, 422);
    const created = await handleFactoryDispatch(async () => dispatch, req("owner", body));
    assert.equal(created.status, 201);
    const c = created.body as { runId: string; taskId: string; replayed: boolean };
    assert.equal(c.taskId, routed.task.id); assert.equal(c.replayed, false);
    const again = await handleFactoryDispatch(async () => dispatch, req("owner", body));
    assert.equal(again.status, 200);
    assert.equal((again.body as { runId: string }).runId, c.runId);
    const runs = await pool.query('SELECT id FROM agent_runs WHERE "issueId"=$1', [issueId]);
    assert.equal(runs.rowCount, 1);
    const audit = await pool.query('SELECT 1 FROM factory_events WHERE "taskId"=$1', [routed.task.id]);
    assert.ok((audit.rowCount ?? 0) >= 1, "dispatch receipt audited in factory_events");
    const stale = await handleFactoryDispatch(async () => dispatch, req("owner", { ...body, note: "different" }));
    assert.equal(stale.status, 409);
  } finally {
    await pool.end(); await admin.end();
  }
});
