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
import { runPrompt } from "../run-prompt";
import { factoryEventId } from "./event-id";
import { isE2eTarget, E2E_DB_RULE } from "../../tests/helpers/e2e-target.mjs";

const url = process.env.E2E_DATABASE_URL;
if (url) assert.ok(isE2eTarget(url), E2E_DB_RULE);
else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("POST /api/factory/tasks dispatches once, replays idempotently and is owner-only", { skip: !url, timeout: 180000 }, async () => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `fac_tasks_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.toString(), max: 8 });
  let previousKey: string | undefined;
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
    // Same prompt builder as the real queue (run-dispatch), so the stored prompt shows what the agent reads.
    const queue: FactoryQueue = async (tx, userId, input, botId) => {
      const runId = randomUUID();
      await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8)`, [runId, userId, input.issueId, input.agentId, deviceId, input.deviceRepoId, botId, runPrompt("Fixture", "", "", input.note)]);
      return { runId };
    };
    const dispatch = createFactoryDispatch(pool, store, queue, { configure: { execute: async () => {} }, freeze: async (tx, _task, id) => { await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id, JSON.stringify({ schemaVersion: 1, definitionDigest: "fixture", harness: "codex" })]); } });
    const issueId = randomUUID(), sourceEventId = randomUUID();
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{}','todo','normal')`, [issueId]);
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId]);
    const routed = await store.route("owner", { issueId, sourceEventId, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
    const req = (userId: string, body: unknown) => ({ userId, origin: "https://app.example", url: "https://app.example/api/factory/tasks", body, enabled: true });
    const secret = "e2b_fixture_0123456789abcdef";
    previousKey = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = secret; // synthetic value, never a real key; restored below
    const note = `use ${secret} and token=ghp_fixtureFixture1234 (b64 ${Buffer.from(secret).toString("base64")})`;
    const body = { binding: factoryBinding(routed.task), agentId, deviceRepoId: repoId, note };
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('intruder','X','x@example.invalid',true,now(),now())`);
    const other = await handleFactoryDispatch(async () => dispatch, req("intruder", body));
    assert.deepEqual(other, { status: 404, body: { error: "factoryNotFound" } });
    const bad = await handleFactoryDispatch(async () => dispatch, req("owner", { ...body, extra: 1 }));
    assert.deepEqual(bad, { status: 422, body: { error: "factoryInvalid" } });
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
    const leaks = (text: string) => [secret, Buffer.from(secret).toString("base64"), "ghp_fixtureFixture1234"].filter((s) => text.includes(s));
    const { rows: [receipt] } = await pool.query(`SELECT request::text AS request, result::text AS result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2`, [routed.task.id, factoryEventId("dispatch-v2", routed.task.attemptId)]);
    assert.deepEqual(leaks(receipt.request + receipt.result), [], "factory_events.request/result carry only the masked note");
    assert.match(receipt.request, /\[secret\]/);
    const { rows: [run] } = await pool.query('SELECT prompt FROM agent_runs WHERE id=$1', [c.runId]);
    assert.deepEqual(leaks(run.prompt), [], "run prompt carries only the masked note");
    assert.match(run.prompt, /## Notes for this run[\s\S]*\[secret\]/);
    const stale = await handleFactoryDispatch(async () => dispatch, req("owner", { ...body, note: "different" }));
    assert.deepEqual(stale, { status: 409, body: { error: "factoryReplayMismatch" } }, "same binding, different note");
  } finally {
    if (previousKey === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = previousKey;
    await pool.end();
    // pool.end() resolves before the backends exit; a FORCE drop right away kills
    // closing sockets ("terminating connection due to administrator command").
    for (let i = 0; i < 100 && (await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [database])).rowCount; i++)
      await new Promise((r) => setTimeout(r, 50));
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
