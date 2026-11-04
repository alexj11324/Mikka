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
    const { ensureThreadMachine, parkThreadMachine, endClosedTaskMachines, keepTailBeforeKill, threadMachineAction, threadMachineProvider, RetainedTaskMachineUnavailable } = await import("./thread-machines");

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
          return {sandboxId:id,files:{read:async()=> 'a'.repeat(40),write:async(path:string,body:string)=>{if(path.startsWith('/run/mikka-viewer/thread-'))bootstrap=JSON.parse(body);}},
            commands:{run:async(command:string)=>{
              if(command.includes('mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json')){
                assert.ok(bootstrap);assert.equal(bootstrap.deviceId,f.prior.device);
                await pool.query(`UPDATE device_tokens SET "lastUsedAt"=clock_timestamp() WHERE "boundDeviceId"=$1 AND "tokenHash"=$2 AND "revokedAt" IS NULL`,[bootstrap.deviceId,createHash('sha256').update(bootstrap.credential).digest('hex')]);
                await pool.query(`UPDATE devices SET "lastSeenAt"=clock_timestamp() WHERE id=$1`,[bootstrap.deviceId]);
              }
              return {stdout:'',stderr:'',exitCode:0};
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
          files: { read: async () => sha, write: async (path: string, body: string) => {
            assert.match(path, /^\/run\/mikka-viewer\/thread-/);
            bootstrap = JSON.parse(body);
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
            } else if (command.includes('mikka-runtime-process-verified')) {
              steps.push('rpc'); stdout = 'mikka-runtime-process-verified 42';
            } else assert.ok(command.includes('node dist/cloud/cloud-worker.js'), 'only worker startup remains');
            return { stdout, stderr: '', exitCode: 0 };
          } },
        } as never;
      };
      return { ...fixture, steps };
    };

    await t.test('a queued stage upgrades its adopted official VM before bootstrap and preserves its completed producer', () => withRefreshWorker(async () => {
      const issueId = await task(), prior = await parked(issueId), next = await run(issueId);
      await pool.query(`UPDATE agent_runs SET "sessionId"='retained-original-session',report='{"summary":"original immutable result"}' WHERE id=$1`, [prior.runId]);
      const before = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [prior.runId])).rows[0];
      const fixture = refreshFake({ prior }, 'paused'), connect = fixture.provider.connect;
      fixture.provider.connect = async (...args) => {
        const sandbox = await connect(...args), execute = sandbox.commands.run.bind(sandbox.commands);
        sandbox.commands.run = (async (...commandArgs: Parameters<typeof sandbox.commands.run>) => {
          if (String(commandArgs[0]).includes('MIKKA_OFFICIAL_WORKER_STAGE')) {
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
        sandbox.commands.run = (async (command: string, options: { timeoutMs?: number }) => {
          if (command.includes('mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json')) return { stdout: '', stderr: '', exitCode: 0 };
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
