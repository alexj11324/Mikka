import "../../tests/support/server-only.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GitHubAccessError } from "./user-access-error";
import type { GitHubMergePort } from "../factory/merge";
import type { PullCheck, PullDetail } from "../pull-directory";

const { mergePullRequest } = await import("./pull-merge");
const sha = "a".repeat(40);
const detail = (patch: Partial<PullDetail> = {}): PullDetail => ({
  url: "https://github.com/Owner/Repo/pull/7",
  title: "A PR",
  state: "open",
  repo: "Owner/Repo",
  number: 7,
  author: "dana",
  authorAvatar: null,
  updatedAt: "2026-11-18T00:00:00Z",
  createdAt: "2026-11-17T00:00:00Z",
  body: "",
  head: "fix",
  base: "main",
  headSha: sha,
  checks: "SUCCESS",
  mergeState: "CLEAN",
  reviewDecision: null,
  labels: [],
  changedFiles: 1,
  mergeable: "MERGEABLE",
  checkRuns: [],
  moreChecks: false,
  reviews: [],
  ...patch,
});
function harness(options: {
  detail?: PullDetail;
  token?: () => Promise<string>;
  github?: Partial<GitHubMergePort>;
} = {}) {
  const merges: unknown[] = [];
  const github: GitHubMergePort = {
    pullRequest: async () => ({ state: "open", merged: false, headSha: sha, mergeableState: "clean", mergeCommitSha: null }),
    mergeMethods: async () => ["squash", "merge"],
    merge: async (token, repo, number, input) => {
      merges.push([token, repo, number, input]);
      return { merged: true, mergeCommitSha: "b".repeat(40) };
    },
    ...options.github,
  };
  return {
    merges,
    deps: {
      detail: async (userId: string, repo: string, number: number) => {
        assert.deepEqual([userId, repo, number], ["owner", "Owner/Repo", 7]);
        return options.detail ?? detail();
      },
      userToken: options.token ?? (async () => "user-token"),
      github,
    },
  };
}
const input = { repo: "Owner/Repo", number: 7, expectedHeadSha: sha };

test("merges as the person, bound to the head they looked at, with the method they asked for when the repository allows it", async () => {
  const { deps, merges } = harness();
  assert.deepEqual(await mergePullRequest("owner", { ...input, method: "merge" }, deps), { kind: "merged", mergeCommitSha: "b".repeat(40) });
  assert.deepEqual(merges, [["user-token", "Owner/Repo", 7, { sha, method: "merge" }]]);
  const second = harness();
  await mergePullRequest("owner", { ...input, method: "rebase" }, second.deps);
  assert.deepEqual((second.merges[0] as unknown[])[3], { sha, method: "squash" }, "a method the repository refuses falls back to its first allowed one");
});

test("failing checks wait for the person's go-ahead; pending and skipped ones do not", async () => {
  const runs: PullCheck[] = [
    { name: "unit", state: "failure", url: null },
    { name: "lint", state: "pending", url: null },
    { name: "e2e", state: "skipped", url: null },
  ];
  const held = harness({ detail: detail({ checkRuns: runs }) });
  assert.deepEqual(await mergePullRequest("owner", input, held.deps), { kind: "needs_confirm", failing: 1 });
  assert.equal(held.merges.length, 0);
  const confirmed = harness({ detail: detail({ checkRuns: runs }) });
  assert.equal((await mergePullRequest("owner", { ...input, confirmFailedChecks: true }, confirmed.deps)).kind, "merged");
});

test("a moved head, a closed or already-merged PR and GitHub's refusals come back as stable codes, never a merge", async () => {
  const moved = harness({ detail: detail({ headSha: "c".repeat(40) }) });
  assert.deepEqual(await mergePullRequest("owner", input, moved.deps), { kind: "refused", code: "githubMergeHeadMoved" });
  assert.deepEqual(await mergePullRequest("owner", input, harness({ detail: detail({ state: "closed" }) }).deps), { kind: "refused", code: "githubMergeClosed" });
  assert.deepEqual(await mergePullRequest("owner", input, harness({ detail: detail({ state: "merged" }) }).deps), { kind: "merged", mergeCommitSha: null });
  const raced = harness({ github: { pullRequest: async () => ({ state: "open", merged: false, headSha: "d".repeat(40), mergeableState: null, mergeCommitSha: null }) } });
  assert.deepEqual(await mergePullRequest("owner", input, raced.deps), { kind: "refused", code: "githubMergeHeadMoved" });
  assert.equal(raced.merges.length, 0);
  const blocked = harness({ github: { merge: async () => ({ merged: false, status: 405 }), pullRequest: async () => ({ state: "open", merged: false, headSha: sha, mergeableState: "blocked", mergeCommitSha: null }) } });
  assert.deepEqual(await mergePullRequest("owner", input, blocked.deps), { kind: "refused", code: "githubMergeBlocked" });
  const forbidden = harness({ github: { merge: async () => ({ merged: false, status: 403 }) } });
  assert.deepEqual(await mergePullRequest("owner", input, forbidden.deps), { kind: "refused", code: "githubMergeForbidden" });
  const none = harness({ github: { mergeMethods: async () => [] } });
  assert.deepEqual(await mergePullRequest("owner", input, none.deps), { kind: "refused", code: "githubMergeBlocked" });
});

test("without the person's own GitHub authorization nothing is merged", async () => {
  const { deps, merges } = harness({ token: async () => { throw new GitHubAccessError("githubReconnectRequired", 401); } });
  assert.deepEqual(await mergePullRequest("owner", input, deps), { kind: "refused", code: "githubMergeAuthorizationRequired" });
  assert.equal(merges.length, 0);
});

test("input names one PR of an admitted repository by number and full head SHA", async () => {
  const { deps } = harness();
  for (const bad of [
    { ...input, repo: "https://github.com/Owner/Repo" },
    { ...input, number: 0 },
    { ...input, expectedHeadSha: "abc" },
    { ...input, extra: true },
  ])
    await assert.rejects(mergePullRequest("owner", bad as typeof input, deps));
});

test("a merge whose answer is lost is read again: merged at this head is success, anything else stays an error", async () => {
  let reads = 0;
  const landed = harness({ github: {
    merge: async () => { throw new Error("socket hang up"); },
    pullRequest: async () => (++reads === 1
      ? { state: "open", merged: false, headSha: sha, mergeableState: "clean", mergeCommitSha: null }
      : { state: "closed", merged: true, headSha: sha, mergeableState: null, mergeCommitSha: "c".repeat(40) }),
  } });
  assert.deepEqual(await mergePullRequest("owner", input, landed.deps), { kind: "merged", mergeCommitSha: "c".repeat(40) });
  assert.equal(reads, 2);
  const lost = new Error("socket hang up");
  const notMerged = harness({ github: { merge: async () => { throw lost; } } });
  await assert.rejects(mergePullRequest("owner", input, notMerged.deps), (error) => error === lost);
  let other = 0;
  const elsewhere = harness({ github: {
    merge: async () => { throw new Error("timeout"); },
    pullRequest: async () => (++other === 1
      ? { state: "open", merged: false, headSha: sha, mergeableState: "clean", mergeCommitSha: null }
      : { state: "closed", merged: true, headSha: "e".repeat(40), mergeableState: null, mergeCommitSha: "f".repeat(40) }),
  } });
  await assert.rejects(mergePullRequest("owner", input, elsewhere.deps), { message: "timeout" }, "a different head merged is not this merge");
});
