// Ready thread machines (#1507): one paused, bootstrapped instance per owner and
// template; a claim is idempotent per operation; the reaper kills what nobody
// will use. Real migrations, fake E2B; disposable *_e2e PG on loopback.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";

const url = process.env.E2E_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(u.hostname), "loopback only");
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/, "database name must end in _e2e");
} else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("ready thread machines: refill, claim, forget, replace and reap", { skip: !url, timeout: 120000 }, async () => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `thr_pool_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    const ready = await import("./thread-machine-pool");
    const { THREAD_MACHINE_POOL_DUE_SQL } = await import("./thread-machine-pool-due");
    const owner = "owner";
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture','thr-pool@example.invalid',true,now(),now())`, [owner]);

    const calls: string[] = [];
    let broken = new Set<string>(), failPrepare = false, n = 0;
    const provider: import("./thread-machine-pool").PoolProvider = {
      options: async () => ({ apiKey: "fixture" }),
      create: async (template) => { const sandboxId = `sb-${template}-${++n}`; calls.push(`create:${sandboxId}`); return { sandboxId, commands: {} as never, pause: async () => { calls.push(`pause:${sandboxId}`); return true; } } as never; },
      connect: async (id) => { if (broken.has(id)) throw new Error("gone"); calls.push(`connect:${id}`); return { sandboxId: id } as never; },
      kill: async (id) => { calls.push(`kill:${id}`); },
      prepare: async () => { if (failPrepare) throw new Error("bootstrap failed"); },
    };
    const env = { MIKKA_CLOUD_WORKER_SHA: "a".repeat(40) };
    const rows = async () => (await pool.query('SELECT template,state,"sandboxId","claimedBy" IS NOT NULL AS claimed,"workerSha" FROM thread_machine_pool ORDER BY "createdAt","sandboxId"')).rows;

    // Refill fills one slot per owner and template, paused and ready.
    assert.equal(await ready.refillThreadMachinePool(pool, owner, "claude", provider, env), "ready");
    assert.equal(await ready.refillThreadMachinePool(pool, owner, "claude", provider, env), "full");
    assert.deepEqual(calls, ["create:sb-claude-1", "pause:sb-claude-1"]);

    // A claim resumes it; the same operation gets the same instance; another finds none.
    const op = randomUUID();
    assert.equal((await ready.claimReadyThreadMachine(pool, owner, "claude", op, provider, env))?.sandboxId, "sb-claude-1");
    assert.equal((await ready.claimReadyThreadMachine(pool, owner, "claude", op, provider, env))?.sandboxId, "sb-claude-1");
    assert.equal(await ready.claimReadyThreadMachine(pool, owner, "claude", randomUUID(), provider, env), null);
    assert.equal(await ready.claimReadyThreadMachine(pool, owner, "codex", randomUUID(), provider, env), null);
    // Another owner never gets this owner's instance (each runs on its own key).
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('other','Other','thr-pool-2@example.invalid',true,now(),now())`);

    // A claimed slot is refilled at once; recording forgets the claimed row.
    assert.equal(await ready.refillThreadMachinePool(pool, owner, "claude", provider, env), "ready");
    assert.equal(await ready.claimReadyThreadMachine(pool, "other", "claude", randomUUID(), provider, env), null);
    await ready.forgetClaimedThreadMachine(pool, "sb-claude-1");
    assert.deepEqual((await rows()).map(r => [r.sandboxId, r.state, r.claimed]), [["sb-claude-2", "ready", false]]);

    // A new worker release replaces an older ready instance; the old one is never handed out.
    calls.length = 0;
    const next = { MIKKA_CLOUD_WORKER_SHA: "b".repeat(40) };
    assert.equal(await ready.claimReadyThreadMachine(pool, owner, "claude", randomUUID(), provider, next), null);
    assert.equal(await ready.refillThreadMachinePool(pool, owner, "claude", provider, next), "ready");
    assert.deepEqual(calls, ["kill:sb-claude-2", "create:sb-claude-3", "pause:sb-claude-3"]);

    // An instance that cannot be resumed is killed and forgotten; the dispatch starts fresh.
    broken = new Set(["sb-claude-3"]); calls.length = 0;
    assert.equal(await ready.claimReadyThreadMachine(pool, owner, "claude", randomUUID(), provider, next), null);
    assert.deepEqual(calls, ["kill:sb-claude-3"]);
    assert.deepEqual(await rows(), []);

    // A failed refill leaves nothing behind.
    failPrepare = true; calls.length = 0;
    assert.equal(await ready.refillThreadMachinePool(pool, owner, "codex", provider, next), "failed");
    assert.deepEqual(calls, ["create:sb-codex-4", "kill:sb-codex-4"]);
    assert.deepEqual(await rows(), []);
    failPrepare = false;

    // Reaper: unused for a week, a refill that died, a claim never recorded; a recorded claim is only forgotten.
    assert.equal((await pool.query(`SELECT * FROM (${THREAD_MACHINE_POOL_DUE_SQL}) d`)).rows[0].at, null);
    assert.equal(await ready.refillThreadMachinePool(pool, owner, "claude", provider, next), "ready"); // sb-claude-5
    assert.equal(await ready.refillThreadMachinePool(pool, owner, "desktop", provider, next), "ready"); // sb-desktop-6
    const due = (await pool.query(`SELECT * FROM (${THREAD_MACHINE_POOL_DUE_SQL}) d`)).rows[0].at as Date;
    assert.ok(due.getTime() > Date.now() + 6 * 86400_000, "a fresh ready instance is due only after a week");
    await pool.query(`UPDATE thread_machine_pool SET "readyAt"=now()-interval '8 days' WHERE "sandboxId"='sb-desktop-6'`);
    await pool.query(`INSERT INTO thread_machine_pool (id,"ownerId",template,"workerSha",state,"sandboxId","createdAt") VALUES ($1,$2,'codex',$3,'warming','sb-dead',now()-interval '1 hour')`, [randomUUID(), owner, next.MIKKA_CLOUD_WORKER_SHA]);
    const recorded = randomUUID(), lost = randomUUID();
    await ready.claimReadyThreadMachine(pool, owner, "claude", recorded, provider, next); // sb-claude-5
    await pool.query(`INSERT INTO thread_machine_pool (id,"ownerId",template,"workerSha",state,"sandboxId","claimedBy","claimedAt","readyAt") VALUES ($1,$2,'claude',$3,'ready','sb-lost',$4,now()-interval '2 hours',now())`, [randomUUID(), owner, next.MIKKA_CLOUD_WORKER_SHA, lost]);
    const workspaceId = randomUUID(), botId = randomUUID(), runId = randomUUID(), agentId = randomUUID(), device = randomUUID();
    await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'Fixture Bot')`, [botId, workspaceId, owner]);
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'bot','cloud')`, [device, owner]);
    await pool.query(`INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,'codex','Fixture',$3)`, [agentId, owner, device]);
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","botId","deviceId",status,prompt) VALUES ($1,$2,$3,$4,$5,'queued','Fixture')`, [runId, owner, agentId, botId, device]);
    await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","sandboxId","snapshotId","operationId",state) VALUES ($1,$2,$3,$4,'sb-claude-5','claude',$5,'starting')`, [runId, workspaceId, owner, botId, recorded]);
    assert.ok(((await pool.query(`SELECT * FROM (${THREAD_MACHINE_POOL_DUE_SQL}) d`)).rows[0].at as Date).getTime() <= Date.now() + 1000);
    calls.length = 0;
    assert.deepEqual(await ready.reapThreadMachinePool(pool, provider), { killed: 3, pending: 0 });
    assert.deepEqual(calls.sort(), ["kill:sb-dead", "kill:sb-desktop-6", "kill:sb-lost"]);
    assert.deepEqual(await rows(), []);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
