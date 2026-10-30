import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { orderMigrations } from '../../scripts/migration-order.mjs';
import { sweepFactoryMonitor } from './monitor-sweep';

const base = process.env.E2E_DATABASE_URL;
const required = process.env.REQUIRE_DB === '1' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
if (required) assert.ok(base, 'E2E_DATABASE_URL is required');
function guarded(url: string) {
  const u = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), 'loopback only');
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/);
  return u;
}

test('monitor sweep: finds unobserved monitor completions per (user, bot), is idempotent, isolates failures, honours the deadline', { skip: !base, timeout: 120_000 }, async () => {
  const admin = guarded(base!);
  const name = `fac_sweep_${randomUUID().replaceAll('-', '')}_e2e`;
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 });
  await adminPool.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  const target = new URL(admin.toString()); target.pathname = `/${name}`; guarded(target.toString());
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  try {
    const dir = new URL('../../drizzle/', import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter(f => f.endsWith('.sql')))) await pool.query(await readFile(new URL(f, dir), 'utf8'));
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','O','o@example.invalid',true,now(),now()),('other','X','x@example.invalid',true,now(),now())`);
    const botB = randomUUID();
    type Seed = { userId: string; botId: string | null; stage?: string; status?: string; finished?: boolean };
    const seed = async ({ userId, botId, stage = 'monitor', status = 'running', finished = true }: Seed) => {
      const [deviceId, agentId, issueId, taskId, attemptId, runId, candidateId, sourceEventId, eventId] = Array.from({ length: 9 }, () => randomUUID());
      await pool.query(`INSERT INTO devices (id,"ownerId",name,harnesses,"lastSeenAt") VALUES ($1,$2,'Mac','[]',now())`, [deviceId, userId]);
      await pool.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,$2,$3,'codex')`, [agentId, userId, agentId]);
      await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Fixture','{}','todo','normal')`, [issueId, userId]);
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,'{"text":"synthetic"}')`, [sourceEventId, userId, sourceEventId]);
      await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,kind,prompt) VALUES ($1,$2,$3,$4,$5,'succeeded','acceptance','p')`, [runId, userId, agentId, deviceId, issueId]);
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason,"botId") VALUES ($1,$2,$3,$4,'{}',$5,$6,$7,'fixture',$8)`, [taskId, userId, issueId, sourceEventId, stage, status, attemptId, botId]);
        await c.query(`INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,'o/r','device:x','repo',$4)`, [candidateId, taskId, 'c'.repeat(40), runId]);
        await c.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason,"candidateId") VALUES ($1,$2,$3,1,1,'running',$4,'x',$5)`, [attemptId, taskId, stage, runId, candidateId]);
        await c.query(`UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1`, [taskId, candidateId]);
        await c.query('COMMIT');
      } finally { c.release(); }
      if (finished) await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey","issueId","runId",payload) VALUES ($1,$2,'run_finished',$5,$3,$4,'{}')`, [eventId, userId, issueId, runId, eventId]);
      return { userId, taskId, candidateId, runId, eventId };
    };
    const observe = (s: { userId: string; taskId: string; candidateId: string; runId: string; eventId: string }) => pool.query(
      `INSERT INTO factory_monitor_observations (id,"userId","workspaceKey","sourceEventId","runId","sessionId","taskId","candidateId","checkKey",request,evidence,outcome) VALUES ($1,$2,'w',$3,$4,'s',$5,$6,'k','{}','[]','passed') ON CONFLICT DO NOTHING`,
      [randomUUID(), s.userId, s.eventId, s.runId, s.taskId, s.candidateId]);

    const ownerDue = await seed({ userId: 'owner', botId: null });
    const ownerDue2 = await seed({ userId: 'owner', botId: null });
    const otherDue = await seed({ userId: 'other', botId: botB });
    await observe(await seed({ userId: 'owner', botId: botB })); // already observed
    await seed({ userId: 'other', botId: null, status: 'cancelled' });
    await seed({ userId: 'other', botId: null, stage: 'verify' });
    await seed({ userId: 'owner', botId: randomUUID(), finished: false });

    const due = new Map([[`owner|null`, [ownerDue, ownerDue2]], [`other|${botB}`, [otherDue]]]);
    const calls: string[] = [];
    const monitorFor = (botId: string | null) => ({
      async reconcile(userId: string) {
        calls.push(`${userId}|${botId}`);
        const rows = due.get(`${userId}|${botId}`) ?? [];
        for (const r of rows) await observe(r); // stands in for the idempotent consume
        return { observed: rows.length };
      },
    });
    const far = () => Date.now() + 60_000;
    assert.deepEqual(await sweepFactoryMonitor(pool, monitorFor, { deadline: far() }), { enabled: true, scopes: 2, observed: 3, failed: 0, deferred: 0 });
    assert.deepEqual(calls.sort(), [`other|${botB}`, 'owner|null'], 'one reconcile per (user, bot) scope, with that bot');
    calls.length = 0;
    assert.deepEqual(await sweepFactoryMonitor(pool, monitorFor, { deadline: far() }), { enabled: true, scopes: 0, observed: 0, failed: 0, deferred: 0 }, 'second run is a no-op');
    assert.deepEqual(calls, []);

    // Failure isolation and the deadline.
    const a = await seed({ userId: 'owner', botId: null });
    await seed({ userId: 'other', botId: null });
    const errors = test.mock.method(console, 'error', () => {});
    const failing = (botId: string | null) => ({
      async reconcile(userId: string) {
        if (userId === 'owner') throw Object.assign(new Error('secret task text'), { code: 'factoryStale' });
        (calls as string[]).push(`${userId}|${botId}`);
        return { observed: 1 };
      },
    });
    assert.deepEqual(await sweepFactoryMonitor(pool, failing, { deadline: far() }), { enabled: true, scopes: 2, observed: 1, failed: 1, deferred: 0 });
    assert.deepEqual(calls, ['other|null'], 'a failing scope does not stop the next');
    assert.ok(!JSON.stringify(errors.mock.calls).includes('secret task text'));
    assert.ok(JSON.stringify(errors.mock.calls).includes('factoryStale'));
    errors.mock.restore();
    calls.length = 0;
    assert.deepEqual(await sweepFactoryMonitor(pool, monitorFor, { deadline: Date.now() - 1 }), { enabled: true, scopes: 2, observed: 0, failed: 0, deferred: 2 });
    assert.deepEqual(calls, [], 'nothing starts after the deadline');
    void a;
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
