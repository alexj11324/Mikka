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
import { dropTestDatabase } from '../../tests/support/drop-test-database';

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
  const saved = { m: process.env.MIKKA_DATABASE_URL, d: process.env.DATABASE_URL, template: process.env.E2B_CODEX_TEMPLATE };
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  let appPool: { end: () => Promise<void> } | null = null;
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    process.env.MIKKA_DATABASE_URL = process.env.DATABASE_URL = target.toString();
    process.env.E2B_CODEX_TEMPLATE = 'ready-template-fixture'; // The fixture agent runs Codex (decision 2026-11-01-2335).
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
    // A repository task's machine was started from its harness's ready template.
    const parked = async (issueId: string, opts: { bot?: string; repo?: string; status?: string; template?: string } = {}) => {
      const runId = await run(issueId, { ...opts, status: opts.status ?? "succeeded" });
      const device = randomUUID(), machineRepo = randomUUID(), sandboxId = `sandbox-${runId}`;
      const repo = (await pool.query(`SELECT "repoPath","remoteUrl" FROM device_repos WHERE id=$1`, [opts.repo ?? repoId])).rows[0];
      await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"nameLocked") VALUES ($1,$2,'Thread computer','cloud',true)`, [device, owner]);
      await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)`, [machineRepo, device, owner, repo.repoPath, repo.remoteUrl]);
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paused',$9,$10)`, [runId, workspaceId, owner, opts.bot ?? botId, issueId, sandboxId, opts.template ?? 'ready-template-fixture', randomUUID(), device, machineRepo]);
      return { runId, device, sandboxId };
    };
    const fake = () => {
      const calls: string[] = [];
      const sources: string[] = [];
      const provider: typeof threadMachineProvider = {
        snapshot: async () => { calls.push("snapshot"); return "snapshot-fixture"; },
        // The fake sandbox has no runtime: provisioning stops right after the provider step.
        connect: async (id) => { calls.push(`connect:${id}`); return { sandboxId: id } as never; },
        create: async (source, op) => { calls.push("create"); sources.push(source); return { sandboxId: `sandbox-${op}` } as never; },
        kill: async (id) => { calls.push(`kill:${id}`); },
      };
      return { calls, sources, provider };
    };
    const machine = async (runId: string) => (await pool.query('SELECT state,"sandboxId","deviceId","issueId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];

    await t.test('moving a queued repository task binds its existing authority to the owned thread device', async () => {
      const { admitRepositoryTask, matchesRepositoryAdmission } = await import('../repository-admission');
      const savedWorker = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA };
      process.env.MIKKA_CLOUD_WORKER_URL = 'https://worker.example.invalid/mikka';
      process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40);
      try {
        for (const corrupt of [false, true]) {
          const issueId = await task(), runId = await run(issueId);
          const scope = { userId: owner, issueId, agentId, deviceId: botDevice, workspaceId, remoteKey: 'v2/github.com/acme/app', remoteUrl: 'https://github.com/acme/app.git', targetBranch: `mikka/fixture-${number}` };
          const admission = admitRepositoryTask({ ...scope, grant: { grantedAt: new Date().toISOString() }, now: new Date() })!;
          assert.ok(admission);
          if (corrupt) admission.deviceId = randomUUID();
          await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [runId, { repositoryAdmission: admission }]);
          const { provider } = fake();
          provider.create = async (_source, op) => ({
            sandboxId: `sandbox-${op}`,
            files: { read: async () => 'a'.repeat(40), write: async () => { throw new Error('fixture reached worker handoff'); } },
            commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
          }) as never;
          await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), corrupt ? /Repository authority unavailable/ : /fixture reached worker handoff/);
          const current = (await pool.query('SELECT "deviceId","agentDefinition" FROM agent_runs WHERE id=$1', [runId])).rows[0];
          if (corrupt) {
            assert.equal(current.deviceId, botDevice, 'an invalid source receipt cannot be repaired into authority');
            assert.deepEqual(current.agentDefinition.repositoryAdmission, admission);
          } else {
            assert.notEqual(current.deviceId, botDevice);
            assert.deepEqual(current.agentDefinition.repositoryAdmission, { ...admission, deviceId: current.deviceId });
            assert.ok(matchesRepositoryAdmission(current.agentDefinition.repositoryAdmission, { ...scope, deviceId: current.deviceId }));
          }
        }
      } finally {
        if (savedWorker.url === undefined) delete process.env.MIKKA_CLOUD_WORKER_URL; else process.env.MIKKA_CLOUD_WORKER_URL = savedWorker.url;
        if (savedWorker.sha === undefined) delete process.env.MIKKA_CLOUD_WORKER_SHA; else process.env.MIKKA_CLOUD_WORKER_SHA = savedWorker.sha;
      }
    });

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
      await t.test(`${label} never gets the task's sandbox: it starts its own from the ready template`, async () => {
        const issueId = await task();
        const before = await parked(issueId);
        const next = await other(issueId);
        const { calls, sources, provider } = fake();
        await assert.rejects(ensureThreadMachine(pool, actor, next, provider));
        assert.deepEqual(calls, ["create"], 'repository tasks never clone a bot filesystem');
        assert.deepEqual(sources, ['ready-template-fixture']);
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

    await t.test("a run on another harness never resumes the task's machine: it starts its own from that harness's template", async () => {
      // The parked machine came from the claude template; the fixture agent runs Codex.
      const issueId = await task();
      const before = await parked(issueId, { template: 'claude-template-fixture' });
      const next = await run(issueId);
      const { calls, sources, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, provider));
      assert.deepEqual(calls, ["create"]);
      assert.deepEqual(sources, ['ready-template-fixture']);
      assert.notEqual((await machine(next)).sandboxId, before.sandboxId);
      assert.deepEqual(await machine(before.runId), { state: "paused", sandboxId: before.sandboxId, deviceId: before.device, issueId }, "the other harness's machine stays parked for the task");
    });

    await t.test("a sandbox whose run has not ended is never taken over", async () => {
      const issueId = await task();
      const before = await parked(issueId, { status: "queued" });
      const next = await run(issueId);
      const { calls, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, provider));
      assert.deepEqual(calls, ["create"]);
      assert.equal((await machine(before.runId)).sandboxId, before.sandboxId);
    });

    await t.test('a non-repository computer task retains its explicit desktop filesystem path', async () => {
      const computerRepo = randomUUID();
      await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,$4)', [computerRepo, botDevice, owner, '/fixture/computer']);
      const next = await run(await task(), { repo: computerRepo });
      const { calls, sources, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, provider));
      assert.deepEqual(calls, ['snapshot', 'create']);
      assert.deepEqual(sources, ['snapshot-fixture']);
    });

    await t.test('a repository identity mismatch refuses before allocating any machine', async () => {
      const next = await run(await task());
      const { calls, provider } = fake();
      await pool.query('UPDATE device_repos SET "remoteUrl"=$2 WHERE id=$1', [repoId, 'https://github.com/foreign/repository.git']);
      try {
        await assert.rejects(ensureThreadMachine(pool, actor, next, provider), /Repository identity unavailable/);
        assert.deepEqual(calls, []);
      } finally { await pool.query('UPDATE device_repos SET "remoteUrl"=$2 WHERE id=$1', [repoId, 'https://github.com/acme/app.git']); }
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
    if (saved.m === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = saved.m;
    if (saved.d === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.d;
    if (saved.template === undefined) delete process.env.E2B_CODEX_TEMPLATE; else process.env.E2B_CODEX_TEMPLATE = saved.template;
    await appPool?.end().catch(() => undefined);
    await dropTestDatabase(admin, database, pool);
    await admin.end();
  }
});
