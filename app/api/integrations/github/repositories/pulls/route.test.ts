import assert from "node:assert/strict";
import { before, beforeEach, mock, test } from "node:test";

let owner: string | null = "owner";
let result: unknown = {
  items: [{ url: "https://github.com/Owner/Repo/pull/4" }],
  cursor: null,
  total: 1,
};
let failure: Error | null = null;
const calls: unknown[][] = [];
const stub = (path: string, namedExports: Record<string, unknown>) =>
  mock.module(new URL(path, import.meta.url).href, { namedExports });
stub("../../../../../../lib/auth.ts", {
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        calls.push(["session", headers]);
        return owner ? { user: { id: owner } } : null;
      },
    },
  },
});
stub("../../../../../../lib/desktop-rpc/handler.ts", {
  humanSessionHeaders: (request: Request) => request.headers,
});
stub("../../../../../../lib/request-log.ts", {
  withRequestLog: (_path: string, handler: unknown) => handler,
});
stub("../../../../../../lib/github/user-access.ts", {
  GitHubAccessError: class GitHubAccessError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
    ) {
      super(code);
    }
  },
});
stub("../../../../../../lib/github/pull-directory.ts", {
  repositoryPullDirectory: async (userId: string, input: unknown) => {
    calls.push(["read", userId, input]);
    if (failure) throw failure;
    return result;
  },
});
let route: typeof import("./route");
before(async () => {
  route = await import("./route");
});
beforeEach(() => {
  owner = "owner";
  result = {
    items: [{ url: "https://github.com/Owner/Repo/pull/4" }],
    cursor: null,
    total: 1,
  };
  failure = null;
  calls.length = 0;
});
const request = (query = "?repo=Owner%2FRepo&view=open") =>
  new Request(
    "https://mikka.example/api/integrations/github/repositories/pulls" + query,
    { headers: { cookie: "session=synthetic" } },
  );

test("reads only the authenticated owner’s selected repository and returns private no-store data", async () => {
  const response = await route.GET(request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ...(result as object),
    viewerId: "owner",
  });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(calls[1], [
    "read",
    "owner",
    { repo: "Owner/Repo", cursor: null, view: "open" },
  ]);
});

test("requires a human session and rejects malformed or attacker-added request fields", async () => {
  owner = null;
  assert.equal((await route.GET(request())).status, 401);
  owner = "owner";
  for (const query of [
    "?repo=../repo",
    "?repo=Owner%2FRepo&view=whatever",
    "?repo=Owner%2FRepo&owner=peer",
    "?repo=Owner%2FRepo&cursor=" + "x".repeat(1025),
  ]) {
    assert.equal(
      (await route.GET(request(query))).status,
      400,
      query.slice(0, 100),
    );
  }
  assert.equal(calls.filter((call) => call[0] === "read").length, 0);
});

test("returns bounded provider errors without source bodies", async () => {
  failure = Object.assign(new Error("githubUnavailable"), {
    status: 502,
    code: "githubUnavailable",
  });
  const response = await route.GET(request());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "githubUnavailable",
  });
});
