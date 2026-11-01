// One task, one cloud sandbox (Alex, 2026-11-01). A task's next run resumes the
// sandbox its last run left paused; no other task, bot or repository can take
// it; a finished run of an open task parks its sandbox (paused, tokens
// revoked); a closed task's paused sandbox is ended for good.
// Real migrations, fake provider; disposable *_e2e PG on loopback.
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

test("a task's sandbox serves only that task's runs, parks between them and ends with the task", { skip: !url, timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `thr_task_${randomUUID().replaceAll("-", "")}_e2e`;
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
    const { ensureThreadMachine, parkThreadMachine, endClosedTaskMachines, keepTailBeforeKill, threadMachineProvider } = await import("./thread-machines");

    const owner = "owner", workspaceId = randomUUID(), botId = randomUUID(), otherBot = randomUUID(), botDevice = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), otherRepo = randomUUID();
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture','thr-task@example.invalid',true,now(),now())`, [owner]);
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'bot','cloud')`, [botDevice, owner]);
    await pool.query(`INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,'codex','Fixture',$3)`, [agentId, owner, botDevice]);
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,'v2/github.com/acme/app','https://github.com/acme/app.git')`, [repoId, botDevice, owner]);
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,'v2/github.com/acme/other','https://github.com/acme/other.git')`, [otherRepo, botDevice, owner]);
    for (const id of [botId, otherBot]) await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,$4)`, [id, workspaceId, owner, `Fixture Bot ${id}`]);
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","sandboxId","operationId","runtimeReady",state,"deviceId") VALUES ($1,$2,'sandbox-bot',$3,true,'running',$4)`, [workspaceId, owner, randomUUID(), botDevice]);
    const actor = { userId: owner, workspaceId } as Parameters<typeof ensureThreadMachine>[1];
    let number = 0;
    const task = async (status = "doing") => {
      const id = randomUUID();
      await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,'Fixture task',jsonb_build_object('type','doc','attrs',jsonb_build_object('mikka',jsonb_build_object('number',$4::int)),'content','[]'::jsonb),$3,'normal','personal')`, [id, owner, status, ++number]);
      return id;
    };
    const run = async (issueId: string | null, opts: { bot?: string; repo?: string; status?: string } = {}) => {
      const runId = randomUUID();
      await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","botId","issueId","deviceId","deviceRepoId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Fixture')`, [runId, owner, agentId, opts.bot ?? botId, issueId, botDevice, opts.repo ?? repoId, opts.status ?? "queued"]);
      await pool.query(`INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)`, [runId, opts.bot ?? botId, workspaceId, owner]);
      return runId;
    };
    // A finished run whose machine the lifecycle parked: paused, with its own device and repo.
    const parked = async (issueId: string, opts: { bot?: string; repo?: string; status?: string } = {}) => {
      const runId = await run(issueId, { ...opts, status: opts.status ?? "succeeded" });
      const device = randomUUID(), machineRepo = randomUUID(), sandboxId = `sandbox-${runId}`;
      const repo = (await pool.query(`SELECT "repoPath","remoteUrl" FROM device_repos WHERE id=$1`, [opts.repo ?? repoId])).rows[0];
      await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"nameLocked") VALUES ($1,$2,'Thread computer','cloud',true)`, [device, owner]);
      await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)`, [machineRepo, device, owner, repo.repoPath, repo.remoteUrl]);
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId") VALUES ($1,$2,$3,$4,$5,$6,'snapshot-fixture',$7,'paused',$8,$9)`, [runId, workspaceId, owner, opts.bot ?? botId, issueId, sandboxId, randomUUID(), device, machineRepo]);
      return { runId, device, sandboxId };
    };
    const fake = () => {
      const calls: string[] = [];
      const provider: typeof threadMachineProvider = {
        snapshot: async () => { calls.push("snapshot"); return "snapshot-fixture"; },
        // The fake sandbox has no runtime: provisioning stops right after the provider step.
        connect: async (id) => { calls.push(`connect:${id}`); return { sandboxId: id } as never; },
        create: async (_s, op) => { calls.push("create"); return { sandboxId: `sandbox-${op}` } as never; },
        kill: async (id) => { calls.push(`kill:${id}`); },
      };
      return { calls, provider };
    };
    const machine = async (runId: string) => (await pool.query('SELECT state,"sandboxId","deviceId","issueId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];

    await t.test("the task's next run resumes the paused sandbox: no snapshot, no new sandbox, same device", async () => {
      const issueId = await task();
      const before = await parked(issueId);
      const next = await run(issueId);
      const { calls, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, provider));
      assert.deepEqual(calls, [`connect:${before.sandboxId}`]);
      assert.deepEqual(await machine(next), { state: "paused", sandboxId: before.sandboxId, deviceId: before.device, issueId });
      assert.deepEqual(await machine(before.runId), { state: "ended", sandboxId: null, deviceId: before.device, issueId }, "the old row gives the sandbox up without a kill");
    });

    for (const [label, other] of [
      ["another task", async (_issueId: string) => run(await task())],
      ["another repository on the same task", async (issueId: string) => run(issueId, { repo: otherRepo })],
      ["a run with no task", async () => run(null)],
    ] as const) {
      await t.test(`${label} never gets the task's sandbox: it starts its own from the workspace snapshot`, async () => {
        const issueId = await task();
        const before = await parked(issueId);
        const next = await other(issueId);
        const { calls, provider } = fake();
        await assert.rejects(ensureThreadMachine(pool, actor, next, provider));
        assert.deepEqual(calls.slice(0, 2), ["snapshot", "create"]);
        assert.notEqual((await machine(next)).sandboxId, before.sandboxId);
        assert.equal((await machine(before.runId)).state, "paused", "the task's sandbox stays parked for the task");
      });
    }

    await t.test("the same task sent to another bot still resumes the task's sandbox (it belongs to the task, not the bot)", async () => {
      const issueId = await task();
      const before = await parked(issueId);
      const next = await run(issueId, { bot: otherBot });
      const { calls, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, provider));
      assert.deepEqual(calls, [`connect:${before.sandboxId}`]);
      assert.equal((await machine(next)).sandboxId, before.sandboxId);
    });

    await t.test("a sandbox whose run has not ended is never taken over", async () => {
      const issueId = await task();
      const before = await parked(issueId, { status: "queued" });
      const next = await run(issueId);
      const { calls, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, provider));
      assert.deepEqual(calls.slice(0, 2), ["snapshot", "create"]);
      assert.equal((await machine(before.runId)).sandboxId, before.sandboxId);
    });

    await t.test("a finished run parks its sandbox: paused, tokens revoked, device kept; a refused pause records nothing", async () => {
      const issueId = await task();
      const runId = await run(issueId, { status: "succeeded" });
      const device = randomUUID();
      await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"nameLocked") VALUES ($1,$2,'Thread computer','cloud',true)`, [device, owner]);
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","runningSince") VALUES ($1,$2,$3,$4,$5,'sandbox-live','snapshot-fixture',$6,'running',$7,now())`, [runId, workspaceId, owner, botId, issueId, randomUUID(), device]);
      await pool.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","expiresAt") VALUES ($1,$2,'Thread worker',$3,$4,now()+interval '1 day')`, [randomUUID(), owner, randomUUID(), device]);
      await assert.rejects(parkThreadMachine(pool, actor, runId, async () => { throw new Error("503 pause refused"); }, async () => null));
      assert.equal((await machine(runId)).state, "running", "a refused pause leaves the row as it was");
      const paused: string[] = [];
      await parkThreadMachine(pool, actor, runId, async (id) => { paused.push(id); }, async () => "worker: run finished");
      assert.equal((await pool.query('SELECT "logTail" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0].logTail, "worker: run finished", "the worker's last output is kept before the pause");
      assert.deepEqual(paused, ["sandbox-live"]);
      assert.deepEqual(await machine(runId), { state: "paused", sandboxId: "sandbox-live", deviceId: device, issueId });
      assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE "boundDeviceId"=$1', [device])).rows[0].revokedAt);
      assert.equal((await pool.query('SELECT "removedAt" FROM devices WHERE id=$1', [device])).rows[0].removedAt, null);
    });

    await t.test("before a kill the worker's tail is kept; a failing read never blocks the kill", async () => {
      const issueId = await task();
      const kept = await parked(issueId);
      await keepTailBeforeKill(pool, actor, kept.runId, kept.sandboxId, async () => "daemon: docker create timed out after 31s");
      assert.equal((await pool.query('SELECT "logTail" FROM thread_machines WHERE "runId"=$1', [kept.runId])).rows[0].logTail, "daemon: docker create timed out after 31s");
      await keepTailBeforeKill(pool, actor, kept.runId, kept.sandboxId, async () => { throw new Error("sandbox unreachable"); });
      assert.equal((await pool.query('SELECT "logTail" FROM thread_machines WHERE "runId"=$1', [kept.runId])).rows[0].logTail, "daemon: docker create timed out after 31s", "a failed read keeps the earlier tail");
    });

    await t.test("closed, duplicate and deleted tasks end their paused sandboxes; open ones keep them", async () => {
      await pool.query(`UPDATE thread_machines SET state='ended' WHERE state<>'ended'`);
      const open = await parked(await task("review"));
      const closed = await Promise.all(["done", "canceled", "duplicate"].map(async (status) => parked(await task(status))));
      const deletedTask = await task();
      await pool.query(`UPDATE issues SET content=jsonb_set(content,'{attrs,mikka,deletedAt}',to_jsonb(now()::text)) WHERE id=$1`, [deletedTask]);
      const deleted = await parked(deletedTask);
      const ended: string[] = [];
      const result = await endClosedTaskMachines(pool, async (_actor, runId) => { ended.push(runId); });
      assert.deepEqual(new Set(ended), new Set([...closed, deleted].map((m) => m.runId)));
      assert.equal(ended.includes(open.runId), false);
      assert.deepEqual(result, { ended: 4, pending: 0 });
    });
  } finally {
    process.env.MIKKA_DATABASE_URL = saved.m;
    process.env.DATABASE_URL = saved.d;
    await appPool?.end().catch(() => undefined);
    await pool.end();
    await admin.end();
  }
});
