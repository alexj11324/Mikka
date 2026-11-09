import { observePoolCommits } from '../db/commit-effects';
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace';
import { createLegacyFactoryStore as createFactoryStore } from '../../tests/helpers/factory-legacy';
import { addFactoryVisualEvidence } from '../../tests/helpers/factory-visual-evidence';
// BE-9: run completion drives Factory reconcile without a Coordinator turn.
// Real migrations, store, dispatch and reconciler over a disposable *_e2e PG.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { workspacePool } from "../workspace-db";
import { orderMigrations } from "../../scripts/migration-order.mjs";
import { adoptProviderContinuation, createFactoryStore as createCurrentFactoryStore } from "./store";
import { freezeWorkerDefinition } from "../agent-kit/worker";
import { runReport } from '@mikka/protocol/run';
import type { ExecutionIdentity } from "../execution-identity";
import { providerContinuationDefinition, providerContinuationLaunchMatches, providerContinuationMatches, recoverProviderFailure } from "../run-provider-fallback";
import { providerContinuationPrompt } from "../run-retry";
import { checkFactoryRepairBudget } from "./check-recovery-evidence";
import { FactoryError } from "./contract";
import { createFactoryDispatch, defaultFactoryDispatchAdapters, factoryBinding, type FactoryQueue } from "./dispatch";
import { createFactoryHumanStore } from './human-store';
import { handleFactory } from './http';
import { factoryWatchdogDecision, sweepFactoryWatchdog } from './watchdog';
import { currentFactoryRequest, factoryCheckAssignment, factoryCheckGates } from './checks';
import { approvalEvidence } from './evidence';
import { createFactoryApprovalGates, createFactoryApprovals } from './approval';
import { handleFactoryApproval } from './approval-http';
import { createFactoryMerges } from './merge';
import { factoryEventId } from './event-id';
import { questionFingerprint, humanQuestionAnswerSchema } from './questions/contract';
import { createFactoryQuestions } from "./questions/store";
import { createFactoryReconciler, observeFactoryProfileDispatch } from "./reconcile";
import { reconcileFactoryCheck } from './reconcile-check';
import { AgentProfileError } from "./agent-profile-definition";
import { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction, registerFactoryProfile } from "./transaction";
import { factoryCheckIndependent } from "./check-independence";
import { reconcileFactoryAfterCompletion } from "../run-completion-effects";
import { orchestratorSettings } from "@mikka/protocol/orchestrator";
import { dropTestDatabase } from "../../tests/support/drop-test-database";

const url = process.env.E2E_DATABASE_URL;
if (url) {
  const u = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(u.hostname), "loopback only");
  assert.match(u.pathname, /^\/[a-z0-9_]+_e2e$/, "database name must end in _e2e");
} else if (process.env.REQUIRE_DB === "1") assert.fail("REQUIRE_DB=1 needs E2E_DATABASE_URL");

