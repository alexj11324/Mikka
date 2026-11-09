import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
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
import { dropTestDatabase } from "../../tests/support/drop-test-database";

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
    const { acknowledgeQueuedThreadStop, ensureThreadMachine, threadMachineProvider } = await import("./thread-machines");
    const { stopOwnedRun } = await import("../run-control");
    // The normal API path still runs the real host acknowledgement. Only the
    // provider credential/HTTP boundary is synthetic; no real key is read.
    if ("prepareKill" in threadMachineProvider) {
      const runtime = threadMachineProvider as typeof threadMachineProvider & { prepareKill: (ownerId: string) => Promise<(sandboxId: string) => Promise<void>> };
      t.mock.method(runtime, "prepareKill", async (ownerId: string) => async (sandboxId: string) => { await threadMachineProvider.kill(sandboxId, ownerId); });
    }

    const owner = "owner", workspaceId = randomUUID(), botId = randomUUID(), botDevice = randomUUID(), agentId = randomUUID(), repoId = randomUUID();
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Fixture','thr-stop@example.invalid',true,now(),now())`, [owner]);
    await seedFixtureWorkspace(pool, owner, 'team', workspaceId);
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
        connect: async (id) => { calls.push(`connect:${id}`); return { sandboxId: id } as never; },
        create: async (template, op) => { assert.equal(template, "desktop"); calls.push("create"); await onCreate(); return { sandboxId: `sandbox-${op}` } as never; },
        kill: async (id) => { calls.push(`kill:${id}`); },
      };
      return { calls, provider };
    };
    const state = async (runId: string) => ({
      run: (await pool.query('SELECT status,"stopRequestedAt" IS NOT NULL AS stop,"finishedAt" IS NOT NULL AS finished FROM agent_runs WHERE id=$1', [runId])).rows[0],
      machine: (await pool.query('SELECT state,"sandboxId","workerLeaseId","deviceId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0],
      tokens: (await pool.query('SELECT count(*)::int AS n FROM device_tokens t JOIN thread_machines m ON m."deviceId"=t."boundDeviceId" WHERE m."runId"=$1', [runId])).rows[0].n,
    });

    const retainedUnclaimedRun = async () => {
      const runId = await queuedRun();
      const deviceId = randomUUID(), machineRepoId = randomUUID();
      await pool.query(`INSERT INTO devices (id,"ownerId",name,kind) VALUES ($1,$2,'unclaimed task','cloud')`, [deviceId, owner]);
      await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,'/fixture/task')`, [machineRepoId, deviceId, owner]);
      await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3 WHERE id=$1`, [runId, deviceId, machineRepoId]);
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","sandboxId","snapshotId","operationId",state,"deviceId","repoId")
        VALUES ($1,$2,$3,$4,$5,'snapshot-fixture',$6,'error',$7,$8)`, [runId, workspaceId, owner, botId, `sandbox-stop-${runId}`, randomUUID(), deviceId, machineRepoId]);
      return runId;
    };

    await t.test("normal Owner Stop acknowledges an unclaimed bound run even when startup never created a lifecycle", async (t) => {
      const runId = await retainedUnclaimedRun();
      const kills: string[] = [];
      t.mock.method(threadMachineProvider, "kill", async (sandboxId: string, userId: string) => {
        assert.equal(userId, owner); kills.push(sandboxId);
      });
      const { requestRunStop } = await import("../agent-runs");
      assert.deepEqual(await requestRunStop(owner, runId), { stoppedRunIds: [runId] });
      const current = await state(runId);
      assert.deepEqual(current.run, { status: "stopped", stop: true, finished: true });
      assert.equal(current.machine.state, "ended");
      assert.deepEqual(kills, [`sandbox-stop-${runId}`]);
    });

    await t.test("the existing maintenance pass acknowledges a host stop on an unclaimed bound run", async (t) => {
      const runId = await retainedUnclaimedRun();
      assert.equal(await stopOwnedRun(db.db, owner, runId), false);
      const kills: string[] = [];
      t.mock.method(threadMachineProvider, "kill", async (sandboxId: string) => { kills.push(sandboxId); });
      const { maintainThreadMachine } = await import("../../workflows/thread-machine/steps");
      assert.equal(await maintainThreadMachine(actor, runId), false);
      assert.deepEqual((await state(runId)).run, { status: "stopped", stop: true, finished: true });
      assert.deepEqual(kills, [`sandbox-stop-${runId}`]);
    });

    await t.test("a frozen Profile and ordinary retry lineage do not count as an actual native claim", async (t) => {
      const runId = await retainedUnclaimedRun(), source = await queuedRun();
      const deviceId = (await state(runId)).machine.deviceId;
      await pool.query(`UPDATE agent_runs SET status='failed',"deviceId"=$2,"finishedAt"=now() WHERE id=$1`, [source, deviceId]);
      const { executionIdentitySchema } = await import("../execution-identity");
      const { parseAgentProfile, agentProfileDigest } = await import("../factory/agent-profile-definition");
      const connectionId = randomUUID(), bindingId = randomUUID();
      const targetEntry = { harness: "codex", model: "gpt-6-luna", source: { kind: "subscription", connectionId } };
      const profile = parseAgentProfile({ name: "Fixture executor", roles: ["frontend"], harness: "codex", model: { mode: "fixed", ...targetEntry }, instructions: "Fixture task" });
      const definition = { harness: "codex", model: "gpt-6-luna", subscription: { bindingId, route: "codex_cli", modelId: "gpt-6-luna" },
        agentProfile: { profileId: randomUUID(), name: profile.name, version: 1, digest: agentProfileDigest(profile, []), source: "decision", reason: "capability_fit",
          scope: { ownerId: owner, workspaceId }, definition: profile, skills: [], instructions: profile.instructions, targetEntry },
        executionIdentity: executionIdentitySchema.parse({ version: 1, requester: owner, botId, botOwner: owner, executionPrincipal: owner, workspaceId, outputOwner: owner,
          resourceBindings: [{ kind: "device", id: deviceId, ownerId: owner, access: "owner" }, { kind: "subscription", id: bindingId, ownerId: owner, access: "owner" }],
          billingAccount: { model: { kind: "subscription", ownerId: owner, resourceId: bindingId, amount: "provider_unknown" }, runtime: { kind: "e2b", ownerId: owner, resourceId: owner, amount: "provider_unknown" } }, personalResourcePolicy: "requester_only" }) };
      await pool.query(`UPDATE agent_runs SET "retryOf"=$2,"agentDefinition"=$3::jsonb WHERE id=$1`, [runId, source, JSON.stringify(definition)]);
      const kills: string[] = [];
      t.mock.method(threadMachineProvider, "kill", async (id: string) => { kills.push(id); });
      const { requestRunStop } = await import("../agent-runs");
      await requestRunStop(owner, runId);
      assert.equal((await state(runId)).run.status, "stopped");
      assert.deepEqual((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [runId])).rows[0].agentDefinition, definition);
      assert.deepEqual(kills, [`sandbox-stop-${runId}`]);
    });

    await t.test("an uncertain provider kill preserves the queued binding for the same normal Stop to retry", async (t) => {
      const runId = await retainedUnclaimedRun();
      const before = (await state(runId)).machine;
      const refusal = new Error("Fixture provider unavailable");
      const kill = t.mock.method(threadMachineProvider, "kill", async () => { throw refusal; });
      const { requestRunStop } = await import("../agent-runs");
      await assert.rejects(requestRunStop(owner, runId), (error) => error === refusal);
      const failed = await state(runId);
      assert.deepEqual(failed.run, { status: "queued", stop: true, finished: false });
      assert.deepEqual(failed.machine, before);
      const requestedAt = (await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0].stopRequestedAt;
      assert.equal((await pool.query('SELECT "removedAt" FROM devices WHERE id=$1', [before.deviceId])).rows[0].removedAt, null);
      kill.mock.mockImplementation(async () => {});
      assert.deepEqual(await requestRunStop(owner, runId), { stoppedRunIds: [runId] });
      assert.deepEqual((await state(runId)).run, { status: "stopped", stop: true, finished: true });
      assert.deepEqual((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0].stopRequestedAt, requestedAt);
      assert.ok((await pool.query('SELECT "removedAt" FROM devices WHERE id=$1', [before.deviceId])).rows[0].removedAt);
      assert.equal(kill.mock.callCount(), 2);
    });

    for (const [name, update] of [
      ["no stop requested", ""],
      ["already started", '"startedAt"=now()'],
      ["native session", '"sessionId"=\'fixture-native-session\''],
      ["claim token", '"deviceTokenId"=gen_random_uuid()'],
      ["claim lease", '"leaseExpiresAt"=now()+interval \'90 seconds\''],
      ["running run", "status='running'"],
      ["paused run", "status='paused',\"pauseReason\"='human_control'"],
      ["question continuation", '"questionContinuation"=\'{"requireSessionResume":true,"originSessionId":"fixture-origin-session"}\'::jsonb'],
    ] as const) await t.test(`host acknowledgement preserves ${name}`, async () => {
      const runId = await retainedUnclaimedRun();
      if (update) await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=now(),${update} WHERE id=$1`, [runId]);
      const before = await state(runId);
      const { calls, provider } = fake();
      assert.equal(await acknowledgeQueuedThreadStop(pool, actor, runId, provider), false);
      assert.deepEqual(await state(runId), before);
      assert.deepEqual(calls, []);
    });

    await t.test("host acknowledgement preserves foreign ownership/workspace and an in-flight provision", async () => {
      const runId = await retainedUnclaimedRun();
      await stopOwnedRun(db.db, owner, runId);
      const before = await state(runId), { calls, provider } = fake();
      assert.equal(await acknowledgeQueuedThreadStop(pool, { ...actor, userId: "peer" }, runId, provider), false);
      assert.equal(await acknowledgeQueuedThreadStop(pool, { ...actor, workspaceId: randomUUID() }, runId, provider), false);
      assert.deepEqual(await state(runId), before);
      await pool.query('UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval \'2 minutes\' WHERE "runId"=$1', [runId, randomUUID()]);
      const provision = await state(runId);
      assert.equal(await acknowledgeQueuedThreadStop(pool, actor, runId, provider), false);
      assert.deepEqual(await state(runId), provision);
      assert.deepEqual(calls, []);
      await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), /Task runtime is busy/);
      assert.deepEqual(await state(runId), provision, 'a queued wake cannot end another bootstrap lease');
      assert.deepEqual(calls, []);
    });

    await t.test("a recorded native claim is preserved even with queued status and no reported SID", async () => {
      const runId = await retainedUnclaimedRun(), connectionId = randomUUID(), bindingId = randomUUID();
      await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider) VALUES($1,$2,$3,'codex')`, [connectionId, owner, workspaceId]);
      await pool.query(`INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,$2,$3,$4,$5,1,'codex_cli','gpt-6-luna')`, [bindingId, owner, workspaceId, agentId, connectionId]);
      await pool.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES($1,$2)', [runId, bindingId]);
      await stopOwnedRun(db.db, owner, runId);
      const before = await state(runId), { calls, provider } = fake();
      assert.equal(await acknowledgeQueuedThreadStop(pool, actor, runId, provider), false);
      assert.deepEqual(await state(runId), before);
      assert.deepEqual(calls, []);
      await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), /Task runtime is busy/);
      assert.deepEqual(await state(runId), before, 'a recorded native claim also fences a queued wake');
      assert.deepEqual(calls, []);
    });

    for (const field of ["retryOf", "continuesRunId"] as const) await t.test(`${field} retains existing native history on the same machine`, async () => {
      const runId = await retainedUnclaimedRun(), source = await queuedRun();
      const deviceId = (await state(runId)).machine.deviceId;
      await pool.query(`UPDATE agent_runs SET status='failed',"deviceId"=$2,"sessionId"='fixture-source-session',"finishedAt"=now() WHERE id=$1`, [source, deviceId]);
      await pool.query(`UPDATE agent_runs SET "${field}"=$2,"stopRequestedAt"=now() WHERE id=$1`, [runId, source]);
      const before = await state(runId), { calls, provider } = fake();
      assert.equal(await acknowledgeQueuedThreadStop(pool, actor, runId, provider), false);
      assert.deepEqual(await state(runId), before);
      assert.deepEqual(calls, []);
    });

    await t.test("an adopted task machine preserves native history without a retry or continuation link", async () => {
      const runId = await retainedUnclaimedRun(), source = await queuedRun(), issueId = randomUUID();
      const machine = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];
      await pool.query(`INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,$2,$3,'Adopted task fixture','{"type":"doc","content":[]}'::jsonb,'todo','normal')`, [issueId, owner, workspaceId]);
      await pool.query(`UPDATE agent_runs SET "issueId"=$2 WHERE id=$1`, [runId, issueId]);
      await pool.query(`UPDATE thread_machines SET "issueId"=$2 WHERE "runId"=$1`, [runId, issueId]);
      await pool.query(`UPDATE agent_runs SET "issueId"=$2,"deviceId"=$3,"deviceRepoId"=$4,status='succeeded',"sessionId"='fixture-adopted-session',"startedAt"=now(),"finishedAt"=now() WHERE id=$1`, [source, issueId, machine.deviceId, machine.repoId]);
      // adoptTaskMachine transfers the sandbox/device to the new row and ends
      // the old row without linking the new run through retryOf/continuesRunId.
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","sandboxId","snapshotId","operationId",state,"deviceId","repoId","endedAt")
        VALUES ($1,$2,$3,$4,$5,NULL,'snapshot-fixture',$6,'ended',$7,$8,now())`, [source, workspaceId, owner, botId, issueId, randomUUID(), machine.deviceId, machine.repoId]);
      assert.deepEqual((await pool.query('SELECT "retryOf","continuesRunId" FROM agent_runs WHERE id=$1', [runId])).rows[0], { retryOf: null, continuesRunId: null });
      await stopOwnedRun(db.db, owner, runId);
      const before = await state(runId), { calls, provider } = fake();
      assert.equal(await acknowledgeQueuedThreadStop(pool, actor, runId, provider), false);
      assert.deepEqual(await state(runId), before);
      assert.deepEqual(calls, []);
      await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), /Task runtime is busy/);
      assert.deepEqual(await state(runId), before, 'a queued wake shares the explicit Stop native-history fence');
      assert.deepEqual(calls, []);
    });

    await t.test("provider preparation uses a one-connection pool before the locked acknowledgement", { timeout: 10_000 }, async () => {
      const runId = await retainedUnclaimedRun();
      await stopOwnedRun(db.db, owner, runId);
      const one = new Pool({ connectionString: target.toString(), max: 1, connectionTimeoutMillis: 200 });
      const calls: string[] = [];
      const provider = {
        // The old path reads provider credentials only after checking out the
        // sole client, reproducing a real pool checkout timeout.
        kill: async () => { await one.query('SELECT 1'); },
        prepareKill: async (ownerId: string) => {
          assert.equal((await one.query('SELECT $1::text AS owner', [ownerId])).rows[0].owner, owner);
          calls.push("prepared");
          return async (sandboxId: string) => { calls.push(`kill:${sandboxId}`); };
        },
      };
      try {
        assert.equal(await acknowledgeQueuedThreadStop(one, actor, runId, provider), true);
        assert.deepEqual((await state(runId)).run, { status: "stopped", stop: true, finished: true });
        assert.deepEqual(calls, ["prepared", `kill:sandbox-stop-${runId}`]);
      } finally { await one.end(); }
    });

    await t.test("provider preparation cannot authorize a binding changed before the final lock", async () => {
      const runId = await retainedUnclaimedRun();
      await stopOwnedRun(db.db, owner, runId);
      let prepared = false, killed = false;
      const provider = {
        kill: async () => { killed = true; },
        prepareKill: async () => {
          prepared = true;
          await pool.query('UPDATE thread_machines SET "workspaceId"=$2 WHERE "runId"=$1', [runId, randomUUID()]);
          return async () => { killed = true; };
        },
      };
      assert.equal(await acknowledgeQueuedThreadStop(pool, actor, runId, provider), false);
      assert.equal(prepared, true);
      assert.equal(killed, false);
      assert.deepEqual((await state(runId)).run, { status: "queued", stop: true, finished: false });
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
      assert.deepEqual(calls, ["create", `kill:sandbox-${created}`]);
      const s = await state(runId);
      assert.deepEqual(s.run, { status: "stopped", stop: true, finished: true });
      assert.equal(s.machine.state, "ended");
      assert.equal(s.machine.workerLeaseId, null);
      assert.equal(s.machine.deviceId, null, "no worker device was registered");
      assert.equal(s.tokens, 0, "no worker token was issued");
      const interval = (await pool.query('SELECT reason,"endedAt" FROM thread_machine_sessions WHERE "runId"=$1', [runId])).rows[0];
      assert.equal(interval.reason, "retired");
      assert.ok(interval.endedAt, "the successful kill closes the session before the next reconciliation");
    });

    for (const killFails of [false, true]) await t.test(`a create that arrives after cancellation records only confirmed kill completion (${killFails ? 'failed' : 'acknowledged'})`, async () => {
      const runId = await queuedRun();
      const { calls, provider } = fake(async () => {
        await pool.query(`UPDATE agent_runs SET status='stopped',"stopRequestedAt"=now(),"finishedAt"=now() WHERE id=$1`, [runId]);
        await pool.query(`UPDATE thread_machines SET state='ended',"endedAt"=now(),"workerLeaseId"=NULL,"workerLeaseUntil"=now() WHERE "runId"=$1`, [runId]);
      });
      const kill = provider.kill;
      provider.kill = async (sandbox, userId) => {
        await kill(sandbox,userId);
        if (killFails) throw new Error('Synthetic kill unacknowledged');
      };
      if (killFails) await assert.rejects(ensureThreadMachine(pool,actor,runId,provider), /Synthetic kill unacknowledged/);
      else await assert.rejects(ensureThreadMachine(pool,actor,runId,provider), { status:409, message:'Thread provisioning cancelled' });
      assert.equal(calls.filter(call => call.startsWith('kill:')).length,1);
      const intervals = (await pool.query('SELECT source,reason,"endedAt" FROM thread_machine_sessions WHERE "runId"=$1', [runId])).rows;
      assert.equal(intervals.length,1);
      assert.equal(intervals[0].source,'observed');
      assert.equal(intervals[0].reason,killFails ? null : 'retired');
      assert.equal(intervals[0].endedAt === null,killFails);
      const machine = (await state(runId)).machine;
      assert.equal(machine.state,'ended');
      assert.ok(machine.sandboxId,'the original cleanup owner and retryable custody row are retained');
    });

    await t.test("a paused thread whose sandbox is gone gets a new sandbox for the same thread", async () => {
      const runId = await queuedRun();
      const oldOperation = randomUUID();
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","sandboxId","snapshotId","operationId",state) VALUES ($1,$2,$3,$4,'sandbox-gone','snapshot-fixture',$5,'paused')`, [runId, workspaceId, owner, botId, oldOperation]);
      const { calls, provider } = fake();
      const { SandboxNotFoundError } = await import("e2b");
      provider.connect = async (id) => { calls.push(`connect:${id}`); throw new SandboxNotFoundError("gone"); };
      await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), (e: Error) => !(e instanceof SandboxNotFoundError), "it goes on past the lost sandbox");
      assert.deepEqual(calls.slice(0, 2), ["connect:sandbox-gone", "create"], "a lost historical snapshot is replaced by the official template");
      const machine = (await pool.query('SELECT "sandboxId","operationId","snapshotId" FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];
      assert.notEqual(machine.operationId, oldOperation, "a new operation, so E2B creates a new sandbox");
      assert.equal(machine.sandboxId, `sandbox-${machine.operationId}`);
      assert.equal(machine.snapshotId, "desktop");
      assert.equal((await state(runId)).run.status, "queued");
    });

    await t.test("control: without a stop, provisioning passes both checks (and fails later on the fake sandbox)", async () => {
      const runId = await queuedRun();
      const { calls, provider } = fake();
      await assert.rejects(ensureThreadMachine(pool, actor, runId, provider), (e: Error) => e.message !== "Thread stopped");
      assert.deepEqual(calls, ["create"], "new threads start from the official template without snapshotting parent files");
      assert.ok(!calls.some((c) => c.startsWith("kill:")));
      assert.equal((await state(runId)).run.status, "queued");
    });
  } finally {
    await appPool?.end();
    if (saved.m === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = saved.m;
    if (saved.d === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.d;
    await dropTestDatabase(admin, database, pool);
    await admin.end();
  }
});
