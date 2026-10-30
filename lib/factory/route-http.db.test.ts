// BE-10b: POST /api/factory/tasks/route handler over the real store on a disposable *_e2e PG.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { createFactoryStore } from "./store";
import { factoryCheckIndependent } from "./check-independence";
import { handleFactoryRoute } from "./route-http";
import { isE2eTarget, E2E_DB_RULE } from "../../tests/helpers/e2e-target.mjs";

const url = process.env.E2E_DATABASE_URL;
if (url) assert.ok(isE2eTarget(url), E2E_DB_RULE);
else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("POST /api/factory/tasks/route routes once, replays, masks and is owner-only", { skip: !url, timeout: 180000 }, async () => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `fac_route_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.toString(), max: 8 });
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    for (const id of ["owner", "intruder"])
      await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture',$2,true,now(),now())`, [id, `${id}@example.invalid`]);
    const authorize = async (user: string, issue: string, tx: PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1;
    const store = createFactoryStore(pool, authorize, null, { independent: factoryCheckIndependent });
    const route = async () => (userId: string, input: unknown) => store.route(userId, input);
    const issueId = randomUUID(), sourceEventId = randomUUID(), intruderEvent = randomUUID();
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal')`, [issueId]);
    for (const [id, user] of [[sourceEventId, "owner"], [intruderEvent, "intruder"]])
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,'{"text":"synthetic"}')`, [id, user, `fixture-${id}`]);
    const req = (userId: string, body: unknown) => ({ userId, origin: "https://app.example", url: "https://app.example/api/factory/tasks/route", body, enabled: true });
    const token = "ghp_fixtureFixture1234";
    const body = { issueId, eventId: randomUUID(), sourceEventId, rationale: `Task requested, token=${token}`, missingInformation: [], missingPermissions: [], needsSpec: false };

    assert.deepEqual(await handleFactoryRoute(route, req("intruder", { ...body, sourceEventId: intruderEvent })), { status: 404, body: { error: "factoryNotFound" } });
    assert.deepEqual(await handleFactoryRoute(route, req("owner", { ...body, extra: 1 })), { status: 422, body: { error: "factoryInvalid" } });
    assert.deepEqual(await handleFactoryRoute(route, req("owner", { ...body, sourceEventId: intruderEvent })), { status: 409, body: { error: "factorySourceMismatch" } });

    const created = await handleFactoryRoute(route, req("owner", body));
    assert.equal(created.status, 200);
    const c = created.body as { taskId: string; stage: string; status: string; binding: { taskId: string; issueId: string; revision: number; candidateId: null } };
    assert.deepEqual([c.stage, c.status, c.binding.taskId, c.binding.issueId, c.binding.revision, c.binding.candidateId], ["execute", "pending", c.taskId, issueId, 1, null]);

    const again = await handleFactoryRoute(route, req("owner", body));
    assert.deepEqual(again, created, "same eventId + body replays the stored snapshot");
    assert.deepEqual(await handleFactoryRoute(route, req("owner", { ...body, rationale: "other" })), { status: 409, body: { error: "factoryReplayMismatch" } });
    assert.deepEqual(await handleFactoryRoute(route, req("owner", { ...body, eventId: randomUUID() })), { status: 409, body: { error: "factoryRouteExists" } });
    assert.equal((await pool.query('SELECT 1 FROM factory_tasks WHERE "issueId"=$1', [issueId])).rowCount, 1);

    const stored = await pool.query(`SELECT t.route::text || t.reason || coalesce(string_agg(e.request::text || e.result::text, ''), '') AS text FROM factory_tasks t LEFT JOIN factory_events e ON e."taskId"=t.id WHERE t.id=$1 GROUP BY t.id`, [c.taskId]);
    assert.ok(!stored.rows[0].text.includes(token), "route, reason and receipts hold only the masked rationale");
    assert.match(stored.rows[0].text, /REDACTED/);
  } finally {
    await pool.end();
    // pool.end() resolves before the backends exit; wait before the FORCE drop.
    for (let i = 0; i < 100 && (await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [database])).rowCount; i++)
      await new Promise((r) => setTimeout(r, 50));
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
