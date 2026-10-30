import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { orderMigrations } from '../../scripts/migration-order.mjs';
import { createFactoryStore } from './store';
import { createFactoryApprovals, deferPublication, markPublicationSucceeded, reservePublication } from './approval';
import { handleFactoryApproval } from './approval-http';
import { PublicationDeferred } from './publication-operation';
import { FactoryError } from './approval-contract';

const base = process.env.E2E_DATABASE_URL;
const required = process.env.REQUIRE_DB === '1' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
if (required) assert.ok(base, 'E2E_DATABASE_URL is required');
function guarded(url: string) {
  const u = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname), 'loopback only');
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/);
  return u;
}

test('B2/B4 migrations: failed publications are terminal and a superseded candidate invalidates its approvals', { skip: !base, timeout: 120_000 }, async () => {
  const admin = guarded(base!);
  const name = `fac_x_${randomUUID().replaceAll('-', '')}_e2e`;
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 });
  await adminPool.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  const target = new URL(admin.toString()); target.pathname = `/${name}`; guarded(target.toString());
  const pool = new Pool({ connectionString: target.toString(), max: 4 });
  try {
    const dir = new URL('../../drizzle/', import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter(f => f.endsWith('.sql')))) await pool.query(await readFile(new URL(f, dir), 'utf8'));
    const { rows: cons } = await pool.query(`SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('factory_publications_status_v2_check','factory_publications_status_check','factory_approvals_invalidation_check') ORDER BY 1`);
    assert.deepEqual(cons, [{ conname: 'factory_approvals_invalidation_check', convalidated: true }, { conname: 'factory_publications_status_v2_check', convalidated: true }]);
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
    await c.query(`INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason) VALUES ($1,'owner',$2,$3,'{}','verify','failed',$4,'fixture')`, [taskId, issueId, sourceEventId, verifyAttempt]);
    await c.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason) VALUES ($1,$4,'execute',1,1,'passed',$5,'x'),($2,$4,'review',1,2,'passed',$6,'x'),($3,$4,'verify',1,3,'failed',NULL,'x')`, [implAttempt, reviewAttempt, verifyAttempt, taskId, implRun, reviewRun]);
    await c.query(`INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId") VALUES ($1,$2,$3,'o/r','device:x','repo',$4)`, [candidateId, taskId, sha, implRun]);
    await c.query(`UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1`, [taskId, candidateId]);
    await c.query('COMMIT'); c.release();

    const approve = async (id: string, cand: string, tgt: string) => pool.query(`INSERT INTO factory_approvals (id,"taskId","candidateId","attemptId","userId","principalId","humanSessionId","eventId",request,candidate,action,target,"evidenceDigest",evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt") VALUES ($1,$2,$3,$4,'owner','session:s','s',$5,'{}','{}','deploy_preview',$6,'d','[]',1,$4,1,now()+interval '1 hour')`, [id, taskId, cand, verifyAttempt, randomUUID(), tgt]);
    await approve(approvalId, candidateId, 'preview');
    const pub = randomUUID();
    await pool.query(`INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status) VALUES ($1,$2,$3,$4,'deploy_preview','preview',$5,'{}','failed')`, [pub, approvalId, taskId, candidateId, randomUUID()]);
    await assert.rejects(pool.query(`UPDATE factory_publications SET status='bogus' WHERE id=$1`, [pub]), /factory_publications_status_v2_check/);
    await assert.rejects(pool.query(`UPDATE factory_approvals SET "invalidatedAt"=now() WHERE id=$1`, [approvalId]), /factory_approvals_invalidation_check/, 'timestamp and reason travel together');
    await assert.rejects(pool.query(`UPDATE factory_approvals SET "invalidatedAt"=now(),"invalidationReason"='whatever' WHERE id=$1`, [approvalId]), /factory_approvals_invalidation_check/);

    const store = createFactoryStore(pool, async () => true, null, { independent: async () => true });
    const state = async () => (await pool.query(`SELECT "invalidatedAt" IS NOT NULL AS gone,"invalidationReason" FROM factory_approvals WHERE id=$1`, [approvalId])).rows[0];
    const binding = async () => { const { rows: [t] } = await pool.query(`SELECT id AS "taskId","issueId","attemptId",revision,"candidateId" FROM factory_tasks WHERE id=$1`, [taskId]); return t; };
    // retry keeps the same candidate: the approval still counts.
    await store.apply('owner', await binding(), randomUUID(), { action: 'retry', reason: 'flake' });
    assert.deepEqual(await state(), { gone: false, invalidationReason: null });
    await pool.query(`UPDATE factory_tasks SET status='failed' WHERE id=$1`, [taskId]);
    await pool.query(`UPDATE factory_attempts SET status='failed' WHERE id=(SELECT "attemptId" FROM factory_tasks WHERE id=$1)`, [taskId]);
    // repair drops the candidate: every approval of the old one is invalidated, once.
    await store.apply('owner', await binding(), randomUUID(), { action: 'repair', reason: 'fix it' });
    const first = (await pool.query(`SELECT "invalidatedAt" FROM factory_approvals WHERE id=$1`, [approvalId])).rows[0].invalidatedAt;
    assert.deepEqual(await state(), { gone: true, invalidationReason: 'candidateSuperseded' });
    await pool.query(`UPDATE factory_tasks SET status='failed' WHERE id=$1`, [taskId]);
    await pool.query(`UPDATE factory_attempts SET status='failed' WHERE id=(SELECT "attemptId" FROM factory_tasks WHERE id=$1)`, [taskId]);
    await store.apply('owner', await binding(), randomUUID(), { action: 'retry', reason: 'again' });
    assert.deepEqual((await pool.query(`SELECT "invalidatedAt" FROM factory_approvals WHERE id=$1`, [approvalId])).rows[0].invalidatedAt, first, 'first invalidation time kept');

    // BE-4 retry: the old logical UNIQUE is gone; the partial key ignores failed rows.
    const { rows: keys } = await pool.query(`SELECT c.relname, i.indisvalid, pg_get_expr(i.indpred, i.indrelid) AS pred FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='factory_publications_active_key'`);
    assert.deepEqual(keys, [{ relname: 'factory_publications_active_key', indisvalid: true, pred: "(status <> 'failed'::text)" }]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname='factory_publications_taskId_candidateId_action_target_key'`)).rows[0].n, 0);
    const [a2, a3, a4] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [a2, a3, a4]) await approve(id, candidateId, 'preview');
    const row = (approvalId: string) => ({ approvalId, taskId, candidateId, action: 'deploy_preview', target: 'preview', eventId: randomUUID(), request: {} });
    const claimed = (e: unknown) => e instanceof FactoryError && e.code === 'factoryPublicationAlreadyClaimed';
    const c1 = await pool.connect(), c2 = await pool.connect();
    try {
      await c1.query('BEGIN'); await c2.query('BEGIN');
      // Both retries pass the "no live row" check; the second blocks on the partial key.
      const won = await reservePublication(c1, row(a2));
      let settled = false;
      const lost = reservePublication(c2, row(a3)).finally(() => { settled = true; });
      lost.catch(() => {});
      await new Promise(r => setTimeout(r, 300));
      assert.equal(settled, false, 'second retry waits for the first');
      await c1.query('COMMIT');
      await assert.rejects(lost, claimed);
      await c2.query('ROLLBACK');
      const { rows: pubs } = await pool.query(`SELECT id,status FROM factory_publications WHERE "taskId"=$1 ORDER BY "createdAt"`, [taskId]);
      assert.deepEqual(pubs.map(p => p.status), ['failed', 'reserved'], 'failed row kept, exactly one retry took effect');
      assert.equal(pubs[1].id, won);
    } finally { c1.release(); c2.release(); }
    // A live (non-failed) row still blocks a fresh attempt.
    const c3 = await pool.connect();
    try { await assert.rejects(reservePublication(c3, row(a4)), claimed); } finally { c3.release(); }

    // ---- QA M3/M4/M6/M7/M8: a real failed row is terminal ----
    const snap = async (id: string) => (await pool.query(`SELECT to_jsonb(p) AS j FROM factory_publications p WHERE id=$1`, [id])).rows[0].j;
    const isDeferred = (state: string) => (e: unknown) => e instanceof PublicationDeferred && e.state === state;
    const aF = randomUUID();
    await approve(aF, candidateId, 'preview');
    const req = { binding: await binding(), eventId: randomUUID(), approvalId: aF, action: 'deploy_preview', target: 'preview', targetEnvironment: 'preview' };
    const fpub = randomUUID();
    await pool.query(`INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status,receipt) VALUES ($1,$2,$3,$4,'deploy_preview','preview',$5,$6,'failed','{"operationId":"dpl_err"}')`, [fpub, aF, taskId, candidateId, req.eventId, JSON.stringify(req)]);
    const failedRow = await snap(fpub);
    let provider = 0;
    const adapter = { action: 'deploy_preview' as const, target: 'preview', environment: 'preview',
      execute: async () => { provider++; throw new Error('provider must not be called'); },
      reconcile: async () => { provider++; throw new Error('provider must not be called'); } };
    const service = createFactoryApprovals(pool, async () => true, store, [adapter]);
    // M4: reconcile reports the terminal failure, never asks the provider, never writes.
    await assert.rejects(service.reconcile({ userId: 'owner' }, { ...req, publicationId: fpub }), isDeferred('failed'));
    assert.equal(provider, 0, 'reconcile of a failed row does not call the provider');
    assert.deepEqual(await snap(fpub), failedRow, 'reconcile leaves the failed row unchanged');
    // M6: the browser route answers 409 factoryPublicationFailed with no next operation.
    const http = await handleFactoryApproval({ reconcile: (_a: unknown, input: unknown) => service.reconcile({ userId: 'owner' }, input) } as any, {
      actor: { userId: 'owner', sessionId: 's' }, authorization: null, method: 'POST', taskId, origin: 'https://app.example', url: 'https://app.example/x',
      body: { operation: 'reconcile', input: { ...req, publicationId: fpub } } });
    assert.deepEqual(http, { status: 409, body: { error: 'factoryPublicationFailed', publicationId: fpub, status: 'failed', nextOperation: null } });
    assert.equal(provider, 0);
    // M3: no deferred/uncertain/generic write overwrites failed.
    for (const err of [new PublicationDeferred(fpub, 'uncertain', { x: 1 }), new PublicationDeferred(fpub, 'pending', { x: 2 }), new FactoryError('factoryVercelUnavailable'), new Error('boom')])
      await assert.rejects(deferPublication(pool, fpub, err));
    assert.deepEqual(await snap(fpub), failedRow, 'failed is never overwritten');
    // M8: failed cannot become succeeded.
    await assert.rejects(markPublicationSucceeded(pool, fpub, { operationId: 'dpl_ok' } as any), claimed);
    assert.deepEqual(await snap(fpub), failedRow, 'failed never becomes succeeded');
    // M7: a provider terminal failure on a live row is stored as failed, not uncertain.
    const live = async (target: string, status: string) => {
      const id = randomUUID(), aid = randomUUID();
      await approve(aid, candidateId, target);
      await pool.query(`INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status) VALUES ($1,$2,$3,$4,'deploy_preview',$5,$6,'{}',$7)`, [id, aid, taskId, candidateId, target, randomUUID(), status]);
      return id;
    };
    const u1 = await live('t-uncertain', 'uncertain');
    await assert.rejects(deferPublication(pool, u1, new PublicationDeferred(u1, 'failed', { operationId: 'dpl_err', readyState: 'ERROR' })), isDeferred('failed'));
    assert.equal((await snap(u1)).status, 'failed');
    assert.deepEqual((await snap(u1)).receipt, { operationId: 'dpl_err', readyState: 'ERROR' });
    const r1 = await live('t-reserved', 'reserved');
    await assert.rejects(deferPublication(pool, r1, new PublicationDeferred(r1, 'failed')), isDeferred('failed'));
    assert.equal((await snap(r1)).status, 'failed');
    const g1 = await live('t-generic', 'reserved');
    await assert.rejects(deferPublication(pool, g1, new FactoryError('factoryVercelUnavailable')), isDeferred('uncertain'));
    assert.equal((await snap(g1)).status, 'uncertain', 'control: an unknown outcome stays uncertain');
    // A live row can still succeed (control for M8).
    await markPublicationSucceeded(pool, g1, { operationId: 'dpl_ok' } as any);
    assert.equal((await snap(g1)).status, 'succeeded');

    // ---- validApproval ignores an invalidated approval ----
    await pool.query(`UPDATE factory_tasks SET stage='publish',status='passed',"candidateId"=$2 WHERE id=$1`, [taskId, candidateId]);
    const sBinding = await binding();
    const a5 = randomUUID();
    await approve(a5, sBinding.candidateId, 'preview');
    const sReq = { binding: sBinding, eventId: randomUUID(), approvalId: a5, action: 'deploy_preview', target: 'p-succeeded', targetEnvironment: 'preview' };
    const spub = randomUUID();
    await pool.query(`INSERT INTO factory_publications (id,"approvalId","taskId","candidateId",action,target,"eventId",request,status,result) VALUES ($1,$2,$3,$4,'deploy_preview','p-succeeded',$5,$6,'succeeded',$7)`, [spub, a5, taskId, sBinding.candidateId, sReq.eventId, JSON.stringify(sReq), JSON.stringify({ binding: sBinding })]);
    const approvalRows: number[] = [];
    const spyPool = { connect: async () => {
      const c = await pool.connect();
      const q = c.query.bind(c);
      (c as any).query = async (...args: any[]) => {
        const r = await (q as any)(...args);
        if (typeof args[0] === 'string' && args[0].startsWith('SELECT * FROM factory_approvals WHERE id=$1')) approvalRows.push(r.rowCount);
        return r;
      };
      return c;
    } } as unknown as Pool;
    const spied = createFactoryApprovals(spyPool, async () => true, store, [adapter]);
    await spied.reconcile({ userId: 'owner' }, { ...sReq, publicationId: spub }).catch(() => {});
    assert.ok(approvalRows.length > 0 && approvalRows.every((n) => n === 1), 'control: the live approval is found');
    approvalRows.length = 0;
    await pool.query(`UPDATE factory_approvals SET "invalidatedAt"=now(),"invalidationReason"='candidateSuperseded' WHERE id=$1`, [a5]);
    await assert.rejects(spied.reconcile({ userId: 'owner' }, { ...sReq, publicationId: spub }), (e: unknown) => e instanceof FactoryError && e.code === 'factoryApprovalInvalid');
    assert.ok(approvalRows.length > 0 && (approvalRows as number[]).every((n) => n === 0), `an invalidated approval is not selected: ${approvalRows}`);
    assert.equal(provider, 0);
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
