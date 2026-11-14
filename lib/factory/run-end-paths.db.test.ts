import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace';
// QA #449: the real cancel and thread-end paths finalize the Factory task.
// Real migrations, app pool, run-control, completion transaction and Factory
// runtime over a disposable *_e2e PG. No module mocks.
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { createTestDatabase, dropTestDatabase } from "../../tests/support/drop-test-database";

const url = process.env.E2E_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(u.hostname), "loopback only");
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/, "database name must end in _e2e");
} else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("cancel and thread end reach a terminal run, then afterRunEnded finalizes the Factory task", { skip: !url, timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `fac_runend_${randomUUID().replaceAll("-", "")}_e2e`;
  await createTestDatabase(admin, database, 'template0');
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const saved = { m: process.env.MIKKA_DATABASE_URL, d: process.env.DATABASE_URL, r: process.env.MIKKA_FACTORY_ROUTING_ENABLED, l: process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED };
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  let appPool: { end: () => Promise<void> } | null = null;
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    // The application pool binds at import: point it at this database first.
    process.env.MIKKA_DATABASE_URL = process.env.DATABASE_URL = target.toString();
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = "1";
    const db = await import("../db");
    appPool = db.pool;
    const { requestRunStop } = await import("../agent-runs");
    const { persistRunCompletion } = await import("../run-publications");
    const { ensureThreadMachine, threadMachineAction, threadMachineProvider } = await import("../cloud-computer/thread-machines");
    const { ComputerError } = await import("../computer/store");
    const { createFactoryStore } = await import("./store");
    const { createFactoryDispatch, factoryBinding } = await import("./dispatch");
    const { factoryCheckIndependent } = await import("./check-independence");
    const { startThreadMachine, failUnclaimedCloudStart } = await import("../run-leases");

    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','runend@example.invalid',true,now(),now())`);
    const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), workspaceId = await seedFixtureWorkspace(pool, 'owner', 'team');
    // Keep fixture sources out of the Coordinator's legacy null-Bot backfill.
    const cloudBotId = randomUUID();
    await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,'owner',$2,'Startup fixture')`, [cloudBotId, workspaceId]);
    await pool.query(`INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Disposable',now(),'[{"harness":"codex","installed":true}]')`, [deviceId]);
    await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture','codex',$2)`, [agentId, deviceId]);
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,'owner','/fixture/repo')`, [repoId, deviceId]);
    const authorize = async (user: string, issue: string, tx: PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1;
    const store = createFactoryStore(pool, authorize, cloudBotId, { independent: factoryCheckIndependent });
    const dispatch = createFactoryDispatch(pool, store, async (tx, userId, input, botId) => {
      const runId = randomUUID();
      await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','Fixture')`, [runId, userId, input.issueId, input.agentId, deviceId, input.deviceRepoId, botId]);
      return { runId };
    }, { configure: { execute: async () => {} }, freeze: async (tx, _task, id) => { await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id, JSON.stringify({ schemaVersion: 1, definitionDigest: "fixture", harness: "codex" })]); } });
    const runningTask = async () => {
      const issueId = randomUUID(), src = randomUUID();
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState",scope) VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal',$2,'bound','workspace')`, [issueId, workspaceId]);
      await pool.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1,'owner',$3,$4,'user_message',$2,'{"text":"synthetic"}')`, [src, src, cloudBotId, issueId]);
      const r = await store.route("owner", { issueId, sourceEventId: src, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
      assert.equal(r.task.botId, cloudBotId, "the task keeps its source Bot");
      const run = await dispatch("owner", { binding: factoryBinding(r.task), agentId, deviceRepoId: repoId });
      await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now() WHERE id=$1`, [run.runId]);
      return { taskId: r.task.id, runId: run.runId };
    };
    const task = async (id: string) => (await pool.query('SELECT stage,status FROM factory_tasks WHERE id=$1', [id])).rows[0];
    const runStatus = async (id: string) => (await pool.query('SELECT status FROM agent_runs WHERE id=$1', [id])).rows[0].status;

    await t.test("cancel: the stop request alone is not an end; the daemon's stopped write finalizes the task", async () => {
      const c = await runningTask();
      await requestRunStop("owner", c.runId);
      assert.equal(await runStatus(c.runId), "running", "stop is requested, not yet acknowledged");
      assert.deepEqual(await task(c.taskId), { stage: "execute", status: "running" });
      assert.ok(await persistRunCompletion("owner", c.runId, { stopReason: "cancelled" }));
      assert.equal(await runStatus(c.runId), "cancelled");
      assert.deepEqual(await task(c.taskId), { stage: "execute", status: "cancelled" });
      // A replayed acknowledgement does not move the task again.
      const before = (await pool.query('SELECT revision FROM factory_tasks WHERE id=$1', [c.taskId])).rows[0].revision;
      await persistRunCompletion("owner", c.runId, { stopReason: "cancelled" });
      assert.equal((await pool.query('SELECT revision FROM factory_tasks WHERE id=$1', [c.taskId])).rows[0].revision, before);
    });

    await t.test("stopping a queued run ends it as stopped and finalizes the task (no daemon ack)", async () => {
      const q = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='queued',"startedAt"=NULL WHERE id=$1`, [q.runId]);
      await requestRunStop("owner", q.runId);
      const row = (await pool.query('SELECT status,"finishedAt","stopRequestedAt" FROM agent_runs WHERE id=$1', [q.runId])).rows[0];
      assert.equal(row.status, "stopped");
      assert.ok(row.finishedAt && row.stopRequestedAt);
      assert.deepEqual(await task(q.taskId), { stage: "execute", status: "cancelled" });
      // Already terminal: a second stop is rejected and moves nothing.
      await assert.rejects(requestRunStop("owner", q.runId), /runChainEnded/); // BE-18: an ended chain is a 409, not a 404
    });

    await t.test("a queued cloud run with a thread machine binding only records the stop request", async () => {
      const b = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='queued',"startedAt"=NULL WHERE id=$1`, [b.runId]);
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","snapshotId","operationId",state) VALUES ($1,$2,'owner','pending',$3,'starting')`, [b.runId, workspaceId, randomUUID()]);
      await requestRunStop("owner", b.runId);
      const row = (await pool.query('SELECT status,"finishedAt","stopRequestedAt" FROM agent_runs WHERE id=$1', [b.runId])).rows[0];
      assert.equal(row.status, "queued", "machine-bound queued run is not ended directly");
      assert.equal(row.finishedAt, null);
      assert.ok(row.stopRequestedAt);
      assert.deepEqual(await task(b.taskId), { stage: "execute", status: "running" });
      assert.equal((await pool.query('SELECT state FROM thread_machines WHERE "runId"=$1', [b.runId])).rows[0].state, "starting");
    });

    await t.test("stop on an ended earlier attempt reaches the queued latest: stopped, and afterRunEnded runs under the latest's own runId (BE-18)", async () => {
      const q = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='queued',"startedAt"=NULL,"createdAt"=now() WHERE id=$1`, [q.runId]);
      const origin = randomUUID();
      await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId",status,prompt,"createdAt","finishedAt") SELECT $1,'owner',"issueId","agentId","deviceId",'succeeded','Origin',now()-interval '1 hour',now() FROM agent_runs WHERE id=$2`, [origin, q.runId]);
      await pool.query(`UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1`, [q.runId, JSON.stringify({ originRunId: origin })]);
      assert.deepEqual(await requestRunStop("owner", origin), { stoppedRunIds: [q.runId] });
      assert.equal(await runStatus(q.runId), "stopped");
      assert.equal(await runStatus(origin), "succeeded");
      assert.deepEqual(await task(q.taskId), { stage: "execute", status: "cancelled" });
    });

    await t.test("ending a thread machine stops a Factory run and finalizes its task", async () => {
      const m = await runningTask();
      await pool.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","snapshotId","operationId",state) VALUES ($1,$2,'owner','fixture-snapshot',$3,'paused')`, [m.runId, workspaceId, randomUUID()]);
      assert.deepEqual(await threadMachineAction(pool, { userId: "owner", workspaceId }, m.runId, "end"), { runId: m.runId, state: "ended" });
      assert.equal(await runStatus(m.runId), "stopped");
      assert.deepEqual(await task(m.taskId), { stage: "execute", status: "cancelled" });
    });

    // No parent cloud machine is provisioned: ensureThreadMachine fails
    // before provider I/O, reproducing an admitted but unclaimed startup error.
    const queuedCloudTask = async (machine = true) => {
      const f = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='queued',"startedAt"=NULL,"agentDefinition"="agentDefinition" || '{"model":"gpt-6-luna"}'::jsonb WHERE id=$1`, [f.runId]);
      await pool.query(`INSERT INTO computer_run_bindings("runId","ownerId","workspaceId","botId") VALUES($1,'owner',$2,$3)`, [f.runId, workspaceId, cloudBotId]);
      if (machine) await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","snapshotId","operationId",state) VALUES($1,$2,'owner','not-provisioned',$3,'starting')`, [f.runId, workspaceId, randomUUID()]);
      return f;
    };
    const startupState = async (runId: string) => (await pool.query('SELECT status,"stopReason","stopRequestedAt","startedAt","finishedAt","sessionId","agentDefinition","leaseExpiresAt" FROM agent_runs WHERE id=$1', [runId])).rows[0];

    await t.test('a rejected Factory failure notice rolls back its run; scoped retries then commit one failure', async () => {
      const { failFactoryCloudStage } = await import('./cloud-stage-handoff');
      const f = await queuedCloudTask(false);
      const actor = { userId: 'owner', workspaceId };
      await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [f.runId, { summary: 'Retained failure report', verify: { status: 'not_run' } }]);
      const row = () => pool.query('SELECT status,error FROM agent_runs WHERE id=$1', [f.runId]).then(r => r.rows[0]);
      const notice = () => pool.query(`SELECT payload FROM coordinator_events WHERE "runId"=$1 AND kind='run_finished'`, [f.runId]);
      const fail = (scope = actor) => failFactoryCloudStage(db.pool, scope, f.runId, 'Repository handoff could not be queued');
      await fail({ ...actor, workspaceId: randomUUID() });
      await fail({ ...actor, userId: 'another-owner' });
      assert.deepEqual(await row(), { status: 'queued', error: null });
      await pool.query(`CREATE FUNCTION reject_failure_notice() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."runId"='${f.runId}'::uuid AND NEW.kind='run_finished' THEN RAISE EXCEPTION 'fixture refused failure notice'; END IF; RETURN NEW; END $$`);
      try {
        await pool.query(`CREATE CONSTRAINT TRIGGER reject_failure_notice AFTER INSERT ON coordinator_events
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_failure_notice()`);
        await assert.rejects(fail(), error => String((error as { cause?: unknown }).cause ?? error).includes('fixture refused failure notice'));
        assert.deepEqual(await row(), { status: 'queued', error: null });
        assert.equal((await notice()).rowCount, 0);
        assert.deepEqual(await task(f.taskId), { stage: 'execute', status: 'running' });
      } finally {
        await pool.query('DROP TRIGGER IF EXISTS reject_failure_notice ON coordinator_events');
        await pool.query('DROP FUNCTION reject_failure_notice()');
      }
      await Promise.all([fail(), fail(), fail(), fail()]);
      assert.deepEqual(await row(), { status: 'failed', error: 'Repository handoff could not be queued' });
      const event = await notice();
      assert.equal(event.rowCount, 1);
      assert.equal(event.rows[0].payload.stopReason, 'device_lost');
      assert.equal(event.rows[0].payload.summary, 'Retained failure report');
      assert.equal(event.rows[0].payload.verification, 'not_run');
      assert.deepEqual(await task(f.taskId), { stage: 'execute', status: 'blocked' });
    });

    for (const machine of [true, false]) await t.test(`an unclaimed cloud startup failure is recoverable infrastructure failure, with machine=${machine}`, async () => {
      const f = await queuedCloudTask(machine), frozen = (await startupState(f.runId)).agentDefinition;
      await Promise.all([startThreadMachine({ userId: 'owner', workspaceId }, f.runId, false), startThreadMachine({ userId: 'owner', workspaceId }, f.runId, false)]);
      const failed = await startupState(f.runId);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.stopReason, 'device_lost', 'startup is not a provider/model failure');
      assert.equal(failed.stopRequestedAt, null, 'an infrastructure error must not forge a user stop');
      assert.equal(failed.startedAt, null); assert.equal(failed.sessionId, null);
      assert.ok(failed.finishedAt);
      assert.deepEqual(failed.agentDefinition, frozen, 'the selected model and credential stay frozen');
      assert.deepEqual(await task(f.taskId), { stage: 'execute', status: 'blocked' });
      if (machine) assert.equal((await pool.query('SELECT state FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0].state, 'ended');
      const events = await pool.query(`SELECT payload FROM coordinator_events WHERE "userId"='owner' AND kind='run_finished' AND "runId"=$1`, [f.runId]);
      assert.equal(events.rows.length, 1, 'one durable failure notice');
      assert.equal(events.rows[0].payload.stopReason, 'device_lost');
      await startThreadMachine({ userId: 'owner', workspaceId }, f.runId, false);
      assert.deepEqual(await startupState(f.runId), failed, 'a replay cannot rewrite the terminal failure');
      const current = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.taskId])).rows[0];
      const next = await store.apply('owner', factoryBinding(current), randomUUID(), { action: 'retry', reason: 'Owner retries the original task after startup failed.' });
      const resumed = await dispatch('owner', { binding: factoryBinding(next.task), agentId, deviceRepoId: repoId });
      assert.notEqual(resumed.runId, f.runId);
      assert.deepEqual(await task(f.taskId), { stage: 'execute', status: 'running' }, 'normal Factory retry remains available');
    });

    await t.test('a startup-error cleanup cannot overwrite a claimed run, a live lease, or another workspace', async () => {
      for (const condition of ['claimed', 'lease', 'provisioning', 'workspace', 'owner'] as const) {
        const f = await queuedCloudTask();
        if (condition === 'claimed') await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now(),"sessionId"='claimed-native-session',"leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [f.runId]);
        if (condition === 'lease') await pool.query(`UPDATE agent_runs SET "leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [f.runId]);
        if (condition === 'provisioning') await pool.query(`UPDATE thread_machines SET "workerLeaseUntil"=now()+interval '1 minute' WHERE "runId"=$1`, [f.runId]);
        const before = await startupState(f.runId);
        await startThreadMachine({ userId: condition === 'owner' ? 'another-owner' : 'owner', workspaceId: condition === 'workspace' ? randomUUID() : workspaceId }, f.runId, false);
        assert.deepEqual(await startupState(f.runId), before, condition);
        assert.equal((await pool.query('SELECT state FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0].state, 'starting', 'the winner owns its machine cleanup');
        assert.deepEqual(await task(f.taskId), { stage: 'execute', status: 'running' });
      }
    });

    await t.test('a real Owner stop stays cancelled when a late cloud-start failure arrives', async () => {
      const f = await queuedCloudTask();
      await threadMachineAction(pool, { userId: 'owner', workspaceId }, f.runId, 'end');
      const stopped = await startupState(f.runId);
      assert.equal(stopped.status, 'stopped'); assert.ok(stopped.stopRequestedAt);
      await startThreadMachine({ userId: 'owner', workspaceId }, f.runId, false);
      assert.deepEqual(await startupState(f.runId), stopped);
      assert.deepEqual(await task(f.taskId), { stage: 'execute', status: 'cancelled' });
    });

    // Exercise the real provisioning transaction too: a provider rejection
    // happens after the host has committed its own 15-minute machine lease.
    // The provider is the only substituted boundary; no model call is made.
    const cloudDevice = randomUUID();
    await pool.query(`INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,'owner','Startup provider fixture','cloud')`, [cloudDevice]);
    await pool.query(`INSERT INTO cloud_machines("workspaceId","ownerId","sandboxId","operationId",state,"deviceId","runtimeReady") VALUES($1,'owner','fixture-parent-sandbox',$2,'running',$3,true)`, [workspaceId, randomUUID(), cloudDevice]);
    const machineState = async (runId: string) => (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];
    const rejectedProvision = async () => {
      const f = await queuedCloudTask();
      const error = Object.freeze(new ComputerError(503, 'Fixture provider refused startup'));
      let calls = 0;
      const provider: typeof threadMachineProvider = {
        connect: async () => assert.fail('no sandbox has been recorded'),
        create: async () => { calls++; throw error; },
        kill: async () => assert.fail('an unknown create response has no sandbox to kill'),
      };
      await assert.rejects(ensureThreadMachine(pool, { userId: 'owner', workspaceId }, f.runId, provider), caught => caught === error);
      assert.equal(calls, 1);
      const machine = await machineState(f.runId);
      assert.ok(machine.workerLeaseId && machine.workerLeaseUntil > new Date(), 'the failed provision still owns its committed lease');
      return { ...f, error, machine };
    };

    await t.test('a real provider-start failure can settle only its own committed provisioning lease', async () => {
      const f = await rejectedProvision(), before = await startupState(f.runId);
      assert.equal(await failUnclaimedCloudStart({ userId: 'owner', workspaceId }, f.runId, new ComputerError(503, f.error.message)), false,
        'copying the public error fields does not authorize cleanup of an active lease');
      assert.deepEqual(await startupState(f.runId), before);
      const another = await queuedCloudTask();
      const anotherBefore = await startupState(another.runId);
      assert.equal(await failUnclaimedCloudStart({ userId: 'owner', workspaceId }, another.runId, f.error), false,
        'the exact failure cannot authorize a different unclaimed run');
      assert.deepEqual(await startupState(another.runId), anotherBefore);
      assert.equal(await failUnclaimedCloudStart({ userId: 'owner', workspaceId }, f.runId, f.error), true);
      const failed = await startupState(f.runId), machine = await machineState(f.runId);
      assert.equal(failed.status, 'failed'); assert.equal(failed.stopReason, 'device_lost');
      assert.equal(failed.stopRequestedAt, null); assert.equal(failed.startedAt, null); assert.equal(failed.sessionId, null);
      assert.deepEqual(failed.agentDefinition, before.agentDefinition);
      assert.deepEqual(await task(f.taskId), { stage: 'execute', status: 'blocked' });
      assert.equal(machine.state, 'ended'); assert.equal(machine.workerLeaseId, null);
      assert.deepEqual(machine.workerLeaseUntil, f.machine.workerLeaseUntil,
        'unknown provider acknowledgement keeps the existing creation-cleanup deadline');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE "runId"=$1 AND kind='run_finished'`, [f.runId])).rows[0].n, 1);
      assert.equal(await failUnclaimedCloudStart({ userId: 'owner', workspaceId }, f.runId, f.error), false);
      assert.deepEqual(await startupState(f.runId), failed);
    });

    await t.test('a captured startup failure cannot overtake a replaced lease, successful provisioning, claim or Owner stop', async () => {
      for (const winner of ['new-lease', 'released-lease', 'claimed', 'stop'] as const) {
        const f = await rejectedProvision();
        if (winner === 'new-lease') await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '15 minutes' WHERE "runId"=$1`, [f.runId, randomUUID()]);
        if (winner === 'released-lease') await pool.query(`UPDATE thread_machines SET state='running',"workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "runId"=$1`, [f.runId]);
        if (winner === 'claimed') await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now(),"sessionId"='new-worker-session',"leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [f.runId]);
        if (winner === 'stop') await requestRunStop('owner', f.runId);
        const before = await startupState(f.runId), machine = await machineState(f.runId), currentTask = await task(f.taskId);
        assert.equal(await failUnclaimedCloudStart({ userId: 'owner', workspaceId }, f.runId, f.error), false, winner);
        assert.deepEqual(await startupState(f.runId), before, winner);
        assert.deepEqual(await machineState(f.runId), machine, winner);
        assert.deepEqual(await task(f.taskId), currentTask, winner);
      }
    });
  } finally {
    for (const [k, v] of [["MIKKA_DATABASE_URL", saved.m], ["DATABASE_URL", saved.d], ["MIKKA_FACTORY_ROUTING_ENABLED", saved.r], ["MIKKA_FACTORY_LIFECYCLE_ENABLED", saved.l]] as const)
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await appPool?.end();
    // Loaded transitively by the run-stop path; it binds to the same database.
    await (globalThis as { workspacePool?: { end: () => Promise<void> } }).workspacePool?.end();
    await dropTestDatabase(admin, database, pool);
    await admin.end();
  }
});