test("run completion enters review without the Coordinator; replays do not advance twice", { skip: !url, timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: url, max: 1 });
  const database = `fac_complete_${randomUUID().replaceAll("-", "")}_e2e`;
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const target = new URL(url!);
  target.pathname = `/${database}`;
  const pool = new Pool({ connectionString: target.toString(), max: 8 });
  observePoolCommits(pool);
  const authorityWorkspaces: string[] = [];
  const flags = { r: process.env.MIKKA_FACTORY_ROUTING_ENABLED, l: process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED };
  try {
    const dir = new URL("../../drizzle/", import.meta.url);
    for (const f of orderMigrations((await readdir(dir)).filter((f) => f.endsWith(".sql"))))
      await pool.query(await readFile(new URL(f, dir), "utf8"));
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','complete@example.invalid',true,now(),now())`);
    const workspaceId = await seedFixtureWorkspace(pool, 'owner', 'team');
    // Request database scope changes APP only. Completion still checks the
    // independent workspace authority, so both stores share this real tenant.
    await seedFixtureWorkspace(workspacePool, 'owner', 'team', workspaceId);
    authorityWorkspaces.push(workspaceId);
    const authorize = async (user: string, issue: string, tx: PoolClient) =>
      (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, user])).rowCount === 1;
    const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID();
    await pool.query(`INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Disposable',now(),'[{"harness":"codex","installed":true}]')`, [deviceId]);
    await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Fixture','codex',$2)`, [agentId, deviceId]);
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,'owner','/fixture/repo','https://github.com/acme/fixture.git')`, [repoId, deviceId]);
    const store = createFactoryStore(pool, authorize, null, { independent: factoryCheckIndependent });
    const queue: FactoryQueue = async (tx, userId, input, botId) => {
      const runId = randomUUID();
      await tx.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",status,prompt) VALUES ($1,$2,$3,$4,$5,$6,$7,'queued','Fixture')`, [runId, userId, input.issueId, input.agentId, deviceId, input.deviceRepoId, botId]);
      return { runId };
    };
    const dispatch = createFactoryDispatch(pool, store, queue, { configure: { execute: async () => {} }, freeze: async (tx, _task, id) => { await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id, JSON.stringify({ schemaVersion: 1, definitionDigest: "fixture", harness: "codex" })]); } });
    const questions = createFactoryQuestions(pool, authorize, store, dispatch);
    const sweep = createFactoryReconciler(pool, store, questions);
    const reconcileFor = () => (userId: string, runId: string) => sweep.run(userId, runId);
    const issueId = randomUUID(), sourceEventId = randomUUID();
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState") VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal',$2,'bound')`, [issueId, workspaceId]);
    /** A routed task on its own issue whose execute attempt is bound to a running run. */
    const runningTask = async (iss?: string) => {
      const ownIssue = iss ?? randomUUID(), src = randomUUID();
      if (!iss) await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState") VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal',$2,'bound')`, [ownIssue, workspaceId]);
      await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [src, src]);
      const r = await store.route("owner", { issueId: ownIssue, sourceEventId: src, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
      const run = await dispatch("owner", { binding: factoryBinding(r.task), agentId, deviceRepoId: repoId });
      await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [run.runId]);
      return { task: r.task, runId: run.runId };
    };
    // Host-owned model references only; no credential values or provider I/O.
    const providerRepoId = randomUUID(), alternateAgentId = randomUUID(), providerWorkspaceId = workspaceId;
    await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Provider fixture','claude_code',$2)`, [alternateAgentId, deviceId]);
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,'owner','v2/github.com/acme/provider-fixture','https://github.com/acme/provider-fixture.git')`, [providerRepoId, deviceId]);
    const providerDefinition = (harness: 'codex' | 'claude_code', prompt: string, targetDevice = deviceId) => {
      const keyId = randomUUID(), model = `fixture-${keyId.slice(0, 8)}`;
      const definition = freezeWorkerDefinition({ harness, instructions: 'Fixture standing permissions', prompt, parent: null, executionId: null,
        model, apiKey: { keyId, model }, readOnly: true,
        modelDispatch: { mode: 'preference', location: 'local', entry: { id: keyId, harness, model, source: { kind: 'api_key', keyId } } } });
      const identity: ExecutionIdentity = { version: 1, requester: 'owner', executionPrincipal: 'owner', outputOwner: 'owner',
        botId: null, botOwner: null, workspaceId: providerWorkspaceId, personalResourcePolicy: 'requester_only',
        resourceBindings: [{ kind: 'device', id: targetDevice, ownerId: 'owner', access: 'owner' }, { kind: 'api_key', id: keyId, ownerId: 'owner', access: 'owner' }],
        billingAccount: { model: { kind: 'api_key', resourceId: keyId, ownerId: 'owner', amount: 'provider_unknown' },
          runtime: { kind: 'local_device', resourceId: targetDevice, ownerId: 'owner', amount: 'not_applicable' } } };
      return { ...definition, executionIdentity: identity };
    };
    const providerSource = async () => {
      const created = await runningTask();
      await pool.query('UPDATE agent_runs SET "deviceRepoId"=$2,"agentDefinition"=$3 WHERE id=$1', [created.runId, providerRepoId, JSON.stringify(providerDefinition('codex', 'Fixture'))]);
      return created;
    };
    const providerChild = async (query: Pick<Pool | PoolClient, 'query'>, sourceId: string,
      target?: { agentId: string; deviceId: string; deviceRepoId: string }) => {
      const prior = (await query.query('SELECT * FROM agent_runs WHERE id=$1', [sourceId])).rows[0];
      const harness = prior.agentDefinition.harness === 'codex' ? 'claude_code' : 'codex';
      const admitted = providerDefinition(harness, prior.prompt, target?.deviceId ?? prior.deviceId);
      const prompt = providerContinuationPrompt(prior.prompt);
      const definition = { ...providerContinuationDefinition(prior.agentDefinition, admitted, prompt), executionIdentity: admitted.executionIdentity };
      const childId = randomUUID();
      await query.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId","botId",kind,status,prompt,"baseBranch","agentDefinition","retryOf",attempt)
        SELECT $2,"userId","issueId",$3,$4,$5,"botId",kind,'queued',$7,"baseBranch",$6,id,attempt FROM agent_runs WHERE id=$1`,
        [sourceId, childId, target?.agentId ?? (harness === 'codex' ? agentId : alternateAgentId), target?.deviceId ?? prior.deviceId, target?.deviceRepoId ?? prior.deviceRepoId, JSON.stringify(definition), prompt]);
      const fallback = { state: 'switched', fallback: 'balance',
        from: { harness: prior.agentDefinition.harness, model: prior.agentDefinition.model, source: 'api_key' },
        to: { harness, model: definition.model, source: 'api_key' }, retryRunId: childId, nextDefinitionDigest: definition.definitionDigest };
      await query.query(`UPDATE agent_runs SET status='failed',"stopReason"='provider_failure',"finishedAt"=clock_timestamp(),report=$2 WHERE id=$1`,
        [sourceId, JSON.stringify({ providerFailure: { kind: 'balance', retryable: false, code: 'insufficient_quota' }, modelFallback: fallback })]);
      return childId;
    };
    const succeed = async (runId: string) => {
      await addFactoryVisualEvidence(pool, runId);
      return pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='s1',report=$2,"startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp() WHERE id=$1`, [runId, JSON.stringify({ publish: { commit: "b".repeat(40) }, verify: { status: "passed" }, summary: "done" })]);
    };
    const exhaustedCompletion = async () => {
      const created = await runningTask();
      await succeed(created.runId);
      const clock = Date.now();
      for (const minutes of [0, 3, 8, 17]) await sweepFactoryWatchdog(pool, {
        runtime: () => ({ store, reconcile: { run: async () => { throw new Error('Fixture completion dispatch unavailable'); } } }),
        dispatch: async () => { throw new Error('A successful producer must not be dispatched again'); },
        wake: async () => {},
      }, new Date(clock + minutes * 60_000), Date.now() + 20_000, { userId: 'owner', runId: created.runId });
      const task = (await store.read('owner', created.task.id)).task;
      assert.equal(task.status, 'blocked');
      const { rows: [watchdog] } = await pool.query(`SELECT request,result FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_watchdog'`, [task.id]);
      assert.equal(watchdog.result.tries, 4);
      assert.equal(watchdog.result.blocked, true);
      assert.equal(watchdog.result.action, 'reconcile');
      const request = { userId: 'owner', method: 'POST', taskId: task.id, origin: 'https://fixture.invalid', url: `https://fixture.invalid/api/factory/tasks/${task.id}`,
        body: { binding: { taskId: task.id, revision: task.revision }, eventId: randomUUID(), action: 'retry', reason: 'Resume completed execution' } };
      return { task, runId: created.runId, request, watchdog };
    };
    await t.test('list recovery eligibility transfers only the run id; the locked action retains the complete producer', async () => {
      const ready = await exhaustedCompletion();
      await pool.query('UPDATE agent_runs SET prompt=$2 WHERE id=$1', [ready.runId, 'Synthetic producer context '.repeat(4096)]);
      const { completedRunForRecovery } = await import('./completion-recovery');
      const full = await completedRunForRecovery(pool, ready.task, true);
      const compact = await completedRunForRecovery(pool, ready.task);
      assert.deepEqual(compact, { id: ready.runId });
      assert.ok(full.report && full.sessionId && full.remoteUrl, 'the mutating recovery still receives all required inputs');
      const beforeBytes = Buffer.byteLength(JSON.stringify([full]));
      const afterBytes = Buffer.byteLength(JSON.stringify([compact]));
      assert.ok(beforeBytes > 100_000 && afterBytes < 100);
      t.diagnostic(JSON.stringify({ factoryRecoveryBeforeBytes: beforeBytes, factoryRecoveryAfterBytes: afterBytes, returnedRows: 1 }));
    });
    const history = async (taskId: string, runId: string, attemptId: string) => ({
      run: (await pool.query('SELECT to_jsonb(r) AS value FROM agent_runs r WHERE id=$1', [runId])).rows[0].value,
      attempt: (await pool.query('SELECT to_jsonb(a) AS value FROM factory_attempts a WHERE id=$1', [attemptId])).rows[0].value,
      watchdog: (await pool.query(`SELECT request,result FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_watchdog'`, [taskId])).rows,
    });
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId]);
    const routed = await store.route("owner", { issueId, sourceEventId, eventId: randomUUID(), rationale: "Task requested", missingInformation: [], missingPermissions: [], needsSpec: false });
    const d = await dispatch("owner", { binding: factoryBinding(routed.task), agentId, deviceRepoId: repoId });
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [d.runId]);
    const other = await runningTask();
    const otherBefore = (await store.read("owner", other.task.id)).task;
    const pick = (x: { stage: string; status: string; revision: number; attemptId: string | null }) => ({ stage: x.stage, status: x.status, revision: x.revision, attemptId: x.attemptId });

    await t.test("flags off: no SQL, no transition", async () => {
      process.env.MIKKA_FACTORY_ROUTING_ENABLED = '0'; process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '0';
      let queried = 0;
      assert.equal(await reconcileFactoryAfterCompletion({ query: async () => { queried++; return { rows: [] }; } }, "owner", d.runId, reconcileFor), 0);
      assert.equal(queried, 0);
    });
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = "1"; process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = "1";

    await t.test('Owner completion retry cannot hand off a submitted producer without its visual evidence', async () => {
      const f = await exhaustedCompletion();
      await pool.query('DELETE FROM run_captures WHERE "runId"=$1', [f.runId]);
      const before = await history(f.task.id, f.runId, f.task.attemptId);
      let completedDispatches = 0;
      const human = createFactoryHumanStore(pool, () => store, async (_tx, _store, task) => {
        completedDispatches++;
        assert.equal(task.stage, 'execute');
        assert.equal(task.status, 'blocked', 'completion recovery must not dispatch the next stage');
        return undefined;
      });
      const response = await handleFactory(human, f.request);
      assert.equal(response.status, 409);
      assert.ok(response.body && typeof response.body === 'object' && 'error' in response.body);
      assert.equal(response.body.error, 'factory_visual_evidence_required');
      const blocked = await store.read('owner', f.task.id);
      assert.equal(blocked.task.stage, 'execute');
      assert.equal(blocked.task.status, 'blocked');
      assert.equal(blocked.task.attemptId, f.task.attemptId);
      assert.equal(blocked.refusal?.code, 'factory_visual_evidence_required');
      assert.equal(blocked.candidates.length, 1);
      assert.equal(blocked.candidates[0].runId, f.runId);
      assert.equal(blocked.attempts.length, 1);
      assert.equal(blocked.attempts.filter(a => ['review', 'approval', 'publish'].includes(a.stage)).length, 0);
      const gate = blocked.attempts[0].output.evidenceGate;
      assert.deepEqual(gate, { code: 'factory_visual_evidence_required', candidateId: blocked.task.candidateId,
        sourceEventId: blocked.task.sourceEventId, eventId: factoryEventId('run-completion', f.runId) });
      const refusedHistory = { ...before, attempt: { ...before.attempt, output: { ...before.attempt.output, evidenceGate: gate } } };
      assert.deepEqual(await history(f.task.id, f.runId, f.task.attemptId), refusedHistory,
        'only the host refusal is appended; the successful run, session, evidence and exhausted result stay unchanged');
      const receipt = (await pool.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',
        [f.task.id, f.request.body.eventId])).rows[0];
      assert.equal(receipt.request.kind, 'owner_completion_recovery');
      assert.equal(receipt.result.task.status, 'blocked');
      assert.equal(receipt.result.refusal?.code, 'factory_visual_evidence_required');
      assert.equal(completedDispatches, 1);
      assert.deepEqual(await handleFactory(human, f.request), response, 'refused completion recovery replays without another dispatch');
      assert.equal(completedDispatches, 1);
      const retry = await handleFactory(human, { ...f.request, body: { ...f.request.body,
        binding: { taskId: blocked.task.id, revision: blocked.task.revision }, eventId: randomUUID(), reason: 'Record and submit the missing visual evidence' } });
      assert.equal(retry.status, 200);
      const pending = (await store.read('owner', f.task.id)).task;
      assert.equal(pending.stage, 'execute');
      assert.equal(pending.status, 'pending');
      assert.equal(pending.candidateId, null, 'the replacement producer must create its own candidate');
      assert.notEqual(pending.attemptId, f.task.attemptId);
      const producer = await dispatch('owner', { binding: factoryBinding(pending), agentId, deviceRepoId: repoId });
      assert.notEqual(producer.runId, f.runId);
      const queued = (await pool.query('SELECT status,"sessionId",report FROM agent_runs WHERE id=$1', [producer.runId])).rows[0];
      assert.deepEqual(queued, { status: 'queued', sessionId: null, report: null });
      const restarted = await store.read('owner', f.task.id);
      assert.equal(restarted.task.stage, 'execute');
      assert.equal(restarted.task.status, 'running');
      assert.equal(restarted.task.candidateId, null);
      assert.equal(restarted.attempts.length, 2);
      assert.ok(restarted.attempts.every(attempt => attempt.stage === 'execute'));
      assert.deepEqual(await history(f.task.id, f.runId, f.task.attemptId), refusedHistory);
      assert.deepEqual(await handleFactory(human, f.request), response, 'the old refusal remains replayable after a fresh producer starts');
      assert.equal(completedDispatches, 1);
    });

    await t.test('Profile Decision refusal preserves the submitted candidate, isolates Coordinator sweeps and retries only the unstarted check', async () => {
      const currentStore = createCurrentFactoryStore(pool, authorize, null, { independent: factoryCheckIndependent,
        gates: { ...factoryCheckGates, ...createFactoryApprovalGates() } });
      const execute = createFactoryDispatch(pool, currentStore, queue, { configure: { execute: async () => {} },
        freeze: async (tx, _task, id) => { await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id, JSON.stringify({ schemaVersion: 1, definitionDigest: 'fixture', harness: 'codex' })]); } });
      const review = createFactoryDispatch(pool, currentStore, queue, { ...defaultFactoryDispatchAdapters,
        freeze: async (tx, _task, id) => {
          const { rows: [run] } = await tx.query('SELECT prompt FROM agent_runs WHERE id=$1', [id]);
          await tx.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id,
            JSON.stringify(freezeWorkerDefinition({ harness: 'codex', instructions: 'Fixture', prompt: run.prompt, parent: null, executionId: null, readOnly: true }))]);
        } });
      const completed = async () => {
        const issue = randomUUID(), source = randomUUID();
        await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState") VALUES ($1,'owner','Profile Decision fixture','{"type":"doc","content":[]}','todo','normal',$2,'bound')`, [issue, workspaceId]);
        await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [source, source]);
        const routed = await currentStore.route('owner', { issueId: issue, sourceEventId: source, eventId: randomUUID(), rationale: 'Task requested', missingInformation: [], missingPermissions: [], needsSpec: false });
        const result = await execute('owner', { binding: factoryBinding(routed.task), agentId, deviceRepoId: repoId });
        await succeed(result.runId);
        return { task: result.task, runId: result.runId };
      };
      const refusals = new Map<string, Error>();
      const reviewRepos = new Map<string, string>();
      const decisions = new Map<string, number>();
      const rolledBackRuns: string[] = [];
      let starts = 0;
      const next = observeFactoryProfileDispatch(async (tx, targetStore, prior) => {
        const current = await targetStore.lockTask(tx, prior.userId, prior.id);
        if (current.status !== 'pending' || current.stage !== 'review') return;
        decisions.set(current.id, (decisions.get(current.id) ?? 0) + 1);
        const refusal = refusals.get(current.id);
        if (refusal) {
          if (refusal instanceof AgentProfileError && refusal.code === 'agentProfileDecisionUnavailable') {
            // Any work registered inside a failed dispatch must be discarded;
            // the completed producer/candidate outside it must still commit.
            const queued = await queue(tx, current.userId, { issueId: current.issueId, agentId, deviceRepoId: repoId }, current.botId, { sourceEventId: current.sourceEventId, attemptId: current.attemptId });
            rolledBackRuns.push(queued.runId);
            registerFactoryProfile(tx, { ownerId: current.userId, workspaceId: randomUUID() });
          }
          throw refusal;
        }
        await review(current.userId, { binding: factoryBinding(current), agentId, deviceRepoId: reviewRepos.get(current.id) ?? repoId }, tx);
        return async () => { starts++; };
      });
      const reconcile = createFactoryReconciler(pool, currentStore, undefined,
        { review: reconcileFactoryCheck, verify: reconcileFactoryCheck }, null, next);
      const failed = await completed(), healthy = await completed();
      const originalRun = (await pool.query('SELECT to_jsonb(r) AS value FROM agent_runs r WHERE id=$1', [failed.runId])).rows[0].value;
      refusals.set(failed.task.id, new AgentProfileError('agentProfileDecisionUnavailable'));
      await reconcile('owner');
      const blocked = await currentStore.read('owner', failed.task.id);
      assert.deepEqual({ stage: blocked.task.stage, status: blocked.task.status }, { stage: 'review', status: 'blocked' });
      assert.equal(blocked.task.route.flowVersion, 2);
      assert.ok(blocked.task.candidateId);
      assert.deepEqual(blocked.attempts.map(a => ({ stage: a.stage, status: a.status, runId: a.runId })), [
        { stage: 'execute', status: 'passed', runId: failed.runId }, { stage: 'review', status: 'blocked', runId: null },
      ]);
      assert.equal(blocked.candidates.length, 1);
      assert.equal(blocked.candidates[0].id, blocked.task.candidateId);
      assert.equal(blocked.candidates[0].runId, failed.runId);
      assert.equal(blocked.candidates[0].sha, 'b'.repeat(40));
      assert.deepEqual(blocked.attempts[1].output.dispatch, { code: 'agentProfileDecisionUnavailable' });
      assert.match(blocked.task.reason, /could not select an Agent Profile/);
      assert.deepEqual(blocked.checks?.map(check => ({ attemptId: check.attemptId, status: check.status, candidateId: check.candidateId, runId: check.runId })),
        [{ attemptId: blocked.task.attemptId, status: 'blocked', candidateId: blocked.task.candidateId, runId: null }]);
      assert.deepEqual((blocked as unknown as { checkDispatchRecovery?: unknown }).checkDispatchRecovery,
        { binding: { taskId: blocked.task.id, revision: blocked.task.revision } });
      assert.deepEqual((await pool.query('SELECT to_jsonb(r) AS value FROM agent_runs r WHERE id=$1', [failed.runId])).rows[0].value, originalRun);
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=ANY($1::uuid[])', [rolledBackRuns])).rowCount, 0);
      assert.equal((await currentStore.read('owner', healthy.task.id)).task.status, 'running', 'an unrelated task still queues its independent review');
      assert.equal(starts, 1);
      await reconcile('owner');
      assert.equal(decisions.get(failed.task.id), 1, 'normal Coordinator sweeps do not retry a known blocked Decision');
      assert.deepEqual(await currentStore.read('owner', failed.task.id), blocked, 'a read/sweep does not rewrite the blocked receipt');

      const human = createFactoryHumanStore(pool, () => currentStore, next);
      const retry = async () => {
        const current = (await currentStore.read('owner', failed.task.id)).task;
        const result = await handleFactory(human, { userId: 'owner', method: 'POST', taskId: current.id,
          origin: 'https://fixture.invalid', url: `https://fixture.invalid/api/factory/tasks/${current.id}`,
          body: { binding: { taskId: current.id, revision: current.revision }, eventId: randomUUID(), action: 'retry', reason: 'Retry the independent review' } });
        assert.equal(result.status, 200);
        const pending = (await currentStore.read('owner', current.id)).task;
        assert.equal(pending.status, 'pending');
        assert.equal(pending.stage, 'review');
        assert.equal(pending.candidateId, blocked.task.candidateId);
        assert.notEqual(pending.attemptId, current.attemptId);
        const tx = await pool.connect();
        try {
          await beginFactoryTransaction(tx);
          const start = await next(tx, currentStore, pending, {});
          await commitFactoryTransaction(tx);
          await start?.();
        } catch (error) { await rollbackFactoryTransaction(tx); throw error; }
        finally { forgetFactoryTransaction(tx); tx.release(); }
      };
      await retry();
      assert.equal((await currentStore.read('owner', failed.task.id)).task.status, 'blocked', 'Owner retry does not bypass the next strict Decision');
      assert.equal(decisions.get(failed.task.id), 2);
      assert.equal(starts, 1);
      refusals.delete(failed.task.id);
      await retry();
      const resumed = await currentStore.read('owner', failed.task.id);
      assert.equal(resumed.task.status, 'running');
      assert.equal(resumed.task.stage, 'review');
      assert.equal(resumed.task.candidateId, blocked.task.candidateId);
      assert.equal(decisions.get(failed.task.id), 3);
      assert.equal(resumed.attempts.filter(a => a.stage === 'execute').length, 1);
      assert.equal(resumed.attempts.filter(a => a.stage === 'review' && a.runId).length, 1);
      assert.equal(resumed.attempts.filter(a => a.stage === 'verify').length, 0);
      const resumedRun = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [resumed.attempts.at(-1)!.runId])).rows[0];
      assert.equal(resumedRun.kind, 'acceptance');
      assert.equal(resumedRun.sessionId, null);
      assert.equal(resumedRun.retryOf, null);
      assert.equal((await factoryCheckAssignment(pool, 'owner', resumedRun.id)).policy.readOnly, true);
      assert.equal(starts, 2);

      // ALEX67 already reached this older watchdog state before the fix. Owner
      // recovery must consume its submitted run, never re-run the producer.
      const exhausted = await completed();
      const deliverableRepo = randomUUID();
      reviewRepos.set(exhausted.task.id, deliverableRepo);
      await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,'owner','/home/user/.mikka/bot-workspaces/recovered-approval')`, [deliverableRepo, deviceId]);
      await pool.query(`UPDATE agent_runs SET "deviceRepoId"=$2,report=$3 WHERE id=$1`, [exhausted.runId, deliverableRepo,
        JSON.stringify({ sourceCommit: 'a'.repeat(40), deliverableCommit: 'b'.repeat(40), verify: { status: 'not_run' }, summary: 'Submitted delivery' })]);
      const clock = Date.now();
      for (const minutes of [0, 3, 8, 17]) await sweepFactoryWatchdog(pool, {
        runtime: () => ({ store: currentStore, reconcile: { run: async () => { throw new AgentProfileError('agentProfileDecisionUnavailable'); } } }),
        dispatch: async () => { throw new Error('A successful producer must not be dispatched again'); }, wake: async () => {},
      }, new Date(clock + minutes * 60_000), Date.now() + 20_000, { userId: 'owner', runId: exhausted.runId });
      const old = await currentStore.read('owner', exhausted.task.id);
      assert.deepEqual({ stage: old.task.stage, status: old.task.status, candidateId: old.task.candidateId }, { stage: 'execute', status: 'blocked', candidateId: null });
      assert.ok(old.completionRecovery);
      const oldHistory = await history(old.task.id, exhausted.runId, old.task.attemptId);
      refusals.set(old.task.id, new AgentProfileError('agentProfileDecisionUnavailable'));
      const ownerRequest = { userId: 'owner', method: 'POST', taskId: old.task.id, origin: 'https://fixture.invalid', url: `https://fixture.invalid/api/factory/tasks/${old.task.id}`,
        body: { binding: old.completionRecovery!.binding, eventId: randomUUID(), action: 'retry', reason: 'Resume the completed execution' } };
      const recovered = await handleFactory(human, ownerRequest);
      assert.equal(recovered.status, 200);
      assert.deepEqual(await handleFactory(human, ownerRequest), recovered, 'Owner completion receipt replays without another Decision');
      const after = await currentStore.read('owner', old.task.id);
      assert.deepEqual({ stage: after.task.stage, status: after.task.status }, { stage: 'review', status: 'blocked' });
      assert.equal(after.candidates.length, 1);
      assert.equal(after.candidates[0].runId, exhausted.runId);
      assert.equal(after.attempts.filter(a => a.stage === 'execute').length, 1);
      assert.equal(after.attempts.filter(a => a.runId).length, 1);
      assert.equal(after.attempts.at(-1)!.runId, null);
      assert.deepEqual(await history(old.task.id, exhausted.runId, old.task.attemptId), oldHistory, 'recovery preserves the original blocked history and completed native run');
      assert.equal(decisions.get(old.task.id), 1);
      assert.equal(starts, 2);
      assert.equal(after.completionRecovery, undefined);
      assert.deepEqual((after as unknown as { checkDispatchRecovery?: unknown }).checkDispatchRecovery,
        { binding: { taskId: after.task.id, revision: after.task.revision } });

      // Completion was consumed before the next-stage Decision refused. Its
      // immutable receipt remains Review blocked after a later Review passes.
      const preservedHistory = async () => {
        const current = await history(old.task.id, exhausted.runId, old.task.attemptId);
        return { ...current, watchdog: current.watchdog.filter(receipt => receipt.request.attemptId === old.task.attemptId) };
      };
      const receiptRows = async () => (await pool.query(`SELECT to_jsonb(e) AS value FROM factory_events e
        WHERE "taskId"=$1 AND "eventId"=ANY($2::uuid[]) ORDER BY "eventId"`,
      [old.task.id, [ownerRequest.body.eventId, factoryEventId('run-completion', exhausted.runId)]])).rows;
      const savedReceipts = await receiptRows();
      assert.equal(savedReceipts.length, 2);
      const ownerReceipt = savedReceipts.find(row => row.value.eventId === ownerRequest.body.eventId)!.value;
      assert.equal(ownerReceipt.request.kind, 'owner_completion_recovery');
      assert.equal(ownerReceipt.result.task.stage, 'review');
      assert.equal(ownerReceipt.result.task.status, 'blocked');
      assert.equal(after.candidates[0].kind, 'deliverable');
      assert.equal(after.candidates[0].sha, null, 'the delivery HEAD is not the candidate.sha field');

      refusals.delete(old.task.id);
      const reviewRetry = await handleFactory(human, { ...ownerRequest,
        body: { ...ownerRequest.body, binding: { taskId: after.task.id, revision: after.task.revision }, eventId: randomUUID(), reason: 'Retry the independent review' } });
      assert.equal(reviewRetry.status, 200);
      const pendingReview = await currentStore.read('owner', old.task.id);
      assert.equal(pendingReview.task.stage, 'review');
      assert.equal(pendingReview.task.status, 'pending');
      // Only this disposable task enters the existing cron observation window.
      const observedAt = new Date(Date.now() - 30_000);
      await pool.query('UPDATE factory_tasks SET "updatedAt"=$2 WHERE id=$1', [old.task.id, new Date(observedAt.getTime() - 61_000)]);
      await sweepFactoryWatchdog(pool, { runtime: () => ({ store: currentStore, reconcile }), dispatch: next, wake: async () => {} }, observedAt);
      const runningReview = await currentStore.read('owner', old.task.id);
      assert.equal(runningReview.task.status, 'running');
      assert.equal(runningReview.task.candidateId, after.task.candidateId);
      const reviewer = runningReview.attempts.find(attempt => attempt.id === runningReview.task.attemptId)!;
      assert.ok(reviewer.runId);
      assert.notEqual(reviewer.runId, exhausted.runId);
      const watchdogHistory = (await history(old.task.id, exhausted.runId, old.task.attemptId)).watchdog;
      assert.equal(watchdogHistory.length, oldHistory.watchdog.length + 1, 'the real cron appends only its new Review attempt receipt');
      assert.equal(watchdogHistory.filter(receipt => receipt.request.attemptId === reviewer.id).length, 1);
      const assigned = await factoryCheckAssignment(pool, 'owner', reviewer.runId);
      assert.equal(assigned.baseBranch, 'b'.repeat(40), 'the independent check uses the actual submitted delivery HEAD');
      const reviewSession = 'independent-recovered-review';
      await pool.query(`UPDATE agent_runs SET status='running',"sessionId"=$2,"startedAt"=now() WHERE id=$1`, [reviewer.runId, reviewSession]);
      // Use the real completion transaction: it projects the successful report
      // to issue Review, which human acceptance may then move to Done. A
      // manually reopened Todo issue is deliberately not closed by acceptance.
      const { createRequestDatabaseScope } = await import('../db');
      const { persistRunCompletion } = await import('../run-publications');
      const completionScope = createRequestDatabaseScope(target.toString());
      try {
        const completed = await completionScope.run(() => persistRunCompletion('owner', reviewer.runId!, {
          stopReason: 'submitted', report: runReport.parse({ summary: 'Independent synthetic delivery check',
            check: { sha: assigned.baseBranch, readOnly: true }, verify: { status: 'not_run' }, filesChanged: [],
            openQuestions: [], nextStep: null, criteria: [{ text: 'Submitted delivery', passed: true, evidence: 'Synthetic isolated PG check' }] }),
        }, deviceId));
        assert.equal(completed?.review?.id, old.task.issueId);
        assert.equal((await pool.query('SELECT status FROM issues WHERE id=$1', [old.task.issueId])).rows[0].status, 'review');
      } finally { await completionScope.close(); }
      await reconcile.run('owner', reviewer.runId);
      const ready = await currentStore.read('owner', old.task.id);
      assert.equal(ready.task.stage, 'approval');
      assert.equal(ready.task.status, 'pending');
      assert.equal(ready.task.route.flowVersion, 2);
      assert.equal(ready.attempts.find(attempt => attempt.id === reviewer.id)!.status, 'passed');
      assert.equal(ready.attempts.filter(attempt => attempt.stage === 'verify').length, 0);

      const sessionId = randomUUID();
      await pool.query(`INSERT INTO "session"(id,"userId",token,"expiresAt","createdAt","updatedAt")
        VALUES($1,'owner',$2,now()+interval '1 hour',now(),now())`, [sessionId, randomUUID()]);
      const approvals = createFactoryApprovals(pool, authorize, currentStore);
      const request = { actor: { userId: 'owner', sessionId }, authorization: null, method: 'GET', taskId: old.task.id,
        origin: null, url: 'https://fixture.invalid/api/factory/tasks/' + old.task.id + '/approval' };
      assert.equal((await handleFactoryApproval(approvals, { ...request, url: request.url + '?view=ledger' })).status, 200);
      const evidenceReply = await handleFactoryApproval(approvals, request);
      assert.equal(evidenceReply.status, 200, JSON.stringify(evidenceReply.body));
      const evidenceBody = evidenceReply.body;
      assert.ok(evidenceBody && typeof evidenceBody === 'object' && 'manifest' in evidenceBody && 'binding' in evidenceBody);
      const manifest = evidenceBody.manifest;
      assert.ok(manifest && typeof manifest === 'object' && 'candidateId' in manifest && 'candidate' in manifest && 'artifacts' in manifest);
      assert.equal(manifest.candidateId, after.task.candidateId);
      assert.ok(manifest.candidate && typeof manifest.candidate === 'object' && 'sha' in manifest.candidate);
      assert.equal(manifest.candidate.sha, null);
      assert.ok(Array.isArray(manifest.artifacts));
      const artifacts = manifest.artifacts.map((item: unknown) => {
        assert.ok(item && typeof item === 'object' && 'stage' in item && 'runId' in item && 'sessionId' in item && 'kind' in item);
        return item;
      });
      const reports = artifacts.filter(item => item.kind === 'report');
      assert.deepEqual(reports.map(item => item.stage), ['execute', 'review']);
      assert.deepEqual(reports.map(item => item.runId), [exhausted.runId, reviewer.runId]);
      assert.deepEqual(artifacts.filter(item => item.kind === 'screenshot').map(item => item.runId), [exhausted.runId]);
      assert.ok('completionRecoveryEventId' in reports[0]);
      assert.equal(reports[0].completionRecoveryEventId, ownerRequest.body.eventId);
      assert.equal(new Set(artifacts.map(item => item.sessionId)).size, 2);
      assert.deepEqual(await receiptRows(), savedReceipts, 'displaying evidence never rewrites either successful completion or Owner recovery receipt');
      assert.deepEqual(await preservedHistory(), oldHistory);

      const corruptions: [string, unknown[]][] = [
        [`UPDATE agent_runs SET status='failed' WHERE id=$1`, [exhausted.runId]],
        [`UPDATE factory_events SET request=jsonb_set(request,'{sourceEventId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [old.task.id, ownerRequest.body.eventId, randomUUID()]],
        [`UPDATE factory_events SET result=jsonb_set(result,'{task,candidateId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [old.task.id, ownerRequest.body.eventId, randomUUID()]],
        [`UPDATE factory_events SET result=jsonb_set(result,'{task,status}','"failed"') WHERE "taskId"=$1 AND "eventId"=$2`, [old.task.id, ownerRequest.body.eventId]],
        [`UPDATE factory_events SET result=jsonb_set(result,'{task,stage}','"approval"') WHERE "taskId"=$1 AND "eventId"=$2`, [old.task.id, ownerRequest.body.eventId]],
        [`UPDATE factory_events SET request=jsonb_set(request,'{change,status}','"failed"') WHERE "taskId"=$1 AND "eventId"=$2`, [old.task.id, factoryEventId('run-completion', exhausted.runId)]],
        [`UPDATE factory_attempts SET "sessionId"='s1' WHERE id=$1`, [reviewer.id]],
        ['DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [old.task.id, ownerRequest.body.eventId]],
      ];
      const evidenceTx = await pool.connect();
      try {
        for (const [sql, values] of corruptions) {
          await evidenceTx.query('BEGIN');
          try {
            await evidenceTx.query(sql, values);
            await assert.rejects(approvalEvidence(evidenceTx, ready.task), /factoryIndependentEvidenceRequired|factoryEvidenceMismatch/);
          } finally { await evidenceTx.query('ROLLBACK'); }
        }
      } finally { evidenceTx.release(); }
      assert.deepEqual(await receiptRows(), savedReceipts);
      assert.deepEqual(await preservedHistory(), oldHistory);

      let githubCalls = 0;
      const noGitHub = async () => { githubCalls++; throw new Error('Deliverable acceptance must not call GitHub'); };
      const merges = createFactoryMerges(pool, authorize, currentStore, { pullRequest: noGitHub, mergeMethods: noGitHub, merge: noGitHub });
      const acceptRequest = { ...request, method: 'POST', origin: 'https://fixture.invalid',
        body: { operation: 'accept', input: { binding: evidenceBody.binding, eventId: randomUUID() } } };
      const accepted = await handleFactoryApproval(approvals, acceptRequest, merges);
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.ok(accepted.body && typeof accepted.body === 'object' && 'status' in accepted.body);
      assert.equal(accepted.body.status, 'accepted');
      const acceptedTask = (await currentStore.read('owner', old.task.id)).task;
      assert.equal(acceptedTask.stage, 'approval');
      assert.equal(acceptedTask.status, 'passed');
      assert.equal(acceptedTask.candidateId, after.task.candidateId);
      assert.equal((await pool.query('SELECT status FROM issues WHERE id=$1', [old.task.issueId])).rows[0].status, 'done');
      assert.deepEqual(await handleFactoryApproval(approvals, acceptRequest, merges), accepted, 'the normal acceptance replays its one durable receipt');
      assert.equal((await pool.query('SELECT 1 FROM factory_deliverable_acceptances WHERE "taskId"=$1 AND "candidateId"=$2',
        [old.task.id, after.task.candidateId])).rowCount, 1);
      assert.equal(githubCalls, 0);
      assert.deepEqual(await receiptRows(), savedReceipts);
      assert.deepEqual(await preservedHistory(), oldHistory);

      for (const refusal of [new Error('Unexpected dispatch error'), Object.assign(new Error('Untrusted Decision code'), { code: 'agentProfileDecisionUnavailable' }), new AgentProfileError('agentProfileScopeNotFound', 404)]) {
        const denied = await completed();
        refusals.set(denied.task.id, refusal);
        await assert.rejects(reconcile.run('owner', denied.runId), error => error === refusal);
        const unchanged = await currentStore.read('owner', denied.task.id);
        assert.equal(unchanged.task.stage, 'execute');
        assert.equal(unchanged.task.status, 'running');
        assert.equal(unchanged.task.candidateId, null);
        assert.equal(unchanged.attempts.length, 1);
      }
    });

    await t.test('Owner Retry consumes exhausted successful completion once, keeps history and queues only fresh independent review', async () => {
      const f = await exhaustedCompletion();
      const before = await history(f.task.id, f.runId, f.task.attemptId);
      await sweep.run('owner', f.runId);
      assert.equal((await store.read('owner', f.task.id)).task.status, 'blocked', 'ordinary completion replay has no owner authority');
      assert.ok((await store.read('owner', f.task.id)).completionRecovery);
      assert.deepEqual((await store.listForIssue('owner', f.task.issueId)).tasks.find(task => task.id === f.task.id)?.completionRecovery,
        { binding: { taskId: f.task.id, revision: f.task.revision } }, 'the normal issue list exposes only the eligible host binding');
      let starts = 0, queued = 0;
      const reviewDispatch = createFactoryDispatch(pool, store, async (...args) => { queued++; return queue(...args); }, defaultFactoryDispatchAdapters);
      const human = createFactoryHumanStore(pool, () => store, async (tx, _store, current, run) => {
        assert.equal(current.stage, 'review');
        assert.equal(run.id, f.runId);
        await reviewDispatch('owner', { binding: factoryBinding(current), agentId, deviceRepoId: repoId }, tx);
        return async () => { starts++; };
      });
      const [a, b] = await Promise.all([handleFactory(human, f.request), handleFactory(human, f.request)]);
      assert.equal(a.status, 200);
      assert.deepEqual(b, a, 'concurrent receipt replay returns the identical result');
      assert.deepEqual({ starts, queued }, { starts: 1, queued: 1 });
      assert.deepEqual(await history(f.task.id, f.runId, f.task.attemptId), before, 'the producer, blocked attempt and exhausted watchdog receipt stay byte-for-byte equal');
      const current = (await store.read('owner', f.task.id)).task;
      assert.deepEqual({ stage: current.stage, status: current.status }, { stage: 'review', status: 'running' });
      assert.equal((await store.listForIssue('owner', f.task.issueId)).tasks.find(task => task.id === f.task.id)?.completionRecovery, undefined);
      const { rows: runs } = await pool.query(`SELECT r.* FROM agent_runs r JOIN factory_attempts a ON a."runId"=r.id WHERE a."taskId"=$1 ORDER BY a.position`, [f.task.id]);
      assert.equal(runs.length, 2);
      assert.equal(runs[0].id, f.runId);
      assert.equal(runs[1].kind, 'acceptance');
      assert.equal(runs[1].sessionId, null);
      assert.equal(runs[1].retryOf, null);
      const assignment = await factoryCheckAssignment(pool, 'owner', runs[1].id);
      assert.equal(assignment.policy.readOnly, true, 'the actual claim assignment enforces the frozen independent read-only policy');
      const frozenCheck = (await store.read('owner', f.task.id)).attempts.find(a => a.id === current.attemptId)!.output.check as { candidateId: string; sha: string };
      assert.equal(frozenCheck.candidateId, current.candidateId);
      assert.equal(frozenCheck.sha, 'b'.repeat(40));
      const candidate = (await pool.query('SELECT * FROM factory_candidates WHERE "taskId"=$1', [f.task.id])).rows[0];
      assert.equal(candidate.runId, f.runId);
      assert.equal(candidate.sha, 'b'.repeat(40));
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM factory_attempts WHERE "taskId"=$1 AND stage='execute'`, [f.task.id])).rows[0].n, 1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='owner_completion_recovery'`, [f.task.id])).rows[0].n, 1);
      assert.deepEqual(await handleFactory(human, f.request), a);
      assert.equal(starts, 1);
      assert.equal((await handleFactory(human, { ...f.request, body: { ...f.request.body, reason: 'different intent' } })).status, 409);
    });

    await t.test('completion recovery rejects stale/foreign/forged epoch authority and does not fall through to a producer retry', async () => {
      for (const fault of ['owner', 'revision', 'epoch', 'receipt', 'candidate', 'publication']) {
        const f = await exhaustedCompletion();
        if (fault === 'epoch') await pool.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{requestEpoch}',to_jsonb($2::text)) WHERE id=$1`, [f.task.attemptId, randomUUID()]);
        if (fault === 'receipt') await pool.query(`DELETE FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_watchdog'`, [f.task.id]);
        if (fault === 'candidate') await pool.query(`UPDATE agent_runs SET report=jsonb_set(report,'{verify,status}','"failed"') WHERE id=$1`, [f.runId]);
        if (fault === 'publication') await pool.query(`INSERT INTO run_publications("runId","userId","issueId","remoteUrl","remoteKey",status)
          VALUES($1,'owner',$2,'https://github.com/acme/fixture.git','github:acme/fixture','processing')`, [f.runId,f.task.issueId]);
        const before = await history(f.task.id, f.runId, f.task.attemptId);
        const human = createFactoryHumanStore(pool, () => store, async () => { throw new Error('must not dispatch'); });
        const response = await handleFactory(human, { ...f.request, userId: fault === 'owner' ? 'foreign' : 'owner',
          body: fault === 'revision' ? { ...f.request.body, binding: { ...f.request.body.binding, revision: f.task.revision - 1 } } : f.request.body });
        assert.equal(response.status, fault === 'owner' ? 404 : 409, fault);
        assert.deepEqual(await history(f.task.id, f.runId, f.task.attemptId), before, fault);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_candidates WHERE "taskId"=$1', [f.task.id])).rows[0].n, 0, fault);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_attempts WHERE "taskId"=$1', [f.task.id])).rows[0].n, 1, fault);
      }
    });

    await t.test('owner completion recovery retains the exact no-repository deliverable candidate and original session', async () => {
      const f = await exhaustedCompletion();
      const deliverableRepo = randomUUID();
      await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,'owner','/home/user/.mikka/bot-workspaces/completion-fixture')`, [deliverableRepo,deviceId]);
      await pool.query(`UPDATE agent_runs SET "deviceRepoId"=$2,report=$3 WHERE id=$1`, [f.runId,deliverableRepo,JSON.stringify({ sourceCommit: 'a'.repeat(40), deliverableCommit: 'b'.repeat(40), verify: { status: 'not_run' }, summary: 'Exact retained deliverable' })]);
      const before = await history(f.task.id, f.runId, f.task.attemptId);
      const response = await handleFactory(createFactoryHumanStore(pool, () => store), f.request);
      assert.equal(response.status, 200);
      const state = await store.read('owner', f.task.id);
      assert.deepEqual({ stage: state.task.stage, status: state.task.status }, { stage: 'review', status: 'pending' });
      assert.equal(state.candidates.length, 1);
      assert.equal(state.candidates[0].kind, 'deliverable');
      assert.equal(state.candidates[0].sha, null);
      assert.equal(state.candidates[0].runId, f.runId);
      assert.equal(state.candidates[0].repository, '/home/user/.mikka/bot-workspaces/completion-fixture');
      assert.deepEqual(await history(f.task.id, f.runId, f.task.attemptId), before);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [f.task.issueId])).rows[0].n, 1, 'completion consumption never replays the producer');
    });

    await t.test('failed next-stage admission rolls completion recovery back; a later owner retry consumes the same successful producer', async () => {
      const f = await exhaustedCompletion();
      const before = await history(f.task.id, f.runId, f.task.attemptId);
      let unavailable = true;
      const human = createFactoryHumanStore(pool, () => store, async () => {
        if (unavailable) throw new Error('Fixture admission unavailable');
      });
      await assert.rejects(handleFactory(human, f.request), /Fixture admission unavailable/);
      assert.deepEqual(await history(f.task.id, f.runId, f.task.attemptId), before);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM factory_candidates WHERE "taskId"=$1', [f.task.id])).rows[0].n, 0);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='owner_completion_recovery'`, [f.task.id])).rows[0].n, 0);
      unavailable = false;
      assert.equal((await handleFactory(human, f.request)).status, 200);
      assert.equal((await store.read('owner', f.task.id)).task.stage, 'review');
      assert.deepEqual(await history(f.task.id, f.runId, f.task.attemptId), before);
    });

    await t.test('recovered completion carries the consumed Owner answer through real independent checks and approval without rewriting blocked history', async () => {
      const f = await exhaustedCompletion();
      const originId = randomUUID(), originAttemptId = randomUUID(), questionId = randomUUID(), questionEventId = randomUUID();
      const deliverableRepo = randomUUID(), answerId = randomUUID();
      const oldTarget = 'Original issue target: exactly 56 bytes.';
      const expectedHash = createHash('sha256').update('x'.repeat(84) + '\n').digest('hex');
      const ownerText = `The answered target is exactly 85 bytes, SHA256 ${expectedHash}. Keep all other requirements. token=fixture-private`;
      await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,'owner','/home/user/.mikka/bot-workspaces/answered-fixture')`, [deliverableRepo, deviceId]);
      await pool.query(`UPDATE agent_runs SET "deviceRepoId"=$2,report=$3 WHERE id=$1`, [f.runId, deliverableRepo,
        JSON.stringify({ sourceCommit: 'a'.repeat(40), deliverableCommit: 'b'.repeat(40), verify: { status: 'not_run' }, summary: 'Producer observation: 56 bytes; this report is not a new owner requirement.' })]);
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"stopReason","sessionId","agentDefinition",prompt)
        SELECT $2,"userId","issueId","agentId","deviceId","deviceRepoId",'stopped','asked_human','s1',"agentDefinition",'Original owner task' FROM agent_runs WHERE id=$1`, [f.runId, originId]);
      await pool.query(`UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1`, [f.runId,
        JSON.stringify({ questionId, originRunId: originId, originSessionId: 's1', requireSessionResume: true })]);
      await pool.query(`UPDATE factory_attempts SET position=2,ordinal=2,output=output-'requestEpoch' WHERE id=$1`, [f.task.attemptId]);
      await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId","sessionId",reason)
        VALUES($1,$2,'execute',1,1,'waiting',$3,'s1','Owner answer required')`, [originAttemptId, f.task.id, originId]);
      await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES($1::uuid,'owner','run_question',$1::text,'{}')`, [questionEventId]);
      const waiting = { taskId: f.task.id, issueId: f.task.issueId, attemptId: originAttemptId, candidateId: null, revision: 2 };
      const input = humanQuestionAnswerSchema.parse({ answerId, text: ownerText, reference: { questionId, questionRevision: 1, binding: waiting, originRunId: originId, originSessionId: 's1' } });
      const answer = { source: 'human', userId: 'owner', input };
      await pool.query(`INSERT INTO factory_questions(id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,context,request,status,revision,reason,"sourceEventId","answerId","answerSource",answer,"answerFingerprint","answeredAt","continuationRunId",result)
        VALUES($1,'owner',$2,$3,$4,'execute',$5,'s1',1,$6,'external','Which target?','UNRELATED PRIVATE RFI CONTEXT','{}','resolved',3,'Answered',$7,$8,'human',$9,$10,now(),$11,$12)`,
        [questionId, f.task.issueId, f.task.id, originAttemptId, originId, JSON.stringify(waiting), questionEventId, answerId, JSON.stringify(answer), questionFingerprint(answer), f.runId,
          JSON.stringify({ questionId, continuationRunId: randomUUID(), task: { ...f.task, attemptId: randomUUID() } })]);
      const before = await history(f.task.id, f.runId, f.task.attemptId);
      const originalQuestion = (await pool.query('SELECT to_jsonb(q) AS value FROM factory_questions q WHERE id=$1', [questionId])).rows[0].value;
      const checkedStore = createFactoryStore(pool, authorize, factoryCheckGates);
      const checkDispatch = createFactoryDispatch(pool, checkedStore, async (...args) => {
        const queued = await queue(...args);
        await args[0].query('UPDATE agent_runs SET prompt=$2 WHERE id=$1', [queued.runId, oldTarget]);
        return queued;
      }, defaultFactoryDispatchAdapters);
      const human = createFactoryHumanStore(pool, () => checkedStore, async (tx, _store, current) => {
        await checkDispatch('owner', { binding: factoryBinding(current), agentId, deviceRepoId: deliverableRepo }, tx);
      });
      assert.equal((await handleFactory(human, f.request)).status, 200);
      const candidate = (await checkedStore.read('owner', f.task.id)).candidates[0];
      for (const stage of ['review', 'verify'] as const) {
        const current = (await checkedStore.read('owner', f.task.id)).task;
        assert.equal(current.stage, stage);
        const run = (await pool.query('SELECT r.* FROM agent_runs r JOIN factory_attempts a ON a."runId"=r.id WHERE a.id=$1', [current.attemptId])).rows[0];
        assert.match(run.prompt, /Saved Owner answer already consumed by this candidate/);
        assert.ok(run.prompt.includes(`exactly 85 bytes, SHA256 ${expectedHash}`));
        assert.ok(run.prompt.includes(oldTarget), 'the conflicting original text remains historical, not rewritten');
        assert.ok(run.prompt.indexOf('exactly 85 bytes') < run.prompt.indexOf(oldTarget));
        assert.match(run.prompt, /supersedes conflicting original issue wording/);
        assert.doesNotMatch(run.prompt, /fixture-private|UNRELATED PRIVATE RFI CONTEXT/);
        const sessionId = `independent-${stage}`;
        await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp(),report=$3 WHERE id=$1`,
          [run.id, sessionId, JSON.stringify({ check: { sha: 'b'.repeat(40), readOnly: true }, verify: { status: 'not_run' }, filesChanged: [], criteria: [{ text: 'Saved 85-byte owner target', passed: true, evidence: 'Synthetic isolated DB observation' }] })]);
        const finished = (await pool.query('SELECT "finishedAt" FROM agent_runs WHERE id=$1', [run.id])).rows[0].finishedAt;
        const passed = await checkedStore.apply('owner', factoryBinding(current), randomUUID(), { action: 'finish', status: 'passed', reason: 'Independent fixture check', output: {},
          evidence: [{ artifact: `run-report:${run.id}`, kind: 'report', runId: run.id, sessionId, candidateId: candidate.id, sha: null, environment: candidate.environment, recordedAt: finished.toISOString() }] });
        const next = await checkedStore.apply('owner', factoryBinding(passed.task), randomUUID(), { action: 'advance', stage: stage === 'review' ? 'verify' : 'approval', reason: 'Independent fixture evidence complete' });
        if (stage === 'review') await checkDispatch('owner', { binding: factoryBinding(next.task), agentId, deviceRepoId: deliverableRepo });
      }
      const ready = (await checkedStore.read('owner', f.task.id)).task;
      const tx = await pool.connect();
      try {
        const evidence = await approvalEvidence(tx, ready);
        assert.deepEqual(evidence.manifest.artifacts.map(x => x.stage), ['execute', 'review', 'verify']);
        assert.equal(evidence.manifest.artifacts[0].runId, f.runId);
        assert.equal(evidence.manifest.artifacts[0].completionRecoveryEventId, f.request.body.eventId);
        assert.equal(evidence.manifest.artifacts[0].completionEventId, factoryEventId('run-completion', f.runId));
        assert.equal(new Set(evidence.manifest.artifacts.map(x => x.sessionId)).size, 3);
        assert.deepEqual(await history(f.task.id, f.runId, f.task.attemptId), before);
        assert.deepEqual((await pool.query('SELECT to_jsonb(q) AS value FROM factory_questions q WHERE id=$1', [questionId])).rows[0].value, originalQuestion);
        const corruptions: [string, unknown[]][] = [
          ['DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.request.body.eventId]],
          ['DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, factoryEventId('run-completion', f.runId)]],
          [`UPDATE factory_events SET request=jsonb_set(request,'{sourceEventId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, f.request.body.eventId, randomUUID()]],
          [`UPDATE factory_events SET result=jsonb_set(result,'{task,candidateId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, f.request.body.eventId, randomUUID()]],
          [`UPDATE factory_events SET request=jsonb_set(request,'{change,status}','"failed"') WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, factoryEventId('run-completion', f.runId)]],
          [`UPDATE factory_attempts SET "sessionId"='s1' WHERE "taskId"=$1 AND stage='verify'`, [f.task.id]],
        ];
        for (const [sql, values] of corruptions) {
          await tx.query('BEGIN');
          try { await tx.query(sql, values); await assert.rejects(approvalEvidence(tx, ready), /factoryIndependentEvidenceRequired|factoryEvidenceMismatch/); }
          finally { await tx.query('ROLLBACK'); }
        }
        const invalidAnswers: [string, unknown[]][] = [
          [`UPDATE factory_questions SET "answerFingerprint"='wrong' WHERE id=$1`, [questionId]],
          [`UPDATE factory_questions SET "userId"='foreign' WHERE id=$1`, [questionId]],
          [`UPDATE factory_attempts SET output=jsonb_set(output,'{requestEpoch}',to_jsonb($2::text)) WHERE id=$1`, [f.task.attemptId, randomUUID()]],
          [`UPDATE agent_runs SET "questionContinuation"=jsonb_set("questionContinuation",'{originSessionId}','"different-session"') WHERE id=$1`, [f.runId]],
          [`UPDATE agent_runs SET "questionContinuation"=NULL WHERE id=$1`, [f.runId]],
        ];
        for (const [sql, values] of invalidAnswers) {
          await tx.query('BEGIN');
          try { await tx.query(sql, values); await assert.rejects(currentFactoryRequest(tx, ready), /factorySourceMismatch/); }
          finally { await tx.query('ROLLBACK'); }
        }
      } finally { tx.release(); }
    });

    await t.test("completed run moves execute → review via the completion hook alone", async () => {
      const report = { publish: { commit: "b".repeat(40) }, verify: { status: "passed" }, summary: "done" };
      // A3: the run's ready captures become evidence by reference; failed or unfinished ones do not.
      const shot = randomUUID(), clip = randomUUID(), broken = randomUUID();
      await addFactoryVisualEvidence(pool, d.runId, { captureId: shot });
      await addFactoryVisualEvidence(pool, d.runId, { captureId: clip, kind: 'video' });
      await addFactoryVisualEvidence(pool, d.runId, { captureId: broken });
      await pool.query("UPDATE run_captures SET status='failed' WHERE id=$1", [broken]);
      await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"='s1',report=$2,"startedAt"=now()-interval '1 minute',"finishedAt"=clock_timestamp() WHERE id=$1`, [d.runId, JSON.stringify(report)]);
      assert.equal(await reconcileFactoryAfterCompletion(pool, "owner", d.runId, reconcileFor), 1);
      const after = await store.read("owner", routed.task.id);
      assert.equal(after.task.stage, "review");
      const { rows: [execute] } = await pool.query(`SELECT evidence FROM factory_attempts WHERE "taskId"=$1 AND stage='execute' AND status='passed'`, [routed.task.id]);
      assert.deepEqual(execute.evidence.map((e: { artifact: string; kind: string }) => [e.artifact, e.kind]),
        [[`run-report:${d.runId}`, "report"], [`run-capture:${shot}`, "screenshot"], [`run-capture:${clip}`, "video"]]);
      // The unrelated running task (its own run still running) did not move.
      assert.deepEqual(pick((await store.read("owner", other.task.id)).task), pick(otherBefore));
    });

    await t.test("an old run's completion after the attempt was replaced does not move the task", async () => {
      const stale = await runningTask();
      await succeed(stale.runId); // the old run ends; its completion hook is delayed
      // Meanwhile the attempt is replaced (finish failed + retry → fresh execute attempt, no run yet).
      let cur = (await store.read("owner", stale.task.id)).task;
      const failed = await store.apply("owner", factoryBinding(cur), randomUUID(), { action: "finish", status: "failed", reason: "replaced", evidence: [], output: {} });
      await store.apply("owner", factoryBinding(failed.task), randomUUID(), { action: "retry", reason: "replaced" });
      cur = (await store.read("owner", stale.task.id)).task;
      assert.equal(await reconcileFactoryAfterCompletion(pool, "owner", stale.runId, reconcileFor), 1);
      const after = (await store.read("owner", stale.task.id)).task;
      assert.deepEqual({ stage: after.stage, status: after.status, attemptId: after.attemptId, revision: after.revision }, { stage: cur.stage, status: cur.status, attemptId: cur.attemptId, revision: cur.revision });
    });

    await t.test("attempt replaced between selection and lock: the stale item is skipped (QA 5)", async () => {
      const race = await runningTask();
      await succeed(race.runId);
      let fresh = "";
      // Same pool, but the moment `.run` has selected its pending items, the attempt is
      // replaced and the replacement's own run also finishes (its hook not yet fired).
      const racing = new Proxy(pool, { get(target, key) {
        if (key !== "query") { const v = Reflect.get(target, key); return typeof v === "function" ? v.bind(target) : v; }
        return async (text: string, params?: unknown[]) => {
          const res = await target.query(text, params);
          if (!fresh && typeof text === "string" && text.includes('AS "attemptId"')) {
            const cur = (await store.read("owner", race.task.id)).task;
            const failed = await store.apply("owner", factoryBinding(cur), randomUUID(), { action: "finish", status: "failed", reason: "replaced", evidence: [], output: {} });
            const retried = await store.apply("owner", factoryBinding(failed.task), randomUUID(), { action: "retry", reason: "replaced" });
            fresh = (await dispatch("owner", { binding: factoryBinding(retried.task), agentId, deviceRepoId: repoId })).runId;
            await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [fresh]);
            await succeed(fresh);
          }
          return res;
        };
      } }) as typeof pool;
      const racer = createFactoryReconciler(racing, store, questions);
      await racer.run("owner", race.runId);
      assert.ok(fresh);
      const after = (await store.read("owner", race.task.id)).task;
      assert.equal(after.stage, "execute", "old run's completion must not advance the replacement attempt");
      assert.notEqual(after.attemptId, race.task.attemptId);
    });

    await t.test("a failed run is a visible failure that re-enters the capped retry loop", async () => {
      const f = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='boom',"finishedAt"=clock_timestamp() WHERE id=$1`, [f.runId]);
      await reconcileFactoryAfterCompletion(pool, "owner", f.runId, reconcileFor);
      const after = (await store.read("owner", f.task.id)).task;
      assert.deepEqual({ stage: after.stage, status: after.status }, { stage: "execute", status: "pending" });
      assert.notEqual(after.attemptId, f.task.attemptId);
      const { rows: [old] } = await pool.query(`SELECT status, output FROM factory_attempts WHERE id=$1`, [f.task.attemptId]);
      assert.equal(old.status, "failed");
      assert.equal(old.output?.reasonCode, "run_failed");
    });

    await t.test('provider handoff binds the queued child before commit and replay never dispatches a second attempt', async () => {
      const f = await providerSource();
      const tx = await pool.connect();
      let childId: string;
      try {
        await tx.query('BEGIN');
        childId = await providerChild(tx, f.runId);
        assert.equal(await adoptProviderContinuation(tx, 'owner', f.runId, childId, () => store), 1);
        const bound = (await tx.query('SELECT a."runId",t.status FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE t.id=$1', [f.task.id])).rows[0];
        assert.deepEqual(bound, { runId: childId, status: 'running' });
        assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=$1', [childId])).rowCount, 0, 'queue and Factory binding remain invisible until their single commit');
        await tx.query('COMMIT');
      } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
      const before = await store.read('owner', f.task.id);
      assert.equal(before.attempts.find(a => a.runId === f.runId)!.output.recovery, 'provider_failure');
      await Promise.all([sweep.run('owner', f.runId), sweep.run('owner', childId!)]);
      const after = await store.read('owner', f.task.id);
      assert.equal(after.task.attemptId, before.task.attemptId);
      assert.equal(after.attempts.length, 2);
    });

    await t.test('provider review handoff keeps the exact candidate and independent check policy across harnesses and owned devices', async () => {
      const f = await providerSource();
      await succeed(f.runId);
      await pool.query(`UPDATE agent_runs SET report=report || $2::jsonb WHERE id=$1`, [f.runId, JSON.stringify({ sourceCommit: 'b'.repeat(40) })]);
      await sweep.run('owner', f.runId);
      const pending = (await store.read('owner', f.task.id)).task;
      assert.equal(pending.stage, 'review');
      const reviewDispatch = createFactoryDispatch(pool, store, queue, defaultFactoryDispatchAdapters);
      const review = await reviewDispatch('owner', { binding: factoryBinding(pending), agentId, deviceRepoId: providerRepoId });
      const original = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [review.runId])).rows[0];
      const profileApi = await import('./agent-profile');
      const { assertRunProfileClaim } = await import('./profile-admission');
      const profileId = randomUUID();
      const role = profileApi.parseAgentProfile({ name: 'Independent review', harness: 'auto', model: { mode: 'inherit' }, instructions: 'Keep the frozen independent review responsibility.' });
      const beforeDefinition = providerDefinition('codex', original.prompt);
      const selectedProfile = { profileId, version: 1, digest: profileApi.agentProfileDigest(role, []), name: role.name,
        source: 'decision' as const, reason: 'Fixture role selection', scope: { ownerId: 'owner', workspaceId: providerWorkspaceId },
        definition: role, skills: [], instructions: role.instructions, targetEntry: beforeDefinition.modelDispatch!.entry! };
      const frozenDefinition = { ...beforeDefinition, instructions: `${beforeDefinition.instructions}\n\n${role.instructions}`, agentProfile: selectedProfile };
      frozenDefinition.definitionDigest = (await import('../agent-kit/worker-digest')).workerDefinitionDigest(frozenDefinition);
      await pool.query(`INSERT INTO factory_agent_profiles (id,"ownerId","workspaceId",version,definition,skills,digest) VALUES ($1,'owner',$2,1,$3,'[]',$4)`, [profileId, providerWorkspaceId, JSON.stringify(role), selectedProfile.digest]);
      await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now(),"agentDefinition"=$2,"sessionId"='provider-check-original' WHERE id=$1`,
        [review.runId, JSON.stringify(frozenDefinition)]);
      // Editing or disabling a role affects future selections, not the role
      // already frozen in the host-authorized provider recovery of this check.
      const editedRole = { ...role, enabled: false, instructions: 'Changed after the original review started.' };
      await pool.query('UPDATE factory_agent_profiles SET version=2,definition=$2,digest=$3 WHERE id=$1', [profileId, JSON.stringify(editedRole), profileApi.agentProfileDigest(editedRole, [])]);
      const checkBefore = (await store.read('owner', f.task.id)).attempts.at(-1)!.output.check;
      const nextDevice = randomUUID(), nextAgent = randomUUID(), nextRepo = randomUUID();
      await pool.query(`INSERT INTO devices (id,"ownerId",name,"lastSeenAt",harnesses) VALUES ($1,'owner','Next provider device',now(),'[{"harness":"claude_code","installed":true}]')`, [nextDevice]);
      await pool.query(`INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,'owner','Next provider agent','claude_code',$2)`, [nextAgent, nextDevice]);
      await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,'owner','v2/github.com/acme/provider-fixture','https://github.com/acme/provider-fixture.git')`, [nextRepo, nextDevice]);
      const tx = await pool.connect();
      let childId: string;
      try {
        await tx.query('BEGIN');
        childId = await providerChild(tx, review.runId, { agentId: nextAgent, deviceId: nextDevice, deviceRepoId: nextRepo });
        await adoptProviderContinuation(tx, 'owner', review.runId, childId, () => store);
        const assignment = await factoryCheckAssignment(tx, 'owner', childId);
        assert.equal(assignment.baseBranch, 'b'.repeat(40));
        assert.equal(assignment.policy.readOnly, true);
        await tx.query('COMMIT');
      } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
      const after = await store.read('owner', f.task.id);
      assert.equal(after.task.stage, 'review');
      assert.equal(after.task.status, 'running');
      assert.equal(after.task.candidateId, pending.candidateId);
      assert.deepEqual(after.attempts.at(-1)!.output.check, { ...(checkBefore as Record<string, unknown>), deviceRepoId: nextRepo, environment: `device:${nextDevice}` });
      assert.equal(after.attempts.at(-1)!.output.requestEpoch, after.task.sourceEventId);
      const child = (await pool.query('SELECT "retryOf","sessionId",prompt FROM agent_runs WHERE id=$1', [childId!])).rows[0];
      assert.deepEqual(child, { retryOf: null, sessionId: null, prompt: original.prompt });
      assert.equal((await pool.query('SELECT result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, factoryEventId('provider-check-continuation', review.runId)])).rows[0].result.runId, childId!);
      const prior = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [review.runId])).rows[0];
      const queued = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [childId!])).rows[0];
      assert.equal(providerContinuationMatches(prior, queued), false, 'an independent check is deliberately not a native-session retry');
      assert.equal(await providerContinuationLaunchMatches(pool, prior, queued), true, 'the current check and exact host receipt authorize its launch');
      await assertRunProfileClaim(pool, childId!);
      assert.equal(queued.agentDefinition.agentProfile.version, 1);
      assert.equal(queued.agentDefinition.agentProfile.instructions, role.instructions);
      assert.equal(await providerContinuationLaunchMatches(pool, prior, { ...queued, sessionId: prior.sessionId }), false, 'a check cannot inherit the failed native session');
      assert.equal(await providerContinuationLaunchMatches(pool, { ...prior, report: { ...prior.report,
        modelFallback: { ...prior.report.modelFallback, nextDefinitionDigest: 'changed' } } }, queued), false);
      let recovered = 0, launched = 0;
      const dependencies = {
        runtime: () => ({ store, reconcile: { run: (userId: string, runId: string) => sweep.run(userId, runId) } }),
        dispatch: async () => { throw new Error('A queued independent provider check cannot enter generic repair'); }, wake: async () => {},
        recoverProvider: async (userId: string, sourceId: string) => {
          assert.equal(userId, 'owner'); assert.equal(sourceId, review.runId);
          const continuation = await recoverProviderFailure(pool, userId, sourceId);
          assert.equal(continuation?.runId, childId!);
          assert.equal(continuation?.previousRunId, review.runId);
          recovered++;
          return async () => { launched++; };
        },
      };
      for (let replay = 0; replay < 2; replay++) {
        const result = await sweepFactoryWatchdog(pool, dependencies, new Date(), Date.now() + 20_000, { userId: 'owner', runId: childId! });
        assert.deepEqual({ recovered: result.recovered, blocked: result.blocked, failed: result.failed }, { recovered: 1, blocked: 0, failed: 0 });
      }
      assert.deepEqual({ recovered, launched }, { recovered: 2, launched: 2 });
      const replayed = await store.read('owner', f.task.id);
      assert.equal(replayed.task.attemptId, after.task.attemptId);
      assert.equal(replayed.attempts.length, after.attempts.length);
      assert.deepEqual((await pool.query('SELECT "retryOf","sessionId",prompt FROM agent_runs WHERE id=$1', [childId!])).rows[0], child,
        'recovery preserves the independent check prompt and empty session binding');
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_watchdog'`, [f.task.id])).rows[0].n, 0);

      for (const fault of ['receipt', 'epoch', 'attempt'] as const) {
        const guard = await pool.connect();
        try {
          await guard.query('BEGIN');
          if (fault === 'receipt') await guard.query(`UPDATE factory_events SET result=jsonb_set(result,'{runId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`,
            [f.task.id, factoryEventId('provider-check-continuation', review.runId), randomUUID()]);
          if (fault === 'epoch') {
            const nextEpoch = randomUUID();
            await guard.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1::uuid,'owner','user_message',$1::text,'{"text":"Changed fixture request"}')`, [nextEpoch]);
            await guard.query('UPDATE factory_tasks SET "sourceEventId"=$2 WHERE id=$1', [f.task.id, nextEpoch]);
          }
          if (fault === 'attempt') {
            // A real independent check owns a fresh native session before it
            // can finish, and its run must end before Factory permits retry.
            await guard.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',"sessionId"=$2 WHERE id=$1`,
              [childId!, `check-replacement-${randomUUID()}`]);
            const current = await store.lockTask(guard, 'owner', f.task.id);
            const failed = await store.apply('owner', factoryBinding(current), randomUUID(), { action: 'finish', status: 'failed', reason: 'Replace fixture check', evidence: [], output: {} }, guard);
            const replacement = await store.apply('owner', factoryBinding(failed.task), randomUUID(), { action: 'retry', reason: 'New fixture check attempt' }, guard);
            assert.notEqual(replacement.task.attemptId, after.task.attemptId);
          }
          assert.equal(await providerContinuationLaunchMatches(guard, prior, queued), false, fault);
          await assert.rejects(assertRunProfileClaim(guard, childId!), { message: 'agentProfileUnavailable' }, `${fault} cannot authorize the stale frozen role`);
        } finally { await guard.query('ROLLBACK'); guard.release(); }
      }
      assert.equal(await providerContinuationLaunchMatches(pool, prior, queued), true, 'guard mutations are rolled back');
    });

    await t.test('provider handoff rejects changed standing scope, repository and monitor placement with no orphan queue row', async () => {
      const otherRepoId = randomUUID();
      await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,'owner','v2/github.com/acme/other-provider-fixture','https://github.com/acme/other-provider-fixture.git')`, [otherRepoId, deviceId]);
      for (const fault of ['scope', 'permissions', 'repository', 'epoch', 'monitor-placement']) {
        const f = await providerSource();
        if (fault === 'monitor-placement') {
          await pool.query("UPDATE factory_tasks SET stage='monitor' WHERE id=$1", [f.task.id]);
          await pool.query("UPDATE factory_attempts SET stage='monitor' WHERE id=$1", [f.task.attemptId]);
        }
        const tx = await pool.connect();
        let childId: string | undefined;
        try {
          await tx.query('BEGIN');
          childId = await providerChild(tx, f.runId);
          if (fault === 'scope') {
            await assert.rejects(tx.query(`UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{executionIdentity,workspaceId}',to_jsonb($2::text)) WHERE id=$1`, [childId, randomUUID()]),
              { code: '23514', message: 'taskWorkspaceMismatch' }, 'a frozen identity cannot move the child into another workspace');
          }
          if (fault === 'permissions') await tx.query(`UPDATE agent_runs SET "agentDefinition"="agentDefinition"-'readOnly' WHERE id=$1`, [childId]);
          if (fault === 'repository' || fault === 'monitor-placement') await tx.query('UPDATE agent_runs SET "deviceRepoId"=$2 WHERE id=$1', [childId, otherRepoId]);
          if (fault === 'epoch') await tx.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{requestEpoch}',to_jsonb($2::text)) WHERE id=$1`, [f.task.attemptId, randomUUID()]);
          if (fault !== 'scope') await assert.rejects(adoptProviderContinuation(tx, 'owner', f.runId, childId, () => store), error => error instanceof FactoryError && ['factoryRunMismatch', 'factoryStale'].includes(error.code), fault);
        } finally { await tx.query('ROLLBACK'); tx.release(); }
        assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=$1', [childId])).rowCount, 0, fault);
        const current = await store.read('owner', f.task.id);
        assert.equal(current.task.attemptId, f.task.attemptId, fault);
        assert.equal(current.attempts.length, 1, fault);
      }
    });

    await t.test('provider continuations exceed the device retry cap without spending the code repair budget; forged output cannot bypass it', async () => {
      const f = await providerSource();
      let last = f.runId;
      const failures: string[] = [];
      const length = orchestratorSettings({}).maxFixAttempts + 2;
      for (let index = 0; index < length; index++) { failures.push(last); last = await providerChild(pool, last); }
      await sweep.run('owner', f.runId);
      const continued = await store.read('owner', f.task.id);
      assert.equal(continued.task.status, 'running');
      assert.equal(continued.attempts.at(-1)!.runId, last);
      assert.equal(continued.attempts.length, length + 1);
      for (const runId of failures) assert.equal(continued.attempts.find(attempt => attempt.runId === runId)!.output.recovery, 'provider_failure');
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='Code failure',"finishedAt"=clock_timestamp() WHERE id=$1`, [last]);
      await sweep.run('owner', last);
      const repaired = await store.read('owner', f.task.id);
      assert.equal(repaired.task.status, 'pending', 'the first actual code failure still has its ordinary repair allowance');
      assert.equal(repaired.attempts.at(-2)!.output.reasonCode, 'run_failed');
      await pool.query(`UPDATE agent_runs SET "stopReason"='error' WHERE id=ANY($1::uuid[])`, [failures]);
      const tx = await pool.connect();
      try { await assert.rejects(checkFactoryRepairBudget(tx, repaired.task), error => error instanceof FactoryError && error.code === 'factoryRecoveryBudgetExceeded'); }
      finally { tx.release(); }
    });

    for (const state of ['blocked', 'picked'] as const) for (const stage of ['spec', 'execute', 'review', 'verify', 'monitor'] as const)
      await t.test(`${stage} provider ${state} blocks without entering a check consumer or repair loop`, async () => {
        const f = await providerSource();
        await pool.query('UPDATE factory_tasks SET stage=$2 WHERE id=$1', [f.task.id, stage]);
        await pool.query('UPDATE factory_attempts SET stage=$2 WHERE id=$1', [f.task.attemptId, stage]);
        const fallback = { state, fallback: 'balance', from: { harness: 'codex', model: 'fixture-model', source: 'api_key' } };
        await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='provider_failure',"finishedAt"=clock_timestamp(),report=$2 WHERE id=$1`, [f.runId, JSON.stringify({ modelFallback: fallback })]);
        const forbidden = async () => { throw new Error('Provider failures cannot enter check or repair dispatch'); };
        const guarded = createFactoryReconciler(pool, store, undefined, { review: forbidden, verify: forbidden, monitor: forbidden }, null, forbidden);
        await guarded.run('owner', f.runId);
        const snapshot = await store.read('owner', f.task.id);
        assert.equal(snapshot.task.status, 'blocked');
        assert.equal(snapshot.attempts.length, 1);
        assert.equal(snapshot.attempts[0].output.recovery, 'provider_failure');
        assert.equal(snapshot.attempts[0].output.reasonCode, state === 'picked' ? 'model_picked_unavailable' : 'model_unavailable');
      });

    await t.test('a stopped provider receipt cancels before an independent check can enter repair', async () => {
      const f = await providerSource();
      await pool.query("UPDATE factory_tasks SET stage='verify' WHERE id=$1", [f.task.id]);
      await pool.query("UPDATE factory_attempts SET stage='verify' WHERE id=$1", [f.task.attemptId]);
      const fallback = { state: 'stopped', fallback: 'balance', from: { harness: 'codex', model: 'fixture-model', source: 'api_key' } };
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='provider_failure',"finishedAt"=clock_timestamp(),report=$2 WHERE id=$1`, [f.runId, JSON.stringify({ modelFallback: fallback })]);
      const forbidden = async () => { throw new Error('An ended request cannot enter a check or repair'); };
      const guarded = createFactoryReconciler(pool, store, undefined, { review: forbidden, verify: forbidden, monitor: forbidden }, null, forbidden);
      await guarded.run('owner', f.runId);
      const snapshot = await store.read('owner', f.task.id);
      assert.equal(snapshot.task.status, 'cancelled');
      assert.equal(snapshot.attempts.length, 1);
    });

    await t.test('a pending provider receipt survives completion replays and watchdog recovers, adopts, then launches outside locks', async () => {
      const f = await providerSource();
      const fallback = { state: 'pending', fallback: 'balance', from: { harness: 'codex', model: 'fixture-model', source: 'api_key' } };
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='provider_failure',"finishedAt"=clock_timestamp(),report=$2 WHERE id=$1`, [f.runId, JSON.stringify({ modelFallback: fallback })]);
      await Promise.all([sweep.run('owner', f.runId), sweep.run('owner', f.runId)]);
      const pending = await store.read('owner', f.task.id);
      assert.equal(pending.task.status, 'running');
      assert.equal(pending.attempts.length, 1);
      assert.equal(factoryWatchdogDecision({ task: pending.task, runId: f.runId, runStatus: 'failed', providerPending: true, activeRun: false,
        uncertainEffect: false, progressAt: new Date(0) }, new Date()), 'wait', 'a racing pending observation never consumes watchdog tries');
      let recovered = 0, launched = 0, childId: string | undefined;
      const result = await sweepFactoryWatchdog(pool, {
        runtime: () => ({ store, reconcile: { run: (userId, runId) => sweep.run(userId, runId) } }),
        dispatch: async () => { throw new Error('No generic repair dispatch'); }, wake: async () => {},
        recoverProvider: async (userId, runId) => {
          assert.equal(userId, 'owner'); assert.equal(runId, f.runId); recovered++;
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN'); childId = await providerChild(tx, runId);
            await adoptProviderContinuation(tx, userId, runId, childId, () => store);
            await tx.query('COMMIT');
          } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
          return async () => { assert.equal((await store.read('owner', f.task.id)).attempts.at(-1)!.runId, childId); launched++; };
        },
      }, new Date(), Date.now() + 20_000, { userId: 'owner', runId: f.runId });
      assert.deepEqual({ recovered, launched, blocked: result.blocked, failed: result.failed }, { recovered: 1, launched: 1, blocked: 0, failed: 0 });
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_watchdog'`, [f.task.id])).rows[0].n, 0);
    });

    await t.test('watchdog relaunches the adopted queued provider child from its committed source receipt', async () => {
      const f = await providerSource();
      const tx = await pool.connect();
      let childId: string;
      try {
        await tx.query('BEGIN'); childId = await providerChild(tx, f.runId);
        await adoptProviderContinuation(tx, 'owner', f.runId, childId, () => store);
        await tx.query('COMMIT');
      } catch (error) { await tx.query('ROLLBACK'); throw error; } finally { tx.release(); }
      let recovered = 0, launched = 0;
      const dependencies = {
        runtime: () => ({ store, reconcile: { run: (userId: string, runId: string) => sweep.run(userId, runId) } }),
        dispatch: async () => { throw new Error('An adopted provider child cannot enter generic repair'); }, wake: async () => {},
        recoverProvider: async (userId: string, sourceId: string) => {
          assert.equal(userId, 'owner'); assert.equal(sourceId, f.runId); recovered++;
          assert.equal((await store.read('owner', f.task.id)).attempts.at(-1)!.runId, childId);
          return async () => { launched++; };
        },
      };
      for (let replay = 0; replay < 2; replay++) {
        const result = await sweepFactoryWatchdog(pool, dependencies, new Date(), Date.now() + 20_000, { userId: 'owner', runId: childId });
        assert.deepEqual({ recovered: result.recovered, blocked: result.blocked, failed: result.failed }, { recovered: 1, blocked: 0, failed: 0 });
      }
      assert.deepEqual({ recovered, launched }, { recovered: 2, launched: 2 });
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [f.runId])).rows[0].n, 1);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='task_watchdog'`, [f.task.id])).rows[0].n, 0);
      await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [childId]);
      await sweepFactoryWatchdog(pool, dependencies, new Date(), Date.now() + 20_000, { userId: 'owner', runId: childId });
      assert.deepEqual({ recovered, launched }, { recovered: 2, launched: 2 }, 'a claimed child is not relaunched');
    });

    await t.test("G2: reconciling one finished run does not move another task whose run also finished", async () => {
      const a = await runningTask(), b = await runningTask();
      await succeed(a.runId); await succeed(b.runId); // b's hook has not fired yet
      const bBefore = pick((await store.read("owner", b.task.id)).task);
      await reconcileFactoryAfterCompletion(pool, "owner", a.runId, reconcileFor);
      assert.equal((await store.read("owner", a.task.id)).task.stage, "review");
      assert.deepEqual(pick((await store.read("owner", b.task.id)).task), bBefore, "reconcile.run must stay scoped to its own run binding");
    });

    await t.test("G3: past maxFixAttempts a failed run stays failed with repair_budget_exhausted and no new attempt", async () => {
      const max = orchestratorSettings({}).maxFixAttempts;
      let cur = await runningTask();
      for (let i = 0; i < max; i++) {
        await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='boom',"finishedAt"=clock_timestamp() WHERE id=$1`, [cur.runId]);
        await reconcileFactoryAfterCompletion(pool, "owner", cur.runId, reconcileFor);
        const task = (await store.read("owner", cur.task.id)).task;
        assert.deepEqual({ stage: task.stage, status: task.status }, { stage: "execute", status: "pending" }, `retry ${i + 1} of ${max}`);
        const runId = (await dispatch("owner", { binding: factoryBinding(task), agentId, deviceRepoId: repoId })).runId;
        await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [runId]);
        cur = { task: (await store.read("owner", cur.task.id)).task, runId };
      }
      const attempts = (await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [cur.task.id])).rows[0].n;
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='boom',"finishedAt"=clock_timestamp() WHERE id=$1`, [cur.runId]);
      await reconcileFactoryAfterCompletion(pool, "owner", cur.runId, reconcileFor);
      const after = (await store.read("owner", cur.task.id)).task;
      assert.deepEqual({ stage: after.stage, status: after.status, attemptId: after.attemptId }, { stage: "execute", status: "failed", attemptId: cur.task.attemptId });
      assert.equal((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [cur.task.attemptId])).rows[0].output?.reasonCode, "repair_budget_exhausted");
      assert.equal((await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [cur.task.id])).rows[0].n, attempts, "no further attempt");
    });

    await t.test("G4: a failed run that already has a run-level retry child stays failed; no second loop", async () => {
      const f = await runningTask();
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',error='boom',"finishedAt"=clock_timestamp() WHERE id=$1`, [f.runId]);
      await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,"retryOf") SELECT $1,"userId","issueId","agentId","deviceId","deviceRepoId",'queued','Fixture',id FROM agent_runs WHERE id=$2`, [randomUUID(), f.runId]);
      const attempts = (await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [f.task.id])).rows[0].n;
      await reconcileFactoryAfterCompletion(pool, "owner", f.runId, reconcileFor);
      const after = (await store.read("owner", f.task.id)).task;
      assert.deepEqual({ status: after.status, attemptId: after.attemptId }, { status: "failed", attemptId: f.task.attemptId });
      assert.equal((await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [f.task.attemptId])).rows[0].output?.reasonCode, "run_failed");
      assert.equal((await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [f.task.id])).rows[0].n, attempts);
    });

    await t.test("firing the hook again (and the preparePrompt fallback) does not advance twice", async () => {
      const before = await store.read("owner", routed.task.id);
      const events = (await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [routed.task.id])).rows[0].n;
      await Promise.all([1, 2, 3].map(() => reconcileFactoryAfterCompletion(pool, "owner", d.runId, reconcileFor)));
      await sweep("owner"); // the Coordinator-turn fallback
      const after = await store.read("owner", routed.task.id);
      assert.equal(after.task.stage, before.task.stage);
      assert.equal(after.task.revision, before.task.revision);
      assert.equal(after.task.candidateId, before.task.candidateId);
      assert.equal((await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1', [routed.task.id])).rows[0].n, events);
    });

    await t.test("reconcile failure still records one owner-bound terminal routing outcome before the fallback", async () => {
      const f = await runningTask();
      const routing = { version: 1, difficulty: 'easy', model: 'gpt-6-luna', harness: 'codex', tier: 'light', effort: 'low', reason: 'difficulty_fit' };
      await pool.query(`UPDATE agent_runs SET "agentDefinition"="agentDefinition" || $2::jsonb WHERE id=$1`,
        [f.runId, JSON.stringify({ modelDispatch: { routing } })]);
      const unavailable = () => async () => { throw Object.assign(new Error("boom secret-ish"), { code: "40P01" }); };
      const outcomes = async () => (await pool.query(`SELECT "taskId","eventId",result FROM factory_events
        WHERE request->>'kind'='model_routing_outcome' AND request->>'runId'=$1`, [f.runId])).rows;

      assert.equal(await reconcileFactoryAfterCompletion(pool, 'owner', f.runId, unavailable), 0);
      assert.deepEqual(await outcomes(), [], 'a still-running run has no terminal outcome');
      await succeed(f.runId);
      assert.equal(await reconcileFactoryAfterCompletion(pool, 'different-owner', f.runId, unavailable), 0);
      assert.deepEqual(await outcomes(), [], "a different owner cannot record another person's outcome");

      assert.deepEqual(await Promise.all([1, 2, 3].map(() => reconcileFactoryAfterCompletion(pool, 'owner', f.runId, unavailable))), [0, 0, 0]);
      const recorded = await outcomes();
      assert.equal(recorded.length, 1, 'concurrent failed-reconcile hooks share one routing receipt');
      assert.equal(recorded[0].taskId, f.task.id);
      assert.equal(recorded[0].eventId, factoryEventId('model-routing-outcome', f.runId));
      assert.deepEqual(recorded[0].result.routing, routing);
      assert.equal(recorded[0].result.outcome.status, 'succeeded');
      assert.equal(recorded[0].result.outcome.stopReason, 'submitted');
      assert.equal(recorded[0].result.outcome.stage, 'execute');
      assert.equal((await store.read('owner', f.task.id)).task.stage, 'execute', 'routing telemetry does not advance the task');

      await sweep.run('owner', f.runId); // preparePrompt uses this independent recovery entry.
      assert.equal((await store.read('owner', f.task.id)).task.stage, 'review');
      await reconcileFactoryAfterCompletion(pool, 'owner', f.runId, reconcileFor);
      assert.deepEqual(await outcomes(), recorded, 'fallback and later completion replay preserve the original outcome');
    });
  } finally {
    if (flags.r === undefined) delete process.env.MIKKA_FACTORY_ROUTING_ENABLED; else process.env.MIKKA_FACTORY_ROUTING_ENABLED = flags.r;
    if (flags.l === undefined) delete process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED; else process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = flags.l;
    if (authorityWorkspaces.length) {
      await workspacePool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [authorityWorkspaces]);
      await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [authorityWorkspaces]);
    }
    await dropTestDatabase(admin, database, pool);
    await admin.end();
  }
});
