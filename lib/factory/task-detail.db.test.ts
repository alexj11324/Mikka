import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { orderMigrations } from '../../scripts/migration-order.mjs';
import { createFactoryStore } from './store';

const base = process.env.E2E_DATABASE_URL;
const required = process.env.REQUIRE_DB === '1' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
if (required) assert.ok(base, 'E2E_DATABASE_URL is required');
function guarded(url: string) {
  const u = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), 'loopback only');
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/);
  return u;
}

test('task detail GET exposes criteria, independence and the B11 header without writing', { skip: !base, timeout: 120_000 }, async () => {
  const admin = guarded(base!);
  const name = `fac_x_${randomUUID().replaceAll('-', '')}_e2e`;
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 });
  await adminPool.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  const target = new URL(admin.toString()); target.pathname = `/${name}`; guarded(target.toString());
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  try {
    const dir = new URL('../../drizzle/', import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter(f => f.endsWith('.sql')))) await pool.query(await readFile(new URL(f, dir), 'utf8'));
    const [deviceId, agentId, issueId, taskId, implAttempt, reviewAttempt, verifyAttempt, implRun, reviewRun, candidateId, approvalId] = Array.from({ length: 11 }, () => randomUUID());
    const sha = 'b'.repeat(40);
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','O','o@example.invalid',true,now(),now()),('other','X','x@example.invalid',true,now(),now())`);
    await pool.query(`INSERT INTO devices (id,"ownerId",name,harnesses,"lastSeenAt") VALUES ($1,'owner','Mac','[]',now())`, [deviceId]);
    await pool.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,'owner','Coder','codex')`, [agentId]);
    await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{}','todo','normal')`, [issueId]);
    const sourceEventId = randomUUID();
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId]);
    const report = { criteria: [
      { criterionId: randomUUID(), text: 'Button renders', passed: true, evidence: 'ran it; token=abc123 seen' },
      { text: 'Mixed case Authorization: Bearer xyz', passed: false },
      { passed: 'yes' },
    ], verify: { status: 'passed', command: 'pnpm test', exitCode: 0, timedOut: false, signal: null } };
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,kind,prompt,report) VALUES ($1,'owner',$3,$4,$5,'succeeded','implement','p',NULL),($2,'owner',$3,$4,$5,'succeeded','review','p',$6)`, [implRun, reviewRun, agentId, deviceId, issueId, JSON.stringify(report)]);
    await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES ($1,'owner',$2,'https://github.com/o/r','o/r','published','{"url":"https://github.com/o/r/pull/7","state":"open"}')`, [implRun, issueId]);
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query(`INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason) VALUES ($1,'owner',$2,$3,'{}','verify','running',$4,'fixture')`, [taskId, issueId, sourceEventId, verifyAttempt]);
    await c.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason) VALUES ($1,$4,'execute',1,1,'passed',$5,'x'),($2,$4,'review',1,2,'passed',$6,'x'),($3,$4,'verify',1,3,'running',NULL,'x')`, [implAttempt, reviewAttempt, verifyAttempt, taskId, implRun, reviewRun]);
    await c.query(`INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,'o/r','device:x','repo',$4)`, [candidateId, taskId, sha, implRun]);
    await c.query(`UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1`, [taskId, candidateId]);
    await c.query('COMMIT'); c.release();

    const calls: string[] = [];
    const store = createFactoryStore(pool, async () => true, null, { independent: async (_tx, _task, runId) => { calls.push(runId); return true; } });
    const tables = ['factory_tasks', 'factory_attempts', 'factory_candidates', 'factory_events', 'factory_publications', 'agent_runs', 'run_publications', 'coordinator_events'];
    const snapshot = async () => Promise.all(tables.map(async t => (await pool.query(`SELECT * FROM ${t} ORDER BY 1`)).rows));
    const before = await snapshot();
    const detail = await store.read('owner', taskId);
    assert.deepEqual(await snapshot(), before, 'GET wrote nothing');
    assert.deepEqual(calls, [reviewRun], 'independence asked only for attempts with a run');
    assert.deepEqual(detail.checks?.map(x => [x.attemptId, x.stage, x.independent]), [[reviewAttempt, 'review', true], [verifyAttempt, 'verify', null]]);
    const [review] = detail.checks!;
    assert.equal(review.criteria.length, 2, 'malformed criterion dropped');
    assert.equal(review.criteria[0].passed, true);
    assert.match(review.criteria[0].evidence!, /token=\[REDACTED\]/);
    assert.doesNotMatch(review.criteria[1].text!, /xyz/);
    assert.equal(review.criteria[1].criterionId, null);
    assert.deepEqual(review.verify, { status: 'passed', command: 'pnpm test', exitCode: 0 });
    assert.deepEqual(detail.delivery, { candidateSha: sha, pullRequest: { url: 'https://github.com/o/r/pull/7', state: 'open' }, previewUrl: null });

    await pool.query(`INSERT INTO factory_approvals (id,"taskId","candidateId","attemptId","userId","principalId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES ($1,$2,$3,$4,'owner','session:s','s',$5,'{}','{}','deploy_preview','preview','d','[]',1,$4,1,now()+interval '1 hour')`, [approvalId, taskId, candidateId, verifyAttempt, randomUUID()]);
    await pool.query(`INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status,receipt,"finishedAt") VALUES ($1,$2,$3,$4,'deploy_preview','preview',$5,'{}','succeeded',$6,now())`, [randomUUID(), approvalId, taskId, candidateId, randomUUID(), JSON.stringify({ verifiedTarget: { environment: 'preview', reference: 'https://mikka-git-x.vercel.app' } })]);
    assert.equal((await store.read('owner', taskId)).delivery?.previewUrl, 'https://mikka-git-x.vercel.app');
    // A later, unconfirmed publication must not replace the verified preview.
    const approval2 = randomUUID();
    await pool.query(`INSERT INTO factory_approvals (id,"taskId","candidateId","attemptId","userId","principalId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES ($1,$2,$3,$4,'owner','session:s','s',$5,'{}','{}','deploy_preview','preview-2','d','[]',1,$4,1,now()+interval '1 hour')`, [approval2, taskId, candidateId, verifyAttempt, randomUUID()]);
    await pool.query(`INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status,receipt,"finishedAt") VALUES ($1,$2,$3,$4,'deploy_preview','preview-2',$5,'{}','uncertain',$6,now()+interval '1 minute')`, [randomUUID(), approval2, taskId, candidateId, randomUUID(), JSON.stringify({ verifiedTarget: { environment: 'preview', reference: 'https://unverified.vercel.app' } })]);
    assert.equal((await store.read('owner', taskId)).delivery?.previewUrl, 'https://mikka-git-x.vercel.app', 'only succeeded publications count');
    await assert.rejects(store.read('other', taskId), (e: { code?: string }) => e.code === 'factoryNotFound');
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
