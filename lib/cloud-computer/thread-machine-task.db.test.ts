// One task, one cloud sandbox (Alex, 2026-11-01). A task's next run resumes the
// sandbox its last run left paused; no other task, bot or repository can take
// it; a finished run of an open task parks its sandbox (paused, tokens
// revoked); a closed task's paused sandbox is ended for good.
// Real migrations, fake provider; disposable *_e2e PG on loopback.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
    process.env.E2B_CODEX_TEMPLATE = 'codex'; // The fixture agent runs Codex (decision 2026-11-01-2335).
    const db = await import("../db");
    appPool = db.pool;
    const { ensureThreadMachine, parkThreadMachine, endClosedTaskMachines, keepTailBeforeKill, threadMachineAction, threadMachineProvider } = await import("./thread-machines");

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
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paused',$9,$10)`, [runId, workspaceId, owner, opts.bot ?? botId, issueId, sandboxId, opts.template ?? 'codex', randomUUID(), device, machineRepo]);
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

    await t.test('a maintenance lease prevents adoption and replacement of the original VM', async () => {
      const issueId = await task(), previous = await parked(issueId);
      await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '10 minutes' WHERE "runId"=$1`, [previous.runId, randomUUID()]);
      const next = await run(issueId), fixture = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider), /maintenance in progress/);
      assert.deepEqual(fixture.calls, []);
      assert.equal((await machine(previous.runId)).sandboxId, previous.sandboxId);
      assert.equal(await machine(next), undefined);
    });
    await t.test('runtime refresh rejects active native work before any provider call', async () => {
      const previous = await parked(await task());
      await pool.query(`UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1`, [previous.runId, previous.device]);
      const active = await run(await task());
      await pool.query(`UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1`, [active, previous.device]);
      const fixture = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, previous.runId, fixture.provider, undefined, true), /runtime is busy/);
      assert.deepEqual(fixture.calls, []);
    });

    await t.test('moving a queued repository task binds its existing authority to the owned thread device', async () => {
      const { admitRepositoryTask, matchesRepositoryAdmission } = await import('../repository-admission');
      const savedWorker = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA };
      process.env.MIKKA_CLOUD_WORKER_URL = 'https://worker.example.invalid/mikka';
      process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40);
      try {
        for (const corrupt of [false, true]) {
          const issueId = await task(), runId = await run(issueId);
          const scope = { userId: owner, issueId, agentId, deviceId: botDevice, workspaceId, remoteKey: 'v2/github.com/acme/app', remoteUrl: 'https://github.com/acme/app.git', targetBranch: `mikka/fixture-${number}` };
          const admission = admitRepositoryTask({ ...scope, now: new Date() })!;
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

    await t.test('a preloaded worker authenticating on bootstrap publication is ready before explicit start', async () => {
      const savedWorker = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA };
      const realNow = Date.now;
      process.env.MIKKA_CLOUD_WORKER_URL = 'https://worker.example.invalid/mikka';
      process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40);
      try {
        const runId = await run(await task()), fixture = fake();
        let bootstrap: { deviceId: string; credential: string } | undefined, authenticated = 0;
        fixture.provider.create = async (_source, op) => ({
          sandboxId: `sandbox-${op}`,
          files: {
            read: async () => 'a'.repeat(40),
            write: async (path: string, body: string) => {
              if (path.startsWith('/run/mikka-viewer/thread-')) bootstrap = JSON.parse(body);
            },
          },
          commands: { run: async (command: string) => {
            if (command.includes('mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json')) {
              assert.ok(bootstrap);
              const used = await pool.query(`UPDATE device_tokens SET "lastUsedAt"=clock_timestamp() WHERE "boundDeviceId"=$1 AND "tokenHash"=$2 AND "revokedAt" IS NULL RETURNING id`, [bootstrap.deviceId, createHash('sha256').update(bootstrap.credential).digest('hex')]);
              assert.equal(used.rowCount, 1);
              await pool.query(`UPDATE devices SET "lastSeenAt"=clock_timestamp() WHERE id=$1`, [bootstrap.deviceId]);
              authenticated++;
              // Make the historical late floor observably later than this real authentication.
              await pool.query('SELECT pg_sleep(0.02)');
            }
            if (command.includes('node dist/cloud/cloud-worker.js')) {
              // The preloader already authenticated. Production throttles the token
              // timestamp, so explicit startup must not manufacture another use.
              let reads = 0;
              Date.now = () => realNow() + (++reads > 1 ? 31_000 : 0);
            }
            return { stdout: '', stderr: '', exitCode: 0 };
          } },
        }) as never;
        assert.deepEqual(await ensureThreadMachine(pool, actor, runId, fixture.provider), { runId, state: 'running' });
        assert.equal(authenticated, 1);
      } finally {
        Date.now = realNow;
        if (savedWorker.url === undefined) delete process.env.MIKKA_CLOUD_WORKER_URL; else process.env.MIKKA_CLOUD_WORKER_URL = savedWorker.url;
        if (savedWorker.sha === undefined) delete process.env.MIKKA_CLOUD_WORKER_SHA; else process.env.MIKKA_CLOUD_WORKER_SHA = savedWorker.sha;
      }
    });

    // The daemon runs every computer action as lease-driver.py under /run/mikka-viewer/1.lock,
    // which reads /run/mikka-viewer/1.json; a snapshot boots with no display and no lease.
    await t.test('a computer task starts display :1 and publishes its lease before the worker is handed a credential', async () => {
      const savedWorker = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA };
      process.env.MIKKA_CLOUD_WORKER_URL = 'https://worker.example.invalid/mikka';
      process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40);
      try {
        const computerRepo = randomUUID();
        await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,'/home/user/.mikka/bot-workspaces/fixture')`, [computerRepo, botDevice, owner]);
        await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,version) VALUES ($1,'allow',3) ON CONFLICT ("workspaceId") DO UPDATE SET permission='allow',version=3`, [workspaceId]);
        const runId = await run(await task(), { repo: computerRepo });
        const steps: string[] = [];
        const files = new Map<string, string>();
        const { provider } = fake();
        provider.create = async (_source, op) => ({
          sandboxId: `sandbox-${op}`,
          files: {
            read: async () => 'a'.repeat(40),
            write: async (path: string, body: string) => {
              if (path.startsWith('/run/mikka-viewer/thread-')) { steps.push('handoff'); throw new Error('fixture reached worker handoff'); }
              files.set(path, body);
            },
          },
          commands: { run: async (command: string) => {
            if (command.includes('start-desktop.sh 1')) steps.push('display');
            if (command.includes('mv /run/mikka-viewer/1.next /run/mikka-viewer/1.json')) steps.push('lease');
            return { stdout: '', stderr: '', exitCode: 0 };
          } },
        }) as never;
        await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), /fixture reached worker handoff/);
        assert.deepEqual(steps, ['display', 'lease', 'handoff']);
        const { epoch } = (await pool.query('SELECT epoch FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];
        assert.deepEqual(JSON.parse(files.get('/run/mikka-viewer/1.next')!), { botId, ownerId: owner, display: 1, epoch, controlledBy: null, controlUntil: 0, computerAllowed: true, policyVersion: 3 });
      } finally {
        await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [workspaceId]);
        if (savedWorker.url === undefined) delete process.env.MIKKA_CLOUD_WORKER_URL; else process.env.MIKKA_CLOUD_WORKER_URL = savedWorker.url;
        if (savedWorker.sha === undefined) delete process.env.MIKKA_CLOUD_WORKER_SHA; else process.env.MIKKA_CLOUD_WORKER_SHA = savedWorker.sha;
      }
    });

    await t.test('a fresh official instance initializes its registered private Bot workspace before worktree creation', async () => {
      const savedWorker = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA };
      const root = await mkdtemp(join(tmpdir(), 'mikka-fresh-hosted-workspace-'));
      const local = join(root, 'registered'), remote = `/home/user/.mikka/bot-workspaces/${botId}`;
      const execute = promisify(execFile);
      process.env.MIKKA_CLOUD_WORKER_URL = 'https://worker.example.invalid/mikka';
      process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40);
      try {
        const workspaceRepo = randomUUID();
        await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch") VALUES ($1,$2,$3,$4,'main')`, [workspaceRepo, botDevice, owner, remote]);
        const runId = await run(await task(), { repo: workspaceRepo });
        const { provider } = fake();
        const commands = { run: async (command: string) => {
          if (command.includes(remote)) await execute('bash', ['-c', command.replaceAll(remote, local)]);
          return { stdout: '', stderr: '', exitCode: 0 };
        } };
        provider.create = async (_source, op) => ({
          sandboxId: `sandbox-${op}`,
          files: { read: async () => 'a'.repeat(40), write: async (path: string) => { if (path.startsWith('/run/mikka-viewer/thread-')) throw new Error('fixture reached worker handoff'); } },
          commands,
        }) as never;
        await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), /fixture reached worker handoff/);
        const { WorktreeManager } = await import('../../packages/daemon/src/worktrees');
        const worktree = await new WorktreeManager(join(root, 'worktrees'), true).create(runId, local, 'main');
        assert.match((await execute('git', ['-C', worktree, 'rev-parse', '--verify', 'HEAD'])).stdout.trim(), /^[a-f0-9]{40}$/);
        await writeFile(join(local, 'unsubmitted.txt'), 'retain uncommitted bytes\n');
        const before = (await execute('git', ['-C', local, 'rev-parse', 'HEAD'])).stdout;
        const { initializeBotWorkspace } = await import('../computer/bot-workspace');
        await initializeBotWorkspace({ commands } as never, botId);
        assert.equal(await readFile(join(local, 'unsubmitted.txt'), 'utf8'), 'retain uncommitted bytes\n');
        assert.equal((await execute('git', ['-C', local, 'rev-parse', 'HEAD'])).stdout, before, 'an existing workspace is not reset or recommitted');
      } finally {
        await rm(root, { recursive: true, force: true });
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
        assert.deepEqual(sources, ['codex']);
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
      const before = await parked(issueId, { template: 'claude' });
      const next = await run(issueId);
      const { calls, sources, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, provider));
      assert.deepEqual(calls, ["create"]);
      assert.deepEqual(sources, ['codex']);
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
      assert.deepEqual(calls, ['create']);
      assert.deepEqual(sources, ['desktop']);
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

    await t.test('concurrent lifecycle and Factory parking cannot suspend or revoke the next stage', async () => {
      const issueId = await task(), before = await parked(issueId);
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now() WHERE "runId"=$1`, [before.runId]);
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      let calls = 0;
      const pause = async () => { if (++calls === 1) { entered(); await held; } };
      const first = parkThreadMachine(pool, actor, before.runId, pause, async () => null);
      await started;
      const second = parkThreadMachine(pool, actor, before.runId, pause, async () => null);
      try {
        const deadline = Date.now() + 5000;
        while (calls < 2) {
          const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`);
          if (waiting.rowCount) break;
          assert.ok(Date.now() < deadline, 'second park must finish or wait on the machine owner');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } finally { release(); await Promise.all([first, second]); }
      assert.equal(calls, 1, 'only one caller may pause the physical sandbox');
      const next = await run(issueId);
      await assert.rejects(ensureThreadMachine(pool, actor, next, fake().provider));
      const token = randomUUID();
      await pool.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","expiresAt") VALUES ($1,$2,'New stage',$3,$4,now()+interval '1 day')`, [token, owner, randomUUID(), before.device]);
      await parkThreadMachine(pool, actor, before.runId, pause, async () => null);
      assert.equal(calls, 1, 'a stale old-run callback cannot pause the adopted sandbox');
      assert.equal((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [token])).rows[0].revokedAt, null);
      assert.equal((await machine(next)).sandboxId, before.sandboxId);
    });

    await t.test('ending an adopted old stage cannot retire the next stage device or credentials', async () => {
      const issueId = await task(), before = await parked(issueId), next = await run(issueId);
      await assert.rejects(ensureThreadMachine(pool, actor, next, fake().provider));
      const token = randomUUID();
      await pool.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","expiresAt") VALUES ($1,$2,'New stage',$3,$4,now()+interval '1 day')`, [token, owner, randomUUID(), before.device]);
      assert.equal((await machine(before.runId)).sandboxId, null);
      await threadMachineAction(pool, actor, before.runId, 'end');
      assert.equal((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [token])).rows[0].revokedAt, null, 'the ended row no longer controls this device');
      assert.equal((await pool.query('SELECT "removedAt" FROM devices WHERE id=$1', [before.device])).rows[0].removedAt, null);
      assert.equal((await machine(next)).sandboxId, before.sandboxId);
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
