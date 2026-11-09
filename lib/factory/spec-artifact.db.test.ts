import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { orderMigrations } from '../../scripts/migration-order.mjs';
import { assertE2eTarget, disposableDatabase } from '../../tests/helpers/e2e-target.mjs';
import { dropTestDatabase } from '../../tests/support/drop-test-database';
import { createFactoryStore, type FactoryTask } from './store';
import { factoryBinding } from './dispatch';
import { syncFactoryPresentation } from './stage-progress';
import { parseFactorySpecArtifactRef, syncFactorySpecArtifact } from './spec-artifact';

const base = process.env.E2E_DATABASE_URL;
const required = process.env.REQUIRE_DB === '1' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
if (required) assert.ok(base && disposableDatabase(), 'isolated E2E_DATABASE_URL is required');

test('spec Artifact: real PG completion, immutable replay, concurrent writes and owner/run/issue isolation', { skip: !base, timeout: 120_000 }, async t => {
  assert.ok(disposableDatabase(), 'all configured application databases must be disposable');
  const adminUrl = assertE2eTarget(base!);
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const name = `spec_${randomUUID().replaceAll('-', '')}_e2e`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  const target = new URL(adminUrl); target.pathname = `/${name}`; assertE2eTarget(target.toString());
  const pool = new Pool({ connectionString: target.toString(), max: 5 });
  try {
    assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2), '17');
    const dir = new URL('../../drizzle/', import.meta.url);
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql'))))
      await pool.query(await readFile(new URL(file, dir), 'utf8'));
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES
      ('spec-owner','Fixture','spec-owner@example.invalid',true,now(),now()),
      ('spec-other','Other','spec-other@example.invalid',true,now(),now())`);
    const deviceId = randomUUID(), agentId = randomUUID();
    await pool.query(`INSERT INTO devices (id,"ownerId",name,harnesses) VALUES ($1,'spec-owner','Fixture device','[]')`, [deviceId]);
    await pool.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,'spec-owner','Planner','codex')`, [agentId]);
    const authorize = async (owner: string, issueId: string, tx: Pick<PoolClient, 'query'>) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issueId, owner])).rowCount === 1;
    const store = createFactoryStore(pool, authorize, null, { onTransition: syncFactoryPresentation });
    const fixture = async () => {
      const issueId = randomUUID(), sourceEventId = randomUUID(), runId = randomUUID();
      await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'spec-owner','Parser task','{}','todo','normal')`, [issueId]);
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1::uuid,'spec-owner','user_message',$1::uuid::text,'{"text":"Plan the parser change"}')`, [sourceEventId]);
      const routed = await store.route('spec-owner', { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Plan first',
        missingInformation: [], missingPermissions: [], needsSpec: true });
      const report = { summary: 'Submitted the parser plan.', filesChanged: [], verify: { status: 'not_run' },
        plan: { specId: randomUUID(), spec: { title: 'Parser plan', summary: 'Keep the existing public API.',
          sections: [{ heading: 'Implementation', items: ['Change the parser token=synthetic-secret.', 'Retain workspace isolation.'] }] } } };
      await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",kind,status,prompt,"sessionId","stopReason",report)
        VALUES ($1,'spec-owner',$2,$3,$4,'plan','running','PRIVATE_PROMPT_NOT_A_SPEC','synthetic-session','submitted',$5)`,
        [runId, agentId, deviceId, issueId, JSON.stringify(report)]);
      const bound = await store.apply('spec-owner', factoryBinding(routed.task), randomUUID(), { action: 'bind_run', runId });
      await pool.query(`UPDATE agent_runs SET status='succeeded' WHERE id=$1`, [runId]);
      return { task: bound.task, runId, issueId, report };
    };
    const finish = async (task: FactoryTask, runId: string) => store.apply('spec-owner', factoryBinding(task), randomUUID(), {
      action: 'finish', status: 'passed', reason: 'The planner submitted its specification', output: { runId, retained: 'preserved' },
      evidence: [{ artifact: `run-report:${runId}`, kind: 'report', runId, sessionId: 'synthetic-session', candidateId: null,
        sha: null, environment: `device:${deviceId}`, recordedAt: new Date().toISOString() }],
    });
    const synchronize = async (task: FactoryTask) => {
      const tx = await pool.connect();
      try { await tx.query('BEGIN'); const ref = await syncFactorySpecArtifact(tx, task); await tx.query('COMMIT'); return ref; }
      catch (error) { await tx.query('ROLLBACK'); throw error; }
      finally { tx.release(); }
    };
    const first = await fixture();
    const completed = await finish(first.task, first.runId);
    const task = completed.task;
    const output = (await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [task.attemptId])).rows[0].output;
    const ref = parseFactorySpecArtifactRef(output.specArtifact);
    assert.ok(ref, 'the normal completion hook persists the plan reference');
    assert.equal(ref.runId, first.runId);
    assert.equal(output.retained, 'preserved');
    assert.equal(output.requestEpoch, task.sourceEventId);
    const { rows: [saved] } = await pool.query(`SELECT a.*,v."inlineContent",v.sha256,v.size FROM artifacts a
      JOIN artifact_versions v ON v."artifactId"=a.id AND v.version=$2 WHERE a.id=$1`, [ref.artifactId, ref.version]);
    assert.equal(saved.userId, task.userId); assert.equal(saved.issueId, task.issueId); assert.equal(saved.runId, first.runId);
    assert.equal(saved.sha256, createHash('sha256').update(saved.inlineContent).digest('hex'));
    assert.equal(saved.size, Buffer.byteLength(saved.inlineContent));
    assert.match(saved.inlineContent, /Retain workspace isolation/);
    assert.doesNotMatch(saved.inlineContent, /synthetic-secret|PRIVATE_PROMPT_NOT_A_SPEC|synthetic-session/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE kind='artifact_submitted' AND "runId"=$1`, [first.runId])).rows[0].n, 1);

    await t.test('concurrent replays keep one immutable version and one submission event', async () => {
      const refs = await Promise.all(Array.from({ length: 8 }, () => synchronize(task)));
      refs.forEach(value => assert.deepEqual(value, ref));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM artifact_versions WHERE "artifactId"=$1', [ref.artifactId])).rows[0].n, 1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE kind='artifact_submitted' AND "runId"=$1`, [first.runId])).rows[0].n, 1);
    });

    await t.test('foreign owner, issue, attempt and mismatched session cannot write or point at another plan', async () => {
      const before = (await pool.query('SELECT count(*)::int AS n FROM artifacts')).rows[0].n;
      assert.equal(await synchronize({ ...task, userId: 'spec-other' }), null);
      assert.equal(await synchronize({ ...task, issueId: randomUUID() }), null);
      assert.equal(await synchronize({ ...task, attemptId: randomUUID() }), null);
      await pool.query('UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1', [task.attemptId, 'wrong-session']);
      try { assert.equal(await synchronize(task), null); }
      finally { await pool.query('UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1', [task.attemptId, 'synthetic-session']); }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM artifacts')).rows[0].n, before);
      await assert.rejects(store.read('spec-other', task.id), { code: 'factoryNotFound' });
    });

    await t.test('an owner edit cannot replace the version linked as the completed spec', async () => {
      await pool.query(`INSERT INTO artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName")
        VALUES ($1,$2,2,'fixture/owner-edit','# Owner annotation',$3,18,'Owner')`, [randomUUID(), ref.artifactId, 'e'.repeat(64)]);
      await pool.query('UPDATE artifacts SET "latestVersion"=2,title=$2 WHERE id=$1', [ref.artifactId, 'Owner annotation']);
      assert.deepEqual(await synchronize(task), ref);
      const edited = (await pool.query('SELECT title,"latestVersion" FROM artifacts WHERE id=$1', [ref.artifactId])).rows[0];
      assert.deepEqual(edited, { title: 'Owner annotation', latestVersion: 2 });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM artifact_versions WHERE "artifactId"=$1', [ref.artifactId])).rows[0].n, 2);
    });

    await t.test('forged output reference is replaced without modifying the referenced foreign artifact', async () => {
      const foreignId = randomUUID();
      await pool.query(`INSERT INTO artifacts (id,"userId",kind,title) VALUES ($1,'spec-other','markdown','Foreign document')`, [foreignId]);
      await pool.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{specArtifact}',$2::jsonb,true) WHERE id=$1`,
        [task.attemptId, JSON.stringify({ ...ref, artifactId: foreignId })]);
      assert.deepEqual(await synchronize(task), ref);
      assert.equal((await pool.query('SELECT title FROM artifacts WHERE id=$1', [foreignId])).rows[0].title, 'Foreign document');
    });

    await t.test('a rolled-back completion leaves no Artifact, version, event or output reference', async () => {
      const pending = await fixture();
      const tx = await pool.connect();
      let rolledBackArtifact: string | undefined;
      try {
        await tx.query('BEGIN');
        await tx.query(`UPDATE factory_attempts SET status='passed',"sessionId"='synthetic-session' WHERE id=$1`, [pending.task.attemptId]);
        const created = await syncFactorySpecArtifact(tx, { ...pending.task, status: 'passed' });
        assert.ok(created); rolledBackArtifact = created.artifactId;
        await tx.query('ROLLBACK');
      } finally { tx.release(); }
      assert.equal((await pool.query('SELECT id FROM artifacts WHERE id=$1', [rolledBackArtifact!])).rowCount, 0);
      assert.equal((await pool.query(`SELECT id FROM coordinator_events WHERE kind='artifact_submitted' AND "runId"=$1`, [pending.runId])).rowCount, 0);
      assert.equal((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [pending.task.attemptId])).rows[0].output.specArtifact, undefined);
      const committed = await finish(pending.task, pending.runId);
      const recovered = await synchronize(committed.task);
      assert.equal(recovered?.artifactId, rolledBackArtifact!, 'a retry reuses the same immutable object key');
    });
  } finally {
    await dropTestDatabase(admin, name, pool);
    await admin.end();
  }
});
