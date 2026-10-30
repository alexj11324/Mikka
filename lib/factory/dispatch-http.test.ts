import assert from "node:assert/strict";
import test from "node:test";
import { FactoryError } from "./contract";
import { handleFactoryDispatch } from "./dispatch-http";

const url = "https://app.example/api/factory/tasks";
const base = { userId: "u1", origin: "https://app.example", url, body: { x: 1 }, enabled: true };
const task = { id: "t1", stage: "execute", status: "running" };
const ok = (replayed: boolean) => async () => async (userId: string, input: unknown) => {
  assert.equal(userId, "u1"); assert.deepEqual(input, { x: 1 });
  return { task, runId: "r1", replayed, binding: { taskId: "t1" } } as never;
};
const never = async () => { throw new Error("dispatch must not be called"); };

test("auth, origin and flag gates run before dispatch", async () => {
  assert.equal((await handleFactoryDispatch(never, { ...base, userId: null })).status, 401);
  assert.equal((await handleFactoryDispatch(never, { ...base, origin: "https://evil.example" })).status, 403);
  assert.equal((await handleFactoryDispatch(never, { ...base, origin: null })).status, 403);
  assert.deepEqual(await handleFactoryDispatch(never, { ...base, enabled: false }), { status: 404, body: { error: "factoryLifecycleUnavailable" } });
});
test("new dispatch returns 201 with run, replay returns 200", async () => {
  const created = await handleFactoryDispatch(ok(false), base);
  assert.equal(created.status, 201);
  assert.deepEqual({ ...(created.body as object), task: undefined }, { taskId: "t1", runId: "r1", stage: "execute", status: "running", replayed: false, binding: { taskId: "t1" }, task: undefined });
  assert.equal((await handleFactoryDispatch(ok(true), base)).status, 200);
});
test("factory errors map to HTTP codes; other errors propagate", async () => {
  const fail = (code: string) => async () => async () => { throw new FactoryError(code); };
  assert.equal((await handleFactoryDispatch(fail("factoryNotFound"), base)).status, 404);
  assert.equal((await handleFactoryDispatch(fail("factoryInvalid"), base)).status, 422);
  assert.equal((await handleFactoryDispatch(fail("factoryStale"), base)).status, 409);
  assert.equal((await handleFactoryDispatch(fail("factoryLifecycleUnavailable"), base)).status, 404);
  await assert.rejects(handleFactoryDispatch(async () => async () => { throw new Error("boom"); }, base), /boom/);
});
