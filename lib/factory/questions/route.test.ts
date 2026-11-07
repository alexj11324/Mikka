// GET /api/factory/questions route gates, with auth and the Factory runtime mocked:
// the flag gate and the Authorization rejection run before any session or store access.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { FactoryError } from "../contract";

let enabled = false, sessions = 0, reads = 0;
const verifiedUsers = new WeakSet<object>();
const namedTaskId = "00000000-0000-4000-8000-000000000002";
const namedQuestion = { id: "00000000-0000-4000-8000-000000000003", taskId: namedTaskId,
  originRunId: "00000000-0000-4000-8000-000000000004", status: "open", kind: "permission",
  question: "Continue the original task?", options: ["Continue"], reference: {} };
mock.module("@/lib/api-auth", { namedExports: { auth: { api: { getSession: async () => { sessions++; const user = { id: "owner" }; verifiedUsers.add(user); return { user, session: { id: "question-fixture-session" } }; } } } } });
// This unit preserves the actual credential, origin and Factory adapters.
// Workspace authorization and transaction ownership are covered by the real PG suite.
mock.module("@/lib/factory/workspace-http", { namedExports: {
  factoryHumanWorkspaceResponse: async (user: object | null | undefined, work: () => Promise<Response>) => {
    assert.ok(user && verifiedUsers.has(user), "the adapter must retain the complete verified user");
    return work();
  },
} });

mock.module("@/lib/factory/runtime", { namedExports: {
  factoryLifecycleEnabled: () => enabled,
  factoryRuntimeForBot: () => ({ questions: { pending: async () => { reads++; return []; },
    list: async (_userId: string, taskId: string, readScope?: "bot" | "user") => {
      reads++;
      if (taskId !== namedTaskId) return [];
      if (readScope !== "user") throw new FactoryError("factoryNotFound");
      return [namedQuestion];
    },
  } }),
} });
let dbQueries = 0, handled = 0;
mock.module("@/lib/db", { namedExports: { pool: { query: async () => { dbQueries++; return { rows: [] }; } } } });
mock.module("@/lib/factory/questions/http", { namedExports: { handleFactoryQuestion: async () => { handled++; return { status: 200, body: {} }; } } });
const call = async (headers: Record<string, string> = {}, query = "") => {
  const { GET } = await import("@/app/api/factory/questions/route");
  const res = await GET(new Request(`https://mikka.test/api/factory/questions${query}`, { headers }));
  return { status: res.status, body: await res.json() };
};

test("flag off: 404 before session or store", async () => {
  enabled = false; sessions = reads = 0;
  assert.deepEqual(await call(), { status: 404, body: { error: "factoryLifecycleUnavailable" } });
  assert.deepEqual(await call({ authorization: "Bearer x" }), { status: 404, body: { error: "factoryLifecycleUnavailable" } });
  assert.deepEqual([sessions, reads], [0, 0]);
});

test("Authorization header: 401 before session or store, even with a valid cookie session", async () => {
  enabled = true; sessions = reads = 0;
  assert.deepEqual(await call({ authorization: "Bearer x" }), { status: 401, body: { error: "authRequired" } });
  assert.deepEqual([sessions, reads], [0, 0]);
  assert.deepEqual(await call(), { status: 200, body: { questions: [] } });
  assert.deepEqual([sessions, reads], [1, 1]);
});

test("the authenticated collection explicitly reads a named Bot task in user scope", async () => {
  enabled = true; sessions = reads = 0;
  const result = await call({}, `?taskId=${namedTaskId}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.questions.map((q: { questionId: string; taskId: string }) => [q.questionId, q.taskId]), [[namedQuestion.id, namedTaskId]]);
  assert.deepEqual([sessions, reads], [1, 1]);
});

test("flag off: GET and POST /api/factory/questions/:id return 404 before session, database or store", async () => {
  enabled = false; sessions = reads = dbQueries = handled = 0;
  const route = await import("@/app/api/factory/questions/[questionId]/route");
  const params = Promise.resolve({ questionId: "00000000-0000-4000-8000-000000000001" });
  for (const method of ["GET", "POST"] as const) {
    const res = await route[method](new Request("https://mikka.test/api/factory/questions/x", { method, ...(method === "POST" ? { body: "{}" } : {}) }), { params });
    assert.deepEqual({ status: res.status, body: await res.json() }, { status: 404, body: { error: "factoryLifecycleUnavailable" } });
  }
  assert.deepEqual([sessions, reads, dbQueries, handled], [0, 0, 0, 0]);
});
