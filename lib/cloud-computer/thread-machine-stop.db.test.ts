// #467 follow-up: ensureThreadMachine never starts a machine for a queued run whose stop was
// requested. Check 1 runs under the first run lock before any provider call; check 2 re-takes
// the run lock after the sandbox is created and before the worker is started.
// Real migrations, real run-control stop, fake provider; disposable *_e2e PG on loopback.
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

test("a stop-requested queued run ends instead of provisioning, at both check points", { skip: !url, timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `thr_stop_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const saved = { m: process.env.MIKKA_DATABASE_URL, d: process.env.DATABASE_URL };
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  let appPool: { end: () => Promise<void> } | null = null;
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    process.env.MIKKA_DATABASE_URL = process.env.DATABASE_URL = target.toString();
    const db = await import("../db");
    appPool = db.pool;
    const { ensureThreadMachine, threadMachineProvider } = await import("./thread-machines");
    const { stopOwnedRun } = await import("../run-control");

    const owner = "owner", workspaceId = randomUUID(), botId = randomUUID(), botDevice = randomUUID(), agentId = randomUUID(), repoId = randomUUID();
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture','thr-stop@example.invalid',true,now(),now())`, [owner]);
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'bot','cloud')`, [botDevice, owner]);
    await pool.query(`INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,'codex','Fixture',$3)`, [agentId, owner, botDevice]);
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,'/fixture/repo')`, [repoId, botDevice, owner]);
    await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'Fixture Bot')`, [botId, workspaceId, owner]);
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","sandboxId","operationId","runtimeReady",state,"deviceId") VALUES ($1,$2,'sandbox-bot',$3,true,'running',$4)`, [workspaceId, owner, randomUUID(), botDevice]);
    const actor = { userId: owner, workspaceId } as Parameters<typeof ensureThreadMachine>[1];
    const queuedRun = async () => {
      const runId = randomUUID();
      await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","botId","deviceId","deviceRepoId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,'queued','Fixture')`, [runId, owner, agentId, botId, botDevice, repoId]);
      await pool.query(`INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)`, [runId, botId, workspaceId, owner]);
      return runId;
    };
    const fake = (onCreate: () => Promise<void> = async () => {}) => {
      const calls: string[] = [];
      const provider: typeof threadMachineProvider = {
        snapshot: async () => { calls.push("snapshot"); return "snapshot-fixture"; },
        connect: async (id) => { calls.push(`connect:${id}`); return { sandboxId: id } as never; },
        create: async (_s, op) => { calls.push("create"); await onCreate(); return { sandboxId: `sandbox-${op}` } as never; },
        kill: async (id) => { calls.push(`kill:${id}`); },
      };
      return { calls, provider };
    };
    const state = async (runId: string) => ({
      run: (await pool.query('SELECT status,"stopRequestedAt" IS NOT NULL AS stop,"finishedAt" IS NOT NULL AS finished FROM agent_runs WHERE id=$1', [runId])).rows[0],
      machine: (await pool.query('SELECT state,"sandboxId","workerLeaseId","deviceId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0],
      tokens: (await pool.query('SELECT count(*)::int AS n FROM device_tokens t JOIN thread_machines m ON m."deviceId"=t."boundDeviceId" WHERE m."runId"=$1', [runId])).rows[0].n,
    });

    await t.test("check 1: a bound queued run stopped before provisioning ends, its old sandbox is killed, nothing is created", async () => {
      const runId = await queuedRun();
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","sandboxId","snapshotId","operationId",state) VALUES ($1,$2,$3,$4,'sandbox-old','snapshot-fixture',$5,'paused')`, [runId, workspaceId, owner, botId, randomUUID()]);
      // The real stop path: a machine-bound queued run only gets stopRequestedAt.
      assert.equal(await stopOwnedRun(db.db, owner, runId), false);
      const { calls, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), { status: 409, message: "Thread stopped" });
      assert.deepEqual(calls, ["kill:sandbox-old"], "no connect, snapshot or create");
      const s = await state(runId);
      assert.deepEqual(s.run, { status: "stopped", stop: true, finished: true });
      assert.equal(s.machine.state, "ended");
      assert.equal(s.machine.sandboxId, "sandbox-old", "kept so a failed kill stays retryable");
    });

    await t.test("check 1: a stopped queued run without a machine row creates none", async () => {
      const runId = await queuedRun();
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId]);
      const { calls, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), { status: 409, message: "Thread stopped" });
      assert.deepEqual(calls, []);
      const s = await state(runId);
      assert.equal(s.run.status, "stopped");
      assert.equal(s.machine, undefined);
    });

    await t.test("check 2: a stop landing while the sandbox is created ends the run before the worker starts", async () => {
      const runId = await queuedRun();
      const { calls, provider } = fake(async () => { assert.equal(await stopOwnedRun(db.db, owner, runId), false, "bound: stop is only requested"); });
      await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), { status: 409, message: "Thread stopped" });
      const created = (await pool.query('SELECT "operationId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0].operationId;
      assert.deepEqual(calls, ["snapshot", "create", `kill:sandbox-${created}`]);
      const s = await state(runId);
      assert.deepEqual(s.run, { status: "stopped", stop: true, finished: true });
      assert.equal(s.machine.state, "ended");
      assert.equal(s.machine.workerLeaseId, null);
      assert.equal(s.machine.deviceId, null, "no worker device was registered");
      assert.equal(s.tokens, 0, "no worker token was issued");
    });

    await t.test("control: without a stop, provisioning passes both checks (and fails later on the fake sandbox)", async () => {
      const runId = await queuedRun();
      const { calls, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), (e: Error) => e.message !== "Thread stopped");
      assert.deepEqual(calls.slice(0, 2), ["snapshot", "create"]);
      assert.ok(!calls.some((c) => c.startsWith("kill:")));
      assert.equal((await state(runId)).run.status, "queued");
    });
  } finally {
    await pool.end();
    await appPool?.end();
    if (saved.m === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = saved.m;
    if (saved.d === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.d;
    for (let i = 0; i < 100 && (await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1", [database])).rowCount; i++)
      await new Promise((r) => setTimeout(r, 50));
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
});
