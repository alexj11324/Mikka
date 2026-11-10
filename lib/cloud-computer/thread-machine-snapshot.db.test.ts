import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import { REGISTRATION_COMPLETE } from '../computer/registration-command'
// Thread-level filesystem snapshots: one image per task machine, only after a
// native safe point; restore only for the same queued task, owner, workspace,
// repository and template kind. Real migrations, fake provider; disposable
// *_e2e PG on loopback. Run with MIKKA_THREAD_SNAPSHOTS=1 (the suite sets it).
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { dropTestDatabase } from "../../tests/support/drop-test-database";

type UploadedFile = { path: string; data: string };
function uploadedFiles(path: string | UploadedFile[], body?: unknown): UploadedFile[] {
  return typeof path === 'string' ? [{ path, data: typeof body === 'string' ? body : '' }] : path;
}
function uploadedBootstrap(path: string | UploadedFile[], body?: unknown): { deviceId: string; credential: string } | undefined {
  const file = uploadedFiles(path, body).find(item => /^\/run\/mikka-viewer\/thread-[\w-]+\.json$/.test(item.path));
  return file ? JSON.parse(file.data) : undefined;
}

const url = process.env.E2E_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(u.hostname), "loopback only");
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/, "database name must end in _e2e");
} else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("thread filesystem snapshots park once and restore only the same task machine", { skip: !url, timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `thr_snap_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const savedEnv: [string, string | undefined][] = [
    ['MIKKA_DATABASE_URL', process.env.MIKKA_DATABASE_URL], ['DATABASE_URL', process.env.DATABASE_URL],
    ['E2B_CODEX_TEMPLATE', process.env.E2B_CODEX_TEMPLATE], ['MIKKA_THREAD_SNAPSHOTS', process.env.MIKKA_THREAD_SNAPSHOTS],
    ['MIKKA_CLOUD_WORKER_URL', process.env.MIKKA_CLOUD_WORKER_URL], ['MIKKA_CLOUD_WORKER_SHA', process.env.MIKKA_CLOUD_WORKER_SHA],
  ];
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  let appPool: Pool | undefined;
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    process.env.MIKKA_DATABASE_URL = process.env.DATABASE_URL = target.toString();
    process.env.E2B_CODEX_TEMPLATE = 'codex';
    process.env.MIKKA_THREAD_SNAPSHOTS = '1';
    process.env.MIKKA_CLOUD_WORKER_URL = 'https://worker.example.invalid/mikka';
    process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40);
    const db = await import("../db");
    appPool = db.pool;
    const { ensureThreadMachine, parkThreadMachine, threadMachineAction, threadMachineProvider } = await import("./thread-machines");
    const { threadLifecycleProvider } = await import("./thread-lifecycle-provider");

    const owner = "owner", workspaceId = randomUUID(), botId = randomUUID(), botDevice = randomUUID(), agentId = randomUUID(), repoId = randomUUID();
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture','thr-snapshot@example.invalid',true,now(),now())`, [owner]);
    await seedFixtureWorkspace(pool, owner, 'team', workspaceId);
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'bot','cloud')`, [botDevice, owner]);
    await pool.query(`INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,'codex','Fixture',$3)`, [agentId, owner, botDevice]);
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,'v2/github.com/acme/app','https://github.com/acme/app.git')`, [repoId, botDevice, owner]);
    await pool.query(`INSERT INTO bots (id,"workspaceId","ownerId",name) VALUES ($1,$2,$3,'Fixture Bot')`, [botId, workspaceId, owner]);
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","sandboxId","operationId","runtimeReady",state,"deviceId") VALUES ($1,$2,'sandbox-bot',$3,true,'running',$4)`, [workspaceId, owner, randomUUID(), botDevice]);
    const actor = { userId: owner, workspaceId } as Parameters<typeof ensureThreadMachine>[1];
    let number = 0;
    const task = async () => {
      const id = randomUUID();
      await pool.query(`INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority,scope) VALUES ($1,$2,$5,'Fixture task',jsonb_build_object('type','doc','attrs',jsonb_build_object('mikka',jsonb_build_object('number',$4::int)),'content','[]'::jsonb),$3,'normal','personal')`, [id, owner, 'doing', ++number, workspaceId]);
      return id;
    };
    const run = async (issueId: string | null, status = "queued") => {
      const runId = randomUUID();
      await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","botId","issueId","deviceId","deviceRepoId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Fixture')`, [runId, owner, agentId, botId, issueId, botDevice, repoId, status]);
      await pool.query(`INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)`, [runId, botId, workspaceId, owner]);
      return runId;
    };
    const machine = async (runId: string) => (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];
    // A task-owned machine with its own device/repository, optionally paused
    // with a filesystem snapshot and a sandbox the provider may or may not have.
    const seeded = async (issueId: string, opts: { state?: string; sandboxId?: string | null; snapshotState?: string; snapshotId?: string | null; templateKind?: string; status?: string } = {}) => {
      const runId = await run(issueId, opts.status ?? 'succeeded');
      const device = randomUUID(), machineRepo = randomUUID(), sandboxId = opts.sandboxId === undefined ? `sandbox-${runId}` : opts.sandboxId;
      await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"nameLocked") VALUES ($1,$2,'Thread computer','cloud',true)`, [device, owner]);
      await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,'v2/github.com/acme/app','https://github.com/acme/app.git')`, [machineRepo, device, owner]);
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId","templateKind","filesystemSnapshotId","snapshotState","snapshotTakenAt")
        VALUES ($1,$2,$3,$4,$5,$6,'codex',$7,$8,$9,$10,$11,$12,$13,$14)`,
      [runId, workspaceId, owner, botId, issueId, sandboxId, randomUUID(), opts.state ?? 'paused', device, machineRepo,
        opts.templateKind ?? 'codex', opts.snapshotId ?? null, opts.snapshotState ?? 'none', opts.snapshotId ? new Date() : null]);
      return { runId, device, machineRepo, sandboxId };
    };
    const recordingSandbox = (sandboxId: string, onBootstrap?: (bootstrap: { deviceId: string; credential: string }) => Promise<void>) => {
      let bootstrap: { deviceId: string; credential: string } | undefined;
      return {
        sandboxId,
        files: { read: async () => 'a'.repeat(40), write: async (path: string | UploadedFile[], body: unknown) => { bootstrap = uploadedBootstrap(path, body) ?? bootstrap; } },
        commands: { run: async (command: string) => {
          if (command.includes('mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json')) {
            assert.ok(bootstrap);
            if (onBootstrap) await onBootstrap(bootstrap);
          }
          return { stdout: command.includes(REGISTRATION_COMPLETE) ? REGISTRATION_COMPLETE + '\n' : '', stderr: '', exitCode: 0 };
        } },
      };
    };
    const markTokenUsed = async (sandboxId: string) => recordingSandbox(sandboxId, async bootstrap => {
      await pool.query(`UPDATE device_tokens SET "lastUsedAt"=clock_timestamp() WHERE "boundDeviceId"=$1 AND "tokenHash"=$2 AND "revokedAt" IS NULL`,
        [bootstrap.deviceId, createHash('sha256').update(bootstrap.credential).digest('hex')]);
      await pool.query('UPDATE devices SET "lastSeenAt"=clock_timestamp() WHERE id=$1', [bootstrap.deviceId]);
    });
    const fakeProvider = (overrides: Partial<typeof threadMachineProvider> = {}) => {
      const calls: string[] = [];
      const provider: typeof threadMachineProvider = {
        connect: overrides.connect ?? (async (id: string) => { calls.push(`connect:${id}`); return { sandboxId: id } as never; }),
        create: overrides.create ?? (async (template: string, op: string) => { calls.push(`create:${template}`); return { sandboxId: `sandbox-${op}` } as never; }),
        kill: overrides.kill ?? (async (id: string) => { calls.push(`kill:${id}`); }),
        ...(overrides.prepareKill ? { prepareKill: overrides.prepareKill } : {}),
      };
      return { calls, provider };
    };

    await t.test('park takes one snapshot, and a lost create ACK is reconciled instead of repeated', async () => {
      const issueId = await task(), seededRun = await seeded(issueId, { state: 'running', snapshotState: 'none' });
      const created: string[] = [], listed: string[] = [], pauses: string[] = [];
      let lists = 0;
      t.mock.method(threadLifecycleProvider, 'info', async () => ({ state: 'running' as const, endAt: null }));
      t.mock.method(threadMachineProvider, 'connect', async (id: string) => ({ sandboxId: id, commands: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } }) as never);
      t.mock.method(threadLifecycleProvider, 'createSnapshot', async () => { created.push('snapshot'); throw new Error('lost snapshot response'); });
      // The first listing (before creating) proves none exists; the reconcile
      // after the lost response finds exactly one.
      t.mock.method(threadLifecycleProvider, 'listSnapshots', async () => {
        listed.push('list');
        return ++lists === 1 ? [] : [{ snapshotId: 'snap-lost', names: [] }];
      });
      await parkThreadMachine(pool, actor, seededRun.runId, async (id: string) => { pauses.push(id); }, async () => null);
      const parked = await machine(seededRun.runId);
      assert.equal(parked.state, 'paused');
      assert.equal(parked.filesystemSnapshotId, 'snap-lost');
      assert.equal(parked.snapshotState, 'ready');
      assert.ok(parked.snapshotTakenAt);
      assert.ok(parked.snapshotOperationId);
      assert.deepEqual(created, ['snapshot']); assert.equal(listed.length, 2); assert.deepEqual(pauses, [seededRun.sandboxId]);
      // Replaying the same park over the paused row never creates a second image.
      await parkThreadMachine(pool, actor, seededRun.runId, async (id: string) => { pauses.push(id); }, async () => null);
      assert.deepEqual(created, ['snapshot']); assert.equal((await machine(seededRun.runId)).filesystemSnapshotId, 'snap-lost');
      // A crash before reconciliation leaves `creating`; the retry adopts the
      // exact per-run image and still does not create another one.
      await pool.query(`UPDATE thread_machines SET "snapshotState"='creating',"filesystemSnapshotId"=NULL,"snapshotTakenAt"=NULL WHERE "runId"=$1`, [seededRun.runId]);
      await parkThreadMachine(pool, actor, seededRun.runId, async () => {}, async () => null);
      const reconciled = await machine(seededRun.runId);
      assert.equal(reconciled.filesystemSnapshotId, 'snap-lost'); assert.equal(reconciled.snapshotState, 'ready');
      assert.deepEqual(created, ['snapshot']);
    });

    await t.test('a failed or unscrubbed snapshot never fails the pause', async () => {
      let mode: 'create' | 'scrub' = 'create';
      let created = 0;
      t.mock.method(threadLifecycleProvider, 'info', async () => ({ state: 'running' as const, endAt: null }));
      t.mock.method(threadMachineProvider, 'connect', async (id: string) => {
        if (mode === 'scrub') throw new Error('scrub connect unavailable');
        return { sandboxId: id, commands: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) } } as never;
      });
      t.mock.method(threadLifecycleProvider, 'createSnapshot', async () => { created++; throw new Error('snapshot unavailable'); });
      t.mock.method(threadLifecycleProvider, 'listSnapshots', async () => []);
      for (const failure of ['create', 'scrub'] as const) {
        mode = failure;
        const issueId = await task(), seededRun = await seeded(issueId, { state: 'running', snapshotState: 'none' });
        let paused = 0;
        await parkThreadMachine(pool, actor, seededRun.runId, async () => { paused++; }, async () => null);
        const parked = await machine(seededRun.runId);
        assert.equal(parked.state, 'paused', failure);
        assert.equal(parked.snapshotState, 'failed', failure);
        assert.equal(parked.filesystemSnapshotId, null, failure);
        assert.equal(paused, 1, failure);
      }
      assert.equal(created, 1, 'only the create attempt reached the provider');
    });

    await t.test('a missing sandbox restores from the task snapshot and finishes running', async () => {
      const issueId = await task(), seededRun = await seeded(issueId, { sandboxId: 'gone-vm', snapshotId: 'snap-task-1', snapshotState: 'ready', status: 'queued' });
      const before = await machine(seededRun.runId);
      const called: string[] = [];
      t.mock.method(threadLifecycleProvider, 'createFromSnapshot', async (snapshotId: string, operationId: string) => {
        called.push(`${snapshotId}:${operationId}`);
        return markTokenUsed('restored-vm') as never;
      });
      const { calls, provider } = fakeProvider({ connect: async (id: string) => {
        calls.push(`connect:${id}`);
        if (id === 'gone-vm') throw { status: 404 };
        return markTokenUsed(id) as never;
      } });
      assert.deepEqual(await ensureThreadMachine(pool, actor, seededRun.runId, provider), { runId: seededRun.runId, state: 'running' });
      const running = await machine(seededRun.runId);
      assert.equal(running.state, 'running'); assert.equal(running.sandboxId, 'restored-vm');
      assert.equal(running.epoch, before.epoch + 2, 'provisioning and restore each advance the fence');
      assert.equal(running.filesystemSnapshotId, 'snap-task-1', 'the source image stays until a newer one replaces it');
      assert.equal(running.snapshotState, 'failed', 'the source image is stale for the restored VM');
      assert.equal(called.length, 1); assert.ok(called[0].startsWith('snap-task-1:'));
      assert.deepEqual(calls, ['connect:gone-vm']);
    });

    await t.test('a stop that wins during restore ends the row and kills the late sandbox', async () => {
      const issueId = await task(), seededRun = await seeded(issueId, { sandboxId: 'gone-vm', snapshotId: 'snap-task-2', snapshotState: 'ready', status: 'queued' });
      let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
      let created!: () => void; const creating = new Promise<void>(resolve => { created = resolve; });
      t.mock.method(threadLifecycleProvider, 'createFromSnapshot', async () => {
        created(); await blocked;
        return { sandboxId: 'late-vm' } as never;
      });
      const { calls, provider } = fakeProvider({ connect: async (id: string) => { calls.push(`connect:${id}`); throw { status: 404 }; } });
      const start = ensureThreadMachine(pool, actor, seededRun.runId, provider);
      await creating;
      await assert.rejects(threadMachineAction(pool, actor, seededRun.runId, 'end'), /Thread creation cleanup pending/);
      assert.equal((await machine(seededRun.runId)).state, 'ended');
      release();
      await assert.rejects(start, /Retained task machine unavailable|Thread provisioning cancelled/);
      const ended = await machine(seededRun.runId);
      assert.equal(ended.state, 'ended'); assert.equal(ended.sandboxId, 'late-vm');
      assert.ok(calls.includes('kill:late-vm'), calls.join(','));
    });

    await t.test('another task or template never contributes a snapshot', async () => {
      const restored: string[] = [];
      t.mock.method(threadLifecycleProvider, 'createFromSnapshot', async () => { restored.push('restore'); return { sandboxId: 'snap-vm' } as never; });
      // A snapshot belongs to the machine row's task; a different issue on the
      // run must not restore it and must fall back to the official template.
      const otherIssue = await task(), runIssue = await task();
      const foreign = await seeded(otherIssue, { sandboxId: 'gone-vm', snapshotId: 'snap-foreign', snapshotState: 'ready', status: 'queued' });
      await pool.query('UPDATE agent_runs SET "issueId"=$2 WHERE id=$1', [foreign.runId, runIssue]);
      const created: string[] = [];
      const { provider } = fakeProvider({ connect: async () => { throw { status: 404 }; },
        create: async (template: string) => { created.push(template); throw new Error('fixture template sandbox'); } });
      await assert.rejects(ensureThreadMachine(pool, actor, foreign.runId, provider));
      assert.deepEqual(restored, [], 'foreign task snapshot must not restore');
      assert.deepEqual(created, ['codex']);
      // Same task, different harness template: the snapshot is refused before I/O.
      const issueId = await task(), mismatch = await seeded(issueId, { sandboxId: 'gone-vm', snapshotId: 'snap-template', snapshotState: 'ready', templateKind: 'claude', status: 'queued' });
      await assert.rejects(ensureThreadMachine(pool, actor, mismatch.runId, provider), /Retained task machine unavailable/);
      assert.deepEqual(restored, [], 'a different harness template must not restore');
    });

    await t.test('a paused sandbox the provider still has resumes without restoring', async () => {
      const issueId = await task(), seededRun = await seeded(issueId, { sandboxId: 'live-vm', snapshotId: 'snap-live', snapshotState: 'ready', status: 'queued' });
      const before = await machine(seededRun.runId);
      const { calls, provider } = fakeProvider({ connect: async (id: string) => { calls.push(`connect:${id}`); return markTokenUsed(id) as never; } });
      const restored: string[] = [];
      t.mock.method(threadLifecycleProvider, 'createFromSnapshot', async () => { restored.push('restore'); return { sandboxId: 'restored-vm' } as never; });
      assert.deepEqual(await ensureThreadMachine(pool, actor, seededRun.runId, provider), { runId: seededRun.runId, state: 'running' });
      const running = await machine(seededRun.runId);
      assert.equal(running.sandboxId, 'live-vm'); assert.equal(running.epoch, before.epoch + 1);
      assert.equal(running.snapshotState, 'failed', 'a resumed VM makes its parked image stale');
      assert.equal(running.filesystemSnapshotId, 'snap-live');
      assert.deepEqual(calls, ['connect:live-vm']); assert.deepEqual(restored, []);
    });
  } finally {
    try { await dropTestDatabase(admin, database, pool, appPool) }
    finally {
      try { await admin.end() } catch { /* best effort */ }
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  }
});
