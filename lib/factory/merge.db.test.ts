import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { mock } from "node:test";
import type { PoolClient } from 'pg';
import { factory194Fixture } from "../../tests/helpers/factory194";
import { factory194Target } from "../../tests/helpers/factory194-target";
import { FactoryError } from "./approval-contract";
import { createFactoryApprovals } from "./approval";
import { handleFactoryApproval } from "./approval-http";
import { createFactoryMerges, FactoryMergeRefused, type FactoryMergeBoundary, type GitHubMergePort, type GitHubPullRequestView } from "./merge";
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { threadGroup } from '../thread-groups'
import { observePoolCommits } from '../db/commit-effects'
import type { LiveInvalidation } from '../live/events'
import type { LiveScope } from '../live/scope'

// #528: acceptance is the person's own merge of the candidate PR. Real
// PostgreSQL (isolated schema); GitHub is a fixture that records every call.

const ci = process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true";
const db = process.env.FACTORY194_TEST_URL ?? (disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined);
if (process.env.REQUIRE_DB === "1" && !db) throw new Error("Factory merge DB test requires an explicit disposable database");
if (db) factory194Target(db, ci);

const TOKEN = "person-user-to-server-token";

function fakeGitHub() {
  const calls: { op: string; token: string; repo: string; number?: number; sha?: string; method?: string }[] = [];
  const state = {
    view: (sha: string): GitHubPullRequestView => ({ state: "open", merged: false, headSha: sha, mergeableState: "clean", mergeCommitSha: null }),
    methods: ["squash"] as ("merge" | "squash" | "rebase")[],
    merge: async (): Promise<{ merged: true; mergeCommitSha: string | null } | { merged: false; status: number }> => ({ merged: true, mergeCommitSha: "m".repeat(40) }),
  };
  let headSha = "";
  const port: GitHubMergePort = {
    async pullRequest(token, repo, number) {
      calls.push({ op: "pull", token, repo, number });
      return state.view(headSha);
    },
    async mergeMethods(token, repo) {
      calls.push({ op: "methods", token, repo });
      return state.methods;
    },
    async merge(token, repo, number, input) {
      calls.push({ op: "merge", token, repo, number, ...input });
      return state.merge();
    },
  };
  return { port, calls, state, setHead: (sha: string) => { headSha = sha; } };
}

