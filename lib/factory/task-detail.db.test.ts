import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { orderMigrations } from '../../scripts/migration-order.mjs';
import { createFactoryStore } from './store';
import { factoryCriteria } from './task-detail';
import { refreshPublishedPullRequest } from '../github/publication-webhook';
import { dropTestDatabase } from '../../tests/support/drop-test-database';

const base = process.env.E2E_DATABASE_URL;
const required = process.env.REQUIRE_DB === '1' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
if (required) assert.ok(base, 'E2E_DATABASE_URL is required');
function guarded(url: string) {
  const u = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), 'loopback only');
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/);
  return u;
}

test('task detail GET exposes criteria and delivery without unused fields or writes', { skip: !base, timeout: 120_000 }, async () => {
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
      { criterionId: randomUUID(), text: 'Button renders', passed: true, evidence: 'ran it; token=abc123 seen', command: 'pnpm test:button token=abc123', exitCode: 0 },
      { text: 'Mixed case Authorization: Bearer xyz', passed: false },
      { passed: 'yes' },
    ], verify: { status: 'passed', command: 'pnpm test', exitCode: 0, timedOut: false, signal: null } };
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,kind,prompt,report) VALUES ($1,'owner',$3,$4,$5,'succeeded','implement','p',NULL),($2,'owner',$3,$4,$5,'succeeded','review','p',$6)`, [implRun, reviewRun, agentId, deviceId, issueId, JSON.stringify(report)]);
    await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") VALUES ($1,'owner',$2,'https://github.com/o/r','o/r','published','{"url":"https://github.com/o/r/pull/7","state":"open"}')`, [implRun, issueId]);
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query(`INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason) VALUES ($1,'owner',$2,$3,'{}','verify','running',$4,'fixture')`, [taskId, issueId, sourceEventId, verifyAttempt]);
    await c.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason) VALUES ($1,$4,'execute',1,1,'passed',$5,'x'),($2,$4,'review',1,2,'passed',$6,'x'),($3,$4,'verify',1,3,'running',NULL,'x')`, [implAttempt, reviewAttempt, verifyAttempt, taskId, implRun, reviewRun]);
    await c.query(`INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId","previewDatabaseBranch","machineName") VALUES ($1,$2,$3,'o/r','device:x','repo',$4,'preview/ac-7','Build server')`, [candidateId, taskId, sha, implRun]);
    await c.query(`UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1`, [taskId, candidateId]);
    await c.query(`UPDATE factory_attempts SET "candidateId"=$2 WHERE id=$1`, [reviewAttempt, candidateId]);
    await c.query('COMMIT'); c.release();

    const calls: string[] = [];
    const store = createFactoryStore(pool, async () => true, null, { independent: async (_tx, _task, runId) => { calls.push(runId); return true; } });
    const tables = ['factory_tasks', 'factory_attempts', 'factory_candidates', 'factory_events', 'factory_publications', 'agent_runs', 'run_publications', 'coordinator_events'];
    const snapshot = async () => Promise.all(tables.map(async t => (await pool.query(`SELECT * FROM ${t} ORDER BY 1`)).rows));
    const before = await snapshot();
    const detail = await store.read('owner', taskId);
    assert.deepEqual(await snapshot(), before, 'GET wrote nothing');
    assert.deepEqual(calls, [], 'detail reads do not recheck execution ancestry');
    assert.deepEqual(detail.checks?.map(x => [x.attemptId, x.stage]), [[reviewAttempt, 'review'], [verifyAttempt, 'verify']]);
    assert.deepEqual(detail.checks?.map(x => [x.status, x.candidateId, x.candidateSha]), [['passed', candidateId, sha], ['running', null, null]], 'each check names its candidate');
    const [review] = detail.checks!;
    assert.equal(review.criteria.length, 2, 'malformed criterion dropped');
    assert.equal(review.criteria[0].passed, true);
    assert.equal(review.criteria[0].command, 'pnpm test:button token=[REDACTED]');
    assert.equal(review.criteria[0].exitCode, 0);
    assert.equal(review.criteria[1].command, 'pnpm test');
    assert.equal(review.criteria[1].exitCode, 0);
    assert.match(review.criteria[0].evidence!, /token=\[REDACTED\]/);
    assert.doesNotMatch(review.criteria[1].text!, /xyz/);
    assert.equal(review.criteria[1].criterionId, null);
    assert.deepEqual(review.verify, { status: 'passed', command: 'pnpm test', exitCode: 0 });
    assert.deepEqual(detail.delivery, { candidateSha: sha, previewDatabaseBranch: 'preview/ac-7', machineName: 'Build server', repository: 'o/r', environment: 'device:x', pullRequest: { url: 'https://github.com/o/r/pull/7', state: 'open' }, previewUrl: null, deploymentEnvironment: null }, 'no receipt: deploymentEnvironment null');

    await refreshPublishedPullRequest('pull_request', { repository: { full_name: 'o/r' }, pull_request: { number: 7, html_url: 'https://github.com/o/r/pull/7', title: 'Updated PR title', state: 'open', draft: false, merged_at: null } }, pool);
    assert.equal((await store.read('owner', taskId)).delivery?.pullRequest?.title, 'Updated PR title');
    await refreshPublishedPullRequest('pull_request', { repository: { full_name: 'foreign/r' }, pull_request: { number: 7, html_url: 'https://github.com/o/r/pull/7', title: 'Foreign title', state: 'open', draft: false, merged_at: null } }, pool);
    assert.equal((await store.read('owner', taskId)).delivery?.pullRequest?.title, 'Updated PR title');

    await pool.query(`INSERT INTO factory_approvals (id,"taskId","candidateId","attemptId","userId","principalId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES ($1,$2,$3,$4,'owner','session:s','s',$5,'{}','{}','deploy_preview','preview','d','[]',1,$4,1,now()+interval '1 hour')`, [approvalId, taskId, candidateId, verifyAttempt, randomUUID()]);
    await pool.query(`INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status,receipt,"finishedAt") VALUES ($1,$2,$3,$4,'deploy_preview','preview',$5,'{}','succeeded',$6,now())`, [randomUUID(), approvalId, taskId, candidateId, randomUUID(), JSON.stringify({ verifiedTarget: { environment: 'preview', reference: 'https://mikka-git-x.vercel.app', provider: { name: 'vercel', environment: 'preview' } } })]);
    assert.equal((await store.read('owner', taskId)).delivery?.previewUrl, 'https://mikka-git-x.vercel.app');
    assert.equal((await store.read('owner', taskId)).delivery?.deploymentEnvironment, 'preview', 'Vercel target preview');
    // A later, unconfirmed publication must not replace the verified preview.
    const approval2 = randomUUID();
    await pool.query(`INSERT INTO factory_approvals (id,"taskId","candidateId","attemptId","userId","principalId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES ($1,$2,$3,$4,'owner','session:s','s',$5,'{}','{}','deploy_preview','preview-2','d','[]',1,$4,1,now()+interval '1 hour')`, [approval2, taskId, candidateId, verifyAttempt, randomUUID()]);
    await pool.query(`INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status,receipt,"finishedAt") VALUES ($1,$2,$3,$4,'deploy_preview','preview-2',$5,'{}','uncertain',$6,now()+interval '1 minute')`, [randomUUID(), approval2, taskId, candidateId, randomUUID(), JSON.stringify({ verifiedTarget: { environment: 'preview', reference: 'https://unverified.vercel.app' } })]);
    assert.equal((await store.read('owner', taskId)).delivery?.previewUrl, 'https://mikka-git-x.vercel.app', 'only succeeded publications count');
    // The newest succeeded preview is http: previewUrl is null, no fallback to the older https one.
    const approval3 = randomUUID();
    await pool.query(`INSERT INTO factory_approvals (id,"taskId","candidateId","attemptId","userId","principalId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES ($1,$2,$3,$4,'owner','session:s','s',$5,'{}','{}','deploy_preview','preview-3','d','[]',1,$4,1,now()+interval '1 hour')`, [approval3, taskId, candidateId, verifyAttempt, randomUUID()]);
    await pool.query(`INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status,receipt,"finishedAt") VALUES ($1,$2,$3,$4,'deploy_preview','preview-3',$5,'{}','succeeded',$6,now()+interval '2 minutes')`, [randomUUID(), approval3, taskId, candidateId, randomUUID(), JSON.stringify({ verifiedTarget: { environment: 'preview', reference: 'http://mikka-git-y.vercel.app' } })]);
    assert.equal((await store.read('owner', taskId)).delivery?.previewUrl, null, 'latest preview is http: null, no fallback');
    assert.equal((await store.read('owner', taskId)).delivery?.deploymentEnvironment, null, 'receipt without Vercel target: null');
    // deploymentEnvironment comes only from the receipt's Vercel target; unknown values map to null.
    // previewUrl and deploymentEnvironment come from the same row: the newest succeeded publication of the current candidate.
    const P = 'https://mikka-git-p.vercel.app', Q = 'https://mikka-prod.vercel.app';
    for (const [i, name, target, status, ref, want, wantUrl] of [
      [4, 'vercel', 'production', 'succeeded', Q, 'production', Q],
      [5, 'vercel', 'staging', 'succeeded', Q, null, Q],
      [6, 'netlify', 'production', 'succeeded', Q, null, Q],
      [7, 'vercel', 'production', 'uncertain', 'https://unconfirmed.vercel.app', null, Q],
      [8, 'vercel', 'preview', 'succeeded', P, 'preview', P],
      [9, 'vercel', 'production', 'succeeded', Q, 'production', Q],
    ] as const) {
      const a = randomUUID();
      await pool.query(`INSERT INTO factory_approvals (id,"taskId","candidateId","attemptId","userId","principalId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES ($1,$2,$3,$4,'owner','session:s','s',$5,'{}','{}','deploy_preview',$6,'d','[]',1,$4,1,now()+interval '1 hour')`, [a, taskId, candidateId, verifyAttempt, randomUUID(), `env-${i}`]);
      await pool.query(`INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status,receipt,"finishedAt") VALUES ($1,$2,$3,$4,'deploy_preview',$5,$6,'{}',$9,$7,now()+make_interval(mins => $8))`, [randomUUID(), a, taskId, candidateId, `env-${i}`, randomUUID(), JSON.stringify({ verifiedTarget: { environment: 'preview', reference: ref, provider: { name, environment: target } } }), i, status]);
      const { delivery } = await store.read('owner', taskId);
      assert.deepEqual([delivery?.previewUrl, delivery?.deploymentEnvironment], [wantUrl, want], `${status} ${name} target ${target}: same row, no stale preview link`);
    }
    // An older candidate's succeeded preview never leaks into the current candidate.
    const newer = randomUUID();
    await pool.query(`INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId","previewDatabaseBranch","machineName") VALUES ($1,$2,$3,'o/r','device:x','repo',$4,'preview/ac-7','Build server')`, [newer, taskId, 'c'.repeat(40), implRun]);
    await pool.query(`UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1`, [taskId, newer]);
    { const { delivery } = await store.read('owner', taskId);
      assert.deepEqual([delivery?.previewUrl, delivery?.deploymentEnvironment], [null, null], 'current candidate has no publication'); }
    await pool.query(`UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1`, [taskId, candidateId]);

    // Closed status unions: a verify.status outside VERIFY_STATUSES drops verify; an attempt status outside
    // FACTORY_STATUSES drops the row (the CHECK constraint is lifted in this throwaway DB to simulate drift).
    await pool.query(`UPDATE agent_runs SET report=jsonb_set(report,'{verify,status}','"skipped"') WHERE id=$1`, [reviewRun]);
    assert.equal((await store.read('owner', taskId)).checks?.[0].verify, null, 'unknown verify.status rejected');
    const { rows: checks } = await pool.query(`SELECT conname FROM pg_constraint WHERE conrelid='factory_attempts'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%'`);
    for (const { conname } of checks) await pool.query(`ALTER TABLE factory_attempts DROP CONSTRAINT "${conname}"`);
    await pool.query(`UPDATE factory_attempts SET status='bogus' WHERE id=$1`, [verifyAttempt]);
    assert.deepEqual((await store.read('owner', taskId)).checks?.map(x => x.attemptId), [reviewAttempt], 'unknown attempt status rejected');

    await assert.rejects(store.read('other', taskId), (e: { code?: string }) => e.code === 'factoryNotFound');
  } finally {
    await dropTestDatabase(adminPool, name, pool);
    await adminPool.end();
  }
});

test('criteria: malformed entries do not take slots; at most 200', () => {
  const ok = (i: number) => ({ text: `c${i}`, passed: true });
  const list = [...Array.from({ length: 5 }, () => ({ passed: 'no' })), ...Array.from({ length: 205 }, (_, i) => ok(i))];
  const out = factoryCriteria({ criteria: list });
  assert.equal(out.length, 200);
  assert.equal(out[0].text, 'c0');
  assert.equal(out[199].text, 'c199');
  assert.equal(factoryCriteria({ criteria: Array.from({ length: 150 }, (_, i) => ok(i)) }).length, 150);
});

test('criterion command and exit code stay paired; legacy entries use the run fallback', () => {
  const out = factoryCriteria({ verify: { status: 'passed', command: 'pnpm test:all', exitCode: 0 }, criteria: [
    { passed: true, command: 'pnpm test:one', exitCode: 3 },
    { passed: false, command: 'pnpm test:two' },
    { passed: true },
  ] });
  assert.deepEqual(out.map(c => [c.command, c.exitCode]), [['pnpm test:one', 3], ['pnpm test:two', null], ['pnpm test:all', 0]]);
});
