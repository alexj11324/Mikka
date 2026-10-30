import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { factory194Fixture } from "../../tests/helpers/factory194";
import { factory194Target } from "../../tests/helpers/factory194-target";
import { FactoryError } from "./approval-contract";
import { createFactoryApprovals } from "./approval";
import { handleFactoryApproval } from "./approval-http";
import { createFactoryMerges, FactoryMergeRefused, type GitHubMergePort, type GitHubPullRequestView } from "./merge";

// #528: acceptance is the person's own merge of the candidate PR. Real
// PostgreSQL (isolated schema); GitHub is a fixture that records every call.

const ci = process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true";
const db = process.env.FACTORY194_TEST_URL ?? (ci ? process.env.E2E_DATABASE_URL : undefined);
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
    await pool.query(await readFile(new URL("../../drizzle/20261030233000_factory_merges.sql", import.meta.url), "utf8"));

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
      const ledger = await f.service([]).ledger(actor, x.task.id);
      assert.equal(ledger.merges.length, 1);
      assert.equal(ledger.merges[0].status, "merged");
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