test("acceptance merges the PR as the person", { skip: !db, timeout: 180000 }, async (t) => {
  const f = await factory194Fixture(db!);
  const { pool, actor } = f;
  try {
    // The candidate's run opened the PR (run_publications); skill candidates have their own table.
    await pool.query(`
      ALTER TABLE factory_candidates ADD COLUMN "runId" uuid;
      CREATE TABLE run_publications ("runId" uuid PRIMARY KEY,"userId" text NOT NULL,"pullRequest" jsonb);
      CREATE TABLE improvement_skill_candidates ("factoryTaskId" uuid,"candidateId" uuid,"userId" text);
    `);
    await pool.query(await readFile(new URL("../../drizzle/20261101121000_factory_merges.sql", import.meta.url), "utf8"));

    await pool.query(await readFile(new URL("../../drizzle/20261103060000_factory_deliverables.sql",import.meta.url),"utf8"));
    await pool.query(`
      ALTER TABLE issues ADD COLUMN priority text NOT NULL DEFAULT 'normal', ADD COLUMN "updatedAt" timestamptz NOT NULL DEFAULT now();
      ALTER TABLE factory_tasks ADD COLUMN "createdAt" timestamptz NOT NULL DEFAULT now(), ADD COLUMN route jsonb;
      ALTER TABLE factory_attempts ADD COLUMN reason text;
      CREATE TABLE issue_versions (id uuid PRIMARY KEY,"issueId" uuid NOT NULL,"userId" text NOT NULL,
        revision integer NOT NULL,title text,content jsonb,status text,priority text,actor_type text,actor_id text,"createdAt" timestamptz NOT NULL DEFAULT now());
    `);

    let nextPull = 418;
    async function prepared(pr = `https://github.com/alexj11324/Mikka/pull/${nextPull++}`) {
      const x = await f.prepare();
      const runId = randomUUID();
      await pool.query('UPDATE factory_candidates SET "runId"=$1 WHERE id=$2', [runId, x.task.candidateId]);
      await pool.query('INSERT INTO run_publications VALUES ($1,$2,$3)', [runId, actor.userId, JSON.stringify({ url: pr, state: "open" })]);
      const github = fakeGitHub();
      github.setHead(x.candidate.sha);
      const merges = createFactoryMerges(pool, f.authorize, f.store, github.port);
      const accept = (eventId = randomUUID(), token: string | null = TOKEN) => merges.accept(actor, { binding: x.approval.binding, eventId }, token);
      const task = async () => (await pool.query('SELECT stage,status FROM factory_tasks WHERE id=$1', [x.task.id])).rows[0];
      const rows = async () => (await pool.query('SELECT status,source,code,sha,"headSha","mergeCommitSha" FROM factory_merges WHERE "taskId"=$1 ORDER BY "createdAt"', [x.task.id])).rows;
      return { ...x, pr, github, merges, accept, taskState: task, rows };
    }
    const refused = (code: string) => (e: unknown) => e instanceof FactoryMergeRefused && e.code === code;

    async function preparedDeliverable(kind: 'report' | 'deliverable' = 'report') {
      const x = await prepared();
      // Production's one independent review flow. These are persisted synthetic
      // reports and receipts, never claims of live Harness/model acceptance.
      await pool.query(`UPDATE issues SET status='review' WHERE id=$1`, [x.task.issueId]);
      await pool.query(`UPDATE factory_tasks SET route='{"flowVersion":2}' WHERE id=$1`, [x.task.id]);
      const removed = await pool.query(`DELETE FROM factory_attempts WHERE "taskId"=$1 AND stage='verify' RETURNING "runId"`, [x.task.id]);
      await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [removed.rows.map(row => row.runId)]);
      await pool.query('UPDATE factory_candidates SET kind=$2,sha=$3 WHERE id=$1', [x.task.candidateId, kind, kind === 'deliverable' ? null : x.candidate.sha]);
      await pool.query(`UPDATE agent_runs SET report=report || jsonb_build_object('sourceCommit',$2::text)
        WHERE "issueId"=$1`, [x.task.issueId, x.candidate.sha]);
      if (kind === 'deliverable') await pool.query(`UPDATE factory_attempts SET evidence=(
        SELECT jsonb_agg(ref || '{"sha":null}'::jsonb) FROM jsonb_array_elements(evidence) ref)
        WHERE "taskId"=$1 AND stage IN ('execute','review')`, [x.task.id]);
      const issue = async () => (await pool.query('SELECT status,revision,title,content,priority FROM issues WHERE id=$1', [x.task.issueId])).rows[0];
      const history = async () => (await pool.query('SELECT revision,status,title,content,priority,actor_type,actor_id FROM issue_versions WHERE "issueId"=$1 ORDER BY revision', [x.task.issueId])).rows;
      const receipts = async () => (await pool.query('SELECT id FROM factory_deliverable_acceptances WHERE "taskId"=$1', [x.task.id])).rows;
      const group = async () => threadGroup({ id: 'independent-review', issueId: x.task.issueId, status: 'succeeded', outcome: null, createdAt: '2026-11-05T00:00:00Z' },
        { status: (await issue()).status, metadata: { pullRequests: [] } });
      return { ...x, issue, history, receipts, group };
    }

    for (const kind of ['report', 'deliverable'] as const) await t.test(`${kind} acceptance commits issue completion and human history, resolving the waiting thread`, async () => {
      const x = await preparedDeliverable(kind);
      const before = await x.issue();
      assert.equal(await x.group(), 'waiting');
      const eventId = randomUUID();
      const result = await x.accept(eventId, null);
      assert.equal(result.status, 'accepted');
      assert.deepEqual(await x.taskState(), { stage: 'approval', status: 'passed' });
      assert.deepEqual(await x.issue(), { ...before, status: 'done', revision: before.revision + 1 });
      assert.deepEqual(await x.history(), [{ ...before, status: 'done', revision: before.revision + 1, actor_type: 'user', actor_id: actor.userId }]);
      assert.equal(await x.group(), 'resolved', 'an unjudged review does not keep a human-accepted issue waiting');
      assert.equal(x.github.calls.length, 0, 'accepting a deliverable needs no GitHub credential or write');
      assert.deepEqual(await x.accept(eventId, null), result, 'the same acceptance returns its durable receipt');
      assert.equal((await x.receipts()).length, 1);
      assert.equal((await x.history()).length, 1);
      assert.equal((await x.issue()).revision, before.revision + 1);
    });

    await t.test('acceptance advances a lagging task while preserving a later human status change', async () => {
      const lagging = await preparedDeliverable();
      await pool.query(`UPDATE issues SET status='doing' WHERE id=$1`, [lagging.task.issueId]);
      assert.equal((await lagging.accept(randomUUID(), null)).status, 'accepted');
      assert.equal((await lagging.issue()).status, 'done');
      assert.equal((await lagging.history())[0].actor_id, actor.userId);

      const held = await preparedDeliverable();
      await pool.query(`INSERT INTO issue_versions (id,"issueId","userId",revision,status,actor_type,actor_id)
        VALUES (gen_random_uuid(),$1,$2,1,'review','system','fixture'), (gen_random_uuid(),$1,$2,2,'todo','user',$2)`,
        [held.task.issueId, actor.userId]);
      await pool.query(`UPDATE issues SET status='todo',revision=2 WHERE id=$1`, [held.task.issueId]);
      assert.equal((await held.accept(randomUUID(), null)).status, 'accepted');
      assert.equal((await held.issue()).status, 'todo');
      assert.equal((await held.history()).length, 2);
    });

    await t.test('a failure writing issue history rolls back acceptance, Factory state and issue completion together', async () => {
      const x = await preparedDeliverable();
      const before = await x.issue();
      const eventId = randomUUID();
      await pool.query(`ALTER TABLE issue_versions ADD CONSTRAINT reject_completion_fixture CHECK(status<>'done') NOT VALID`);
      try {
        await assert.rejects(() => x.accept(eventId, null), /reject_completion_fixture/);
      } finally {
        await pool.query('ALTER TABLE issue_versions DROP CONSTRAINT reject_completion_fixture');
      }
      assert.deepEqual(await x.taskState(), { stage: 'approval', status: 'pending' });
      assert.deepEqual(await x.issue(), before);
      assert.equal((await x.receipts()).length, 0);
      assert.equal((await x.history()).length, 0);
      assert.equal((await x.accept(eventId, null)).status, 'accepted', 'the rolled-back event can succeed once');
      assert.equal((await x.history()).length, 1);
    });

    await t.test('a replaced candidate cannot complete the issue or leave an acceptance receipt', async () => {
      const x = await preparedDeliverable();
      const candidateId = randomUUID();
      await pool.query(`INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,kind)
        SELECT $2,"taskId",sha,repository,environment,scope,kind FROM factory_candidates WHERE id=$1`, [x.task.candidateId, candidateId]);
      await pool.query('UPDATE factory_tasks SET "candidateId"=$2,revision=revision+1 WHERE id=$1', [x.task.id, candidateId]);
      await assert.rejects(() => x.accept(randomUUID(), null), error => error instanceof FactoryError && error.code === 'factoryStale');
      assert.equal((await x.issue()).status, 'review');
      assert.equal((await x.receipts()).length, 0);
      assert.equal((await x.history()).length, 0);
    });

    async function successor(task: Awaited<ReturnType<typeof prepared>>['task']) {
      await pool.query(`INSERT INTO factory_tasks (id,"userId","issueId","workspaceId","attemptId",revision,stage,status,"createdAt")
        SELECT $2,"userId","issueId","workspaceId",$3,1,'execute','pending',"createdAt"+interval '1 second' FROM factory_tasks WHERE id=$1`,
      [task.id, randomUUID(), randomUUID()]);
    }

    await t.test('accepted deliverables refresh connected panels only after COMMIT, with no replay, rollback or unchanged-status notification', async () => {
      const pending: (() => Promise<void>)[] = [];
      const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = [];
      const notify = await import('../live/notify');
      const requestScope = await import('../db/request-scope');
      const workspace = await import('../workspace-db');
      const mocks = [
        mock.module(new URL('../live/notify.ts', import.meta.url).href, { namedExports: { ...notify,
          scheduleLive: (work: () => Promise<void>) => { pending.push(work); },
          sendLiveInvalidations: async (scope: LiveScope, events: LiveInvalidation[]) => { sent.push({ scope, events }); },
        } }),
        mock.module(new URL('../db/request-scope.ts', import.meta.url).href, { namedExports: { ...requestScope, pool } }),
        mock.module(new URL('../workspace-db.ts', import.meta.url).href, { namedExports: { ...workspace, workspacePool: pool } }),
      ];
      const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET };
      process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid';
      process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-factory-relations-fixture';
      observePoolCommits(pool);
      const drain = async () => { await Promise.all(pending.splice(0).map(work => work())); };
      try {
        await pool.query(`
          CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY,"userId" text,kind text);
          CREATE TABLE mikka_workspace_members ("workspaceId" uuid,"userId" text,status text);
          CREATE TABLE mikka_team_issues ("issueId" uuid,"workspaceId" uuid);
          CREATE TABLE workspace_projects (id uuid PRIMARY KEY,"userId" text NOT NULL,
            "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id),"issueIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
            UNIQUE(id,"workspaceId"));
          CREATE TABLE workspace_project_tasks ("projectId" uuid NOT NULL,"issueId" uuid NOT NULL UNIQUE,"workspaceId" uuid NOT NULL,
            PRIMARY KEY("projectId","issueId"),FOREIGN KEY("projectId","workspaceId") REFERENCES workspace_projects(id,"workspaceId"));
          CREATE TABLE mikka_team_projects ("projectId" uuid NOT NULL,"workspaceId" uuid NOT NULL,PRIMARY KEY("projectId","workspaceId"));
        `);
        const home = f.workspaceId;
        await pool.query(`INSERT INTO mikka_workspaces VALUES ($1,$2,'personal')`, [home, actor.userId]);
        await pool.query(`INSERT INTO mikka_workspace_members VALUES ($1,$2,'active')`, [home, actor.userId]);
        const x = await preparedDeliverable();
        const projectId = randomUUID();
        await pool.query('INSERT INTO workspace_projects (id,"userId","workspaceId") VALUES ($1,$2,$3)', [projectId, actor.userId, home]);
        await pool.query('INSERT INTO workspace_project_tasks ("projectId","issueId","workspaceId") VALUES ($1,$2,$3)', [projectId, x.task.issueId, home]);
        const parent = randomUUID(), blocked = randomUUID();
        for (const [id, metadata] of [[parent, {}], [blocked, { blockedByIds: [x.task.issueId] }]] as const) {
          await pool.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",title,content,revision) VALUES($1,$2,$4,'bound','Connected fixture',$3,1)`,
            [id, actor.userId, JSON.stringify({ type: 'doc', attrs: { mikka: metadata }, content: [] }), home]);
        }
        await pool.query(`UPDATE issues SET content=$2 WHERE id=$1`, [x.task.issueId,
          JSON.stringify({ type: 'doc', attrs: { mikka: { parentId: parent } }, content: [] })]);
        const eventId = randomUUID();
        const accepted = await x.accept(eventId, null);
        assert.equal(accepted.status, 'accepted');
        assert.equal((await x.issue()).status, 'done', 'the status is committed before deferred readers run');
        assert.equal(sent.length, 0, 'no transport runs ahead of the deferred after-COMMIT work');
        await drain();
        const relations = sent.flatMap(value => value.events.filter(event => event.kind === 'issue_relations').map(event => event.id)).sort();
        assert.deepEqual(relations, [x.task.issueId, parent, blocked].sort(), 'the accepted child, parent progress and blocked task all refresh');
        assert.ok(sent.some(value => value.events.some(event => event.kind === 'project_map' && event.id === projectId)), 'the canonical Project relation refreshes after COMMIT even with an empty legacy issueIds cache');
        assert.ok(sent.every(value => value.scope.ownerId === actor.userId && value.scope.workspaceId === home));
        const delivered = sent.length;
        assert.deepEqual(await x.accept(eventId, null), accepted);
        assert.equal(pending.length, 0, 'an idempotent acceptance does not emit another invalidation');

        const rolledBack = await preparedDeliverable();
        await pool.query(`
          CREATE FUNCTION reject_live_completion_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'reject_live_completion_fixture'; END $$;
          CREATE CONSTRAINT TRIGGER reject_live_completion_fixture AFTER UPDATE ON issues
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status='done')
            EXECUTE FUNCTION reject_live_completion_fixture();
        `);
        try {
          await assert.rejects(() => rolledBack.accept(randomUUID(), null), /reject_live_completion_fixture/);
        } finally {
          await pool.query('DROP TRIGGER reject_live_completion_fixture ON issues; DROP FUNCTION reject_live_completion_fixture()');
        }
        assert.equal((await rolledBack.issue()).status, 'review');
        assert.equal((await rolledBack.receipts()).length, 0);
        assert.equal(pending.length, 0, 'a failed COMMIT drops all registered panel notifications');

        const unchanged = await preparedDeliverable();
        await successor(unchanged.task);
        assert.equal((await unchanged.accept(randomUUID(), null)).status, 'accepted');
        assert.equal((await unchanged.issue()).status, 'review');
        assert.equal(pending.length, 0, 'accepting older work does not refresh unchanged relation panels');
        assert.equal(sent.length, delivered);
      } finally {
        pending.splice(0);
        for (const module of mocks.reverse()) module.restore();
        if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url;
        if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret;
      }
    });

    await t.test('accepting an older deliverable does not complete a later Factory task on the same issue', async () => {
      const x = await preparedDeliverable();
      await successor(x.task);
      assert.equal((await x.accept(randomUUID(), null)).status, 'accepted');
      assert.equal((await x.issue()).status, 'review');
      assert.equal((await x.history()).length, 0);
      assert.equal(await x.group(), 'waiting');
    });

    await t.test('replaying acceptance does not close a reopened issue with subsequent work', async () => {
      const x = await preparedDeliverable();
      const eventId = randomUUID();
      const accepted = await x.accept(eventId, null);
      await successor(x.task);
      await pool.query(`UPDATE issues SET status='review',revision=revision+1 WHERE id=$1`, [x.task.issueId]);
      const before = await x.issue();
      assert.deepEqual(await x.accept(eventId, null), accepted);
      assert.deepEqual(await x.issue(), before);
      assert.equal((await x.history()).length, 1);
    });

    await t.test('acceptance preserves active work and an explicit issue status change', async () => {
      const active = await preparedDeliverable();
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId",status) VALUES($1,$2,$3,'running')`, [randomUUID(), actor.userId, active.task.issueId]);
      assert.equal((await active.accept(randomUUID(), null)).status, 'accepted');
      assert.equal((await active.issue()).status, 'review');
      assert.equal((await active.history()).length, 0);
      const changed = await preparedDeliverable();
      await pool.query(`UPDATE issues SET status='canceled' WHERE id=$1`, [changed.task.issueId]);
      assert.equal((await changed.accept(randomUUID(), null)).status, 'accepted');
      assert.equal((await changed.issue()).status, 'canceled');
      assert.equal((await changed.history()).length, 0);
    });

    await t.test("accept → merge with the person's own token, bound to the candidate sha; the task completes", async () => {
      const x = await prepared();
      const out = await x.accept();
      assert.equal(out.status, "merged");
      const merge = x.github.calls.filter((c) => c.op === "merge");
      assert.equal(merge.length, 1);
      assert.deepEqual(merge[0], { op: "merge", token: TOKEN, repo: "alexj11324/Mikka", number: Number(x.pr.split("/").at(-1)), sha: x.candidate.sha, method: "squash" });
      assert.ok(x.github.calls.every((c) => c.token === TOKEN), "every GitHub call is the person's");
      assert.deepEqual(await x.taskState(), { stage: "publish", status: "passed" });
      assert.deepEqual(await x.rows(), [{ status: "merged", source: "mikka", code: null, sha: x.candidate.sha, headSha: x.candidate.sha, mergeCommitSha: "m".repeat(40) }]);
      const { rows: [publication] } = await pool.query('SELECT "pullRequest"->>\'state\' AS state FROM run_publications WHERE "pullRequest"->>\'url\'=$1', [x.pr]);
      assert.equal(publication.state, "merged", "the candidate card reads merged before the webhook");
      const ledger = await f.service([]).ledger(actor, x.task.id);
      assert.equal(ledger.merges.length, 1);
      assert.equal(ledger.merges[0].status, "merged");
      const shown = await f.service([]).evidence(actor, x.task.id);
      assert.ok(shown.manifest.artifacts.length > 0, "a merged candidate keeps showing its evidence");
    });

    await t.test('trusted host guards compose with the durable Factory merge ledger', async t => {
      type Prepared = Awaited<ReturnType<typeof prepared>>;
      function guarded(overrides: Partial<FactoryMergeBoundary> = {}) {
        const state = { commits: 0, rollbacks: 0, client: null as PoolClient | null, pid: null as number | null };
        const boundary: FactoryMergeBoundary = {
          async claim(work) {
            const tx = await pool.connect();
            state.client = tx;
            try {
              await tx.query('BEGIN');
              state.pid = (await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
              const result = await work(tx);
              await tx.query('COMMIT');
              state.commits++;
              return result;
            } catch (error) {
              await tx.query('ROLLBACK');
              state.rollbacks++;
              throw error;
            } finally {
              state.client = null;
              tx.release();
            }
          },
          beforeInsert: async () => {},
          existing: async () => {},
          effect: (_id, _pull, invoke) => invoke(),
          preserveUnknown: true,
          ...overrides,
        };
        return { boundary, state };
      }
      const accept = (x: Prepared, boundary: FactoryMergeBoundary, eventId = randomUUID()) =>
        x.merges.accept(actor, { binding: x.approval.binding, eventId }, TOKEN, boundary);
      const ledger = async (x: Prepared, reader: Pick<PoolClient, 'query'> = pool) =>
        (await reader.query('SELECT * FROM factory_merges WHERE "taskId"=$1 ORDER BY "createdAt"', [x.task.id])).rows;
      async function pending(x: Prepared, mergeId: string, eventId: string) {
        const rows = await ledger(x);
        assert.equal(rows.length, 1);
        assert.deepEqual([rows[0].id, rows[0].eventId, rows[0].status, rows[0].code, rows[0].finishedAt],
          [mergeId, eventId, 'merging', null, null]);
        assert.deepEqual(await x.taskState(), { stage: 'approval', status: 'pending' });
      }

      for (const reason of ['needs confirmation', 'source changed'] as const) await t.test(`${reason} before insertion rolls back without a claim or provider call`, async () => {
        const x = await prepared(), eventId = randomUUID();
        const denial = reason === 'needs confirmation' ? new Error('fixture_needs_confirm') : new FactoryError('factoryStale');
        let checked = 0;
        const g = guarded({
          beforeInsert: async (tx, task, pull) => {
            checked++;
            assert.equal(tx, g.state.client);
            assert.equal(task.candidateId, x.task.candidateId);
            assert.deepEqual(pull, { sha: x.candidate.sha, url: x.pr, repo: 'alexj11324/Mikka', number: Number(x.pr.split('/').at(-1)) });
            assert.equal((await ledger(x, tx)).length, 0);
            await tx.query('UPDATE factory_tasks SET revision=revision+1 WHERE id=$1', [x.task.id]);
            throw denial;
          },
          effect: async () => { assert.fail('a rejected claim cannot reach the effect boundary'); },
        });
        await assert.rejects(accept(x, g.boundary, eventId), error => error === denial);
        assert.equal(checked, 1);
        assert.deepEqual([g.state.commits, g.state.rollbacks], [0, 1]);
        assert.deepEqual(await ledger(x), []);
        assert.equal(x.github.calls.length, 0);
        assert.equal((await pool.query('SELECT revision FROM factory_tasks WHERE id=$1', [x.task.id])).rows[0].revision, x.task.revision);
        assert.deepEqual(await x.taskState(), { stage: 'approval', status: 'pending' });
      });

      await t.test('an effect guard rejects after a durable claim, records failure and never invokes PUT', async () => {
        const x = await prepared(), eventId = randomUUID(), observer = await pool.connect();
        let checked = 0;
        const g = guarded({ effect: async (id, pull) => {
          checked++;
          assert.equal(g.state.commits, 1);
          const rows = await ledger(x, observer);
          assert.equal(rows.length, 1);
          assert.deepEqual([rows[0].id, rows[0].eventId, rows[0].status, rows[0].sha], [id, eventId, 'merging', pull.sha]);
          throw new FactoryMergeRefused('githubMergeHeadMoved', pull.url);
        } });
        try {
          await assert.rejects(accept(x, g.boundary, eventId), refused('githubMergeHeadMoved'));
          const rows = await ledger(x);
          assert.equal(rows.length, 1);
          assert.deepEqual([rows[0].eventId, rows[0].status, rows[0].source, rows[0].code],
            [eventId, 'failed', 'mikka', 'githubMergeHeadMoved']);
          assert.ok(rows[0].finishedAt);
          assert.deepEqual(x.github.calls.map(call => call.op), ['pull', 'methods']);
          await assert.rejects(accept(x, g.boundary, eventId), refused('githubMergeHeadMoved'));
          assert.equal(checked, 1);
          assert.deepEqual(await ledger(x), rows);
          assert.equal(x.github.calls.filter(call => call.op === 'merge').length, 0);
          assert.deepEqual(await x.taskState(), { stage: 'approval', status: 'pending' });
        } finally { observer.release(); }
      });

      await t.test('the provider is invoked only after COMMIT and the claim task lock has been released', async () => {
        const x = await prepared(), eventId = randomUUID(), observer = await pool.connect();
        const g = guarded();
        let effectCalls = 0, providerCalls = 0, claimId: string | undefined;
        g.boundary.effect = async (id, pull, invoke) => {
          effectCalls++;
          claimId = id;
          assert.equal(g.state.commits, 1);
          assert.equal(g.state.client, null);
          assert.equal(pull.sha, x.candidate.sha);
          return invoke();
        };
        x.github.state.merge = async () => {
          providerCalls++;
          const rows = await ledger(x, observer);
          assert.equal(rows.length, 1, 'an independent connection sees the committed claim before PUT');
          assert.deepEqual([rows[0].id, rows[0].eventId, rows[0].status], [claimId, eventId, 'merging']);
          assert.notEqual((await observer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, g.state.pid);
          await observer.query('BEGIN');
          try {
            const unlocked = await observer.query('SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE NOWAIT', [x.task.id]);
            assert.equal(unlocked.rowCount, 1, 'the claim does not hold its task lock over provider I/O');
          } finally { await observer.query('ROLLBACK'); }
          return { merged: true, mergeCommitSha: 'c'.repeat(40) };
        };
        try {
          const result = await accept(x, g.boundary, eventId);
          assert.equal(result.status, 'merged');
          assert.deepEqual([effectCalls, providerCalls], [1, 1]);
          assert.deepEqual(await x.taskState(), { stage: 'publish', status: 'passed' });
          const row = (await ledger(x))[0];
          assert.deepEqual([row.id, row.status, row.headSha, row.mergeCommitSha], [claimId, 'merged', x.candidate.sha, 'c'.repeat(40)]);
        } finally { observer.release(); }
      });

      await t.test('a lost claim callback after COMMIT cannot restart a provider attempt on replay or after sixty seconds', async () => {
        const x = await prepared(), eventId = randomUUID(), lost = new Error('fixture_claim_callback_lost');
        const g = guarded(), originalClaim = g.boundary.claim;
        g.boundary.claim = async work => { await originalClaim(work); throw lost; };
        await assert.rejects(accept(x, g.boundary, eventId), error => error === lost);
        const row = (await ledger(x))[0];
        await pending(x, row.id, eventId);
        assert.equal(x.github.calls.length, 0);
        g.boundary.claim = originalClaim;
        for (const replayId of [eventId, randomUUID()]) {
          assert.deepEqual(await accept(x, g.boundary, replayId), { status: 'merging', mergeId: row.id, pullRequestUrl: x.pr });
        }
        assert.equal(x.github.calls.length, 0, 'fresh replay does not even read the provider');
        await pool.query(`UPDATE factory_merges SET "createdAt"=clock_timestamp()-interval '61 seconds' WHERE id=$1`, [row.id]);
        for (const replayId of [eventId, randomUUID()]) {
          assert.deepEqual(await accept(x, g.boundary, replayId), { status: 'merging', mergeId: row.id, pullRequestUrl: x.pr });
          await pending(x, row.id, eventId);
        }
        assert.deepEqual(x.github.calls.map(call => call.op), ['pull', 'pull']);
      });

      for (const loss of ['PUT response', 'effect callback', 'typed effect authorization'] as const)
        await t.test(`${loss} loss preserves an unknown outcome through negative readback and stale replays`, async () => {
          const x = await prepared(), eventId = randomUUID();
          let effectCalls = 0, existingCalls = 0;
          const g = guarded({
            existing: async () => { existingCalls++; },
            effect: async (_id, _pull, invoke) => {
              effectCalls++;
              const result = await invoke();
              if (loss === 'effect callback') throw new Error('fixture_effect_callback_lost');
              if (loss === 'typed effect authorization') throw new FactoryMergeRefused('githubMergeAuthorizationRequired', x.pr);
              return result;
            },
          });
          if (loss === 'PUT response') x.github.state.merge = async () => { throw new FactoryMergeRefused('githubUnavailable', x.pr); };
          const result = await accept(x, g.boundary, eventId);
          assert.equal(result.status, 'merging');
          if (result.status !== 'merging') assert.fail('the provider outcome is still unknown');
          await pending(x, result.mergeId, eventId);
          assert.deepEqual(x.github.calls.map(call => call.op), ['pull', 'methods', 'merge', 'pull']);
          const calls = x.github.calls.length;
          for (const replayId of [eventId, randomUUID()]) assert.deepEqual(await accept(x, g.boundary, replayId), result);
          assert.equal(x.github.calls.length, calls);
          await pool.query(`UPDATE factory_merges SET "createdAt"=clock_timestamp()-interval '61 seconds' WHERE id=$1`, [result.mergeId]);
          for (const replayId of [eventId, randomUUID()]) {
            assert.deepEqual(await accept(x, g.boundary, replayId), result);
            await pending(x, result.mergeId, eventId);
          }
          assert.deepEqual([effectCalls, existingCalls], [1, 4]);
          assert.equal(x.github.calls.filter(call => call.op === 'merge').length, 1);
          assert.equal(x.github.calls.length, calls + 2, 'stale reconciliation only reads, never issues a second PUT');
        });

      for (const readback of ['immediate', 'stale replay'] as const) await t.test(`a positive ${readback} still settles the original durable merge`, async () => {
        const x = await prepared(), eventId = randomUUID(), g = guarded();
        let reads = 0, mergedVisible = readback === 'immediate';
        x.github.state.merge = async () => { throw new FactoryMergeRefused('githubUnavailable', x.pr); };
        x.github.state.view = sha => ++reads > 1 && mergedVisible
          ? { state: 'closed', merged: true, headSha: sha, mergeableState: null, mergeCommitSha: 'd'.repeat(40) }
          : { state: 'open', merged: false, headSha: sha, mergeableState: 'clean', mergeCommitSha: null };
        let result = await accept(x, g.boundary, eventId);
        if (readback === 'stale replay') {
          assert.equal(result.status, 'merging');
          if (result.status !== 'merging') assert.fail('negative readback must remain unknown');
          await pending(x, result.mergeId, eventId);
          await pool.query(`UPDATE factory_merges SET "createdAt"=clock_timestamp()-interval '61 seconds' WHERE id=$1`, [result.mergeId]);
          mergedVisible = true;
          result = await accept(x, g.boundary, eventId);
        }
        assert.equal(result.status, 'merged');
        if (result.status !== 'merged') assert.fail('a positive native receipt must settle');
        const rows = await ledger(x);
        assert.equal(rows.length, 1);
        assert.deepEqual([rows[0].id, rows[0].eventId, rows[0].status, rows[0].headSha, rows[0].mergeCommitSha],
          [result.mergeId, eventId, 'merged', x.candidate.sha, 'd'.repeat(40)]);
        assert.deepEqual(await x.taskState(), { stage: 'publish', status: 'passed' });
        assert.deepEqual(await accept(x, g.boundary, eventId), result);
        assert.equal(x.github.calls.filter(call => call.op === 'merge').length, 1);
      });

      for (const status of ['merged', 'merging'] as const) for (const route of ['event replay', 'active candidate'] as const)
        await t.test(`the existing guard rejects a different review tuple before returning a ${status} ${route}`, async () => {
          const x = await prepared(), eventId = randomUUID(), g = guarded();
          if (status === 'merging') x.github.state.merge = async () => { throw new FactoryMergeRefused('githubUnavailable', x.pr); };
          const original = await accept(x, g.boundary, eventId);
          assert.equal(original.status, status);
          const before = await ledger(x), providerCalls = x.github.calls.length;
          let seen = 0;
          const binding = { ...x.approval.binding };
          if (route === 'event replay') {
            binding.candidateId = randomUUID(); binding.revision++;
            await pool.query(`INSERT INTO factory_candidates (id,"taskId",sha,repository,environment,scope,kind,"runId")
              SELECT $2,"taskId",sha,repository,environment,scope,kind,"runId" FROM factory_candidates WHERE id=$1`,
            [x.task.candidateId, binding.candidateId]);
            await pool.query('UPDATE factory_tasks SET "candidateId"=$2,revision=$3 WHERE id=$1', [x.task.id, binding.candidateId, binding.revision]);
          } else {
            // The same candidate can acquire a different current PR head; the
            // host's frozen review must not inherit the earlier active receipt.
            x.github.setHead('b'.repeat(40));
          }
          const denial = new FactoryError('factoryReplayMismatch');
          g.boundary.existing = async (tx, row) => {
            seen++;
            assert.equal(tx, g.state.client);
            assert.deepEqual([row.id, row.candidateId, row.sha, row.pullRequestUrl, row.eventId, row.status],
              [before[0].id, x.task.candidateId, x.candidate.sha, x.pr, eventId, status]);
            if (route === 'event replay') assert.notEqual(row.candidateId, binding.candidateId);
            else assert.notEqual(row.sha, 'b'.repeat(40));
            throw denial;
          };
          await assert.rejects(x.merges.accept(actor, { binding, eventId: route === 'event replay' ? eventId : randomUUID() }, TOKEN, g.boundary),
            error => error === denial);
          assert.equal(seen, 1);
          assert.deepEqual(await ledger(x), before);
          assert.equal(x.github.calls.length, providerCalls, 'the guard runs before returning or reconciling the previous receipt');
        });
    });

    await t.test("head moved → refused before merging; GitHub's sha mismatch is refused the same way", async () => {
      const x = await prepared();
      x.github.setHead("b".repeat(40));
      await assert.rejects(() => x.accept(), refused("githubMergeHeadMoved"));
      assert.equal(x.github.calls.filter((c) => c.op === "merge").length, 0);
      assert.deepEqual(await x.taskState(), { stage: "approval", status: "pending" });
      x.github.setHead(x.candidate.sha);
      x.github.state.merge = async () => ({ merged: false, status: 409 });
      await assert.rejects(() => x.accept(), refused("githubMergeHeadMoved"));
      assert.deepEqual((await x.rows()).map((r) => r.code), ["githubMergeHeadMoved", "githubMergeHeadMoved"]);
      assert.deepEqual(await x.taskState(), { stage: "approval", status: "pending" });
    });

    await t.test("no permission, failing checks and conflicts keep the task waiting; a later accept can merge", async () => {
      const x = await prepared();
      x.github.state.merge = async () => ({ merged: false, status: 403 });
      await assert.rejects(() => x.accept(), refused("githubMergeForbidden"));
      x.github.state.view = (sha) => ({ state: "open", merged: false, headSha: sha, mergeableState: "blocked", mergeCommitSha: null });
      x.github.state.merge = async () => ({ merged: false, status: 405 });
      await assert.rejects(() => x.accept(), refused("githubMergeBlocked"));
      x.github.state.view = (sha) => ({ state: "open", merged: false, headSha: sha, mergeableState: "dirty", mergeCommitSha: null });
      await assert.rejects(() => x.accept(), refused("githubMergeConflict"));
      assert.deepEqual(await x.taskState(), { stage: "approval", status: "pending" });
      x.github.state.view = (sha) => ({ state: "open", merged: false, headSha: sha, mergeableState: "clean", mergeCommitSha: null });
      x.github.state.merge = async () => ({ merged: true, mergeCommitSha: null });
      assert.equal((await x.accept()).status, "merged");
      assert.deepEqual(await x.taskState(), { stage: "publish", status: "passed" });
    });

    await t.test("no linked GitHub authorization → githubMergeAuthorizationRequired with the PR to open", async () => {
      const x = await prepared();
      await assert.rejects(() => x.accept(randomUUID(), null), (e) => refused("githubMergeAuthorizationRequired")(e) && (e as FactoryMergeRefused).pullRequestUrl === x.pr);
      assert.equal(x.github.calls.length, 0);
      assert.deepEqual(await x.rows(), []);
    });

    await t.test("double click → one merge call; the same click replays its result", async () => {
      const x = await prepared();
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      x.github.state.merge = async () => { await held; return { merged: true, mergeCommitSha: null }; };
      const eventId = randomUUID();
      const first = x.accept(eventId);
      // Let the first click claim the merge, then click again.
      while (!(await x.rows()).length) await new Promise((r) => setTimeout(r, 10));
      const second = await x.accept();
      assert.equal(second.status, "merging");
      release();
      assert.equal((await first).status, "merged");
      assert.equal(x.github.calls.filter((c) => c.op === "merge").length, 1);
      assert.equal((await x.accept(eventId)).status, "merged");
      assert.equal((await x.accept()).status, "merged", "a later click reports the merge, never repeats it");
      assert.equal(x.github.calls.filter((c) => c.op === "merge").length, 1);
      assert.equal((await x.rows()).length, 1);
    });

    await t.test("merged webhook completes a merge whose outcome was unknown", async () => {
      const x = await prepared();
      x.github.state.merge = async () => { throw new FactoryMergeRefused("githubUnavailable", null); };
      x.github.state.view = () => { throw new FactoryMergeRefused("githubUnavailable", null); };
      // The PR read before merging fails too: the attempt is recorded as failed, never merged again blindly.
      await assert.rejects(() => x.accept(), refused("githubUnavailable"));
      x.github.state.view = (sha) => ({ state: "open", merged: false, headSha: sha, mergeableState: "clean", mergeCommitSha: null });
      let reads = 0;
      x.github.state.view = (sha) => {
        if (reads++ > 0) throw new FactoryMergeRefused("githubUnavailable", null);
        return { state: "open", merged: false, headSha: sha, mergeableState: "clean", mergeCommitSha: null };
      };
      assert.equal((await x.accept()).status, "merging");
      assert.deepEqual(await x.taskState(), { stage: "approval", status: "pending" });
      const done = await x.merges.pullRequestMerged({ url: x.pr, headSha: x.candidate.sha, mergeCommitSha: "c".repeat(40) });
      assert.equal(done.completed, 1);
      assert.deepEqual(await x.taskState(), { stage: "publish", status: "passed" });
      assert.deepEqual((await x.rows()).map((r) => [r.status, r.source]), [["failed", "mikka"], ["merged", "mikka"]]);
      assert.equal((await x.merges.pullRequestMerged({ url: x.pr, headSha: x.candidate.sha, mergeCommitSha: null })).completed, 0, "a redelivered webhook changes nothing");
    });

    await t.test("a merge made on GitHub completes the task the same way", async () => {
      const x = await prepared("https://github.com/alexj11324/Mikka/pull/900");
      const done = await x.merges.pullRequestMerged({ url: "https://github.com/ALEXJ11324/mikka/pull/900", headSha: "d".repeat(40), mergeCommitSha: "e".repeat(40) });
      assert.equal(done.completed, 1);
      assert.deepEqual(await x.taskState(), { stage: "publish", status: "passed" });
      assert.deepEqual(await x.rows(), [{ status: "merged", source: "github", code: null, sha: x.candidate.sha, headSha: "d".repeat(40), mergeCommitSha: "e".repeat(40) }]);
      const { rows: [publication] } = await pool.query('SELECT "pullRequest"->>\'state\' AS state FROM run_publications WHERE "pullRequest"->>\'url\'=$1', [x.pr]);
      assert.equal(publication.state, "merged");
      assert.equal(x.github.calls.length, 0);
    });

    await t.test('a pending PR parks its terminal producer; merged delivery completes and refreshes it without waking compute', async () => {
      // Real PG, lifecycle/park and merge writers; only provider I/O and live
      // transport are fixtures. Signature admission has its own route tests.
      await pool.query(`
        ALTER TABLE agent_runs ADD COLUMN "pauseReason" text, ADD COLUMN "deviceTokenId" uuid,
          ADD COLUMN "retryOf" uuid, ADD COLUMN "continuesRunId" uuid, ADD COLUMN "agentId" uuid, ADD COLUMN "createdAt" timestamptz NOT NULL DEFAULT now();
        ALTER TABLE run_publications ADD COLUMN "issueId" uuid, ADD COLUMN "updatedAt" timestamptz DEFAULT now();
        CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid);
        CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY,"botId" uuid,"ownerId" text);
        CREATE TABLE bot_cloud_runtimes ("agentId" uuid,"botId" uuid,"ownerId" text);
        CREATE TABLE device_tokens (id uuid PRIMARY KEY,"boundDeviceId" uuid,"revokedAt" timestamptz);
        CREATE TABLE suggestion_executions ("runId" uuid,status text,"endedAt" timestamptz);
        CREATE TABLE thread_machines ("runId" uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"issueId" uuid,
          "sandboxId" text,"snapshotId" text NOT NULL,state text,"deviceId" uuid,epoch integer NOT NULL DEFAULT 1,"operationId" uuid,
          "workerLeaseId" uuid,"workerLeaseUntil" timestamptz,"lastActiveAt" timestamptz NOT NULL DEFAULT now(),
          "runningSince" timestamptz,"computeSeconds" bigint NOT NULL DEFAULT 0,
          "lifecycleAt" timestamptz DEFAULT now(),lifecycle jsonb NOT NULL DEFAULT '{}');
        CREATE TABLE coding_review_sessions ("runId" uuid,"taskId" uuid,"ownerId" text,"workspaceId" uuid,
          "sandboxId" text,"machineEpoch" bigint,"machineOperationId" uuid,"revokedAt" timestamptz,"expiresAt" timestamptz);
        CREATE TABLE IF NOT EXISTS mikka_workspaces (id uuid PRIMARY KEY,"userId" text,kind text);
        CREATE TABLE IF NOT EXISTS mikka_workspace_members ("workspaceId" uuid,"userId" text,status text);
        CREATE TABLE IF NOT EXISTS mikka_team_issues ("issueId" uuid,"workspaceId" uuid);
        CREATE TABLE IF NOT EXISTS workspace_projects (id uuid PRIMARY KEY,"userId" text NOT NULL,
          "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id),"issueIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
          UNIQUE(id,"workspaceId"));
        CREATE TABLE IF NOT EXISTS workspace_project_tasks ("projectId" uuid NOT NULL,"issueId" uuid NOT NULL UNIQUE,"workspaceId" uuid NOT NULL,
          PRIMARY KEY("projectId","issueId"),FOREIGN KEY("projectId","workspaceId") REFERENCES workspace_projects(id,"workspaceId"));
        CREATE TABLE IF NOT EXISTS mikka_team_projects ("projectId" uuid,"workspaceId" uuid,PRIMARY KEY("projectId","workspaceId"));
      `);
      for (const name of ['20261025013400_run_checkpoints.sql', '20261031002607_checkpoint_recovery_availability.sql'])
        await pool.query(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'));
      const x = await prepared();
      const { rows: [producer] } = await pool.query('SELECT "runId" FROM factory_attempts WHERE "taskId"=$1 AND stage=\'execute\'', [x.task.id]);
      const runId = producer.runId as string, deviceId = randomUUID(), tokenId = randomUUID(), sandboxId = `fixture-pr-${runId}`;
      const workspaceId = f.workspaceId, machineActor = { userId: actor.userId, workspaceId };
      const { rows: [home] } = await pool.query('SELECT id FROM mikka_workspaces WHERE id=$1 AND "userId"=$2 AND kind=\'personal\'', [workspaceId, actor.userId]);
      if (!home) {
        await pool.query('INSERT INTO mikka_workspaces VALUES ($1,$2,\'personal\')', [workspaceId, actor.userId]);
        await pool.query('INSERT INTO mikka_workspace_members VALUES ($1,$2,\'active\')', [workspaceId, actor.userId]);
      }
      const projectId = randomUUID();
      await pool.query('INSERT INTO workspace_projects (id,"userId","workspaceId") VALUES ($1,$2,$3)', [projectId, actor.userId, workspaceId]);
      await pool.query('INSERT INTO workspace_project_tasks ("projectId","issueId","workspaceId") VALUES ($1,$2,$3)', [projectId, x.task.issueId, workspaceId]);
      await pool.query('UPDATE issues SET status=\'review\' WHERE id=$1', [x.task.issueId]);
      await pool.query('UPDATE factory_candidates SET "runId"=$2 WHERE id=$1', [x.task.candidateId, runId]);
      await pool.query('UPDATE run_publications SET "runId"=$2,"issueId"=$3 WHERE "pullRequest"->>\'url\'=$1', [x.pr, runId, x.task.issueId]);
      await pool.query(`UPDATE agent_runs SET "deviceId"=$2,report=report||'{"safePoint":{"session":"exited","checkpoint":"unavailable"}}' WHERE id=$1`, [runId, deviceId]);
      await pool.query('INSERT INTO device_tokens VALUES ($1,$2,NULL)', [tokenId, deviceId]);
      await pool.query(`INSERT INTO thread_machines ("runId","ownerId","workspaceId","issueId","sandboxId","snapshotId",state,"deviceId","runningSince")
        VALUES ($1,$2,$3,$4,$5,'desktop','running',$6,now()-interval '1 minute')`, [runId, actor.userId, workspaceId, x.task.issueId, sandboxId, deviceId]);
      const runs = async () => (await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [x.task.issueId])).rows;
      const machine = async () => (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [runId])).rows[0];
      const beforeRuns = await runs(), pending: (() => Promise<void>)[] = [];
      const sent: { scope: LiveScope; events: LiveInvalidation[] }[] = [];
      const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET };
      const { reconcileThreadMachine } = await import('../cloud-computer/thread-lifecycle');
      const { parkThreadMachine, threadMachineProvider } = await import('../cloud-computer/thread-machines');
      const { factoryAutomaticRuntime } = await import('./automatic-dispatch');
      const notify = await import('../live/notify'), requestScope = await import('../db/request-scope'), workspace = await import('../workspace-db');
      const calls = { pause: 0, connect: 0, create: 0, start: 0, enqueue: 0, kill: 0, keepAlive: 0 };
      const forbidden = (kind: Exclude<keyof typeof calls, 'pause'>) => async () => { calls[kind]++; assert.fail(`unexpected ${kind} during PR wait`); };
      const methods = [
        mock.method(threadMachineProvider, 'connect', forbidden('connect')),
        mock.method(threadMachineProvider, 'create', forbidden('create')),
        mock.method(threadMachineProvider, 'kill', forbidden('kill')),
        mock.method(factoryAutomaticRuntime, 'start', forbidden('start')),
        mock.method(factoryAutomaticRuntime, 'enqueue', forbidden('enqueue')),
      ];
      const mocks = [
        mock.module(new URL('../live/notify.ts', import.meta.url).href, { namedExports: { ...notify,
          scheduleLive: (work: () => Promise<void>) => { pending.push(work); },
          sendLiveInvalidations: async (scope: LiveScope, events: LiveInvalidation[]) => { sent.push({ scope, events }); },
        } }),
        mock.module(new URL('../db/request-scope.ts', import.meta.url).href, { namedExports: { ...requestScope, pool } }),
        mock.module(new URL('../workspace-db.ts', import.meta.url).href, { namedExports: { ...workspace, workspacePool: pool } }),
      ];
      observePoolCommits(pool);
      let providerState: 'running' | 'paused' = 'running';
      const dependencies: NonNullable<Parameters<typeof reconcileThreadMachine>[3]> = {
        provider: { info: async id => { assert.equal(id, sandboxId); return { state: providerState, endAt: null }; }, keepAlive: forbidden('keepAlive') },
        park: (database, owner, id, fence) => parkThreadMachine(database, owner, id,
          async vm => { assert.equal(vm, sandboxId); calls.pause++; providerState = 'paused'; }, async () => null, undefined, fence),
        end: forbidden('kill'), stop: async () => { assert.fail('terminal PR wait cannot request a new stop'); },
        recover: async () => { assert.fail('terminal PR wait cannot recover a run'); },
      };
      const reconcile = () => reconcileThreadMachine(pool, machineActor, runId, dependencies);
      const drain = async () => { await Promise.all(pending.splice(0).map(work => work())); };
      try {
        delete process.env.DEVICE_GATEWAY_URL; delete process.env.DEVICE_GATEWAY_PUSH_SECRET;
        assert.deepEqual(await x.taskState(), { stage: 'approval', status: 'pending' });
        assert.equal(typeof await reconcile(), 'number');
        const parked = await machine();
        assert.equal(parked.state, 'paused'); assert.equal(providerState, 'paused');
        assert.equal(parked.sandboxId, sandboxId); assert.equal(parked.lifecycle.reason, 'run_ended');
        const assertPaused = async () => {
          const current = await machine();
          assert.deepEqual([current.sandboxId, current.deviceId, current.epoch, current.state],
            [sandboxId, deviceId, parked.epoch, 'paused']);
          assert.equal(current.runningSince, null);
          assert.equal(current.lifecycle.owner, 'run-recovery');
          assert.ok(current.lifecycleAt && new Date(current.lifecycleAt).getTime() > Date.now());
        };
        assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [tokenId])).rows[0].revokedAt);
        assert.deepEqual(await x.taskState(), { stage: 'approval', status: 'pending' });
        assert.deepEqual(await runs(), beforeRuns);

        process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid';
        process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-pr-lifecycle-fixture';
        const { refreshPublishedPullRequest } = await import('../github/publication-webhook');
        const event = { url: x.pr, headSha: x.candidate.sha, mergeCommitSha: 'e'.repeat(40) };
        const publication = { action: 'closed', repository: { full_name: 'alexj11324/Mikka' }, pull_request: {
          number: Number(x.pr.split('/').at(-1)), html_url: x.pr, title: 'Controlled external PR', state: 'closed',
          draft: false, merged_at: new Date().toISOString(),
        } };
        // The verified webhook uses this order: committed publication, then
        // the locked Factory completion; no GitHub request or CLI is needed.
        await refreshPublishedPullRequest('pull_request', publication, pool);
        assert.equal((await pool.query('SELECT "pullRequest"->>\'state\' AS state FROM run_publications WHERE "runId"=$1', [runId])).rows[0].state, 'merged');
        assert.deepEqual(await x.taskState(), { stage: 'approval', status: 'pending' });
        await drain();
        assert.ok(sent.some(value => value.events.some(event => event.kind === 'pull_request_status' && event.id === x.task.issueId)));
        assert.ok(sent.some(value => value.events.some(event => event.kind === 'project_map' && event.id === projectId)), 'the committed publication refreshes its canonical Project');
        sent.length = 0;
        assert.deepEqual(await x.merges.pullRequestMerged(event), { completed: 1 });
        assert.deepEqual(await x.taskState(), { stage: 'publish', status: 'passed' });
        assert.equal(sent.length, 0, 'the committed result precedes deferred live transport');
        await drain();
        assert.ok(sent.some(value => value.events.some(event => event.kind === 'factory_task' && event.id === x.task.id)));
        assert.ok(sent.every(value => value.scope.ownerId === actor.userId && value.scope.workspaceId === workspaceId));
        await reconcile();
        // Recovery may advance closure observations and its deadline without
        // waking compute or replacing this task's retained VM.
        await assertPaused();
        const factoryEvents = () => sent.flatMap(value => value.events).filter(event => event.kind === 'factory_task').length;
        const delivered = factoryEvents(), receipts = await x.rows();
        await refreshPublishedPullRequest('pull_request', publication, pool);
        assert.deepEqual(await x.merges.pullRequestMerged(event), { completed: 0 });
        await drain(); await reconcile();
        // A repeated PR badge invalidation is harmless; no Factory completion,
        // worker, native run or physical provider action is repeated.
        assert.equal(factoryEvents(), delivered); assert.deepEqual(await x.rows(), receipts);
        assert.deepEqual(await runs(), beforeRuns); await assertPaused();
        assert.deepEqual(calls, { pause: 1, connect: 0, create: 0, start: 0, enqueue: 0, kill: 0, keepAlive: 0 });
        assert.equal(x.github.calls.length, 0);
      } finally {
        pending.splice(0);
        for (const method of methods.reverse()) method.mock.restore();
        for (const mocked of mocks.reverse()) mocked.restore();
        if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url;
        if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret;
      }
    });

    await t.test("a code candidate cannot be approved into an unpublished state; HTTP refusals carry the PR", async () => {
      const x = await prepared();
      await assert.rejects(() => createFactoryApprovals(pool, f.authorize, f.store, [], { codeCandidatesMerge: true }).approve(actor, x.approval), (e) => e instanceof FactoryError && e.code === "factoryAcceptanceIsMerge");
      x.github.state.merge = async () => ({ merged: false, status: 403 });
      const request = { actor, authorization: null, method: "POST", taskId: x.task.id, origin: "https://mikka.test", url: `https://mikka.test/api/factory/tasks/${x.task.id}/approval` };
      const http = await handleFactoryApproval(f.service([]), { ...request, body: { operation: "accept", input: { binding: x.approval.binding, eventId: randomUUID() } }, githubToken: async () => TOKEN }, x.merges);
      assert.deepEqual(http, { status: 409, body: { error: "githubMergeForbidden", pullRequestUrl: x.pr } });
      const agent = await handleFactoryApproval(f.service([]), { ...request, authorization: "Bearer run-token", body: { operation: "accept", input: { binding: x.approval.binding, eventId: randomUUID() } }, githubToken: async () => TOKEN }, x.merges);
      assert.deepEqual(agent, { status: 401, body: { error: "factoryHumanRequired" } }, "agents and workers never reach the merge");
      assert.equal(x.github.calls.filter((c) => c.op === "merge").length, 1);
    });
  } finally {
    await f.close();
  }
});
