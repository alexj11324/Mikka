import "../../tests/support/server-only.mjs";
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import { GitHubAccessError } from "./user-access-error";

mock.module(new URL("./user-access.ts", import.meta.url).href, {
  namedExports: {
    githubRepositoryReadCredential: async (userId: string, key: string) => {
      assert.equal(userId, "owner");
      assert.equal(key, "v2/github.com/owner/repo");
      return { token: "test-private-token", repository: { id: "91", fullName: "Owner/Repo" } };
    },
    GitHubAccessError,
  },
});
const sha = "a".repeat(40);
let body: () => unknown;
let variables: Record<string, unknown> = {};
mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
  const sent = JSON.parse(String(init?.body));
  assert.ok(sent.query.startsWith("query PullDetail("));
  assert.ok(!sent.query.includes("mutation"));
  variables = sent.variables;
  return Response.json(body());
});
const pull = () => ({
  number: 7, title: "A PR", bodyText: "Body", state: "OPEN", isDraft: false,
  createdAt: "2026-11-17T00:00:00Z", updatedAt: "2026-11-18T00:00:00Z",
  additions: 3, deletions: 1, changedFiles: 2, headRefName: "fix", baseRefName: "main", headRefOid: sha,
  mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
  author: { login: "dana", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
  labels: { nodes: [{ name: "ui" }] },
  commits: { nodes: [{ commit: { oid: sha, statusCheckRollup: { state: "FAILURE", contexts: { pageInfo: { hasNextPage: true }, nodes: [
    { __typename: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/x" },
    { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null, detailsUrl: null },
    { __typename: "StatusContext", context: "deploy", state: "SUCCESS", targetUrl: null },
    { __typename: "SomethingNew" },
  ] } } } }] },
  reviews: { nodes: [{ author: { login: "alex" }, state: "APPROVED", submittedAt: "2026-11-18T00:00:00Z" }] },
});
const response = (pr: unknown, databaseId = 91) => ({ data: { repository: { databaseId, nameWithOwner: "Owner/Repo", pullRequest: pr } } });
const { readPullDetail } = await import("./pull-detail");
const read = () => readPullDetail("owner", "owner/repo", 7, { deadline: Date.now() + 25_000 });
beforeEach(() => { body = () => response(pull()); });

test("one PR reads its summary, its current head's checks and its reviews, with or without a task", async () => {
  const detail = await read();
  assert.deepEqual(variables, { owner: "Owner", name: "Repo", number: 7 });
  assert.equal(detail.url, "https://github.com/Owner/Repo/pull/7");
  assert.equal(detail.headSha, sha);
  assert.equal(detail.head, "fix");
  assert.deepEqual(detail.checkRuns.map((check) => [check.name, check.state]), [["unit", "failure"], ["lint", "pending"], ["deploy", "success"]]);
  assert.equal(detail.moreChecks, true);
  assert.deepEqual(detail.reviews, [{ author: "alex", state: "APPROVED", submittedAt: "2026-11-18T00:00:00Z" }]);
  assert.ok(!JSON.stringify(detail).includes("test-private-token"));
});

test("checks of an older head are not reported as this head's", async () => {
  body = () => {
    const pr = pull();
    pr.commits.nodes[0].commit.oid = "b".repeat(40);
    return response(pr);
  };
  const detail = await read();
  assert.deepEqual(detail.checkRuns, []);
  assert.equal(detail.checks, null);
});

test("another repository's identity or a missing PR is refused, never read", async () => {
  body = () => response(pull(), 92);
  await assert.rejects(read(), { message: "githubRepositoryForbidden" });
  body = () => response(null);
  await assert.rejects(read(), { message: "githubPullRequestInvalid" });
  body = () => ({ ...response(pull()), errors: [{ message: "private" }] });
  await assert.rejects(read(), { message: "githubUnavailable" });
});
