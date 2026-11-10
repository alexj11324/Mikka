import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { orderMigrations } from '../../scripts/migration-order.mjs';
import { createFactoryStore } from './store';
import { readFactoryTaskView } from './public-task';
import { handleFactoryFlow } from './flow-http';
import { factoryCriteria } from './task-detail';
import { runDecisionWarnings, factoryDecisionWarnings, reviewDecisionExplanation } from '../project-decision-warnings';
import { citedQuestionCommandSources } from './question-command-sources';
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

test('task detail GET exposes criteria and delivery without unused fields or writes', { skip: !base, timeout: 120_000 }, async t => {
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
    await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority,"workspaceId","ownershipState") VALUES ($1,'owner','Fixture','{}','todo','normal',$2,'bound')`, [issueId, await seedFixtureWorkspace(pool, 'owner')]);
    const sourceEventId = randomUUID();
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId]);
    const report = { criteria: [
      { criterionId: randomUUID(), text: 'Button renders', passed: true, evidence: 'ran it; token=abc123 seen', command: 'pnpm test:button token=abc123', exitCode: 0 },
      { text: 'Mixed case Authorization: Bearer xyz', passed: false },
      { passed: 'yes' },
    ], verify: { status: 'passed', command: 'pnpm test', exitCode: 0, timedOut: false, signal: null } };
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,kind,prompt,report) VALUES ($1,'owner',$3,$4,$5,'succeeded','implement','p',NULL),($2,'owner',$3,$4,$5,'succeeded','review','p',$6)`, [implRun, reviewRun, agentId, deviceId, issueId, JSON.stringify(report)]);
    await pool.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,branch,"baseBranch","pullRequest") VALUES ($1,'owner',$2,'https://github.com/o/r','o/r','published','mik-7-fix','main','{"url":"https://github.com/o/r/pull/7","state":"open"}')`, [implRun, issueId]);
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
    assert.deepEqual(detail.delivery, { candidateSha: sha, previewDatabaseBranch: 'preview/ac-7', machineName: 'Build server', repository: 'o/r', environment: 'device:x', pullRequest: { url: 'https://github.com/o/r/pull/7', state: 'open' }, previewUrl: null, deploymentEnvironment: null, branch: { head: 'mik-7-fix', base: 'main' }, mergeAs: null, summary: null }, 'no receipt: deploymentEnvironment null');

    await t.test('public task readers keep the v1 contract on a one-connection pool', async () => {
      const single = new Pool({ connectionString: target.toString(), max: 1 });
      try {
        assert.deepEqual(await readFactoryTaskView(single, createFactoryStore(single, async () => true), 'owner', taskId), detail);
        assert.deepEqual(await store.listPublicForIssue('owner', issueId), await store.listForIssue('owner', issueId));
      } finally { await single.end(); }
    });

    await t.test('v2 tool detail and issue context share canonical flow, bindings, real history and current-candidate merge evidence', async () => {
      const [triagePlaceholder, specPlaceholder, handoffAttempt, mergeId, acceptanceId, nextReport] = Array.from({ length: 6 }, () => randomUUID());
      await pool.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,reason) VALUES
        ($1,$4,'clarify',1,4,'cancelled','unused'),($2,$4,'spec',1,5,'cancelled','unused'),($3,$4,'approval',1,6,'pending','handoff')`,
        [triagePlaceholder, specPlaceholder, handoffAttempt, taskId]);
      await pool.query(`UPDATE factory_tasks SET route='{"flowVersion":2}',stage='publish',status='passed',"attemptId"=$2,reason='token=private-fixture' WHERE id=$1`, [taskId, handoffAttempt]);
      try {
        const stable = await snapshot();
        const view = await readFactoryTaskView(pool, store, 'owner', taskId);
        assert.equal(view.contractVersion, 2);
        if (view.contractVersion !== 2) assert.fail('expected the v2 public reader');
        assert.equal(view.task.stage, 'handoff', 'raw publish/passed cannot claim completion');
        assert.equal(view.task.needsYou?.kind, 'pr_review');
        assert.deepEqual(view.task.stages, ['implement', 'review', 'handoff']);
        assert.equal('status' in view.task, false); assert.equal('route' in view.task, false);
        assert.deepEqual(view.binding, { taskId, issueId, attemptId: handoffAttempt, candidateId, revision: detail.task.revision });
        assert.deepEqual(view.attempts.map(attempt => [attempt.id, attempt.stage, attempt.runId]), [[implAttempt, 'implement', implRun], [reviewAttempt, 'review', reviewRun]]);
        assert.deepEqual(view.history, { limit: 20, total: 2, truncated: false });
        assert.deepEqual(view.candidates.map(candidate => [candidate.id, candidate.runId, candidate.sha]), [[candidateId, implRun, sha]]);
        assert.match(view.reason, /token=\[REDACTED\]/);
        assert.doesNotMatch(JSON.stringify(view), /private-fixture|"verify"|"spec"|"triage"/);
        const flow = await handleFactoryFlow(pool, store, (() => assert.fail('GET cannot approve')) as never, {
          actor: { userId: 'owner', sessionId: 'normal-browser' }, authorization: null, method: 'GET', taskId, origin: null, url: `https://app.invalid/api/factory/tasks/${taskId}/flow`,
        });
        assert.equal(flow.status, 200); assert.deepEqual(flow.body, view.task, 'the browser and tools read the same projection');
        const [listed] = (await store.listPublicForIssue('owner', issueId)).tasks;
        assert.equal(listed.stage, view.task.stage); assert.equal('status' in listed, false); assert.equal('route' in listed, false);
        assert.ok('binding' in listed); assert.deepEqual(listed.binding, view.binding);
        assert.equal(listed.needsYou?.kind, view.task.needsYou?.kind);
        assert.equal((await store.listForIssue('owner', issueId)).tasks[0].status, 'passed', 'legacy HTTP/internal list stays compatible');
        assert.deepEqual(await snapshot(), stable, 'both public reads are read-only');
        await assert.rejects(readFactoryTaskView(pool, store, 'other', taskId), { code: 'factoryNotFound' });
        await assert.rejects(readFactoryTaskView(pool, createFactoryStore(pool, async () => true, randomUUID()), 'owner', taskId), { code: 'factoryNotFound' });
        assert.deepEqual((await createFactoryStore(pool, async () => true, randomUUID()).listPublicForIssue('owner', issueId)).tasks, []);
        await pool.query(`UPDATE coordinator_events SET kind='run_completed' WHERE id=$1`, [sourceEventId]);
        try {
          await assert.rejects(readFactoryTaskView(pool, store, 'owner', taskId), { code: 'factoryNotFound' });
          assert.deepEqual((await store.listPublicForIssue('owner', issueId)).tasks, [], 'invalid source disappears from the public list too');
        } finally { await pool.query(`UPDATE coordinator_events SET kind='user_message' WHERE id=$1`, [sourceEventId]); }

        // A concurrent confirmed merge cannot split the read's task state from its binding.
        const merged = () => pool.query(`INSERT INTO factory_merges (id,"taskId","candidateId","userId","eventId","pullRequestUrl",sha,status,source,"mergeCommitSha")
          VALUES ($1,$2,$3,'owner',$4,'https://github.com/o/r/pull/7',$5,'merged','github',$6)`, [mergeId, taskId, candidateId, randomUUID(), sha, 'd'.repeat(40)]);
        const concurrent = await readFactoryTaskView(pool, { read: store.read, readTask: async (tx, user, id) => {
          const frozen = await store.readTask(tx, user, id); await merged(); return frozen;
        } }, 'owner', taskId);
        assert.equal(concurrent.task.stage, 'handoff', 'one repeatable snapshot excludes a merge committed after authorization');
        assert.equal((await readFactoryTaskView(pool, store, 'owner', taskId)).task.stage, 'completed');
        assert.equal((await store.listPublicForIssue('owner', issueId)).tasks[0].stage, 'completed');
        await pool.query('DELETE FROM factory_merges WHERE id=$1', [mergeId]);
        await pool.query(`UPDATE factory_attempts SET status='failed' WHERE id=$1`, [reviewAttempt]);
        const failed = await readFactoryTaskView(pool, store, 'owner', taskId);
        assert.equal(failed.attempts.find(attempt => attempt.id === reviewAttempt)?.status, 'failed', 'actual failed review history is retained');
        await pool.query(`INSERT INTO factory_deliverable_acceptances (id,"taskId","candidateId","userId","sessionId","eventId")
          VALUES ($1,$2,$3,'owner','fixture-session',$4)`, [acceptanceId, taskId, candidateId, randomUUID()]);
        assert.equal((await readFactoryTaskView(pool, store, 'owner', taskId)).task.stage, 'handoff', 'a repository still requires an actual merge');
        await pool.query(`UPDATE factory_candidates SET kind='report' WHERE id=$1`, [candidateId]);
        const accepted = await readFactoryTaskView(pool, store, 'owner', taskId);
        assert.equal(accepted.contractVersion, 2);
        if (accepted.contractVersion !== 2) assert.fail('expected v2 report');
        assert.equal(accepted.task.stage, 'completed'); assert.equal(accepted.task.completion, 'accepted');
        assert.equal(accepted.task.needsYou, undefined);
        assert.equal((await store.listPublicForIssue('owner', issueId)).tasks[0].stage, 'completed');
        await pool.query(`UPDATE factory_deliverable_acceptances SET "userId"='other' WHERE id=$1`, [acceptanceId]);
        assert.equal((await readFactoryTaskView(pool, store, 'owner', taskId)).task.stage, 'handoff', 'another owner cannot complete the report');
        await pool.query(`UPDATE factory_deliverable_acceptances SET "userId"='owner' WHERE id=$1`, [acceptanceId]);
        await pool.query(`INSERT INTO factory_candidates (id,"taskId",sha,kind,repository,environment,scope,"runId")
          VALUES ($1,$2,$3,'report','o/r','device:x','report',$4)`, [nextReport, taskId, 'e'.repeat(40), implRun]);
        await pool.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [taskId, nextReport]);
        assert.equal((await readFactoryTaskView(pool, store, 'owner', taskId)).task.stage, 'handoff', 'the older report acceptance never completes a new candidate');
        assert.equal((await store.listPublicForIssue('owner', issueId)).tasks[0].stage, 'handoff');
      } finally {
        await pool.query('DELETE FROM factory_merges WHERE id=$1', [mergeId]);
        await pool.query('DELETE FROM factory_deliverable_acceptances WHERE id=$1', [acceptanceId]);
        await pool.query(`UPDATE factory_tasks SET route='{}',stage='verify',status='running',"attemptId"=$2,"candidateId"=$3,reason='fixture' WHERE id=$1`, [taskId, verifyAttempt, candidateId]);
        await pool.query(`UPDATE factory_candidates SET kind='repository' WHERE id=$1`, [candidateId]);
        await pool.query('DELETE FROM factory_candidates WHERE id=$1', [nextReport]);
        await pool.query(`UPDATE factory_attempts SET status='passed' WHERE id=$1`, [reviewAttempt]);
        await pool.query('DELETE FROM factory_attempts WHERE id=ANY($1::uuid[])', [[triagePlaceholder, specPlaceholder, handoffAttempt]]);
      }
    });

    await t.test('v2 clarification preserves its latest missing context without inventing an execution history', async () => {
      const clarificationIssue = randomUUID(), requestId = randomUUID(), answerId = randomUUID();
      await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority,"workspaceId","ownershipState") VALUES ($1,'owner','Clarify fixture','{}','todo','normal',$2,'bound')`, [clarificationIssue, await seedFixtureWorkspace(pool, 'owner')]);
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"clarify"}')`, [requestId, requestId]);
      const routed = await store.route('owner', { issueId: clarificationIssue, sourceEventId: requestId, eventId: randomUUID(), rationale: 'Needs context', missingInformation: ['Which file?'], missingPermissions: ['Permission token=fixture'], needsSpec: true });
      const read = () => readFactoryTaskView(pool, store, 'owner', routed.task.id);
      try {
        const first = await read(); assert.equal(first.contractVersion, 2);
        if (first.contractVersion !== 2) assert.fail('expected v2 clarification');
        assert.equal(first.task.stage, 'triage'); assert.equal(first.task.needsYou?.kind, 'question');
        assert.deepEqual(first.attempts, []);
        assert.deepEqual(first.clarification, { missingInformation: ['Which file?'], missingPermissions: ['Permission token=[REDACTED]'], needsSpec: true });
        await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"README; more context follows"}')`, [answerId, answerId]);
        await store.apply('owner', first.binding, randomUUID(), { action: 'resolve', sourceEventId: answerId, rationale: 'File identified', missingInformation: ['Which heading?'], missingPermissions: [], needsSpec: true });
        const next = await read(); assert.equal(next.contractVersion, 2);
        if (next.contractVersion !== 2) assert.fail('expected v2 clarification');
        assert.deepEqual(next.clarification, { missingInformation: ['Which heading?'], missingPermissions: [], needsSpec: true }, 'latest unresolved response supersedes the original route');
        assert.equal(next.binding.revision, first.binding.revision + 1); assert.equal('route' in next.task, false);
      } finally {
        await pool.query('DELETE FROM factory_tasks WHERE id=$1', [routed.task.id]);
        await pool.query('DELETE FROM coordinator_events WHERE id=ANY($1::uuid[])', [[requestId, answerId]]);
        await pool.query('DELETE FROM issues WHERE id=$1', [clarificationIssue]);
      }
    });

    assert.deepEqual(detail.decisionWarnings, [], 'ordinary completed work has no decision warning');
    const successor = randomUUID(), decisionId = randomUUID(), changedCandidate = randomUUID(), rejectionEvent = randomUUID();
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","issueId",status,kind,prompt,"retryOf","agentDefinition",error)
      VALUES ($1,'owner',$2,$3,'succeeded','implement','Retry after provider capacity changed',$4,'{"model":"changed-model"}','provider quota')`,
      [successor, agentId, issueId, implRun]);
    assert.deepEqual(await runDecisionWarnings(pool, 'owner', implRun), [], 'retry and provider/model changes alone are not decisions');
    await pool.query('UPDATE agent_runs SET "threadReplacedBy"=$2 WHERE id=$1', [implRun, successor]);
    const warned = await store.read('owner', taskId);
    assert.equal(warned.decisionWarnings?.length, 1);
    assert.equal(warned.decisionWarnings![0].severity, 'warning');
    assert.deepEqual(warned.decisionWarnings![0].sourceRefs, [{ type: 'run', id: implRun }, { type: 'run', id: successor }]);
    assert.equal(warned.checks![0].status, 'passed', 'a missing decision never changes a check verdict');
    assert.equal((await runDecisionWarnings(pool, 'owner', implRun)).length, 1, 'normal run inspection sees the same host signal');
    assert.deepEqual(await runDecisionWarnings(pool, 'other', implRun), [], 'a caller without the source run cannot see its warning');

    await pool.query(`INSERT INTO project_decisions
      (id,"workspaceId","projectId","ownerId","issueId","runId",kind,title,summary,reason,provenance,"captureMode","decidedBy","recordedBy","occurredAt","idempotencyKey","payloadHash")
      VALUES ($1,$2,$3,'owner',$4,$5,'confirm','Recorded route','Recorded route','Explicit owner choice','recorded','live','{"kind":"human","id":"owner"}','{"kind":"bot","id":"fixture"}',now(),'warning-fixture','fixture')`,
      [decisionId, randomUUID(), randomUUID(), issueId, successor]);
    assert.deepEqual(await runDecisionWarnings(pool, 'owner', implRun), [], 'the linked active decision prevents repeated reminders');
    assert.deepEqual((await store.read('owner', taskId)).decisionWarnings, []);
    await pool.query('DELETE FROM project_decisions WHERE id=$1', [decisionId]);
    await pool.query('UPDATE agent_runs SET "threadReplacedBy"=NULL WHERE id=$1', [implRun]);
    await pool.query(`INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,"runId")
      VALUES ($1,$2,$3,'o/r','device:x','repo',$4)`, [changedCandidate, taskId, 'c'.repeat(40), successor]);
    await pool.query(`INSERT INTO factory_approval_controls ("taskId","eventId","userId","principalId",request,result)
      VALUES ($1,$2,'owner','owner',$3,'{}')`, [taskId, rejectionEvent, JSON.stringify({ operation: 'reject', candidateId })]);
    assert.deepEqual((await store.read('owner', taskId)).decisionWarnings, [], 'owner rejection with unchanged candidate is not a changed-route observation');
    await pool.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [taskId, changedCandidate]);
    const changed = await store.read('owner', taskId);
    assert.deepEqual(changed.decisionWarnings?.[0].sourceRefs, [{ type: 'candidate', id: candidateId }, { type: 'candidate', id: changedCandidate }]);
    assert.equal(changed.decisionWarnings?.[0].code, 'possible_unrecorded_decision');
    await pool.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [taskId, candidateId]);
    await pool.query('DELETE FROM factory_approval_controls WHERE "taskId"=$1 AND "eventId"=$2', [taskId, rejectionEvent]);
    await pool.query('DELETE FROM factory_candidates WHERE id=$1', [changedCandidate]);

    await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [reviewAttempt, JSON.stringify({ check: { candidateId, sha } })]);
    await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [reviewRun, JSON.stringify({ ...report, summary: 'Review completed.\npossible_unrecorded_decision: The person changed the target without a linked decision; token=secret-fixture' })]);
    const semantic = await store.read('owner', taskId);
    assert.equal(semantic.decisionWarnings?.length, 1, 'explicit existing review output is a semantic warning');
    assert.deepEqual(semantic.decisionWarnings![0].sourceRefs, [{ type: 'run', id: reviewRun }, { type: 'candidate', id: candidateId }], 'sources come only from the frozen host binding');
    assert.match(semantic.decisionWarnings![0].explanation, /token=\[REDACTED\]/);
    assert.equal(semantic.checks![0].status, 'passed');
    assert.deepEqual((await store.read('owner', taskId)).decisionWarnings, semantic.decisionWarnings, 'reading again does not duplicate a review warning');
    assert.deepEqual(await factoryDecisionWarnings(pool, { id: taskId, userId: 'other', issueId }), []);
    await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [reviewAttempt, JSON.stringify({ check: { candidateId: randomUUID(), sha } })]);
    assert.deepEqual((await store.read('owner', taskId)).decisionWarnings, [], 'a mismatched candidate cannot attribute model output');
    await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [reviewAttempt, JSON.stringify({ check: { candidateId, sha } })]);
    await pool.query(`INSERT INTO project_decisions
      (id,"workspaceId","projectId","ownerId","issueId","runId",kind,title,summary,reason,provenance,"captureMode","decidedBy","recordedBy","occurredAt","idempotencyKey","payloadHash")
      VALUES ($1,$2,$3,'owner',$4,$5,'confirm','Recorded route','Recorded route','Explicit owner choice','recorded','live','{"kind":"human","id":"owner"}','{"kind":"bot","id":"fixture"}',now(),'warning-fixture','fixture')`,
      [decisionId, randomUUID(), randomUUID(), issueId, implRun]);
    assert.deepEqual((await store.read('owner', taskId)).decisionWarnings, [], 'recording the producer decision suppresses an old semantic reminder');
    await pool.query('DELETE FROM project_decisions WHERE id=$1', [decisionId]);
    await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [reviewRun, JSON.stringify(report)]);
    await pool.query("UPDATE factory_attempts SET output='{}' WHERE id=$1", [reviewAttempt]);

    const source = { runId: randomUUID(), sessionId: 'prior-question-session', status: 'stopped',
      recoveryEventId: randomUUID(), candidateSha: sha, outputChunkId: randomUUID(), observedAt: '2026-11-04T12:03:04.000Z' };
    await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [reviewAttempt,
      JSON.stringify({ check: { candidateId, sha, questionCommandSources: [source] } })]);
    await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [reviewRun,
      JSON.stringify({ ...report, criteria: [{ text: 'Producer command', passed: true, evidence: 'Checked run-chunk:' + source.outputChunkId }] })]);
    const attributed = await store.read('owner', taskId);
    assert.deepEqual(attributed.checks?.[0].commandSources, [{ runId: source.runId, sessionId: source.sessionId, status: source.status,
      recoveryEventId: source.recoveryEventId, observedAt: source.observedAt }], 'GET joins the actual citation to host-frozen candidate provenance');
    assert.equal(attributed.checks?.[0].status, 'passed', 'attribution never changes a verdict');
    await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [reviewRun, JSON.stringify(report)]);
    assert.equal((await store.read('owner', taskId)).checks?.[0].commandSources, undefined, 'an uncited source is not represented as used');
    await pool.query("UPDATE factory_attempts SET output='{}' WHERE id=$1", [reviewAttempt]);

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

test('question command attribution accepts only cited host records for the same fixed candidate', () => {
  const candidateId = randomUUID(), sha = 'c'.repeat(40), outputChunkId = randomUUID();
  const source = { runId: randomUUID(), sessionId: 'native-before-question', status: 'failed',
    recoveryEventId: randomUUID(), candidateSha: sha, outputChunkId, observedAt: '2026-11-04T12:03:04.000Z' };
  const check = { candidateId, sha, questionCommandSources: [source] };
  const criteria = [{ evidence: 'Observed run-chunk:' + outputChunkId + ' after checking the fixed file.' }];
  assert.deepEqual(citedQuestionCommandSources(check, criteria, candidateId, sha),
    [{ runId: source.runId, sessionId: source.sessionId, status: 'failed', recoveryEventId: source.recoveryEventId, observedAt: source.observedAt }]);
  assert.deepEqual(citedQuestionCommandSources(check, [{ evidence: 'The producer said it passed.' }], candidateId, sha), []);
  assert.deepEqual(citedQuestionCommandSources(check, criteria, randomUUID(), sha), []);
  assert.deepEqual(citedQuestionCommandSources(check, criteria, candidateId, 'd'.repeat(40)), []);
  for (const malformed of [
    { ...source, outputChunkId: randomUUID() }, { ...source, candidateSha: 'e'.repeat(40) },
    { ...source, observedAt: 'not-a-date' }, { ...source, runId: 'not-a-run-id' },
    { ...source, status: 'passed' }, { ...source, sessionId: '' },
  ]) assert.deepEqual(citedQuestionCommandSources({ ...check, questionCommandSources: [malformed] }, criteria, candidateId, sha), []);
  assert.deepEqual(citedQuestionCommandSources({ ...check, questionCommandSources: Array.from({ length: 33 }, () => source) }, criteria, candidateId, sha), []);
});

test('review warning markers are explicit standalone bounded output, not user-text keyword guesses', () => {
  assert.equal(reviewDecisionExplanation('There was a retry, fallback, formatting change or pivot.'), null);
  assert.equal(reviewDecisionExplanation('Quoted possible_unrecorded_decision: change'), null);
  assert.equal(reviewDecisionExplanation('possible_unrecorded_decision: ' + 'x'.repeat(501)), null);
  assert.equal(reviewDecisionExplanation('possible_unrecorded_decision: '), null);
  assert.equal(reviewDecisionExplanation('Review passed.\npossible_unrecorded_decision: Explain the changed target.'), 'Explain the changed target.');
});
