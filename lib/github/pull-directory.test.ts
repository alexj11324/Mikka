import "../../tests/support/server-only.mjs";
import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { GitHubAccessError } from "./user-access-error";
const credential = mock.fn(async (userId: string, key: string) => {
  assert.equal(userId, "owner");
  assert.equal(key, "v2/github.com/owner/repo");
  return {
    token: "test-private-token",
    repository: { id: "91", fullName: "Owner/Repo" },
  };
});
mock.module(new URL("./user-access.ts", import.meta.url).href, {
  namedExports: {
    githubRepositoryReadCredential: credential,
    GitHubAccessError,
  },
});
let response: () => Response;
let variables: Record<string, unknown>;
const request = mock.method(
  globalThis,
  "fetch",
  async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(url, "https://api.github.com/graphql");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-private-token",
    );
    const body = JSON.parse(String(init?.body));
    assert.ok(body.query.startsWith("query PullDirectory("));
    assert.ok(body.query.includes("pullRequests(first: 20"));
    assert.ok(!body.query.includes("mutation"));
    variables = body.variables;
    return response();
  },
);
const sha = "a".repeat(40);
const fixture = () => ({
  data: {
    repository: {
      databaseId: 91,
      nameWithOwner: "Owner/Repo",
      pullRequests: {
        totalCount: 52,
        pageInfo: { hasNextPage: true, endCursor: "next-page" },
        nodes: [
          {
            number: 7,
            title: "A real PR",
            bodyText: "Description",
            state: "OPEN",
            isDraft: false,
            createdAt: "2026-11-17T12:00:00Z",
            updatedAt: "2026-11-18T00:00:00Z",
            additions: 12,
            deletions: 3,
            headRefName: "fix",
            baseRefName: "main",
            headRefOid: sha,
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            author: {
              login: "alex",
              avatarUrl: "https://avatars.githubusercontent.com/u/1",
            },
            labels: { nodes: [{ name: "bug" }] },
            commits: {
              nodes: [
                {
                  commit: { oid: sha, statusCheckRollup: { state: "SUCCESS" } },
                },
              ],
            },
          },
        ],
      },
    },
  },
});
let read: (typeof import("./pull-directory"))["repositoryPullDirectory"];
before(async () => {
  read = (await import("./pull-directory")).repositoryPullDirectory;
});
beforeEach(() => {
  credential.mock.resetCalls();
  request.mock.resetCalls();
  response = () => Response.json(fixture());
});
after(() => request.mock.restore());
const run = (input: Parameters<typeof read>[1] = { repo: "Owner/Repo" }) =>
  read("owner", input, { deadline: Date.now() + 25000 });
test("verifies repository ID and keeps provider cursor, head-bound status and actual author", async () => {
  const page = await run();
  assert.equal(page.total, 52);
  assert.equal(page.cursor, "next-page");
  assert.equal(page.items[0].author, "alex");
  assert.equal(page.items[0].checks, "SUCCESS");
  assert.equal(page.items[0].url, "https://github.com/Owner/Repo/pull/7");
  assert.ok(!JSON.stringify(page).includes("test-private-token"));
  assert.equal(credential.mock.callCount(), 1);
  await run({ repo: "Owner/Repo", cursor: "previous", view: "merged" });
  assert.deepEqual(variables, {
    owner: "Owner",
    name: "Repo",
    after: "previous",
    states: ["MERGED"],
  });
});
test("never interprets partial GraphQL errors as an empty or successful page", async () => {
  response = () =>
    Response.json({ ...fixture(), errors: [{ message: "private body" }] });
  await assert.rejects(run(), { message: "githubUnavailable" });
});
test("rejects mismatched repository identity and cyclic pagination", async () => {
  response = () => {
    const data = fixture();
    data.data.repository.databaseId = 92;
    return Response.json(data);
  };
  await assert.rejects(run(), { message: "githubRepositoryForbidden" });
  response = () => Response.json(fixture());
  await assert.rejects(run({ repo: "Owner/Repo", cursor: "next-page" }), {
    message: "githubUnavailable",
  });
});
test("old-head checks are unknown, and closed drafts remain closed", async () => {
  response = () => {
    const data = fixture();
    const row = data.data.repository.pullRequests.nodes[0];
    row.commits.nodes[0].commit.oid = "b".repeat(40);
    row.state = "CLOSED";
    row.isDraft = true;
    return Response.json(data);
  };
  const page = await run();
  assert.equal(page.items[0].checks, null);
  assert.equal(page.items[0].state, "closed");
});
test("denied repository access never sends GraphQL, nor leaks provider errors", async () => {
  credential.mock.mockImplementationOnce(async () => {
    throw new GitHubAccessError("githubRepositoryForbidden", 403);
  });
  await assert.rejects(run(), { message: "githubRepositoryForbidden" });
  assert.equal(request.mock.callCount(), 0);
  response = () => new Response("private body", { status: 403 });
  await assert.rejects(run(), { message: "githubRepositoryForbidden" });
  response = () => new Response("private body", { status: 401 });
  await assert.rejects(run(), { message: "githubReconnectRequired" });
});
test("since keeps PRs opened from that instant and stops paging once updates fall before it", async () => {
  response = () => {
    const data = fixture();
    const [row] = data.data.repository.pullRequests.nodes;
    data.data.repository.pullRequests.nodes = [
      row,
      { ...row, number: 6, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z" },
    ];
    return Response.json(data);
  };
  const open = await run({ repo: "Owner/Repo", since: "2026-11-01T00:00:00Z" });
  assert.deepEqual(open.items.map((item) => item.number), [7]);
  assert.equal(open.cursor, "next-page", "every update on this page is after the cut-off, so older PRs may follow");
  const stale = await run({ repo: "Owner/Repo", since: "2026-11-17T06:00:00Z" });
  assert.deepEqual(stale.items.map((item) => item.number), [7]);
  assert.equal(stale.cursor, null, "a page reaching updates before the cut-off is the last one that can match");
  assert.equal("since" in variables, false, "GitHub is never asked to filter: the cut-off is applied to what it returns");
});
