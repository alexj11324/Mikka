import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import { REGISTRATION_COMPLETE, REGISTRATION_WAITING } from '../computer/registration-command';
// One task, one cloud sandbox (Alex, 2026-11-01). A task's next run resumes the
// sandbox its last run left paused; no other task, bot or repository can take
// it; a finished run of an open task parks its sandbox (paused, tokens
// revoked); a closed task's paused sandbox is ended for good.
// Real migrations, fake provider; disposable *_e2e PG on loopback.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { dropTestDatabase } from '../../tests/support/drop-test-database';

type UploadedFile = { path: string; data: string };
function uploadedFiles(path: string | UploadedFile[], body?: unknown): UploadedFile[] {
  return typeof path === 'string' ? [{ path, data: typeof body === 'string' ? body : '' }] : path;
}
function uploadedBootstrap(path: string | UploadedFile[], body?: unknown): { deviceId: string; credential: string } | undefined {
  const file = uploadedFiles(path, body).find(file => /^\/run\/mikka-viewer\/thread-[\w-]+\.json$/.test(file.path));
  return file ? JSON.parse(file.data) : undefined;
}

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
    const { ensureThreadMachine, parkThreadMachine, retainThreadMachineForHandoff, endClosedTaskMachines, keepTailBeforeKill, threadMachineAction, threadMachineProvider, RetainedTaskMachineUnavailable } = await import("./thread-machines");

    const owner = "owner", workspaceId = randomUUID(), botId = randomUUID(), otherBot = randomUUID(), botDevice = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), otherRepo = randomUUID();
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture','thr-task@example.invalid',true,now(),now())`, [owner]);
    await seedFixtureWorkspace(pool, owner, 'team', workspaceId);
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
      await pool.query(`INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority,scope) VALUES ($1,$2,$5,'Fixture task',jsonb_build_object('type','doc','attrs',jsonb_build_object('mikka',jsonb_build_object('number',$4::int)),'content','[]'::jsonb),$3,'normal','personal')`, [id, owner, status, ++number, workspaceId]);
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
        // The fake sandbox has no runtime: provisioning stops right after the provider step.
        connect: async (id) => { calls.push(`connect:${id}`); return { sandboxId: id } as never; },
        create: async (source, op) => { calls.push("create"); sources.push(source); return { sandboxId: `sandbox-${op}` } as never; },
        kill: async (id) => { calls.push(`kill:${id}`); },
      };
      return { calls, sources, provider };
    };
    const machine = async (runId: string) => (await pool.query('SELECT state,"sandboxId","deviceId","issueId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];

    const questionMachine = async (state = 'paused') => {
      const issueId = await task(), prior = await parked(issueId, { status: 'stopped' });
      const next = await run(issueId), q = randomUUID(), taskId = randomUUID(), attemptId = randomUUID();
      const originMachine = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1',[prior.runId])).rows[0];
      const continuation = { questionId:q, originRunId:prior.runId,originSessionId:'original-native-session',followUp:'owner answer',requireSessionResume:true,requiredSandboxId:prior.sandboxId };
      await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"sessionId"=$4 WHERE id=$1`,[prior.runId,prior.device,originMachine.repoId,continuation.originSessionId]);
      await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"questionContinuation"=$4 WHERE id=$1`,[next,prior.device,originMachine.repoId,JSON.stringify(continuation)]);
      await pool.query(`UPDATE thread_machines SET state='ended',"sandboxId"=NULL WHERE "runId"=$1`,[prior.runId]);
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[next,workspaceId,owner,botId,issueId,prior.sandboxId,originMachine.snapshotId,randomUUID(),state,prior.device,originMachine.repoId]);
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query(`INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason) VALUES ($1,$2,$3,$4,'{}','execute','running',$5,'fixture')`,[taskId,owner,issueId,randomUUID(),attemptId]);
        await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason) VALUES ($1,$2,'execute',1,1,'running',$3,'fixture')`,[attemptId,taskId,next]);
        await tx.query(`INSERT INTO factory_questions(id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,request,status,reason,"sourceEventId","continuationRunId") VALUES ($1,$2,$3,$4,$5,'execute',$6,$7,1,'{}','context','fixture','{}','resuming','fixture',$8,$9)`,[q,owner,issueId,taskId,attemptId,prior.runId,continuation.originSessionId,randomUUID(),next]);
        await tx.query('COMMIT');
      } finally { tx.release(); }
      return { prior, next, q, continuation, issueId, taskId, attemptId };
    };
    const exactFake = (state = 'paused') => {
      const fixture = fake();
      return { ...fixture, provider: { ...fixture.provider, state: async (_id: string, _owner: string) => {
        fixture.calls.push('state');
        // A separate transaction can take the run lock during provider I/O.
        return state;
      } } };
    };

    await t.test('an exact question wake observes a running original worker without bootstrap or token rotation', async () => {
      const f = await questionMachine('running'), fixture = exactFake('running');
      assert.deepEqual(await ensureThreadMachine(pool,actor,f.next,fixture.provider),{runId:f.next,state:'running'});
      assert.deepEqual(fixture.calls,['state']);
      assert.equal((await machine(f.next)).sandboxId,f.prior.sandboxId);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM device_tokens WHERE "boundDeviceId"=$1',[f.prior.device])).rows[0].n,0);
    });
    await t.test('retained original question VMs ignore replacement-template configuration', async () => {
      const savedTemplates = { codex: process.env.E2B_CODEX_TEMPLATE, desktop: process.env.E2B_BYO_COMPUTER_TEMPLATE };
      process.env.E2B_CODEX_TEMPLATE = 'unavailable-replacement';
      process.env.E2B_BYO_COMPUTER_TEMPLATE = 'unavailable-replacement';
      try {
        for (const state of ['running', 'paused']) {
          const f = await questionMachine(state), fixture = exactFake(state);
          if (state === 'running') {
            assert.deepEqual(await ensureThreadMachine(pool,actor,f.next,fixture.provider),{runId:f.next,state:'running'});
            assert.deepEqual(fixture.calls,['state']);
          } else {
            fixture.provider.connect = async id => {fixture.calls.push(`connect:${id}`); throw new Error('fixture original connection');};
            await assert.rejects(ensureThreadMachine(pool,actor,f.next,fixture.provider),/fixture original connection/);
            assert.deepEqual(fixture.calls,['state',`connect:${f.prior.sandboxId}`]);
          }
          assert.equal((await machine(f.next)).sandboxId,f.prior.sandboxId);
        }
      } finally {
        if (savedTemplates.codex === undefined) delete process.env.E2B_CODEX_TEMPLATE; else process.env.E2B_CODEX_TEMPLATE = savedTemplates.codex;
        if (savedTemplates.desktop === undefined) delete process.env.E2B_BYO_COMPUTER_TEMPLATE; else process.env.E2B_BYO_COMPUTER_TEMPLATE = savedTemplates.desktop;
      }
    });
    await t.test('original VM provider loss never creates or adopts a replacement and releases only its own wake lease', async () => {
      const f = await questionMachine(), fixture = exactFake();
      fixture.provider.connect = async (id) => {fixture.calls.push(`connect:${id}`); throw {status:404};};
      await assert.rejects(ensureThreadMachine(pool,actor,f.next,fixture.provider),/Original question machine unavailable/);
      assert.deepEqual(fixture.calls,['state',`connect:${f.prior.sandboxId}`]);
      const m=(await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1',[f.next])).rows[0];
      assert.equal(m.sandboxId,f.prior.sandboxId); assert.equal(m.state,'paused'); assert.equal(m.workerLeaseId,null);
      assert.equal((await pool.query('SELECT "questionContinuation" FROM agent_runs WHERE id=$1',[f.next])).rows[0].questionContinuation.originSessionId,f.continuation.originSessionId);
    });
    await t.test('an exact paused wake uses only the original VM and performs provider I/O after commit', async () => {
      const f = await questionMachine(), fixture = exactFake();
      fixture.provider.state = async () => {
        fixture.calls.push('state');
        const tx=await pool.connect();
        try {await tx.query('BEGIN'); await tx.query(`SET LOCAL lock_timeout='250ms'`); await tx.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[f.next]); await tx.query('ROLLBACK');} finally {tx.release();}
        return 'paused';
      };
      fixture.provider.connect=async id=>{fixture.calls.push(`connect:${id}`);throw new Error('fixture exact original connect');};
      await assert.rejects(ensureThreadMachine(pool,actor,f.next,fixture.provider),/fixture exact original connect/);
      assert.deepEqual(fixture.calls,['state',`connect:${f.prior.sandboxId}`]);
      assert.equal((await machine(f.next)).sandboxId,f.prior.sandboxId);
    });
    await t.test('a failed question wake records its safe phase while retaining the original VM, SID and committed answer', async () => {
      const f = await questionMachine(), fixture = exactFake();
      const history = async () => ({
        runs: (await pool.query('SELECT * FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id', [[f.prior.runId, f.next]])).rows,
        question: (await pool.query('SELECT * FROM factory_questions WHERE id=$1', [f.q])).rows,
        machines: (await pool.query('SELECT * FROM thread_machines WHERE "runId"=ANY($1::uuid[]) ORDER BY "runId"', [[f.prior.runId, f.next]])).rows,
      });
      const before = await history(), warnings: string[] = [];
      const fault = Object.assign(new Error('PRIVATE-CREDENTIAL provider response'), { statusCode: 503, code: 'PRIVATE-CREDENTIAL', cause: { token: 'PRIVATE-CREDENTIAL' } });
      fixture.provider.connect = async id => { fixture.calls.push(`connect:${id}`); throw fault; };
      const warning = mock.method(console, 'warn', (line: string) => { warnings.push(line); });
      try { await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider), error => error === fault); }
      finally { warning.mock.restore(); }
      assert.deepEqual(warnings.map(line => JSON.parse(line)), [{ event: 'thread_runtime_start_failed', runId: f.next,
        phase: 'connect', errorClass: 'Error', errorCode: 'unknown', status: 503 }]);
      assert.doesNotMatch(warnings.join('\n'), /PRIVATE-CREDENTIAL|original-native-session/);
      const after = await history();
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(after.question, before.question);
      const withoutLifecycle = (rows: Record<string, unknown>[]) => rows.map(({ lifecycle: _lifecycle, lifecycleAt: _at, epoch: _epoch, ...identity }) => identity);
      assert.deepEqual(withoutLifecycle(after.machines), withoutLifecycle(before.machines), 'no answer, VM or native session changes');
      const wake = after.machines.find(row => row.runId === f.next)!;
      assert.equal(wake.epoch, before.machines.find(row => row.runId === f.next)!.epoch + 1, 'a failed wake still fences older maintenance');
      assert.equal(wake.lifecycle.owner, 'run-recovery');
      assert.ok(wake.lifecycleAt, 'failure leaves durable recovery responsibility');
      assert.deepEqual(fixture.calls, ['state', `connect:${f.prior.sandboxId}`]);
    });
    await t.test('a resumed provider VM with paused DB placement retries bootstrap instead of falsely returning ready', async () => {
      const f=await questionMachine(),fixture=exactFake('running');
      fixture.provider.connect=async id=>{fixture.calls.push(`connect:${id}`);throw new Error('fixture retry original bootstrap');};
      await assert.rejects(ensureThreadMachine(pool,actor,f.next,fixture.provider),/fixture retry original bootstrap/);
      assert.deepEqual(fixture.calls,['state',`connect:${f.prior.sandboxId}`]);
      assert.equal((await machine(f.next)).state,'paused');
    });
    await t.test('a worker that already claimed the continuation keeps its token and native process on replay', async () => {
      const f=await questionMachine('running'),fixture=exactFake('running');
      await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`,[f.next]);
      assert.deepEqual(await ensureThreadMachine(pool,actor,f.next,fixture.provider),{runId:f.next,state:'running'});
      assert.deepEqual(fixture.calls,[]);
    });
    await t.test('a paused question VM resumes and registers on the same device without replacing its native session', async () => {
      const f=await questionMachine(),fixture=exactFake();
      const savedWorker={url:process.env.MIKKA_CLOUD_WORKER_URL,sha:process.env.MIKKA_CLOUD_WORKER_SHA};
      process.env.MIKKA_CLOUD_WORKER_URL='https://worker.example.invalid/mikka';process.env.MIKKA_CLOUD_WORKER_SHA='a'.repeat(40);
      let bootstrap:{deviceId:string;credential:string}|undefined;
      try {
        fixture.provider.connect=async id=>{
          fixture.calls.push(`connect:${id}`);
          return {sandboxId:id,files:{read:async()=> 'a'.repeat(40),write:async(path:string|UploadedFile[],body:unknown)=>{bootstrap=uploadedBootstrap(path,body)??bootstrap;}},
            commands:{run:async(command:string)=>{
              if(command.includes('mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json')){
                assert.ok(bootstrap);assert.equal(bootstrap.deviceId,f.prior.device);
                await pool.query(`UPDATE device_tokens SET "lastUsedAt"=clock_timestamp() WHERE "boundDeviceId"=$1 AND "tokenHash"=$2 AND "revokedAt" IS NULL`,[bootstrap.deviceId,createHash('sha256').update(bootstrap.credential).digest('hex')]);
                await pool.query(`UPDATE devices SET "lastSeenAt"=clock_timestamp() WHERE id=$1`,[bootstrap.deviceId]);
              }
              return {stdout:command.includes(REGISTRATION_COMPLETE)?REGISTRATION_COMPLETE+'\n':'',stderr:'',exitCode:0};
            }}} as never;
        };
        assert.deepEqual(await ensureThreadMachine(pool,actor,f.next,fixture.provider),{runId:f.next,state:'running'});
        assert.deepEqual(fixture.calls,['state',`connect:${f.prior.sandboxId}`]);
        assert.equal((await machine(f.next)).state,'running');assert.equal((await machine(f.next)).sandboxId,f.prior.sandboxId);
        assert.equal((await pool.query('SELECT "sessionId" FROM agent_runs WHERE id=$1',[f.prior.runId])).rows[0].sessionId,f.continuation.originSessionId);
      } finally { if(savedWorker.url===undefined)delete process.env.MIKKA_CLOUD_WORKER_URL;else process.env.MIKKA_CLOUD_WORKER_URL=savedWorker.url;if(savedWorker.sha===undefined)delete process.env.MIKKA_CLOUD_WORKER_SHA;else process.env.MIKKA_CLOUD_WORKER_SHA=savedWorker.sha; }
    });

    await t.test('gone or unknown provider state never creates a replacement or claims readiness', async () => {
      for (const state of ['gone','unknown']) {
        const f=await questionMachine(),fixture=exactFake(state);
        if(state==='gone')fixture.provider.state=async()=>{fixture.calls.push('state');throw {status:404};};
        await assert.rejects(ensureThreadMachine(pool,actor,f.next,fixture.provider));
        assert.deepEqual(fixture.calls,['state']);
        assert.equal((await machine(f.next)).sandboxId,f.prior.sandboxId);
      }
    });
    await t.test('source SID, snapshot and transferred sandbox mismatches refuse before provider I/O', async () => {
      for (const field of ['session','snapshot','sandbox','source']) {
        const f=await questionMachine(), fixture=exactFake();
        if(field==='session') await pool.query(`UPDATE agent_runs SET "sessionId"='changed' WHERE id=$1`,[f.prior.runId]);
        if(field==='snapshot') await pool.query(`UPDATE thread_machines SET "snapshotId"='another-snapshot' WHERE "runId"=$1`,[f.next]);
        if(field==='sandbox') await pool.query(`UPDATE thread_machines SET "sandboxId"='another-vm' WHERE "runId"=$1`,[f.next]);
        if(field==='source') await pool.query(`UPDATE factory_questions SET "continuationRunId"=NULL WHERE id=$1`,[f.q]);
        await assert.rejects(ensureThreadMachine(pool,actor,f.next,fixture.provider),/Original question machine unavailable/);
        assert.deepEqual(fixture.calls,[]);
      }
    });

    await t.test('the normal start wrapper retains an unavailable exact question run and its original VM', async () => {
      const f=await questionMachine();
      await pool.query(`UPDATE agent_runs SET "sessionId"='changed' WHERE id=$1`,[f.prior.runId]);
      const {startThreadMachine}=await import('../run-leases');
      assert.deepEqual(await startThreadMachine(actor,f.next),{state:'unavailable'});
      assert.equal((await machine(f.next)).state,'paused');
      assert.equal((await machine(f.next)).sandboxId,f.prior.sandboxId);
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[f.next])).rows[0].status,'queued');
    });
    await t.test('durable question handoff retries an unavailable original VM instead of reporting false success', async () => {
      const f=await questionMachine();
      const {factoryAutomaticRuntime}=await import('../factory/automatic-dispatch');
      const {handoffFactoryCloudStage}=await import('../factory/cloud-stage-handoff');
      const start=factoryAutomaticRuntime.start;
      try {
        factoryAutomaticRuntime.start=async()=>({state:'unavailable' as const});
        await assert.rejects(handoffFactoryCloudStage(pool,actor,null,f.next),/Original question machine unavailable/);
        assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1',[f.next])).rows[0].status,'queued');
        assert.equal((await machine(f.next)).sandboxId,f.prior.sandboxId);
      } finally {factoryAutomaticRuntime.start=start;}
    });

    await t.test('a replayed Factory handoff only resumes lifecycle for its current live owned worker', async () => {
      const f = await questionMachine('running');
      await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [f.next]);
      const { factoryAutomaticRuntime } = await import('../factory/automatic-dispatch');
      const { handoffFactoryCloudStage } = await import('../factory/cloud-stage-handoff');
      const park = mock.method(factoryAutomaticRuntime, 'park', async () => { throw new Error('active worker must not be parked'); });
      const start = mock.method(factoryAutomaticRuntime, 'start', async () => { throw new Error('active worker must not be bootstrapped'); });
      try {
        assert.equal(await handoffFactoryCloudStage(pool, actor, f.prior.runId, f.next), true);
        assert.equal(await handoffFactoryCloudStage(pool, { ...actor, userId: 'foreign' }, f.prior.runId, f.next), false);
        await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 minute' WHERE id=$1`, [f.next]);
        assert.equal(await handoffFactoryCloudStage(pool, actor, f.prior.runId, f.next), false);
        assert.equal(park.mock.callCount(), 0);
        assert.equal(start.mock.callCount(), 0);
      } finally { park.mock.restore(); start.mock.restore(); }
    });

    await t.test('required question wake refuses a machine without authoritative question provenance', async () => {
      const prior = await parked(await task());
      await pool.query(`UPDATE agent_runs r SET status='queued',"deviceId"=m."deviceId","deviceRepoId"=m."repoId" FROM thread_machines m WHERE r.id=$1 AND m."runId"=r.id`, [prior.runId]);
      await pool.query(`UPDATE agent_runs SET "questionContinuation"='{"requireSessionResume":true}' WHERE id=$1`,[prior.runId]);
      const fixture = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, prior.runId, fixture.provider), /Original question machine unavailable/);
      assert.deepEqual(fixture.calls, []);
      assert.equal((await machine(prior.runId)).sandboxId, prior.sandboxId);
    });

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

    const failedQuestionMachine = async (state = 'paused', recovered = false) => {
      const f = await questionMachine(state);
      const answerId = randomUUID();
      const definition = { harness: 'codex', model: 'fixture-model', definitionDigest: 'd'.repeat(64), subscription: { bindingId: randomUUID(), route: 'codex_cli', modelId: 'fixture-model' } };
      await pool.query(`UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=ANY($1::uuid[])`, [[f.prior.runId, f.next], definition]);
      await pool.query(`UPDATE agent_runs SET status='failed',"sessionId"=$2,"continuesRunId"=$3 WHERE id=$1`, [f.next, f.continuation.originSessionId, f.prior.runId]);
      await pool.query(`UPDATE factory_tasks SET status='blocked',"botId"=$2 WHERE id=$1`, [f.taskId, botId]);
      await pool.query(`UPDATE factory_attempts SET status='blocked' WHERE id=$1`, [f.attemptId]);
      await pool.query(`UPDATE factory_questions SET status='blocked',"answerId"=$2,"answerFingerprint"='original-answer',result=$3 WHERE id=$1`, [f.q, answerId, { questionId: f.q, continuationRunId: f.next, originRunId: f.prior.runId, originSessionId: f.continuation.originSessionId }]);
      await pool.query(`INSERT INTO run_messages(id,"runId","userId",text,"deliveredAt") VALUES($1,$2,$3,'Original owner answer',now())`, [answerId, f.prior.runId, owner]);
      if (!recovered) return f;
      const next = await run(f.issueId, { status: 'failed' }), attemptId = randomUUID();
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        const { rows: [retained] } = await tx.query('SELECT "sandboxId",state FROM thread_machines WHERE "runId"=$1 FOR UPDATE', [f.next]);
        assert.ok(retained?.sandboxId);
        await tx.query(`UPDATE agent_runs current SET "deviceId"=previous."deviceId","deviceRepoId"=previous."deviceRepoId","sessionId"=previous."sessionId","agentDefinition"=previous."agentDefinition","continuesRunId"=previous.id,"questionContinuation"=previous."questionContinuation" FROM agent_runs previous WHERE current.id=$1 AND previous.id=$2`, [next, f.next]);
        // Like the production queue, release the old row's unique sandbox
        // custody before assigning that same sandbox to its continuation.
        await tx.query(`UPDATE thread_machines SET state='ended',"sandboxId"=NULL WHERE "runId"=$1`, [f.next]);
        await tx.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId")
          SELECT $1,"workspaceId","ownerId","botId","issueId",$4,"snapshotId",$3,$5,"deviceId","repoId" FROM thread_machines WHERE "runId"=$2`, [next, f.next, randomUUID(), retained.sandboxId, retained.state]);
        await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason) VALUES($1,$2,'execute',2,2,'blocked',$3,'owner recovery')`, [attemptId, f.taskId, next]);
        await tx.query(`UPDATE factory_tasks SET "attemptId"=$2,revision=revision+1 WHERE id=$1`, [f.taskId, attemptId]);
        await tx.query(`UPDATE factory_questions SET "continuationRunId"=$2,revision=revision+1 WHERE id=$1`, [f.q, next]);
        await tx.query(`INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)`, [f.taskId, randomUUID(), { kind: 'question_recover', input: { expectedFailedRunId: f.next } }, { continuationRunId: next, historyRunId: f.next, originRunId: f.prior.runId, originSessionId: f.continuation.originSessionId }]);
        await tx.query('COMMIT');
      } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
      return { ...f, next, attemptId };
    };
    const questionHistory = async (f: Awaited<ReturnType<typeof failedQuestionMachine>>) => ({
      runs: (await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [f.issueId])).rows,
      task: (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.taskId])).rows,
      question: (await pool.query('SELECT * FROM factory_questions WHERE id=$1', [f.q])).rows,
      attempts: (await pool.query('SELECT * FROM factory_attempts WHERE "taskId"=$1 ORDER BY position', [f.taskId])).rows,
      receipts: (await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [f.taskId])).rows,
      messages: (await pool.query('SELECT * FROM run_messages WHERE "runId"=$1 ORDER BY id', [f.prior.runId])).rows,
      previousMachines: (await pool.query('SELECT * FROM thread_machines WHERE "issueId"=$1 AND "runId"<>$2 ORDER BY "runId"', [f.issueId, f.next])).rows,
    });
    const withRefreshWorker = async (check: () => Promise<void>) => {
      const names = ['MIKKA_CLOUD_WORKER_URL', 'MIKKA_CLOUD_WORKER_SHA', 'MIKKA_CLOUD_WORKER_SOURCE_COMMIT'] as const;
      const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
      process.env.MIKKA_CLOUD_WORKER_URL = 'https://worker.example.invalid/mikka';
      process.env.MIKKA_CLOUD_WORKER_SHA = 'b'.repeat(40);
      process.env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT = 'c'.repeat(40);
      try { await check(); } finally {
        for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
      }
    };
    const refreshFake = (f: { prior: { device: string } }, state: string) => {
      const fixture = exactFake(state), steps: string[] = [];
      let sha = 'a'.repeat(40), bootstrap: { deviceId: string; credential: string } | undefined;
      fixture.provider.connect = async id => {
        fixture.calls.push(`connect:${id}`);
        return {
          sandboxId: id,
          files: { read: async () => sha, write: async (path: string | UploadedFile[], body: unknown) => {
            bootstrap = uploadedBootstrap(path,body);
            assert.ok(bootstrap);
          } },
          commands: { run: async (command: string) => {
            let stdout = '';
            if (command.includes('MIKKA_OFFICIAL_WORKER_STAGE')) {
              steps.push('stage');
              stdout = `mikka-official-instance-staged ${process.env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT} ${process.env.MIKKA_CLOUD_WORKER_SHA}`;
            } else if (command.includes('MIKKA_PRIVATE_RUNTIME_SWITCH')) {
              const action = /python3 - (switch|rollback|verify) /.exec(command)![1];
              steps.push(action);
              sha = action === 'rollback' ? 'a'.repeat(40) : process.env.MIKKA_CLOUD_WORKER_SHA!;
              stdout = JSON.stringify({ status: action === 'switch' ? 'switched' : action === 'rollback' ? 'restored_not_ready' : 'verified_process', workerSourceCommit: process.env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT, workerSha: sha, pid: 42 });
            } else if (command.includes('mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json')) {
              assert.ok(bootstrap); assert.equal(bootstrap.deviceId, f.prior.device);
              await pool.query(`UPDATE device_tokens SET "lastUsedAt"=clock_timestamp() WHERE "boundDeviceId"=$1 AND "tokenHash"=$2 AND "revokedAt" IS NULL`, [bootstrap.deviceId, createHash('sha256').update(bootstrap.credential).digest('hex')]);
              await pool.query(`UPDATE devices SET "lastSeenAt"=clock_timestamp() WHERE id=$1`, [bootstrap.deviceId]);
              steps.push('registered');
              stdout = REGISTRATION_COMPLETE + '\n';
            } else if (command.includes('mikka-runtime-process-verified')) {
              steps.push('rpc'); stdout = 'mikka-runtime-process-verified 42';
            } else assert.ok(command.includes('node dist/cloud/cloud-worker.js'), 'only worker startup remains');
            return { stdout, stderr: '', exitCode: 0 };
          } },
        } as never;
      };
      return { ...fixture, steps };
    };

    // The retained runtime can outlive a Web/worker release. Keep a real,
    // immutable answer receipt so the upgrade must recheck its current task.
    const upgradingQuestion = async (stage: 'spec' | 'execute' | 'review' | 'verify' = 'execute', taskBot = botId) => {
      const f = await questionMachine(), originAttemptId = randomUUID(), answerId = randomUUID();
      const { factoryEventId } = await import('../factory/event-id');
      const { questionFingerprint } = await import('../factory/questions/contract');
      const { freezeWorkerDefinition, retryWorkerDefinition } = await import('../agent-kit/worker');
      const candidateId = stage === 'spec' || stage === 'execute' ? null : randomUUID();
      if (candidateId) await pool.query(`INSERT INTO factory_candidates(id,"taskId",sha,repository,environment,scope,"runId")
        VALUES($1,$2,$3,'fixture/repo','fixture','fixture',$4)`, [candidateId, f.taskId, 'd'.repeat(40), f.prior.runId]);
      await pool.query(`UPDATE factory_attempts SET stage=$2,ordinal=2,position=2,"candidateId"=$3 WHERE id=$1`, [f.attemptId, stage, candidateId]);
      await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId","candidateId",reason)
        VALUES($1,$2,$3,1,1,'waiting',$4,$5,'Original question')`, [originAttemptId, f.taskId, stage, f.prior.runId, candidateId]);
      const binding = { taskId: f.taskId, issueId: f.issueId, attemptId: originAttemptId, revision: 1, candidateId };
      const input = { reference: { questionId: f.q, questionRevision: 1, originRunId: f.prior.runId,
        originSessionId: f.continuation.originSessionId, binding }, answerId, text: 'Continue the original saved task.' };
      const answer = { source: 'human', userId: owner, input }, fingerprint = questionFingerprint(answer);
      await pool.query(`UPDATE factory_tasks SET stage=$2,"candidateId"=$3,"botId"=$4,revision=2 WHERE id=$1`, [f.taskId, stage, candidateId, taskBot]);
      const current = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.taskId])).rows[0];
      // The real claim service requires the task's owned, same-Bot user request.
      await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey","issueId",payload)
        VALUES($1::uuid,$2,$3,'user_message',$1::text,$4,'{"text":"Continue the fixture task"}')`,
      [current.sourceEventId, owner, taskBot, f.issueId]);
      const result = { questionId: f.q, continuationRunId: f.next, task: current, replayed: false };
      await pool.query(`UPDATE factory_questions SET stage=$2,"candidateId"=$3,"attemptId"=$4,"waitingBinding"=$5,
        "answerId"=$6,"answerSource"='human',answer=$7,"answerFingerprint"=$8,"answeredAt"=now(),revision=2,result=$9 WHERE id=$1`,
      [f.q, stage, candidateId, originAttemptId, binding, answerId, answer, fingerprint, result]);
      const eventId = factoryEventId('question-resume', answerId);
      await pool.query('INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)', [f.taskId, eventId,
        { kind: 'question_resume', ...answer }, { ...result, answerId, answerFingerprint: fingerprint,
          originRunId: f.prior.runId, originSessionId: f.continuation.originSessionId, originAttemptId }]);
      const originDefinition = freezeWorkerDefinition({ harness: 'codex', instructions: 'Keep the original policy', prompt: 'Fixture',
        parent: null, executionId: null, model: 'gpt-6-luna' });
      const definition = retryWorkerDefinition(originDefinition, 'Fixture\nOwner answer')!;
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.prior.runId, originDefinition]);
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.next, definition]);
      await pool.query(`UPDATE devices SET harnesses='[{"harness":"codex","installed":true}]',"lastSeenAt"=clock_timestamp() WHERE id=$1`, [f.prior.device]);
      return { ...f, eventId, definition, candidateId, originAttemptId, answerId, taskBot };
    };

    // This matches the real refusal before claim: the answer and immutable
    // receipt exist, but the failed child has never owned a native session.
    const unclaimedPlanQuestion = async (state = 'paused', taskBot = botId) => {
      const f = await upgradingQuestion('spec', taskBot), connectionId = randomUUID(), bindingId = randomUUID();
      const { freezeWorkerDefinition, retryWorkerDefinition } = await import('../agent-kit/worker');
      await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject")
        VALUES($1,$2,$3,'codex','connected',1,$4,$5,$6)`,
      [connectionId, owner, workspaceId, `fixture-preclaim-${connectionId}`, 'a'.repeat(64), `fixture-${connectionId}`]);
      await pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
        VALUES($1,$2,$3,$4,$5,1,'codex_cli','gpt-6-luna')`, [bindingId, owner, workspaceId, agentId, connectionId]);
      const originalDefinition = freezeWorkerDefinition({ harness: 'codex', instructions: 'Preserve the original read-only plan',
        prompt: 'Fixture', parent: null, executionId: null, model: 'gpt-6-luna', readOnly: true,
        subscription: { id: bindingId, modelId: 'gpt-6-luna', route: 'codex_cli' } });
      const definition = retryWorkerDefinition(originalDefinition, 'Fixture\nContinue the original saved task.')!;
      await pool.query(`UPDATE agent_runs SET kind='plan',"agentDefinition"=$2,"startedAt"=now()-interval '1 minute',
        "finishedAt"=now(),"stopReason"='blocked' WHERE id=$1`, [f.prior.runId, originalDefinition]);
      await pool.query(`INSERT INTO byos_native_runs("runId","bindingId") VALUES($1,$2)`, [f.prior.runId, bindingId]);
      await pool.query(`UPDATE agent_runs SET kind='plan',"agentDefinition"=$2,status='failed',"stopReason"='blocked',
        "finishedAt"=now(),error='Synthetic Profile refusal before claim' WHERE id=$1`, [f.next, definition]);
      await pool.query(`UPDATE factory_tasks SET status='blocked',revision=3,route='{"flowVersion":2}' WHERE id=$1`, [f.taskId]);
      await pool.query(`UPDATE factory_attempts SET status='blocked',"finishedAt"=now() WHERE id=$1`, [f.attemptId]);
      await pool.query(`UPDATE factory_attempts SET output=output || jsonb_build_object('requestEpoch',t."sourceEventId")
        FROM factory_tasks t WHERE "taskId"=t.id AND t.id=$1`, [f.taskId]);
      await pool.query(`UPDATE factory_questions SET status='blocked',revision=3 WHERE id=$1`, [f.q]);
      await pool.query(`UPDATE thread_machines SET state=$2 WHERE "runId"=$1`, [f.next, state]);
      await pool.query(`INSERT INTO run_messages(id,"runId","userId",text,"deliveredAt")
        VALUES($1,$2,$3,'Continue the original saved task.',now())`, [f.answerId, f.prior.runId, owner]);
      const scope = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.taskId])).rows[0];
      const edge = await (await import('../factory/questions/execution-continuation')).unclaimedPlanQuestionContinuation(pool, scope, f.next);
      assert.equal(edge?.historyRunId, f.prior.runId, 'the fixture must have an authentic host receipt before runtime admission');
      assert.equal(edge?.answerId, f.answerId);
      return { ...f, definition, originalDefinition, connectionId, bindingId };
    };
    const unclaimedHistory = async (f: Awaited<ReturnType<typeof unclaimedPlanQuestion>>) => ({
      ...await questionHistory(f),
      native: (await pool.query(`SELECT n.* FROM byos_native_runs n JOIN agent_runs r ON r.id=n."runId"
        WHERE r."issueId"=$1 ORDER BY n."runId"`, [f.issueId])).rows,
      chunks: (await pool.query(`SELECT c.* FROM run_chunks c JOIN agent_runs r ON r.id=c."runId"
        WHERE r."issueId"=$1 ORDER BY c.id`, [f.issueId])).rows,
      credential: (await pool.query('SELECT * FROM byos_bindings WHERE id=$1', [f.bindingId])).rows,
    });
    const withQuestionProvider = async (fixture: ReturnType<typeof refreshFake>, check: () => Promise<void>) => {
      const state = Object.getOwnPropertyDescriptor(threadMachineProvider, 'state');
      const connect = mock.method(threadMachineProvider, 'connect', fixture.provider.connect);
      const create = mock.method(threadMachineProvider, 'create', fixture.provider.create);
      const kill = mock.method(threadMachineProvider, 'kill', fixture.provider.kill);
      // Replace only the external provider seam. The recovery preparation,
      // action router and ensureThreadMachine remain their real functions.
      Object.defineProperty(threadMachineProvider, 'state', { configurable: true, value: fixture.provider.state });
      try { await check(); } finally {
        connect.mock.restore(); create.mock.restore(); kill.mock.restore();
        if (state) Object.defineProperty(threadMachineProvider, 'state', state);
        else Reflect.deleteProperty(threadMachineProvider, 'state');
      }
    };

    for (const state of ['paused', 'running']) {
      await t.test(`spec preclaim runtime refresh keeps the ${state} original VM, null child SID and immutable answer history`, () => withRefreshWorker(async () => {
        const f = await unclaimedPlanQuestion(state), fixture = refreshFake(f, state), before = await unclaimedHistory(f);
        await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider), /Thread unavailable/);
        assert.deepEqual(fixture.calls, [], 'an ordinary wake has no terminal-run maintenance authority');
        assert.deepEqual(await ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true), { runId: f.next, state: 'running' });
        assert.deepEqual(fixture.calls, ['state', `connect:${f.prior.sandboxId}`]);
        assert.deepEqual(fixture.steps, ['stage', 'switch', 'registered', 'verify', 'rpc']);
        assert.deepEqual(await unclaimedHistory(f), before, 'maintenance cannot rewrite the failed run, SID, answer, receipt or subscription');
        assert.deepEqual(await machine(f.next), { state: 'running', sandboxId: f.prior.sandboxId, deviceId: f.prior.device, issueId: f.issueId });
        assert.equal(before.runs.find(row => row.id === f.next).sessionId, null);
        assert.equal(before.runs.find(row => row.id === f.next).startedAt, null);
        assert.equal(before.runs.find(row => row.id === f.next).leaseExpiresAt, null);
      }));
    }

    await t.test('spec preclaim recovery with distinct chat and runtime Bots runs real preparation, queue and claim once', () => withRefreshWorker(async () => {
      const f = await unclaimedPlanQuestion('paused', otherBot), fixture = refreshFake(f, 'paused'), before = await unclaimedHistory(f);
      assert.notEqual(f.taskBot, botId);
      assert.equal(before.task[0].botId, f.taskBot); assert.equal(before.runs.find(row => row.id === f.next).botId, botId);
      const [{ createFactoryQuestions }, { prepareCloudQuestionRecovery, queueCloudQuestionContinuation },
        { createFactoryStore }, { createFactoryDispatch }, { createFactoryClaim }, { claimCloudRun }, { factoryTestLifecycle }] = await Promise.all([
        import('../factory/questions/store'), import('../factory/questions/queue-continuation'), import('../factory/store'),
        import('../factory/dispatch'), import('../factory/claim'), import('../computer/claim'), import('../../tests/helpers/factory-test-authority'),
      ]);
      const authorize = async (userId: string, issueId: string) => userId === owner && issueId === f.issueId;
      const store = createFactoryStore(pool, authorize, f.taskBot, factoryTestLifecycle);
      const dispatch = createFactoryDispatch(pool, store, async (tx, userId, input, bot, context) => {
        const result = await queueCloudQuestionContinuation(tx, userId, input, bot, context);
        assert.ok(result, 'recovery must use the real original-session queue'); return result;
      });
      let preparations = 0;
      const questions = createFactoryQuestions(pool, authorize, store, dispatch, undefined, undefined, undefined, async (userId, scope) => {
        assert.deepEqual({ userId, ...scope }, { userId: owner, runId: f.next, workspaceId });
        preparations++;
        await prepareCloudQuestionRecovery(pool, userId, scope);
        assert.deepEqual(await unclaimedHistory(f), before, 'the actual runtime preparation leaves native and answer history untouched');
      });
      fixture.provider.state = async () => {
        fixture.calls.push('state');
        const probe = await pool.connect();
        try {
          await probe.query('BEGIN');
          assert.equal((await probe.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [`computer-policy:${workspaceId}`])).rows[0].acquired, true);
          await probe.query('SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE NOWAIT', [f.taskId]);
          await probe.query('SELECT id FROM factory_questions WHERE id=$1 FOR UPDATE NOWAIT', [f.q]);
          await probe.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE NOWAIT', [f.next]);
        } finally { await probe.query('ROLLBACK'); probe.release(); }
        return 'paused';
      };
      const sessionId = randomUUID();
      await pool.query(`INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt")
        VALUES($1,$2,$3,now()+interval '1 hour',now(),now())`, [sessionId, owner, `fixture-${randomUUID()}`]);
      const human = { source: 'human' as const, userId: owner, sessionId };
      const current = await questions.read(owner, f.q); assert.ok(current.recoverReference);
      const request = { requestId: randomUUID(), ...current.recoverReference };
      await withQuestionProvider(fixture, async () => {
        const recovered = await questions.recover(human, request);
        const replay = await questions.recover(human, request);
        assert.equal(replay.continuationRunId, recovered.continuationRunId); assert.equal(replay.replayed, true);
        assert.equal(preparations, 1, 'recovery replay cannot refresh the VM or queue again');
        const factoryClaim = createFactoryClaim(store, questions), lease = new Date(Date.now() + 60_000);
        let metadata: Record<string, unknown> = {};
        const claimed = await claimCloudRun(pool, actor, recovered.continuationRunId, f.prior.device, lease, f.bindingId,
          async tx => { metadata = await factoryClaim(tx, owner, f.prior.device, recovered.continuationRunId, lease.toISOString()); }, undefined, false);
        assert.equal(claimed?.ownerId, owner);
        assert.equal(metadata.resumeSessionId, f.continuation.originSessionId);
        assert.equal(metadata.continuesRunId, f.prior.runId, 'native resume uses the actual original history');
        assert.equal(metadata.requireSessionResume, true); assert.equal(metadata.preserveQuestionWorktree, true);
        assert.match(String(metadata.followUp), /Continue the original saved task\./);
        assert.ok(String(metadata.followUp).includes(f.answerId), 'the previously unclaimed answer keeps its source ID');
        const child = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [recovered.continuationRunId])).rows[0];
        assert.equal(child.status, 'preparing'); assert.ok(child.startedAt);
        assert.equal(child.continuesRunId, f.next, 'the database preserves the immediate failed-child audit edge');
        assert.equal(child.agentDefinition.readOnly, true);
        assert.equal(child.agentDefinition.definitionDigest, f.definition.definitionDigest);
        assert.deepEqual(child.agentDefinition.subscription, f.definition.subscription);
        assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id', [[f.prior.runId, f.next]])).rows, before.runs);
        assert.deepEqual((await pool.query('SELECT * FROM run_messages WHERE "runId"=$1 ORDER BY id', [f.prior.runId])).rows, before.messages);
        assert.deepEqual((await pool.query(`SELECT * FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='question_resume' ORDER BY "eventId"`, [f.taskId])).rows, before.receipts);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rows[0].n, 3);
        assert.deepEqual((await pool.query('SELECT "runId","bindingId" FROM byos_native_runs WHERE "runId"=$1', [child.id])).rows, [{ runId: child.id, bindingId: f.bindingId }]);
        assert.equal((await machine(child.id)).sandboxId, f.prior.sandboxId);
        assert.equal((await machine(f.next)).sandboxId, null);
      });
      assert.deepEqual(fixture.calls, ['state', `connect:${f.prior.sandboxId}`], 'the complete recovery path creates no replacement VM');
      assert.deepEqual(fixture.steps, ['stage', 'switch', 'registered', 'verify', 'rpc']);
    }));

    await t.test('spec preclaim runtime refresh waits behind idempotent blocked question settlement without owning the run lock', () => withRefreshWorker(async () => {
      const f = await unclaimedPlanQuestion(), fixture = refreshFake(f, 'paused'), before = await unclaimedHistory(f);
      const [{ createFactoryQuestions }, { createFactoryStore }, { factoryTestLifecycle }] = await Promise.all([
        import('../factory/questions/store'), import('../factory/store'), import('../../tests/helpers/factory-test-authority'),
      ]);
      const authorize = async (userId: string, issueId: string) => userId === owner && issueId === f.issueId;
      const store = createFactoryStore(pool, authorize, botId, factoryTestLifecycle);
      const questions = createFactoryQuestions(pool, authorize, store, async () => { throw new Error('Settlement must not dispatch'); });
      const settlement = await pool.connect();
      let refresh: Promise<{ result?: { runId: string; state: string }; error?: unknown }> | undefined;
      let settled: Awaited<ReturnType<typeof unclaimedHistory>> | undefined;
      try {
        await settlement.query('BEGIN');
        await settlement.query(`SET LOCAL lock_timeout='1s'`);
        const pid = (await settlement.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        // Hold the actual settlement prefix while maintenance starts. It must
        // wait on this task without already owning the child run's lock.
        await store.lockTask(settlement, owner, f.taskId);
        await settlement.query('SELECT id FROM factory_questions WHERE id=$1 FOR UPDATE', [f.q]);
        refresh = ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true)
          .then(result => ({ result }), error => ({ error }));
        let waiting = false;
        for (let attempt = 0; attempt < 80 && !waiting; attempt++) {
          waiting = (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE $1::int=ANY(pg_blocking_pids(pid))) AS waiting`, [pid])).rows[0].waiting;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(waiting, true, 'maintenance must wait for the current settlement transaction');
        assert.deepEqual(fixture.calls, []);
        // A blocked question is already closed, so settle is intentionally
        // idempotent and does not acquire the run lock itself. Probe that lock
        // explicitly: maintenance must not own it while waiting on the task.
        await settlement.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE NOWAIT', [f.next]);
        const replay = await questions.settle(owner, f.next, settlement);
        assert.equal(replay?.status, before.question[0].status);
        assert.equal(replay?.revision, before.question[0].revision);
        await settlement.query('COMMIT');
        settled = await unclaimedHistory(f);
      } finally {
        await settlement.query('ROLLBACK'); settlement.release();
        // Observe every started promise even if a lock-order assertion fails.
        if (refresh) await refresh;
      }
      assert.ok(refresh);
      const outcome = await refresh;
      if (outcome.error) throw outcome.error;
      assert.deepEqual(outcome.result, { runId: f.next, state: 'running' });
      assert.ok(settled); assert.deepEqual(settled, before, 'settling an already blocked question is an immutable replay');
      assert.deepEqual(await unclaimedHistory(f), before, 'maintenance preserves the original history after the settlement releases its locks');
      assert.deepEqual(fixture.calls, ['state', `connect:${f.prior.sandboxId}`]);
      assert.deepEqual(fixture.steps, ['stage', 'switch', 'registered', 'verify', 'rpc']);
    }));

    for (const invalid of ['receipt', 'epoch', 'origin-session', 'answer', 'started', 'native-binding', 'chunks', 'lease', 'writable', 'non-plan', 'paused-credential', 'revoked-credential', 'credential-epoch', 'latest'] as const) {
      await t.test(`spec preclaim runtime refresh rejects ${invalid} before provider I/O`, () => withRefreshWorker(async () => {
        const f = await unclaimedPlanQuestion(), fixture = refreshFake(f, 'paused');
        if (invalid === 'receipt') await pool.query('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.taskId, f.eventId]);
        if (invalid === 'epoch') await pool.query('UPDATE factory_tasks SET "sourceEventId"=$2 WHERE id=$1', [f.taskId, randomUUID()]);
        if (invalid === 'origin-session') await pool.query(`UPDATE agent_runs SET "sessionId"='different-native-session' WHERE id=$1`, [f.prior.runId]);
        if (invalid === 'answer') await pool.query(`UPDATE factory_questions SET "answerFingerprint"='tampered' WHERE id=$1`, [f.q]);
        if (invalid === 'started') await pool.query('UPDATE agent_runs SET "startedAt"=now() WHERE id=$1', [f.next]);
        if (invalid === 'native-binding') await pool.query('INSERT INTO byos_native_runs("runId","bindingId") VALUES($1,$2)', [f.next, f.bindingId]);
        if (invalid === 'chunks') await pool.query('INSERT INTO run_chunks(id,"runId",seq,chunk) VALUES($1,$2,1,$3)', [randomUUID(), f.next, { type: 'text', text: 'Native output already exists' }]);
        if (invalid === 'lease') await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [f.next]);
        if (invalid === 'writable') await pool.query(`UPDATE agent_runs SET "agentDefinition"="agentDefinition"-'readOnly' WHERE id=$1`, [f.next]);
        if (invalid === 'non-plan') await pool.query(`UPDATE agent_runs SET kind='implement' WHERE id=$1`, [f.next]);
        if (invalid === 'paused-credential') await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [f.connectionId]);
        if (invalid === 'revoked-credential') await pool.query(`UPDATE byos_connections SET state='disconnected',epoch=epoch+1 WHERE id=$1`, [f.connectionId]);
        if (invalid === 'credential-epoch') await pool.query('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1', [f.connectionId]);
        if (invalid === 'latest') await pool.query('UPDATE factory_questions SET "continuationRunId"=$2 WHERE id=$1', [f.q, f.prior.runId]);
        const before = await unclaimedHistory(f);
        await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true));
        assert.deepEqual(fixture.calls, []); assert.deepEqual(fixture.steps, []);
        assert.deepEqual(await unclaimedHistory(f), before);
        assert.equal((await machine(f.next)).sandboxId, f.prior.sandboxId);
      }));
    }

    for (const drift of ['epoch', 'revision', 'receipt', 'attempt', 'claim', 'lease', 'credential'] as const) {
      await t.test(`spec preclaim runtime refresh fences ${drift} drift after staging before any switch or bootstrap`, () => withRefreshWorker(async () => {
        const f = await unclaimedPlanQuestion(), fixture = refreshFake(f, 'paused'), connect = fixture.provider.connect;
        const newerLease = randomUUID(); let changed: Awaited<ReturnType<typeof unclaimedHistory>> | undefined;
        fixture.provider.connect = async (...args) => {
          const sandbox = await connect(...args), execute = sandbox.commands.run.bind(sandbox.commands);
          sandbox.commands.run = (async (...commandArgs: Parameters<typeof sandbox.commands.run>) => {
            const result = await execute(...commandArgs);
            if (String(commandArgs[0]).includes('MIKKA_OFFICIAL_WORKER_STAGE')) {
              if (drift === 'epoch') await pool.query('UPDATE factory_tasks SET "sourceEventId"=$2 WHERE id=$1', [f.taskId, randomUUID()]);
              if (drift === 'revision') await pool.query('UPDATE factory_tasks SET revision=revision+1 WHERE id=$1', [f.taskId]);
              if (drift === 'receipt') await pool.query(`UPDATE factory_events SET result=result || '{"tampered":true}'::jsonb WHERE "taskId"=$1 AND "eventId"=$2`, [f.taskId, f.eventId]);
              if (drift === 'attempt') await pool.query('UPDATE factory_tasks SET "attemptId"=$2 WHERE id=$1', [f.taskId, f.originAttemptId]);
              if (drift === 'claim') await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now(),"sessionId"=$2,"leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [f.next, f.continuation.originSessionId]);
              if (drift === 'lease') await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '10 minutes' WHERE "runId"=$1`, [f.next, newerLease]);
              if (drift === 'credential') await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [f.connectionId]);
              changed = await unclaimedHistory(f);
            }
            return result;
          }) as typeof sandbox.commands.run;
          return sandbox;
        };
        await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true));
        assert.ok(changed, 'the real admission must reach provider staging before the competing change');
        assert.deepEqual(fixture.calls, ['state', `connect:${f.prior.sandboxId}`]);
        assert.deepEqual(fixture.steps, ['stage'], 'a losing refresh cannot switch, bootstrap or roll back a release it never changed');
        assert.deepEqual(await unclaimedHistory(f), changed);
        if (drift === 'lease') assert.equal((await pool.query('SELECT "workerLeaseId" FROM thread_machines WHERE "runId"=$1', [f.next])).rows[0].workerLeaseId, newerLease);
      }));
    }

    await t.test('spec preclaim runtime refresh rechecks receipt after provider connect and before staging', () => withRefreshWorker(async () => {
      const f = await unclaimedPlanQuestion(), fixture = refreshFake(f, 'paused'), connect = fixture.provider.connect;
      let changed: Awaited<ReturnType<typeof unclaimedHistory>> | undefined;
      fixture.provider.connect = async (...args) => {
        const sandbox = await connect(...args);
        await pool.query('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.taskId, f.eventId]);
        changed = await unclaimedHistory(f); return sandbox;
      };
      await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true));
      assert.ok(changed); assert.deepEqual(fixture.calls, ['state', `connect:${f.prior.sandboxId}`]);
      assert.deepEqual(fixture.steps, []); assert.deepEqual(await unclaimedHistory(f), changed);
    }));

    for (const revoked of ['answer', 'credential', 'device'] as const) {
      await t.test(`spec preclaim runtime refresh rolls back after switched ${revoked} revocation without publishing credentials`, () => withRefreshWorker(async () => {
        const f = await unclaimedPlanQuestion(), fixture = refreshFake(f, 'paused'), connect = fixture.provider.connect;
        let changed: Awaited<ReturnType<typeof unclaimedHistory>> | undefined;
        fixture.provider.connect = async (...args) => {
          const sandbox = await connect(...args), read = sandbox.files.read.bind(sandbox.files);
          sandbox.files.read = (async (...readArgs: Parameters<typeof sandbox.files.read>) => {
            const result = await read(...readArgs);
            if (fixture.steps.includes('switch') && !changed) {
              if (revoked === 'answer') await pool.query('UPDATE factory_questions SET revision=revision+1 WHERE id=$1', [f.q]);
              if (revoked === 'credential') await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [f.connectionId]);
              if (revoked === 'device') await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [f.prior.device]);
              changed = await unclaimedHistory(f);
            }
            return result;
          }) as typeof sandbox.files.read;
          return sandbox;
        };
        await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true));
        assert.ok(changed); assert.deepEqual(fixture.steps, ['stage', 'switch', 'rollback']);
        assert.deepEqual(await unclaimedHistory(f), changed);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM device_tokens WHERE "boundDeviceId"=$1', [f.prior.device])).rows[0].n, 0);
        const current = (await pool.query('SELECT state,"sandboxId","workerLeaseId","workerLeaseUntil" FROM thread_machines WHERE "runId"=$1', [f.next])).rows[0];
        assert.deepEqual(current, { state: 'error', sandboxId: f.prior.sandboxId, workerLeaseId: null, workerLeaseUntil: null });
      }));
    }

    for (const stage of ['execute', 'review', 'verify'] as const) {
      await t.test(`a queued ${stage} question upgrades the old worker on its original VM without changing the answer or native session`, () => withRefreshWorker(async () => {
        const f = await upgradingQuestion(stage), fixture = refreshFake(f, 'paused'), before = await questionHistory(f);
        assert.deepEqual(await ensureThreadMachine(pool, actor, f.next, fixture.provider), { runId: f.next, state: 'running' });
        assert.deepEqual(fixture.calls, ['state', `connect:${f.prior.sandboxId}`], 'no create, snapshot or kill');
        assert.deepEqual(fixture.steps, ['stage', 'switch', 'registered', 'verify', 'rpc']);
        assert.deepEqual(await questionHistory(f), before, 'the answer, receipt, original run, candidate and native SID stay immutable');
        assert.deepEqual(await machine(f.next), { state: 'running', sandboxId: f.prior.sandboxId, deviceId: f.prior.device, issueId: f.issueId });
        const pending = (await pool.query('SELECT status,"startedAt","sessionId","agentDefinition" FROM agent_runs WHERE id=$1', [f.next])).rows[0];
        assert.equal(pending.status, 'queued'); assert.equal(pending.startedAt, null); assert.equal(pending.sessionId, null);
        assert.deepEqual(pending.agentDefinition, f.definition);
        if (stage === 'execute') {
          const { createFactoryQuestions } = await import('../factory/questions/store');
          const { createFactoryStore } = await import('../factory/store');
          const { factoryTestLifecycle } = await import('../../tests/helpers/factory-test-authority');
          const authorize = async (userId: string, issueId: string) => userId === owner && issueId === f.issueId;
          const store = createFactoryStore(pool, authorize, botId, factoryTestLifecycle);
          const service = createFactoryQuestions(pool, authorize, store, async () => { throw new Error('Upgrade must not dispatch another run'); });
          const claim = await service.claimContinuation(owner, f.prior.device, f.next, new Date(Date.now() + 60_000).toISOString());
          assert.equal(claim.resumeSessionId, f.continuation.originSessionId);
          assert.equal(claim.requireSessionResume, true);
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rows[0].n, 2);
        }
      }));
    }

    await t.test('a non-repository Codex question upgrades the original official desktop and restores its display lease', () => withRefreshWorker(async () => {
      const f = await upgradingQuestion(), fixture = refreshFake(f, 'paused'), connect = fixture.provider.connect;
      await pool.query(`UPDATE thread_machines SET "snapshotId"='desktop' WHERE "runId"=ANY($1::uuid[])`, [[f.prior.runId, f.next]]);
      await pool.query(`UPDATE device_repos SET "remoteUrl"=NULL,"repoPath"=$2 WHERE id=(SELECT "deviceRepoId" FROM agent_runs WHERE id=$1)`,
        [f.next, `/home/user/.mikka/bot-workspaces/${botId}`]);
      fixture.provider.connect = async (...args) => {
        const sandbox = await connect(...args), execute = sandbox.commands.run.bind(sandbox.commands);
        sandbox.commands.run = (async (...commandArgs: Parameters<typeof sandbox.commands.run>) =>
          String(commandArgs[0]).includes('MIKKA_RUNTIME_HASHES') ? { stdout: '', stderr: '', exitCode: 0 } : execute(...commandArgs)) as typeof sandbox.commands.run;
        return sandbox;
      };
      const before = await questionHistory(f);
      const desktop = {
        startDesktop: async (_sandbox: unknown, display: number, managed: boolean | undefined) => { assert.equal(display, 1); assert.equal(managed, true); fixture.steps.push('display'); },
        syncDesktopLease: async (_sandbox: unknown, lease: { botId: string; ownerId: string; controlledBy: string | null }) => {
          assert.equal(lease.botId, botId); assert.equal(lease.ownerId, owner); assert.equal(lease.controlledBy, null); fixture.steps.push('lease');
        },
      };
      assert.deepEqual(await ensureThreadMachine(pool, actor, f.next, fixture.provider, desktop), { runId: f.next, state: 'running' });
      assert.deepEqual(fixture.calls, ['state', `connect:${f.prior.sandboxId}`]);
      assert.deepEqual(fixture.steps, ['stage', 'switch', 'display', 'lease', 'registered', 'verify', 'rpc']);
      assert.deepEqual(await questionHistory(f), before);
      assert.equal((await machine(f.next)).sandboxId, f.prior.sandboxId);
    }));

    for (const drift of ['epoch', 'attempt', 'stage', 'receipt', 'stop', 'claim', 'lease', 'workspace'] as const) {
      await t.test(`question worker upgrade refuses ${drift} drift after staging and leaves the winning state untouched`, () => withRefreshWorker(async () => {
        const f = await upgradingQuestion(), fixture = refreshFake(f, 'paused'), connect = fixture.provider.connect;
        let changed: Awaited<ReturnType<typeof questionHistory>> | undefined;
        const newerLease = randomUUID();
        fixture.provider.connect = async (...args) => {
          const sandbox = await connect(...args), execute = sandbox.commands.run.bind(sandbox.commands);
          sandbox.commands.run = (async (...commandArgs: Parameters<typeof sandbox.commands.run>) => {
            const result = await execute(...commandArgs);
            if (String(commandArgs[0]).includes('MIKKA_OFFICIAL_WORKER_STAGE')) {
              if (drift === 'epoch') await pool.query('UPDATE factory_tasks SET "sourceEventId"=$2 WHERE id=$1', [f.taskId, randomUUID()]);
              if (drift === 'attempt') await pool.query(`UPDATE factory_tasks SET "attemptId"=(SELECT id FROM factory_attempts WHERE "taskId"=$1 AND position=1) WHERE id=$1`, [f.taskId]);
              if (drift === 'stage') await pool.query(`UPDATE factory_tasks SET stage='review' WHERE id=$1`, [f.taskId]);
              if (drift === 'receipt') await pool.query('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.taskId, f.eventId]);
              if (drift === 'stop') await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [f.next]);
              if (drift === 'claim') await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now(),"sessionId"=$2,"leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [f.next, f.continuation.originSessionId]);
              if (drift === 'lease') await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '10 minutes' WHERE "runId"=$1`, [f.next, newerLease]);
              if (drift === 'workspace') {
                const foreignWorkspace = randomUUID(), foreignBot = randomUUID();
                await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,'Other fixture workspace','team')`, [foreignWorkspace, owner]);
                await pool.query(`INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,'Other fixture Bot')`, [foreignBot, foreignWorkspace, owner]);
                await pool.query('UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1', [f.next, foreignWorkspace, foreignBot]);
              }
              changed = await questionHistory(f);
            }
            return result;
          }) as typeof sandbox.commands.run;
          return sandbox;
        };
        const warning = mock.method(console, 'warn', () => undefined);
        try { await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider), /question|runtime|ownership/i); }
        finally { warning.mock.restore(); }
        assert.ok(changed, 'the old worker version must reach staging before the currentness race');
        assert.deepEqual(fixture.steps, ['stage'], 'no switch, bootstrap, rollback or competing worker is touched');
        assert.deepEqual(await questionHistory(f), changed);
        assert.equal((await machine(f.next)).sandboxId, f.prior.sandboxId);
        if (drift === 'lease') assert.equal((await pool.query('SELECT "workerLeaseId" FROM thread_machines WHERE "runId"=$1', [f.next])).rows[0].workerLeaseId, newerLease);
      }));
    }

    await t.test('question worker upgrade rolls back its own release when bootstrap fails and retries the same child', () => withRefreshWorker(async () => {
      const f = await upgradingQuestion(), fixture = refreshFake(f, 'paused'), before = await questionHistory(f), connect = fixture.provider.connect;
      const fault = new Error('Synthetic bootstrap publication failure');
      fixture.provider.connect = async (...args) => {
        const sandbox = await connect(...args);
        sandbox.files.write = async () => { throw fault; };
        return sandbox;
      };
      const warning = mock.method(console, 'warn', () => undefined);
      try { await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider), error => error === fault); }
      finally { warning.mock.restore(); }
      assert.deepEqual(fixture.steps, ['stage', 'switch', 'rollback']);
      assert.deepEqual(await questionHistory(f), before);
      const current = (await pool.query('SELECT "sandboxId","workerLeaseId","workerLeaseUntil" FROM thread_machines WHERE "runId"=$1', [f.next])).rows[0];
      assert.deepEqual(current, { sandboxId: f.prior.sandboxId, workerLeaseId: null, workerLeaseUntil: null });
      const retry = refreshFake(f, 'running');
      assert.deepEqual(await ensureThreadMachine(pool, actor, f.next, retry.provider), { runId: f.next, state: 'running' });
      assert.deepEqual(retry.calls, ['state', `connect:${f.prior.sandboxId}`]);
      assert.deepEqual(await questionHistory(f), before);
    }));

    for (const derived of [false, true]) await t.test(`a queued stage upgrades its adopted ${derived ? 'retired additive' : 'official'} VM before bootstrap and preserves its completed producer`, () => withRefreshWorker(async () => {
      const issueId = await task(), prior = await parked(issueId, { template: derived ? 'retired-derived-codex' : 'codex' }), next = await run(issueId);
      if (derived) await pool.query('UPDATE thread_machines SET "templateKind"=$2 WHERE "runId"=$1', [prior.runId, 'codex']);
      await pool.query(`UPDATE agent_runs SET "sessionId"='retained-original-session',report='{"summary":"original immutable result"}' WHERE id=$1`, [prior.runId]);
      const before = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [prior.runId])).rows[0];
      const fixture = refreshFake({ prior }, 'paused'), connect = fixture.provider.connect;
      fixture.provider.connect = async (...args) => {
        const sandbox = await connect(...args), execute = sandbox.commands.run.bind(sandbox.commands);
        sandbox.commands.run = (async (...commandArgs: Parameters<typeof sandbox.commands.run>) => {
          if (String(commandArgs[0]).includes('MIKKA_OFFICIAL_WORKER_STAGE')) {
            assert.match(String(commandArgs[0]), /bash -s -- [a-f0-9]{40} [a-f0-9]{40} codex stage /, 'worker maintenance uses the preserved official base, never the retired image ID');
            const tx = await pool.connect();
            try {
              await tx.query('BEGIN'); await tx.query(`SET LOCAL lock_timeout='250ms'`);
              await tx.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [next]);
              await tx.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1 FOR UPDATE', [next]);
              await tx.query('ROLLBACK');
            } finally { tx.release(); }
          }
          return execute(...commandArgs);
        }) as typeof sandbox.commands.run;
        return sandbox;
      };
      assert.deepEqual(await ensureThreadMachine(pool, actor, next, fixture.provider), { runId: next, state: 'running' });
      assert.deepEqual(fixture.calls, [`connect:${prior.sandboxId}`], 'no new sandbox, snapshot or kill');
      assert.deepEqual(fixture.steps, ['stage', 'switch', 'registered', 'verify', 'rpc']);
      assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [prior.runId])).rows[0], before);
      assert.equal((await machine(prior.runId)).sandboxId, null);
      assert.deepEqual(await machine(next), { state: 'running', sandboxId: prior.sandboxId, deviceId: prior.device, issueId });
      assert.equal((await pool.query('SELECT "templateKind" FROM thread_machines WHERE "runId"=$1', [next])).rows[0].templateKind, 'codex');
      const current = (await pool.query('SELECT status,"deviceId","sessionId" FROM agent_runs WHERE id=$1', [next])).rows[0];
      assert.deepEqual(current, { status: 'queued', deviceId: prior.device, sessionId: null }, 'the independent checker has not borrowed the producer session');
    }));

    await t.test('adopted VM wake failures and durable replays preserve custody and never take the generic end path', () => withRefreshWorker(async () => {
      const issueId = await task(), prior = await parked(issueId), next = await run(issueId);
      const before = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [prior.runId])).rows[0];
      const calls: string[] = [];
      let failWith404 = false;
      const connect = mock.method(threadMachineProvider, 'connect', async (id: string) => {
        calls.push(`connect:${id}`);
        if (failWith404) throw { status: 404 };
        throw new Error('fixture transient connect');
      });
      const kill = mock.method(threadMachineProvider, 'kill', async (id: string) => { calls.push(`kill:${id}`); });
      const create = mock.method(threadMachineProvider, 'create', async () => { throw new Error('replacement is forbidden'); });
      try {
        const { startThreadMachine } = await import('../run-leases');
        for (const missing of [false, true]) {
          failWith404 = missing;
          assert.deepEqual(await startThreadMachine(actor, next), { state: 'unavailable', reason: 'retained_runtime' });
          assert.deepEqual(await machine(next), { state: 'error', sandboxId: prior.sandboxId, deviceId: prior.device, issueId });
          const row = (await pool.query('SELECT "workerLeaseId","workerLeaseUntil" FROM thread_machines WHERE "runId"=$1', [next])).rows[0];
          assert.deepEqual(row, { workerLeaseId: null, workerLeaseUntil: null });
        }
        assert.deepEqual(calls, [`connect:${prior.sandboxId}`, `connect:${prior.sandboxId}`]);
        assert.equal(create.mock.callCount(), 0);
        assert.equal(kill.mock.callCount(), 0);
        assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [next])).rows[0].status, 'queued');
        assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [prior.runId])).rows[0], before);
      } finally { connect.mock.restore(); kill.mock.restore(); create.mock.restore(); }
      const retry = refreshFake({ prior }, 'paused');
      assert.deepEqual(await ensureThreadMachine(pool, actor, next, retry.provider), { runId: next, state: 'running' });
      assert.equal((await machine(next)).sandboxId, prior.sandboxId, 'successful retry continues with the same retained VM');
    }));

    await t.test('Factory starts the retained worker without spawning a second lifecycle workflow', () => withRefreshWorker(async () => {
      const issueId = await task(), prior = await parked(issueId), next = await run(issueId);
      const fixture = refreshFake({ prior }, 'paused');
      let childStarts = 0;
      const workflow = mock.module('workflow/api', { namedExports: { start: async () => {
        childStarts++; throw new Error('the current Factory workflow already owns the lifecycle');
      } } });
      const connect = mock.method(threadMachineProvider, 'connect', fixture.provider.connect);
      const { factoryAutomaticRuntime } = await import('../factory/automatic-dispatch');
      try {
        assert.deepEqual(await factoryAutomaticRuntime.start(actor, next), { state: 'running' });
        assert.equal(childStarts, 0);
        assert.equal((await machine(next)).sandboxId, prior.sandboxId);
        assert.deepEqual(fixture.steps, ['stage', 'switch', 'registered', 'verify', 'rpc']);
      } finally { connect.mock.restore(); workflow.restore(); }
    }));

    await t.test('retained stage maintenance rejects another active run before touching its VM', async () => {
      const issueId = await task(), prior = await parked(issueId), next = await run(issueId), active = await run(await task());
      await pool.query('UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [active, prior.device]);
      const fixture = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider), RetainedTaskMachineUnavailable);
      assert.deepEqual(fixture.calls, []);
      assert.equal((await machine(prior.runId)).sandboxId, prior.sandboxId, 'failed admission rolls back adoption');
      assert.equal(await machine(next), undefined);
    });

    await t.test('a queued running retained VM can upgrade without replacing its existing machine', () => withRefreshWorker(async () => {
      const issueId = await task(), prior = await parked(issueId), next = await run(issueId);
      const first = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, first.provider), RetainedTaskMachineUnavailable);
      await pool.query(`UPDATE thread_machines SET state='running' WHERE "runId"=$1`, [next]);
      const fixture = refreshFake({ prior }, 'running'), connect = fixture.provider.connect;
      fixture.provider.connect = async (...args) => {
        assert.equal((await machine(next)).state, 'error', 'maintenance fences claims before provider I/O without pretending the provider paused');
        return connect(...args);
      };
      assert.deepEqual(await ensureThreadMachine(pool, actor, next, fixture.provider), { runId: next, state: 'running' });
      assert.deepEqual(fixture.calls, [`connect:${prior.sandboxId}`]);
      assert.deepEqual(fixture.steps, ['stage', 'switch', 'registered', 'verify', 'rpc']);
      assert.equal((await machine(next)).sandboxId, prior.sandboxId);
    }));

    await t.test('a changed maintenance lease prevents switch and cleanup from affecting its new owner', () => withRefreshWorker(async () => {
      const issueId = await task(), prior = await parked(issueId), next = await run(issueId), newerLease = randomUUID();
      const fixture = refreshFake({ prior }, 'paused'), connect = fixture.provider.connect;
      fixture.provider.connect = async (...args) => {
        const sandbox = await connect(...args), execute = sandbox.commands.run.bind(sandbox.commands);
        sandbox.commands.run = (async (...commandArgs: Parameters<typeof sandbox.commands.run>) => {
          const result = await execute(...commandArgs);
          if (String(commandArgs[0]).includes('MIKKA_OFFICIAL_WORKER_STAGE'))
            await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '10 minutes' WHERE "runId"=$1`, [next, newerLease]);
          return result;
        }) as typeof sandbox.commands.run;
        return sandbox;
      };
      const warning = mock.method(console, 'warn', () => undefined);
      try { await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider), RetainedTaskMachineUnavailable); }
      finally { warning.mock.restore(); }
      assert.deepEqual(fixture.steps, ['stage'], 'no switch, bootstrap or rollback under a changed lease');
      const row = (await pool.query('SELECT state,"sandboxId","workerLeaseId" FROM thread_machines WHERE "runId"=$1', [next])).rows[0];
      assert.deepEqual(row, { state: 'paused', sandboxId: prior.sandboxId, workerLeaseId: newerLease });
    }));

    await t.test('a queued adopted stage cannot switch or bootstrap after its run starts elsewhere', () => withRefreshWorker(async () => {
      const issueId = await task(), prior = await parked(issueId), next = await run(issueId);
      const fixture = refreshFake({ prior }, 'paused'), connect = fixture.provider.connect;
      fixture.provider.connect = async (...args) => {
        const sandbox = await connect(...args), execute = sandbox.commands.run.bind(sandbox.commands);
        sandbox.commands.run = (async (...commandArgs: Parameters<typeof sandbox.commands.run>) => {
          const result = await execute(...commandArgs);
          if (String(commandArgs[0]).includes('MIKKA_OFFICIAL_WORKER_STAGE'))
            await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [next]);
          return result;
        }) as typeof sandbox.commands.run;
        return sandbox;
      };
      const warning = mock.method(console, 'warn', () => undefined);
      try { await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider), RetainedTaskMachineUnavailable); }
      finally { warning.mock.restore(); }
      assert.deepEqual(fixture.steps, ['stage']);
      assert.equal((await machine(next)).sandboxId, prior.sandboxId);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM device_tokens WHERE "boundDeviceId"=$1', [prior.device])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [next])).rows[0].status, 'running', 'no run status is rewritten on failure');
    }));

    for (const status of ['stopped','cancelled'] as const) await t.test('explicit refresh retains a safely exited '+status+' run and its microsecond stop marker', () => withRefreshWorker(async()=>{
      const prior=await parked(await task(),{status}),fixture=refreshFake({prior},'paused')
      await pool.query(`UPDATE agent_runs r SET "stopRequestedAt"='2026-11-06T23:59:59.123456Z',
        report='{"safePoint":{"session":"exited"}}',"deviceId"=m."deviceId","deviceRepoId"=m."repoId"
        FROM thread_machines m WHERE r.id=$1 AND m."runId"=r.id`,[prior.runId])
      const before=(await pool.query('SELECT status,"stopRequestedAt"::text AS stop,report FROM agent_runs WHERE id=$1',[prior.runId])).rows[0]
      assert.deepEqual(await ensureThreadMachine(pool,actor,prior.runId,fixture.provider,undefined,true),{runId:prior.runId,state:'running'})
      assert.deepEqual((await pool.query('SELECT status,"stopRequestedAt"::text AS stop,report FROM agent_runs WHERE id=$1',[prior.runId])).rows[0],before)
      assert.deepEqual(fixture.steps,['stage','switch','registered','verify','rpc'])
    }))
    for (const stopPhase of ['stage','publication'] as const) await t.test('a fresh stop during maintenance '+stopPhase+' cannot use the historic stopped-run exception', () => withRefreshWorker(async()=>{
      const prior=await parked(await task(),{status:'stopped'}),fixture=refreshFake({prior},'paused')
      await pool.query(`UPDATE agent_runs r SET "stopRequestedAt"='2026-11-06T23:59:59.123456Z',
        report='{"safePoint":{"session":"exited"}}',"deviceId"=m."deviceId","deviceRepoId"=m."repoId"
        FROM thread_machines m WHERE r.id=$1 AND m."runId"=r.id`,[prior.runId])
      const connect=fixture.provider.connect
      fixture.provider.connect=async(...args)=>{
        const box=await connect(...args),execute=box.commands.run.bind(box.commands)
        box.commands.run=(async(...commandArgs:Parameters<typeof box.commands.run>)=>{
          const result=await execute(...commandArgs)
          if(String(commandArgs[0]).includes(stopPhase==='stage'?'MIKKA_OFFICIAL_WORKER_STAGE':'mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json'))
            await pool.query('UPDATE agent_runs SET "stopRequestedAt"=clock_timestamp() WHERE id=$1',[prior.runId])
          return result
        }) as typeof box.commands.run
        return box
      }
      const warning=mock.method(console,'warn',()=>undefined)
      try{await assert.rejects(ensureThreadMachine(pool,actor,prior.runId,fixture.provider,undefined,true),/Thread provisioning cancelled|Task runtime is busy or its ownership changed/)}
      finally{warning.mock.restore()}
      assert.notEqual((await machine(prior.runId)).state,'running')
      assert.ok(fixture.steps.includes('rollback'))
    }))

    for (const [state, recovered] of [['paused', false], ['running', true]] as const) {
      await t.test(`explicit runtime refresh updates the ${state} failed original VM without changing answer or recovery history`, () => withRefreshWorker(async () => {
        const f = await failedQuestionMachine(state, recovered), fixture = refreshFake(f, state);
        const before = await questionHistory(f);
        await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider), /Thread unavailable/);
        assert.deepEqual(fixture.calls, [], 'ordinary resume never gains maintenance authority');
        assert.deepEqual(await ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true), { runId: f.next, state: 'running' });
        assert.deepEqual(fixture.calls, ['state', `connect:${f.prior.sandboxId}`]);
        assert.deepEqual(fixture.steps, ['stage', 'switch', 'registered', 'verify', 'rpc']);
        assert.deepEqual(await questionHistory(f), before);
        assert.equal((await machine(f.next)).sandboxId, f.prior.sandboxId);
        assert.equal((await machine(f.next)).deviceId, f.prior.device);
        await assert.rejects(ensureThreadMachine(pool, actor, f.prior.runId, fixture.provider, undefined, true), /Existing official task runtime required/);
        assert.deepEqual(fixture.calls, ['state', `connect:${f.prior.sandboxId}`], 'the root no longer owns a VM to refresh');
      }));
    }
    await t.test('failed question refresh refuses stale custody, changed sessions and busy work before provider I/O', async () => {
      for (const fault of ['latest', 'attempt', 'origin-session', 'failed-session', 'sandbox', 'lease', 'active']) {
        const f = await failedQuestionMachine(), fixture = exactFake();
        if (fault === 'latest') await pool.query(`UPDATE factory_questions SET "continuationRunId"=NULL WHERE id=$1`, [f.q]);
        if (fault === 'attempt') await pool.query(`UPDATE factory_attempts SET "runId"=$2 WHERE id=$1`, [f.attemptId, f.prior.runId]);
        if (fault === 'origin-session' || fault === 'failed-session') await pool.query(`UPDATE agent_runs SET "sessionId"='changed' WHERE id=$1`, [fault === 'origin-session' ? f.prior.runId : f.next]);
        if (fault === 'sandbox') await pool.query(`UPDATE thread_machines SET "sandboxId"='wrong-vm' WHERE "runId"=$1`, [f.next]);
        if (fault === 'lease') await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '1 minute' WHERE "runId"=$1`, [f.next, randomUUID()]);
        if (fault === 'active') await pool.query(`UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1`, [await run(await task()), f.prior.device]);
        const before = await questionHistory(f);
        await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true), /Original question machine unavailable|provisioning in progress|runtime is busy/, fault);
        assert.deepEqual(fixture.calls, [], fault);
        assert.deepEqual(await questionHistory(f), before, fault);
      }
    });
    await t.test('concurrent explicit refresh cannot take the held maintenance lease or touch question history', () => withRefreshWorker(async () => {
      const f = await failedQuestionMachine(), fixture = refreshFake(f, 'paused'), second = exactFake();
      const before = await questionHistory(f);
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      fixture.provider.state = async () => { fixture.calls.push('state'); entered(); await held; return 'paused'; };
      const first = ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true);
      try {
        await Promise.race([started, first]);
        await assert.rejects(ensureThreadMachine(pool, actor, f.next, second.provider, undefined, true), /provisioning in progress/);
        assert.deepEqual(second.calls, []);
      } finally { release(); }
      assert.deepEqual(await first, { runId: f.next, state: 'running' });
      assert.deepEqual(await questionHistory(f), before);
      assert.deepEqual(fixture.steps, ['stage', 'switch', 'registered', 'verify', 'rpc']);
    }));
    await t.test('an expired refresh rolls back with its own budget and leaves a retryable original VM', () => withRefreshWorker(async () => {
      const f = await failedQuestionMachine('running'), fixture = refreshFake(f, 'running');
      const before = await questionHistory(f), realNow = Date.now;
      const connect = fixture.provider.connect;
      fixture.provider.connect = async id => {
        const sandbox = await connect(id, workspaceId);
        const execute = sandbox.commands.run.bind(sandbox.commands);
        sandbox.commands.run = (async (command: string, options: { timeoutMs?: number; signal?: AbortSignal }) => {
          const result = await execute(command, options);
          if (command.includes('python3 - switch ')) Date.now = () => realNow() + 240_001;
          if (command.includes('python3 - rollback ')) {
            assert.ok(options.timeoutMs && options.timeoutMs > 5_000 && options.timeoutMs <= 30_000);
            assert.equal(options.signal?.aborted, false, 'rollback gets a fresh budget');
          }
          return result;
        }) as typeof sandbox.commands.run;
        return sandbox;
      };
      try {
        await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true), /runtime refresh timed out/);
      } finally { Date.now = realNow; }
      assert.deepEqual(fixture.steps, ['stage', 'switch', 'rollback']);
      assert.deepEqual(await questionHistory(f), before);
      const current = (await pool.query('SELECT state,"sandboxId","workerLeaseId","workerLeaseUntil" FROM thread_machines WHERE "runId"=$1', [f.next])).rows[0];
      assert.deepEqual(current, { state: 'error', sandboxId: f.prior.sandboxId, workerLeaseId: null, workerLeaseUntil: null });
      const retry = refreshFake(f, 'running');
      assert.deepEqual(await ensureThreadMachine(pool, actor, f.next, retry.provider, undefined, true), { runId: f.next, state: 'running' });
      assert.deepEqual(await questionHistory(f), before);
    }));
    await t.test('refresh registration failure keeps its log on the VM without rewriting the original failed run', () => withRefreshWorker(async () => {
      const f = await failedQuestionMachine('running', true), fixture = refreshFake(f, 'running');
      const before = await questionHistory(f), realNow = Date.now;
      assert.equal(before.runs.find(row => row.id === f.next).error, null);
      const tail = 'fixture worker could not authenticate its replacement credential';
      const connect = fixture.provider.connect;
      fixture.provider.connect = async id => {
        const sandbox = await connect(id, workspaceId);
        const execute = sandbox.commands.run.bind(sandbox.commands);
        sandbox.commands.run = (async (command: string, options: { timeoutMs?: number; onStdout?: (chunk: string) => void }) => {
          if (command.includes('mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json')) {
            options.onStdout?.(REGISTRATION_WAITING + '\n');
            throw new Error('cloud_registration_timeout');
          }
          if (command.startsWith('tail -n 200 ')) return { stdout: tail, stderr: '', exitCode: 0 };
          const result = await execute(command, options);
          if (command.includes('node dist/cloud/cloud-worker.js')) {
            let reads = 0;
            Date.now = () => realNow() + (++reads > 1 ? 31_000 : 0);
          }
          return result;
        }) as typeof sandbox.commands.run;
        return sandbox;
      };
      const warnings: string[] = [];
      const warning = mock.method(console, 'warn', (line: string) => { warnings.push(line); });
      try {
        await assert.rejects(ensureThreadMachine(pool, actor, f.next, fixture.provider, undefined, true), /Thread worker did not register/);
      } finally { Date.now = realNow; warning.mock.restore(); }
      assert.deepEqual(warnings.map(line => JSON.parse(line)), [{ event: 'thread_runtime_refresh_failed', runId: f.next,
        phase: 'worker_register', errorClass: 'Error', errorCode: 'unknown' }]);
      assert.deepEqual(fixture.steps, ['stage', 'switch', 'rollback']);
      assert.deepEqual(await questionHistory(f), before);
      const current = (await pool.query('SELECT state,"sandboxId","deviceId","logTail","workerLeaseId" FROM thread_machines WHERE "runId"=$1', [f.next])).rows[0];
      assert.deepEqual(current, { state: 'error', sandboxId: f.prior.sandboxId, deviceId: f.prior.device, logTail: tail, workerLeaseId: null });
    }));

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
        let bootstrap: { deviceId: string; credential: string } | undefined, authenticated = 0, uploads = 0, starts = 0;
        fixture.provider.create = async (_source, op) => ({
          sandboxId: `sandbox-${op}`,
          files: {
            read: async () => 'a'.repeat(40),
            write: async (path: string | UploadedFile[], body: unknown) => {
              uploads++;
              const files = uploadedFiles(path,body), primary = files.find(file => file.path.endsWith('.json'));
              bootstrap = uploadedBootstrap(path,body);
              assert.ok(primary); assert.ok(bootstrap);
              assert.deepEqual(body, { user: 'root', useOctetStream: false });
              const locator = files.find(file => file.path === primary.path + '.run');
              assert.ok(locator);
              assert.deepEqual(JSON.parse(locator.data), { version: 1, runId, bootstrapSha256: createHash('sha256').update(primary.data).digest('hex') });
              assert.ok(!locator.data.includes(bootstrap.credential));
              assert.equal('initialRunId' in JSON.parse(primary.data), false, 'old strict bootstrap consumers retain the original schema');
            },
          },
          commands: { run: async (command: string, options: { user?: string; background?: boolean }) => {
            if (command.includes('mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json')) {
              assert.ok(bootstrap);
              assert.equal(uploads, 1, 'the optional locator shares the existing upload RPC');
              assert.equal(options.user, 'root');
              assert.notEqual(options.background, true, 'publication failures must complete before any fallback');
              assert.match(command, /runuser -u user -- sh -c/);
              assert.ok(command.indexOf('mv /home/user/.mikka/initial-run.next /home/user/.mikka/initial-run.json') < command.indexOf('mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json'));
              const used = await pool.query(`UPDATE device_tokens SET "lastUsedAt"=clock_timestamp() WHERE "boundDeviceId"=$1 AND "tokenHash"=$2 AND "revokedAt" IS NULL RETURNING id`, [bootstrap.deviceId, createHash('sha256').update(bootstrap.credential).digest('hex')]);
              assert.equal(used.rowCount, 1);
              await pool.query(`UPDATE devices SET "lastSeenAt"=clock_timestamp() WHERE id=$1`, [bootstrap.deviceId]);
              authenticated++;
              // Make the historical late floor observably later than this real authentication.
              await pool.query('SELECT pg_sleep(0.02)');
              return { stdout: REGISTRATION_COMPLETE + '\n', stderr: '', exitCode: 0 };
            }
            if (command.includes('node dist/cloud/cloud-worker.js')) {
              starts++;
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
        assert.equal(starts, 0, 'the registered preloader needs no second remote start command');
      } finally {
        Date.now = realNow;
        if (savedWorker.url === undefined) delete process.env.MIKKA_CLOUD_WORKER_URL; else process.env.MIKKA_CLOUD_WORKER_URL = savedWorker.url;
        if (savedWorker.sha === undefined) delete process.env.MIKKA_CLOUD_WORKER_SHA; else process.env.MIKKA_CLOUD_WORKER_SHA = savedWorker.sha;
      }
    });


    for (const mode of ['success', 'upload_failure', 'lease_cancel_after_attestation', 'revoked_before_finish', 'legacy'] as const) await t.test('fresh worker broker transaction and publication boundary: ' + mode, async () => {
      const savedWorker = { url: process.env.MIKKA_CLOUD_WORKER_URL, sha: process.env.MIKKA_CLOUD_WORKER_SHA };
      process.env.MIKKA_CLOUD_WORKER_URL = 'https://worker.example.invalid/mikka';
      process.env.MIKKA_CLOUD_WORKER_SHA = 'a'.repeat(40);
      try {
        const runId = await run(await task()), fixture = fake();
        let bootstrap: { deviceId: string; credential: string } | undefined, uploaded: UploadedFile[] = [];
        let reads = 0, commands = 0, streams = 0, commits = 0, uploadCompleted = false;
        let resolveCompletion!: (value: { stdout: string; stderr: string; exitCode: number }) => void;
        const completion = new Promise<{ stdout: string; stderr: string; exitCode: number }>(resolve => { resolveCompletion = resolve; });
        let output: ((value: string) => void) | undefined;
        const register = async () => {
          assert.ok(bootstrap);
          const used = await pool.query('UPDATE device_tokens SET "lastUsedAt"=clock_timestamp() WHERE "boundDeviceId"=$1 AND "tokenHash"=$2 AND "revokedAt" IS NULL RETURNING id',
            [bootstrap.deviceId, createHash('sha256').update(bootstrap.credential).digest('hex')]);
          assert.equal(used.rowCount, 1, 'the credential transaction is committed before provider publication');
          await pool.query('UPDATE devices SET "lastSeenAt"=clock_timestamp() WHERE id=$1', [bootstrap.deviceId]);
          if (mode === 'revoked_before_finish') await pool.query('UPDATE device_tokens SET "revokedAt"=clock_timestamp() WHERE "boundDeviceId"=$1', [bootstrap.deviceId]);
          return { stdout: REGISTRATION_COMPLETE + '\n', stderr: '', exitCode: 0 };
        };
        fixture.provider.create = async (_source, op) => ({
          sandboxId: 'sandbox-' + op,
          files: {
            read: async () => { reads++; return 'a'.repeat(40); },
            write: async (path: string | UploadedFile[], body: unknown) => {
              uploaded = uploadedFiles(path, body); bootstrap = uploadedBootstrap(path, body);
              assert.equal(uploaded.length, 4, 'the original bootstrap and three sidecars remain one multipart request');
              assert.ok(bootstrap);
              const row = await pool.query('SELECT 1 FROM device_tokens WHERE "boundDeviceId"=$1 AND "tokenHash"=$2', [bootstrap.deviceId, createHash('sha256').update(bootstrap.credential).digest('hex')]);
              assert.equal(row.rowCount, 1, 'a separate PG connection can read the committed credential at upload');
              if (mode === 'upload_failure') throw Error('upload response lost after provider writes');
              uploadCompleted = true;
            },
          },
          commands: {
            run: async (_command: string, options: { background?: boolean; stdin?: boolean; onStdout?: (value: string) => void }) => {
              commands++;
              if (!options.background) return register();
              assert.equal(options.stdin, true); assert.equal(uploadCompleted, false);
              const row = (await pool.query('SELECT "workerLeaseId","deviceId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];
              assert.equal(row.deviceId, null, 'attestation precedes credential device creation');
              if (mode === 'lease_cancel_after_attestation') await pool.query(`UPDATE thread_machines SET state='ended',"workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "runId"=$1`, [runId]);
              output = options.onStdout;
              output?.('mikka-worker-broker-attestation ' + JSON.stringify({ version: 1, runId, leaseId: row.workerLeaseId, sourceSha: 'a'.repeat(40), broker: mode !== 'legacy' }) + '\n');
              if (mode === 'legacy') resolveCompletion({ stdout: '', stderr: '', exitCode: 0 });
              return { pid: 42, wait: () => completion, disconnect: async () => {}, kill: async () => { resolveCompletion({ stdout: '', stderr: '', exitCode: 1 }); return true; } };
            },
            streamInput: () => {
              streams++;
              return {
                send: async (raw: string) => {
                  const value = JSON.parse(raw); if (value.kind === 'abort') { resolveCompletion({ stdout: '', stderr: '', exitCode: 1 }); return; }
                  commits++; assert.equal(uploadCompleted, true, 'no commit on the stream before files.write resolves');
                  assert.equal(value.runId, runId); assert.equal(value.files.length, 4);
                  for (let i = 0; i < uploaded.length; i++) {
                    assert.equal(value.files[i].bytes, Buffer.byteLength(uploaded[i].data));
                    assert.equal(value.files[i].sha256, createHash('sha256').update(uploaded[i].data).digest('hex'));
                  }
                  output?.(REGISTRATION_WAITING + '\n'); resolveCompletion(await register());
                },
                close: async () => {},
              };
            },
          },
        }) as never;
        if (mode === 'success' || mode === 'legacy') {
          assert.deepEqual(await ensureThreadMachine(pool, actor, runId, fixture.provider), { runId, state: 'running' });
        } else {
          await assert.rejects(ensureThreadMachine(pool, actor, runId, fixture.provider),
            mode === 'upload_failure' ? /upload response lost/ : /provisioning cancelled/);
          assert.notEqual((await machine(runId)).state, 'running', 'the original final fresh fence still controls success');
        }
        assert.equal(reads, 0, 'the live broker replaces the independent marker files.read');
        assert.equal(commands, mode === 'legacy' ? 2 : 1, 'only an explicitly unsupported release uses the original command');
        assert.equal(streams, mode === 'legacy' ? 0 : 1);
        assert.equal(commits, mode === 'success' || mode === 'revoked_before_finish' ? 1 : 0);
      } finally {
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
            write: async (path: string | UploadedFile[], body: unknown) => {
              for (const file of uploadedFiles(path,body)) {
                if (file.path.startsWith('/run/mikka-viewer/thread-')) { steps.push('handoff'); throw new Error('fixture reached worker handoff'); }
                files.set(file.path, file.data);
              }
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
          files: { read: async () => 'a'.repeat(40), write: async (path: string | UploadedFile[]) => { if (uploadedFiles(path).some(file => file.path.startsWith('/run/mikka-viewer/thread-'))) throw new Error('fixture reached worker handoff'); } },
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

    await t.test('additive releases preserve the task VM and official harness provenance after catalogue rotation', async () => {
      const issueId = await task(), before = await parked(issueId, { template: 'retired-derived-codex' });
      await pool.query('UPDATE thread_machines SET "templateKind"=$2 WHERE "runId"=$1', [before.runId, 'codex']);
      const next = await run(issueId), fixture = fake();
      fixture.provider.connect = async id => { fixture.calls.push(`connect:${id}`); throw new Error('fixture retained derived runtime'); };
      await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider), RetainedTaskMachineUnavailable);
      assert.deepEqual(fixture.calls, [`connect:${before.sandboxId}`]);
      const retained = (await pool.query('SELECT "snapshotId","templateKind","sandboxId" FROM thread_machines WHERE "runId"=$1', [next])).rows[0];
      assert.deepEqual(retained, { snapshotId: 'retired-derived-codex', templateKind: 'codex', sandboxId: before.sandboxId });
      assert.equal((await machine(before.runId)).sandboxId, null);
    });
    await t.test('a derived VM from another official harness cannot be adopted', async () => {
      const issueId = await task(), before = await parked(issueId, { template: 'retired-derived-claude' });
      await pool.query('UPDATE thread_machines SET "templateKind"=$2 WHERE "runId"=$1', [before.runId, 'claude']);
      const next = await run(issueId), fixture = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider));
      assert.deepEqual(fixture.calls, ['create']);
      assert.equal((await machine(before.runId)).sandboxId, before.sandboxId);
    });
    await t.test("the task's next run resumes the paused sandbox: no snapshot, no new sandbox, same device", async () => {
      const issueId = await task();
      const before = await parked(issueId);
      const next = await run(issueId);
      const { calls, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, provider), RetainedTaskMachineUnavailable);
      assert.deepEqual(calls, [`connect:${before.sandboxId}`]);
      assert.deepEqual(await machine(next), { state: "error", sandboxId: before.sandboxId, deviceId: before.device, issueId });
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

    await t.test("a sandbox whose run has not ended is neither taken over nor replaced", async () => {
      const issueId = await task();
      const before = await parked(issueId, { status: "queued" });
      const next = await run(issueId);
      const { calls, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, provider), /maintenance in progress/);
      assert.deepEqual(calls, []);
      assert.equal(await machine(next), undefined);
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

    await t.test("a finished run parks its sandbox; a refused pause retains a durable retry without claiming it paused", async () => {
      const issueId = await task();
      const runId = await run(issueId, { status: "succeeded" });
      const device = randomUUID();
      await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,"nameLocked") VALUES ($1,$2,'Thread computer','cloud',true)`, [device, owner]);
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","runningSince") VALUES ($1,$2,$3,$4,$5,'sandbox-live','snapshot-fixture',$6,'running',$7,now())`, [runId, workspaceId, owner, botId, issueId, randomUUID(), device]);
      await pool.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","expiresAt") VALUES ($1,$2,'Thread worker',$3,$4,now()+interval '1 day')`, [randomUUID(), owner, randomUUID(), device]);
      await assert.rejects(parkThreadMachine(pool, actor, runId, async () => { throw new Error("503 pause refused"); }, async () => null));
      assert.equal((await machine(runId)).state, "running", "a refused pause leaves the row as it was");
      const failed = (await pool.query('SELECT lifecycle,"lifecycleAt" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];
      assert.equal(failed.lifecycle.phase, 'pause_failed');
      assert.ok(failed.lifecycleAt, 'the durable recovery timer must retain responsibility after provider refusal');
      assert.equal(failed.lifecycle.failures, 1);
      const paused: string[] = [];
      await parkThreadMachine(pool, actor, runId, async (id) => { paused.push(id); }, async () => "worker: run finished");
      assert.equal((await pool.query('SELECT "logTail" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0].logTail, "worker: run finished", "the worker's last output is kept before the pause");
      assert.deepEqual(paused, ["sandbox-live"]);
      assert.deepEqual(await machine(runId), { state: "paused", sandboxId: "sandbox-live", deviceId: device, issueId });
      assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE "boundDeviceId"=$1', [device])).rows[0].revokedAt);
      assert.equal((await pool.query('SELECT "removedAt" FROM devices WHERE id=$1', [device])).rows[0].removedAt, null);
    });

    await t.test('parking refuses an active execution lease before touching the provider', async () => {
      const issueId = await task(), before = await parked(issueId);
      await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '2 minutes' WHERE id=$1`, [before.runId]);
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now() WHERE "runId"=$1`, [before.runId]);
      let calls = 0;
      await assert.rejects(parkThreadMachine(pool, actor, before.runId, async () => { calls++; }, async () => null));
      assert.equal(calls, 0);
      assert.equal((await machine(before.runId)).state, 'running');
    });

    await t.test('an immediate owner continuation transfers its safely exited running VM before the timer parks it', async () => {
      const issueId = await task(), before = await parked(issueId), next = await run(issueId), tokenId = randomUUID();
      await pool.query('UPDATE agent_runs SET report=$2,"finishedAt"=now(),"leaseExpiresAt"=NULL WHERE id=$1', [before.runId,
        JSON.stringify({ safePoint: { session: 'exited', checkpoint: 'unavailable', observedAt: new Date().toISOString() } })]);
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now(),"lifecycleAt"=now()+interval '2 minutes' WHERE "runId"=$1`, [before.runId]);
      await pool.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","expiresAt") VALUES ($1,$2,'Old worker',$3,$4,now()+interval '1 day')`, [tokenId, owner, randomUUID(), before.device]);
      const oldEpoch = (await pool.query('SELECT epoch FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].epoch;
      const fixture = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider));
      assert.deepEqual(fixture.calls, [`connect:${before.sandboxId}`], 'the already admitted next run reuses the VM without a pause or create');
      assert.equal((await machine(next)).sandboxId, before.sandboxId);
      assert.equal((await machine(next)).deviceId, before.device);
      assert.equal((await machine(before.runId)).sandboxId, null);
      assert.ok((await pool.query('SELECT epoch FROM thread_machines WHERE "runId"=$1', [next])).rows[0].epoch > oldEpoch);
      assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [tokenId])).rows[0].revokedAt,
        'the previous worker loses authority in the same transfer transaction');
    });

    await t.test('immediate continuation cannot bypass a native exit, lease, reconciliation or stop fence', async () => {
      for (const blocked of ['native_exit', 'execution_lease', 'bootstrap_lease', 'reconciliation', 'pause_requested', 'retire_requested', 'stop_requested', 'other_handoff']) {
        const issueId = await task(), before = await parked(issueId), next = await run(issueId), tokenId = randomUUID();
        await pool.query('UPDATE agent_runs SET report=$2,"finishedAt"=now() WHERE id=$1', [before.runId,
          JSON.stringify(blocked === 'native_exit' ? {} : { safePoint: { session: 'exited', checkpoint: 'unavailable', observedAt: new Date().toISOString() } })]);
        await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now() WHERE "runId"=$1`, [before.runId]);
        if (blocked === 'execution_lease') await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()+interval \'2 minutes\' WHERE id=$1', [before.runId]);
        if (blocked === 'bootstrap_lease') await pool.query('UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval \'2 minutes\' WHERE "runId"=$1', [before.runId, randomUUID()]);
        if (blocked === 'reconciliation') await pool.query('UPDATE thread_machines SET lifecycle=$2 WHERE "runId"=$1', [before.runId, JSON.stringify({ reconcileId: randomUUID(), reconcileUntil: Date.now() + 120_000 })]);
        if (blocked === 'pause_requested' || blocked === 'retire_requested') await pool.query('UPDATE thread_machines SET lifecycle=$2 WHERE "runId"=$1', [before.runId, JSON.stringify({ phase: blocked })]);
        if (blocked === 'stop_requested') await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [before.runId]);
        if (blocked === 'other_handoff') await pool.query('UPDATE thread_machines SET lifecycle=$2 WHERE "runId"=$1', [before.runId, JSON.stringify({ phase: 'handoff', handoffRunId: randomUUID() })]);
        await pool.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","expiresAt") VALUES ($1,$2,'Current worker',$3,$4,now()+interval '1 day')`, [tokenId, owner, randomUUID(), before.device]);
        const original = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0];
        const fixture = fake();
        await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider), /provisioning in progress|runtime is busy/, blocked);
        assert.deepEqual(fixture.calls, [], blocked);
        assert.equal(await machine(next), undefined, blocked);
        assert.deepEqual((await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0], original, blocked);
        assert.equal((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [tokenId])).rows[0].revokedAt, null, blocked);
      }
    });

    await t.test('an admitted adjacent stage keeps the same live VM and fences old lifecycle callbacks', async () => {
      const issueId = await task(), before = await parked(issueId), next = await run(issueId);
      await pool.query(`UPDATE agent_runs SET report='{"safePoint":{"session":"exited","checkpoint":"unavailable"}}' WHERE id=$1`, [before.runId]);
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now(),"computeSeconds"=43200 WHERE "runId"=$1`, [before.runId]);
      const oldEpoch = (await pool.query('SELECT epoch FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].epoch;
      assert.equal(await retainThreadMachineForHandoff(pool, actor, before.runId, next), true);
      let pauses = 0;
      await parkThreadMachine(pool, actor, before.runId, async () => { pauses++; }, async () => null, undefined, { epoch: oldEpoch, sandboxId: before.sandboxId });
      assert.equal(pauses, 0, 'an observation before the admitted handoff cannot pause the new epoch');
      const provider = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, provider.provider));
      assert.deepEqual(provider.calls, [`connect:${before.sandboxId}`]);
      assert.equal((await machine(next)).sandboxId, before.sandboxId);
      assert.equal(Number((await pool.query('SELECT "computeSeconds" FROM thread_machines WHERE "runId"=$1', [next])).rows[0].computeSeconds), 0,
        'an admitted new run has its own execution budget; prior compute remains on the historical row');
      assert.equal((await machine(before.runId)).sandboxId, null);
      assert.equal((await pool.query('SELECT "lifecycleAt" FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].lifecycleAt, null);
    });

    await t.test('an adjacent stage with another harness or repository cannot retain a running VM', async () => {
      for (const mismatch of ['harness', 'repository']) {
        const issueId = await task(), before = await parked(issueId), next = await run(issueId, mismatch === 'repository' ? { repo: otherRepo } : {});
        await pool.query(`UPDATE agent_runs SET report='{"safePoint":{"session":"exited","checkpoint":"unavailable"}}' WHERE id=$1`, [before.runId]);
        await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now() WHERE "runId"=$1`, [before.runId]);
        if (mismatch === 'harness') await pool.query(`UPDATE agent_runs SET "agentDefinition"='{"harness":"claude_code"}' WHERE id=$1`, [next]);
        const priorEpoch = (await pool.query('SELECT epoch FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].epoch;
        assert.equal(await retainThreadMachineForHandoff(pool, actor, before.runId, next), false, mismatch);
        const retained = (await pool.query('SELECT state,epoch,lifecycle FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0];
        assert.equal(retained.state, 'running');
        assert.equal(retained.epoch, priorEpoch);
        assert.equal(retained.lifecycle.handoffRunId, undefined);
      }
    });

    await t.test('a stop that did not acknowledge is frozen after its grace, with bytes retained and claims fenced', async () => {
      const issueId = await task(), before = await parked(issueId);
      await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '2 minutes',"stopRequestedAt"=now() WHERE id=$1`, [before.runId]);
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now() WHERE "runId"=$1`, [before.runId]);
      const epoch = (await pool.query('SELECT epoch FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].epoch;
      const fence = { epoch, sandboxId: before.sandboxId, suspendAfterStop: true };
      let pauses = 0;
      const pause = async () => { pauses++; };
      await assert.rejects(parkThreadMachine(pool, actor, before.runId, pause, async () => null, undefined, fence));
      assert.equal(pauses, 0, 'a new stop allows the worker to upload its checkpoint first');
      await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=now()-interval '31 seconds' WHERE id=$1`, [before.runId]);
      await parkThreadMachine(pool, actor, before.runId, pause, async () => null, undefined, fence);
      assert.equal(pauses, 1);
      assert.equal((await machine(before.runId)).state, 'paused');
      assert.equal((await machine(before.runId)).sandboxId, before.sandboxId, 'forced suspension never destroys the sole filesystem');
    });

    const frozenStop = async () => {
      const issueId = await task(), before = await parked(issueId);
      await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '2 minutes',"stopRequestedAt"=now()-interval '31 seconds' WHERE id=$1`, [before.runId]);
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now() WHERE "runId"=$1`, [before.runId]);
      const epoch = (await pool.query('SELECT epoch FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].epoch;
      const fence = { epoch, sandboxId: before.sandboxId, suspendAfterStop: true };
      return { issueId, before, fence };
    };

    await t.test('a frozen unacknowledged stop blocks another run from adopting or replacing its VM', async () => {
      for (const repo of [repoId, otherRepo]) {
        const { issueId, before, fence } = await frozenStop();
        await parkThreadMachine(pool, actor, before.runId, async () => {}, async () => null, undefined, fence);
        const next = await run(issueId, { repo }), fixture = fake();
        await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider), /busy|maintenance in progress|provisioning in progress/);
        assert.deepEqual(fixture.calls, [], 'a frozen native process still owns this task, even after its bootstrap lease was cleared');
        assert.equal(await machine(next), undefined);
        assert.equal((await machine(before.runId)).sandboxId, before.sandboxId);
      }
    });

    await t.test('a host terminal status cannot unfreeze a stopped VM without native exit evidence', async () => {
      const { issueId, before, fence } = await frozenStop();
      await parkThreadMachine(pool, actor, before.runId, async () => {}, async () => null, undefined, fence);
      // Lease recovery can finish the DB row without hearing from its daemon.
      await pool.query(`UPDATE agent_runs SET status='stopped',"leaseExpiresAt"=NULL,"finishedAt"=now() WHERE id=$1`, [before.runId]);
      await pool.query(`UPDATE thread_machines SET lifecycle=lifecycle||'{"phase":"paused","reason":"retained"}'::jsonb WHERE "runId"=$1`, [before.runId]);
      const next = await run(issueId), fixture = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider), /busy|maintenance in progress/);
      assert.deepEqual(fixture.calls, []);
      assert.equal(await machine(next), undefined);
      assert.equal((await machine(before.runId)).sandboxId, before.sandboxId);
      await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [before.runId,
        JSON.stringify({ safePoint: { session: 'exited', checkpoint: 'unavailable', observedAt: new Date().toISOString() } })]);
      await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider));
      assert.deepEqual(fixture.calls, [`connect:${before.sandboxId}`], 'native exit permits reuse without claiming a durable archive exists');
      assert.equal((await machine(next)).sandboxId, before.sandboxId);
      assert.equal((await machine(before.runId)).sandboxId, null);
    });

    await t.test('a host stop terminalized before suspension still needs native exit before reuse', async () => {
      for (const needsPause of [true, false]) {
        const { issueId, before } = await frozenStop();
        // The lease sweep can win before park, or the provider can already be paused.
        await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='device_lost',"leaseExpiresAt"=NULL,"finishedAt"=now() WHERE id=$1`, [before.runId]);
        if (needsPause) await parkThreadMachine(pool, actor, before.runId, async () => {}, async () => null);
        else await pool.query(`UPDATE thread_machines SET state='paused' WHERE "runId"=$1`, [before.runId]);
        const next = await run(issueId), fixture = fake();
        await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider), /maintenance in progress/);
        assert.deepEqual(fixture.calls, []);
        assert.equal(await machine(next), undefined);
        assert.equal((await machine(before.runId)).sandboxId, before.sandboxId);
      }
    });

    await t.test('device-lost terminalization requires native exit only when the run had actually claimed', async () => {
      for (const claim of ['startedAt', 'sessionId', 'deviceTokenId', null]) {
        const issueId = await task(), before = await parked(issueId, { status: 'failed' });
        await pool.query(`UPDATE agent_runs r SET "stopReason"='device_lost',"startedAt"=$2,"sessionId"=$3,"deviceTokenId"=$4,
          "deviceId"=m."deviceId","deviceRepoId"=m."repoId" FROM thread_machines m WHERE r.id=$1 AND m."runId"=r.id`,
          [before.runId, claim === 'startedAt' ? new Date() : null, claim === 'sessionId' ? 'native-session' : null, claim === 'deviceTokenId' ? randomUUID() : null]);
        const fixture = fake();
        if (claim) {
          await assert.rejects(ensureThreadMachine(pool, actor, before.runId, fixture.provider, undefined, true), /runtime is busy/);
          const next = await run(issueId, claim === 'deviceTokenId' ? { repo: otherRepo } : {});
          await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider), /maintenance in progress|provisioning in progress/);
          assert.deepEqual(fixture.calls, [], claim);
          assert.equal(await machine(next), undefined);
          assert.equal((await machine(before.runId)).sandboxId, before.sandboxId);
        } else {
          const next = await run(issueId);
          await assert.rejects(ensureThreadMachine(pool, actor, next, fixture.provider));
          assert.deepEqual(fixture.calls, [`connect:${before.sandboxId}`], 'an unclaimed host failure does not invent a running native process');
        }
      }
    });

    await t.test('runtime refresh cannot resume a frozen stop after host-only terminalization', async () => {
      const { before, fence } = await frozenStop();
      await parkThreadMachine(pool, actor, before.runId, async () => {}, async () => null, undefined, fence);
      await pool.query(`UPDATE agent_runs r SET status='stopped',"leaseExpiresAt"=NULL,"finishedAt"=now(),"deviceId"=m."deviceId","deviceRepoId"=m."repoId"
        FROM thread_machines m WHERE r.id=$1 AND m."runId"=r.id`, [before.runId]);
      const fixture = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, before.runId, fixture.provider, undefined, true), /runtime is busy/);
      assert.deepEqual(fixture.calls, []);
      assert.equal((await machine(before.runId)).state, 'paused');
    });

    await t.test('stop suspension commits its native exit barrier before provider I/O and keeps it after a lost response', async () => {
      const { before, fence } = await frozenStop();
      await assert.rejects(parkThreadMachine(pool, actor, before.runId, async () => {
        const committed = (await pool.query('SELECT lifecycle FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].lifecycle;
        assert.equal(committed.requiresNativeExit, true);
        throw new Error('lost stop pause response');
      }, async () => null, undefined, fence), /lost stop pause response/);
      let saved = (await pool.query('SELECT lifecycle FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].lifecycle;
      assert.equal(saved.requiresNativeExit, true);
      assert.equal(saved.phase, 'pause_failed');
      await pool.query(`UPDATE agent_runs SET status='stopped',"leaseExpiresAt"=NULL WHERE id=$1`, [before.runId]);
      await pool.query(`UPDATE thread_machines SET state='paused' WHERE "runId"=$1`, [before.runId]);
      await parkThreadMachine(pool, actor, before.runId, async () => { assert.fail('an observed paused VM must not be connected or paused again'); });
      saved = (await pool.query('SELECT lifecycle FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].lifecycle;
      assert.equal(saved.requiresNativeExit, true, 'later terminal status and pause reconciliation cannot erase the native exit requirement');
    });

    await t.test('automatic retirement refuses a reopened task or an unverified final archive', async () => {
      const issueId = await task(), before = await parked(issueId);
      const epoch = (await pool.query('SELECT epoch FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].epoch;
      const fence = { epoch, sandboxId: before.sandboxId, requireClosedTask: true, requireArchived: true };
      assert.equal((await threadMachineAction(pool, actor, before.runId, 'end', fence)).state, 'paused');
      await pool.query(`UPDATE issues SET status='done' WHERE id=$1`, [issueId]);
      assert.equal((await threadMachineAction(pool, actor, before.runId, 'end', fence)).state, 'paused');
      assert.equal((await machine(before.runId)).sandboxId, before.sandboxId);
      const takenAt = new Date(Date.now() - 60_000).toISOString();
      await pool.query('INSERT INTO run_checkpoints ("runId","userId","baseCommit",patch,files,"takenAt") VALUES ($1,$2,$3,$4,0,$5)',
        [before.runId, owner, 'a'.repeat(40), Buffer.alloc(0), takenAt]);
      for (const observedAt of [new Date(Date.now() + 60_000).toISOString(), new Date(Date.now() - 120_000).toISOString()]) {
        await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [before.runId,
          JSON.stringify({ safePoint: { session: 'exited', checkpoint: 'ready', checkpointTakenAt: takenAt, observedAt } })]);
        assert.equal((await threadMachineAction(pool, actor, before.runId, 'end', fence)).state, 'paused');
      }
    });

    await t.test('an expired creation with a lost response recovers its exact provider identity and parks without waking it', async () => {
      const { reconcileThreadMachine } = await import('./thread-lifecycle');
      const issueId = await task(), before = await parked(issueId, { status: 'queued' });
      const operationId = (await pool.query('SELECT "operationId" FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].operationId;
      await pool.query(`UPDATE thread_machines SET state='starting',"sandboxId"=NULL,"workerLeaseId"=$2,
        "workerLeaseUntil"=now()-interval '1 second',"lastActiveAt"=now()-interval '3 minutes',
        lifecycle='{"phase":"create_requested","owner":"run-recovery"}',"lifecycleAt"=now() WHERE "runId"=$1`, [before.runId, randomUUID()]);
      let pauses = 0, lookups = 0;
      const provider = {
        findCreated: async (id: string, workspace: string, operation: string, user: string) => {
          assert.deepEqual([id, workspace, operation, user], [before.runId, workspaceId, operationId, owner]);
          lookups++;
          return { sandboxId: before.sandboxId, state: 'running' as const, startedAt: Date.now()-180_000, endAt: Date.now()+720_000 };
        },
        info: async () => ({ state: 'running' as const, endAt: Date.now()+720_000 }),
        keepAlive: async () => { assert.fail('an expired unclaimed allocation has no authority to renew'); },
      };
      const park: NonNullable<Parameters<typeof reconcileThreadMachine>[3]>['park'] = (p, a, id, fence) =>
        parkThreadMachine(p, a, id, async vm => { assert.equal(vm, before.sandboxId); pauses++; }, async () => null, undefined, fence);
      await reconcileThreadMachine(pool, actor, before.runId, { provider, park });
      assert.equal(lookups, 1);
      assert.equal(pauses, 1);
      assert.equal((await machine(before.runId)).sandboxId, before.sandboxId);
      assert.equal((await machine(before.runId)).state, 'paused');
      assert.equal((await pool.query('SELECT "workerLeaseUntil" FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].workerLeaseUntil, null);
    });

    await t.test('a cancelled creation with a lost response is found and killed before its provider reference is cleared', async () => {
      const { reconcileThreadMachine } = await import('./thread-lifecycle');
      const issueId = await task(), before = await parked(issueId, { status: 'stopped' });
      await pool.query(`UPDATE thread_machines SET state='ended',"sandboxId"=NULL,"workerLeaseUntil"=now()-interval '1 second',
        lifecycle='{"phase":"retire_requested","owner":"run-recovery"}',"lifecycleAt"=now() WHERE "runId"=$1`, [before.runId]);
      const killed: string[] = [];
      const kill = mock.method(threadMachineProvider, 'kill', async (id: string) => {
        assert.equal((await machine(before.runId)).sandboxId, id, 'the recovered reference must commit before kill');
        killed.push(id);
      });
      try {
        await reconcileThreadMachine(pool, actor, before.runId, { provider: {
          findCreated: async () => ({ sandboxId: before.sandboxId, state: 'paused', startedAt: Date.now()-900_000, endAt: null }),
          info: async () => ({ state: 'paused', endAt: null }),
          keepAlive: async () => { assert.fail('cancelled creation must not renew'); },
        } });
        assert.deepEqual(killed, [before.sandboxId]);
        const retired = (await pool.query('SELECT "sandboxId","lifecycleAt",lifecycle FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0];
        assert.equal(retired.sandboxId, null);
        assert.equal(retired.lifecycleAt, null);
        assert.equal(retired.lifecycle.phase, 'retired');
      } finally { kill.mock.restore(); }
    });

    await t.test('a stale lost-create lookup cannot attach or operate on a newer epoch', async () => {
      const { reconcileThreadMachine } = await import('./thread-lifecycle');
      const issueId = await task(), before = await parked(issueId, { status: 'queued' });
      await pool.query(`UPDATE thread_machines SET state='starting',"sandboxId"=NULL,"workerLeaseUntil"=now()-interval '1 second',
        lifecycle='{"phase":"create_requested"}',"lifecycleAt"=now() WHERE "runId"=$1`, [before.runId]);
      await reconcileThreadMachine(pool, actor, before.runId, { provider: {
        findCreated: async () => {
          await pool.query(`UPDATE thread_machines SET epoch=epoch+1,"sandboxId"='newer-owned-vm',state='running',
            lifecycle=lifecycle-'reconcileId'-'reconcileUntil' WHERE "runId"=$1`, [before.runId]);
          return { sandboxId: before.sandboxId, state: 'paused', startedAt: Date.now()-900_000, endAt: null };
        },
        info: async () => { assert.fail('the old lookup must yield before provider maintenance'); },
        keepAlive: async () => { assert.fail('an old allocation cannot renew a newer owner'); },
      }, park: async () => { assert.fail('an old allocation cannot park a newer owner'); }, end: async () => { assert.fail('an old allocation cannot retire a newer owner'); } });
      assert.equal((await machine(before.runId)).sandboxId, 'newer-owned-vm');
    });

    await t.test('the durable controller reconciles a refused/lost pause with real PG and revokes the retained device', async () => {
      const { reconcileThreadMachine } = await import('./thread-lifecycle');
      const issueId = await task(), before = await parked(issueId);
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now() WHERE "runId"=$1`, [before.runId]);
      const token = randomUUID();
      await pool.query(`INSERT INTO device_tokens (id,"userId",name,"tokenHash","boundDeviceId","expiresAt") VALUES ($1,$2,'Lost pause',$3,$4,now()+interval '1 day')`, [token, owner, randomUUID(), before.device]);
      let providerState: 'running' | 'paused' = 'running', first = true;
      const provider = { info: async () => ({ state: providerState, endAt: Date.now()+900_000 }), keepAlive: async () => { assert.fail('terminal work must not renew compute'); } };
      const park: NonNullable<Parameters<typeof reconcileThreadMachine>[3]>['park'] = (p, a, id, fence) => parkThreadMachine(p, a, id, async () => {
        providerState = 'paused';
        if (first) { first = false; throw new Error('provider completed pause but the response was lost'); }
      }, async () => null, undefined, fence);
      const retry = await reconcileThreadMachine(pool, actor, before.runId, { provider, park });
      assert.equal(typeof retry, 'number');
      assert.equal((await machine(before.runId)).state, 'running', 'unknown provider outcome is never reported as a successful pause');
      await pool.query('UPDATE thread_machines SET "lifecycleAt"=now() WHERE "runId"=$1', [before.runId]);
      await reconcileThreadMachine(pool, actor, before.runId, { provider, park });
      assert.equal((await machine(before.runId)).state, 'paused');
      assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [token])).rows[0].revokedAt);
      const saved = (await pool.query('SELECT lifecycle,"lifecycleAt" FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0];
      assert.equal(saved.lifecycle.owner, 'run-recovery');
      assert.equal(saved.lifecycle.phase, 'paused');
      assert.equal(saved.lifecycle.reconcileId, undefined);
      assert.ok(saved.lifecycleAt);
    });

    await t.test('a renewed execution lease during provider observation cannot be stopped from an expired snapshot', async () => {
      const { reconcileThreadMachine } = await import('./thread-lifecycle');
      const issueId = await task(), before = await parked(issueId, { status: 'running' });
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now() WHERE "runId"=$1`, [before.runId]);
      await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()-interval '1 second' WHERE id=$1`, [before.runId]);
      const provider = {
        info: async () => {
          await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()+interval '2 minutes' WHERE id=$1`, [before.runId]);
          return { state: 'running' as const, endAt: Date.now()+900_000 };
        },
        keepAlive: async () => { assert.fail('a stale decision must yield to a fresh read'); },
      };
      const next = await reconcileThreadMachine(pool, actor, before.runId, { provider, recover: async () => {} });
      assert.equal(typeof next, 'number');
      assert.equal((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [before.runId])).rows[0].stopRequestedAt, null);
      const lifecycle = (await pool.query('SELECT lifecycle FROM thread_machines WHERE "runId"=$1', [before.runId])).rows[0].lifecycle;
      assert.equal(lifecycle.observedStop, false);
      assert.equal(lifecycle.reconcileId, undefined);
    });

    await t.test('a task reopened during provider observation cannot be stopped by the stale closure', async () => {
      const { reconcileThreadMachine } = await import('./thread-lifecycle');
      const issueId = await task('done'), before = await parked(issueId, { status: 'running' });
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=now() WHERE "runId"=$1`, [before.runId]);
      await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()+interval '2 minutes' WHERE id=$1`, [before.runId]);
      const provider = {
        info: async () => {
          await pool.query(`UPDATE issues SET status='doing' WHERE id=$1`, [issueId]);
          return { state: 'running' as const, endAt: Date.now()+900_000 };
        },
        keepAlive: async () => { assert.fail('a stale decision must yield to a fresh read'); },
      };
      assert.equal(typeof await reconcileThreadMachine(pool, actor, before.runId, { provider }), 'number');
      assert.equal((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [before.runId])).rows[0].stopRequestedAt, null);
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

