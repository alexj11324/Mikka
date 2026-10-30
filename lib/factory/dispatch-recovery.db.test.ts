import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { orderMigrations } from '../../scripts/migration-order.mjs';
import { createFactoryDispatchRecovery } from './dispatch-recovery';

const base = process.env.E2E_DATABASE_URL;
const required = process.env.REQUIRE_DB === '1' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
if (required) assert.ok(base, 'E2E_DATABASE_URL is required');
function guarded(url: string) {
  const u = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), 'loopback only');
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/);
  return u;
}

test('dispatch failure, status and exactly-once re-dispatch on a real database', { skip: !base, timeout: 120_000 }, async () => {
  const admin = guarded(base!);
  const name = `fac_x_${randomUUID().replaceAll('-', '')}_e2e`;
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 });
  await adminPool.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  const target = new URL(admin.toString()); target.pathname = `/${name}`; guarded(target.toString());
  const pool = new Pool({ connectionString: target.toString(), max: 8 });
  try {
    const dir = new URL('../../drizzle/', import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter(f => f.endsWith('.sql')))) await pool.query(await readFile(new URL(f, dir), 'utf8'));
    let clock = Date.now();
    const recovery = createFactoryDispatchRecovery(pool, async () => false, () => clock);
    const [deviceId, agentId, issueId, eventId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','O','o@example.invalid',true,now(),now()),('other','X','x@example.invalid',true,now(),now())`);
    await pool.query(`INSERT INTO devices (id,"ownerId",name,harnesses,"lastSeenAt") VALUES ($1,'owner','Mac','[{"harness":"codex","installed":true}]',now()-interval '10 minutes')`, [deviceId]);
    await pool.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,'owner','Coder','codex')`, [agentId]);
    await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{}','todo','normal')`, [issueId]);
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [eventId, eventId]);
    async function task(status = 'queued') {
      const [taskId, attemptId, runId] = [randomUUID(), randomUUID(), randomUUID()];
      await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,kind,prompt) VALUES ($1,'owner',$2,$3,$4,$5,'implement','p')`, [runId, agentId, deviceId, issueId, status]);
      const c = await pool.connect();
      await c.query('BEGIN');
      await c.query(`INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason) VALUES ($1,'owner',$2,$3,'{}','execute','running',$4,'fixture')`, [taskId, issueId, randomUUID(), attemptId]);
      await c.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason) VALUES ($1,$2,'execute',1,1,'running',$3,'fixture')`, [attemptId, taskId, runId]);
      await c.query('COMMIT'); c.release();
      return { taskId, runId };
    }
    const a = await task(), b = await task(), running = await task('running');

    assert.equal(await recovery.status('other', a.taskId), null, 'other owner sees nothing');
    const first = await recovery.status('owner', a.taskId);
    assert.equal(first?.failure?.reasonCode, 'deviceOffline');
    assert.equal(first?.device?.online, false);
    assert.equal(first?.clarification?.options[1].action, 'cloudKeySettings');
    await recovery.status('owner', a.taskId);
    await recovery.status('owner', b.taskId);
    assert.equal((await recovery.status('owner', running.taskId))?.failure, null, 'a claimed run is not a dispatch failure');
    const failed = await pool.query(`SELECT "runId" FROM coordinator_events WHERE kind='run_dispatch_failed'`);
    assert.equal(failed.rowCount, 2, 'one failure event per run and reason, however often status is read');

    assert.deepEqual(await recovery.deviceOnline('owner', deviceId), [], 'still offline: nothing resumes');
    await pool.query(`UPDATE devices SET "lastSeenAt"=now() WHERE id=$1`, [deviceId]);
    clock = Date.now();
    // Concurrent heartbeats: the per-device lock and dedupe key give each pending run exactly one re-dispatch.
    const results = await Promise.all(Array.from({ length: 6 }, () => recovery.deviceOnline('owner', deviceId)));
    assert.deepEqual(results.flat().sort(), [a.runId, b.runId].sort());
    assert.deepEqual(await recovery.deviceOnline('owner', deviceId), [], 'idempotent on repeat');
    assert.equal((await pool.query(`SELECT 1 FROM coordinator_events WHERE kind='run_redispatched'`)).rowCount, 2);
    assert.equal((await pool.query(`SELECT 1 FROM agent_runs WHERE status='queued'`)).rowCount, 2, 'runs stay queued once; nothing queued twice');
    assert.equal((await recovery.status('owner', a.taskId))?.device?.online, true);

    const cloud = await recovery.switchToCloud('owner', a.taskId);
    assert.deepEqual([cloud.status, cloud.body.error], [409, 'e2bKeyNotConfigured']);
    assert.equal((await recovery.switchToCloud('other', a.taskId)).status, 404);
  } finally {
    await pool.end();
    for (let i = 0; i < 100; i++) {
      const { rows: [r] } = await adminPool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [name]);
      if (r.n === 0) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await adminPool.end();
  }
});
