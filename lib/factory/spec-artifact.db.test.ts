import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { orderMigrations } from '../../scripts/migration-order.mjs';
import { assertE2eTarget, disposableDatabase } from '../../tests/helpers/e2e-target.mjs';
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database';
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace';
import { bindFixtureWorkspaceDatabase } from '../../tests/helpers/workspace-database';
import { freezeWorkerDefinition } from '../agent-kit/worker';
import { executionIdentityForRun, freezeExecutionIdentity } from '../execution-identity';
import { GovernanceError } from '../governance/errors';
import { createFactoryStore, type FactoryTask } from './store';
import { factoryBinding } from './dispatch';
import { syncFactoryPresentation } from './stage-progress';
import { parseFactorySpecArtifactRef, syncFactorySpecArtifact } from './spec-artifact';
import { backfillFactorySpecArtifacts, type FactorySpecBackfillCursor } from './spec-artifact-backfill';

const base = process.env.E2E_DATABASE_URL;
const required = process.env.REQUIRE_DB === '1' || (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true');
if (required) assert.ok(base && disposableDatabase(), 'isolated E2E_DATABASE_URL is required');

test('spec Artifact: real PG completion, immutable replay, concurrent writes and owner/run/issue isolation', { skip: !base, timeout: 120_000 }, async t => {
  assert.ok(disposableDatabase(), 'all configured application databases must be disposable');
  const adminUrl = assertE2eTarget(base!);
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const name = `spec_${randomUUID().replaceAll('-', '')}_e2e`;
  await createTestDatabase(admin, name, 'template0');
  const target = new URL(adminUrl); target.pathname = `/${name}`; assertE2eTarget(target.toString());
  const pool = new Pool({ connectionString: target.toString(), max: 5 });
  const closeWorkspace = await bindFixtureWorkspaceDatabase(pool);
  try {
    assert.equal((await pool.query('SHOW server_version_num')).rows[0].server_version_num.slice(0, 2), '17');
    const dir = new URL('../../drizzle/', import.meta.url);
    for (const file of orderMigrations((await readdir(dir)).filter(file => file.endsWith('.sql'))))
      await pool.query(await readFile(new URL(file, dir), 'utf8'));
    await pool.query(`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES
      ('spec-owner','Fixture','spec-owner@example.invalid',true,now(),now()),
      ('spec-other','Other','spec-other@example.invalid',true,now(),now())`);
    const workspaceId = await seedFixtureWorkspace(pool, 'spec-owner');
    const deviceId = randomUUID(), agentId = randomUUID();
    await pool.query(`INSERT INTO devices (id,"ownerId",name,harnesses) VALUES ($1,'spec-owner','Fixture device','[]')`, [deviceId]);
    await pool.query(`INSERT INTO agents (id,"userId",name,harness) VALUES ($1,'spec-owner','Planner','codex')`, [agentId]);
    const authorize = async (owner: string, issueId: string, tx: Pick<PoolClient, 'query'>) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issueId, owner])).rowCount === 1;
    const store = createFactoryStore(pool, authorize, null, { onTransition: syncFactoryPresentation });
    const fixture = async (tenantId = workspaceId) => {
      const issueId = randomUUID(), sourceEventId = randomUUID(), runId = randomUUID();
      await pool.query(`INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,'spec-owner',$2,'Parser task','{}','todo','normal')`, [issueId, tenantId]);
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
    assert.equal(saved.workspaceId, workspaceId);
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
      assert.equal(await synchronize({ ...task, workspaceId: randomUUID() }), null);
      assert.equal(await synchronize({ ...task, workspaceId: null }), null);
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

    await t.test('explicit historical batches are bounded, quiet, resumable and reauthorize after inspection', async () => {
      const historical = async () => {
        const value = await fixture(), currentAttemptId = randomUUID();
        await pool.query(`UPDATE factory_attempts SET status='passed',"finishedAt"=now() WHERE id=$1`, [value.task.attemptId]);
        await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,reason,output)
          VALUES ($1,$2,'execute',1,2,'pending','Historical task continued',$3)`,
          [currentAttemptId, value.task.id, JSON.stringify({ requestEpoch: value.task.sourceEventId })]);
        await pool.query(`UPDATE factory_tasks SET "attemptId"=$2,stage='execute',status='pending',revision=revision+1 WHERE id=$1`,
          [value.task.id, currentAttemptId]);
        return { ...value, currentAttemptId };
      };
      const legacy = await historical(), scopeChanged = await historical(), sessionMismatch = await historical(), revoked = await historical();
      await pool.query(`UPDATE agent_runs SET report=$2 WHERE id=$1`, [legacy.runId,
        JSON.stringify({ summary: 'Keep the historical API.\nAPI_TOKEN=historical-private-fixture', filesChanged: [], verify: { status: 'not_run' } })]);
      await pool.query(`UPDATE factory_attempts SET "sessionId"='other-session' WHERE id=$1`, [sessionMismatch.task.attemptId]);
      const revokedDevice = randomUUID();
      await pool.query(`INSERT INTO devices (id,"ownerId",name,harnesses) VALUES ($1,'spec-owner','Revoked fixture','[]')`, [revokedDevice]);
      const definition = freezeWorkerDefinition({ harness: 'codex', instructions: 'Plan the change', prompt: 'Plan', parent: null, executionId: null });
      const identity = await freezeExecutionIdentity(pool, { userId: 'spec-owner', botId: null, deviceId: revokedDevice, agentDefinition: definition });
      await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"agentDefinition"=$3 WHERE id=$1`,
        [revoked.runId, revokedDevice, JSON.stringify({ ...definition, executionIdentity: identity })]);
      await pool.query(`UPDATE devices SET enabled=false WHERE id=$1`, [revokedDevice]);
      const count = async (table: 'artifacts' | 'artifact_versions' | 'coordinator_events') =>
        Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
      const before = { artifacts: await count('artifacts'), versions: await count('artifact_versions'), events: await count('coordinator_events') };
      const inspect = await backfillFactorySpecArtifacts(pool, store, 'spec-owner', { limit: 2 });
      assert.equal(inspect.mode, 'dry-run'); assert.equal(inspect.scanned, 2); assert.ok(inspect.nextCursor);
      const sum = { scanned: inspect.scanned, wouldCreate: inspect.wouldCreate, unauthorized: inspect.skipped.unauthorized,
        unavailable: inspect.skipped.sourceUnavailable };
      let cursor: FactorySpecBackfillCursor | null = inspect.nextCursor;
      while (cursor) {
        const batch = await backfillFactorySpecArtifacts(pool, store, 'spec-owner', { limit: 2, cursor });
        assert.ok(batch.scanned <= 2); assert.equal(batch.cursor.through, inspect.cursor.through);
        sum.scanned += batch.scanned; sum.wouldCreate += batch.wouldCreate;
        sum.unauthorized += batch.skipped.unauthorized; sum.unavailable += batch.skipped.sourceUnavailable;
        cursor = batch.nextCursor;
      }
      assert.equal(sum.scanned, 6); assert.equal(sum.wouldCreate, 2);
      assert.equal(sum.unauthorized, 1); assert.equal(sum.unavailable, 1);
      assert.equal(await count('artifacts'), before.artifacts); assert.equal(await count('artifact_versions'), before.versions);
      assert.equal(await count('coordinator_events'), before.events);
      // Access is checked again when applying, even after a successful dry run.
      await pool.query(`UPDATE issues SET "userId"='spec-other' WHERE id=$1`, [scopeChanged.issueId]);
      const currentBefore = (await pool.query('SELECT "attemptId",stage,status,revision FROM factory_tasks WHERE id=$1', [legacy.task.id])).rows[0];
      const applied = await backfillFactorySpecArtifacts(pool, store, 'spec-owner', { dryRun: false, limit: 100, cursor: inspect.cursor });
      assert.equal(applied.created, 1); assert.equal(applied.existing, 2);
      assert.equal(applied.skipped.unauthorized, 2); assert.equal(applied.skipped.sourceUnavailable, 1); assert.equal(applied.nextCursor, null);
      assert.equal(await count('coordinator_events'), before.events, 'historical copies never queue a new Coordinator turn');
      assert.deepEqual((await pool.query('SELECT "attemptId",stage,status,revision FROM factory_tasks WHERE id=$1', [legacy.task.id])).rows[0], currentBefore);
      const legacyRef = parseFactorySpecArtifactRef((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [legacy.task.attemptId])).rows[0].output.specArtifact);
      assert.ok(legacyRef); assert.equal(legacyRef.runId, legacy.runId);
      const { rows: [document] } = await pool.query('SELECT "inlineContent" FROM artifact_versions WHERE "artifactId"=$1 AND version=1', [legacyRef.artifactId]);
      assert.match(document.inlineContent, /Keep the historical API/);
      assert.doesNotMatch(document.inlineContent, /historical-private-fixture|PRIVATE_PROMPT|synthetic-session/);
      const replay = await backfillFactorySpecArtifacts(pool, store, 'spec-owner', { dryRun: false, limit: 100, cursor: inspect.cursor });
      assert.equal(replay.created, 0); assert.equal(replay.existing, 3);
      assert.equal(await count('artifacts'), before.artifacts + 1); assert.equal(await count('artifact_versions'), before.versions + 1);
      assert.equal(await count('coordinator_events'), before.events);
      assert.equal((await backfillFactorySpecArtifacts(pool, store, 'spec-other', { dryRun: false })).scanned, 0);
      await assert.rejects(backfillFactorySpecArtifacts(pool, store, 'spec-owner', { limit: 101 }), { code: 'factoryInvalid' });
      await assert.rejects(backfillFactorySpecArtifacts(pool, store, 'spec-owner', { cursor: { through: '2999-01-01T00:00:00.000Z', afterId: null } }), { code: 'factoryInvalid' });
    });

    await t.test('historical repair pins current membership before APP locks and skips a revoked tenant', async () => {
      const historicalWorkspace = await seedFixtureWorkspace(pool, 'spec-owner', 'team');
      const pending = await fixture(historicalWorkspace);
      // PostgreSQL retains microseconds, but the cursor is serialized to JS
      // milliseconds. A historical fixture must sit strictly before its cutoff.
      await pool.query(`UPDATE factory_attempts SET status='passed',"finishedAt"=clock_timestamp()-interval '1 second' WHERE id=$1`, [pending.task.attemptId]);
      const inspect = await backfillFactorySpecArtifacts(pool, store, 'spec-owner');
      assert.equal(inspect.scanned, 7, JSON.stringify(inspect));
      assert.equal(inspect.wouldCreate, 1, JSON.stringify(inspect));
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"='spec-owner'`, [historicalWorkspace]);
      try {
        const denied = await backfillFactorySpecArtifacts(pool, store, 'spec-owner', { dryRun: false, cursor: inspect.cursor });
        assert.ok(denied.skipped.unauthorized > 0);
        assert.equal((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [pending.task.attemptId])).rows[0].output.specArtifact, undefined);
      } finally {
        await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"='spec-owner'`, [historicalWorkspace]);
      }
      let sawLease = false;
      const observingStore = { lockTask: async (tx: PoolClient, userId: string, taskId: string) => {
        if (taskId === pending.task.id) {
          const probe = await pool.connect();
          try {
            await probe.query('BEGIN');
            await assert.rejects(probe.query(`SELECT "userId" FROM mikka_workspace_members
              WHERE "workspaceId"=$1 AND "userId"=$2 FOR UPDATE NOWAIT`, [historicalWorkspace, userId]), { code: '55P03' });
            sawLease = true;
          } finally { await probe.query('ROLLBACK'); probe.release(); }
        }
        return store.lockTask(tx, userId, taskId);
      } };
      const eventsBefore = (await pool.query('SELECT count(*)::int AS n FROM coordinator_events')).rows[0].n;
      const applied = await backfillFactorySpecArtifacts(pool, observingStore, 'spec-owner', { dryRun: false, cursor: inspect.cursor });
      assert.equal(applied.created, 1); assert.equal(sawLease, true);
      assert.ok(parseFactorySpecArtifactRef((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [pending.task.attemptId])).rows[0].output.specArtifact));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM coordinator_events')).rows[0].n, eventsBefore, 'restoring access still performs a quiet historical copy');
    });

    await t.test('a provider policy revoked after inspection skips only that historical plan and preserves database failures', async () => {
      const { createRequestDatabaseScope } = await import('../db/request-scope');
      const { sealSecret } = await import('../secrets/crypto');
      // Enterprise reads both stores. Bind the canonical APP request scope to
      // this owned database without holding an APP connection ahead of WS.
      const requestScope = createRequestDatabaseScope(target.toString());
      try { await requestScope.run(async () => {
        const candidates = [];
        for (let i = 0; i < 2; i++) candidates.push(await fixture(await seedFixtureWorkspace(pool, 'spec-owner', 'team')));
        candidates.sort((left, right) => left.task.attemptId < right.task.attemptId ? -1 : 1);
        const [denied, allowed] = candidates, organizationId = randomUUID(), keyId = randomUUID();
        assert.ok(denied.task.workspaceId);
        await pool.query(`INSERT INTO mikka_organizations(id,name,"createdBy") VALUES($1,'Historical plan policy','spec-owner')`, [organizationId]);
        await pool.query(`INSERT INTO mikka_organization_members("organizationId","userId",role,name,email)
          VALUES($1,'spec-owner','owner','Fixture','spec-owner@example.invalid')`, [organizationId]);
        await pool.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES($1,$2)', [denied.task.workspaceId, organizationId]);
        await pool.query(`INSERT INTO mikka_organization_resource_policies("organizationId","allowedModelProviders") VALUES($1,'["api-key"]')`, [organizationId]);
        const sealed = sealSecret('synthetic-plan-key-never-sent-to-a-provider', ['model_api_key', keyId, 'spec-owner'].join('\0'),
          { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') });
        await pool.query(`INSERT INTO model_api_keys(id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4,models)
          VALUES($1,'spec-owner','openai','openai',$2,$3,$4,'test','["example-model"]')`, [keyId, sealed.ciphertext, sealed.iv, sealed.keyVersion]);
        const definition = freezeWorkerDefinition({ harness: 'codex', instructions: 'Plan the change', prompt: 'Plan', parent: null,
          executionId: null, model: 'example-model', apiKey: { keyId, model: 'example-model' } });
        definition.executionIdentity = await freezeExecutionIdentity(pool, { userId: 'spec-owner', botId: null, deviceId,
          agentDefinition: definition }, pool, denied.task.workspaceId);
        await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [denied.runId, JSON.stringify(definition)]);
        await pool.query(`UPDATE factory_attempts SET status='passed',"finishedAt"=clock_timestamp()-interval '1 second'
          WHERE id=ANY($1::uuid[])`, [candidates.map(value => value.task.attemptId)]);
        const inspect = await backfillFactorySpecArtifacts(pool, store, 'spec-owner');
        assert.equal(inspect.wouldCreate, 2, JSON.stringify(inspect));
        const eventsBefore = (await pool.query('SELECT count(*)::int AS n FROM coordinator_events')).rows[0].n;
        await pool.query(`UPDATE mikka_organization_resource_policies SET "allowedModelProviders"='[]',revision=revision+1 WHERE "organizationId"=$1`, [organizationId]);
        await assert.rejects(executionIdentityForRun(pool, denied.runId, 'spec-owner'),
          error => error instanceof GovernanceError && error.detail === 'access_denied');
        // The policy refusal is expected; a genuine later APP write failure
        // must still reject the batch and roll back that candidate's Artifact.
        const constraint = `spec_backfill_failure_${randomUUID().replaceAll('-', '')}`;
        await pool.query(`ALTER TABLE artifacts ADD CONSTRAINT "${constraint}" CHECK ("runId" IS DISTINCT FROM '${allowed.runId}'::uuid) NOT VALID`);
        try {
          await assert.rejects(backfillFactorySpecArtifacts(pool, store, 'spec-owner', { dryRun: false, cursor: inspect.cursor }),
            { code: '23514', constraint });
          assert.equal((await pool.query('SELECT id FROM artifacts WHERE "runId"=$1', [allowed.runId])).rowCount, 0);
        } finally { await pool.query(`ALTER TABLE artifacts DROP CONSTRAINT "${constraint}"`); }
        const visited: string[] = [];
        const observingStore = { lockTask: async (tx: PoolClient, userId: string, taskId: string) => {
          visited.push(taskId);
          return store.lockTask(tx, userId, taskId);
        } };
        const applied = await backfillFactorySpecArtifacts(pool, observingStore, 'spec-owner', { dryRun: false, cursor: inspect.cursor });
        assert.equal(applied.created, 1);
        assert.equal(applied.skipped.unauthorized, inspect.skipped.unauthorized + 1);
        assert.ok(visited.indexOf(denied.task.id) >= 0 && visited.indexOf(allowed.task.id) > visited.indexOf(denied.task.id),
          'the real batch proceeds to a later candidate after the policy denial');
        assert.equal((await pool.query('SELECT id FROM artifacts WHERE "runId"=$1', [denied.runId])).rowCount, 0);
        assert.equal((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [denied.task.attemptId])).rows[0].output.specArtifact, undefined);
        assert.ok(parseFactorySpecArtifactRef((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [allowed.task.attemptId])).rows[0].output.specArtifact));
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM coordinator_events')).rows[0].n, eventsBefore,
          'both refusal and the permitted historical copy remain quiet');
      }); } finally { await requestScope.close(); }
    });

    await t.test('the same transaction fences account deletion before any Artifact write', async () => {
      const writer = await pool.connect(), deletion = await pool.connect();
      try {
        await writer.query('BEGIN');
        // An existing Artifact performs no INSERT, so only the explicit writer
        // barrier can protect this transaction from account deletion.
        await syncFactorySpecArtifact(writer, task, { historical: true });
        await deletion.query('BEGIN');
        const locked = async () => (await deletion.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_xact_lock(hashtextextended('mikka-account-write:' || $1::text,0)) AS acquired`, ['spec-owner'])).rows[0].acquired;
        assert.equal(await locked(), false, 'the deletion barrier waits for the actual writer transaction');
        await writer.query('COMMIT');
        assert.equal(await locked(), true, 'the shared barrier releases with the same COMMIT');
        await deletion.query('ROLLBACK');
      } finally {
        await writer.query('ROLLBACK'); await deletion.query('ROLLBACK');
        writer.release(); deletion.release();
      }
      const pending = await fixture();
      await pool.query(`UPDATE factory_attempts SET status='passed',"finishedAt"=now() WHERE id=$1`, [pending.task.attemptId]);
      const guardedTask = { ...pending.task, status: 'passed' as const };
      const before = (await pool.query(`SELECT
        (SELECT count(*)::int FROM artifacts) AS artifacts,
        (SELECT count(*)::int FROM artifact_versions) AS versions,
        (SELECT count(*)::int FROM coordinator_events) AS events`)).rows[0];
      await pool.query('INSERT INTO account_deletion_guards("subjectId","jobId") VALUES ($1,$2)', ['spec-owner', randomUUID()]);
      try {
        await assert.rejects(synchronize(guardedTask), { code: '55000', message: 'account_deletion_pending' });
        for (const dryRun of [true, false]) {
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            await assert.rejects(syncFactorySpecArtifact(tx, guardedTask, { historical: true, dryRun }),
              { code: '55000', message: 'account_deletion_pending' });
          } finally { await tx.query('ROLLBACK'); tx.release(); }
        }
        assert.deepEqual((await pool.query(`SELECT
          (SELECT count(*)::int FROM artifacts) AS artifacts,
          (SELECT count(*)::int FROM artifact_versions) AS versions,
          (SELECT count(*)::int FROM coordinator_events) AS events`)).rows[0], before);
        assert.equal((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [pending.task.attemptId])).rows[0].output.specArtifact, undefined);
      } finally { await pool.query('DELETE FROM account_deletion_guards WHERE "subjectId"=$1', ['spec-owner']); }
    });
  } finally {
    await closeWorkspace();
    await dropTestDatabase(admin, name, pool);
    await admin.end();
  }
});
