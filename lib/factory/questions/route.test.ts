// GET /api/factory/questions route gates, with auth and the Factory runtime mocked:
// the flag gate and the Authorization rejection run before any session or store access.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

let enabled = false, sessions = 0, reads = 0;
mock.module("@/lib/auth", { namedExports: { auth: { api: { getSession: async () => { sessions++; return { user: { id: "owner" } }; } } } } });
mock.module("@/lib/factory/runtime", { namedExports: {
  factoryLifecycleEnabled: () => enabled,
  factoryRuntimeForBot: () => ({ questions: { pending: async () => { reads++; return []; }, list: async () => { reads++; return []; } } }),
} });
const call = async (headers: Record<string, string> = {}) => {
  const { GET } = await import("@/app/api/factory/questions/route");
  const res = await GET(new Request("https://mikka.test/api/factory/questions", { headers }));
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
