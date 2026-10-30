import assert from "node:assert/strict";
import test from "node:test";
import { FactoryError } from "./contract";
import { factoryRouteEnabled, handleFactoryRoute, maskRouteText } from "./route-http";

const url = "https://app.example/api/factory/tasks/route";
const base = { userId: "u1", origin: "https://app.example", url, body: { rationale: "x" }, enabled: true };
const task = { id: "t1", issueId: "i1", attemptId: "a1", candidateId: null, revision: 1, stage: "execute", status: "pending" };
const never = async () => { throw new Error("route must not be called"); };

test("auth, origin and flag gates run before routing", async () => {
  assert.deepEqual(await handleFactoryRoute(never, { ...base, userId: null }), { status: 401, body: { error: "authRequired" } });
  assert.deepEqual(await handleFactoryRoute(never, { ...base, origin: "https://evil.example" }), { status: 403, body: { error: "originRejected" } });
  assert.deepEqual(await handleFactoryRoute(never, { ...base, origin: null }), { status: 403, body: { error: "originRejected" } });
  assert.deepEqual(await handleFactoryRoute(never, { ...base, enabled: false }), { status: 404, body: { error: "factoryLifecycleUnavailable" } });
});
test("routed task returns its binding for dispatch", async () => {
  const ok = async () => async (userId: string, input: unknown) => {
    assert.equal(userId, "u1"); assert.deepEqual(input, { rationale: "x" });
    return { task } as never;
  };
  assert.deepEqual(await handleFactoryRoute(ok, base), {
    status: 200,
    body: { taskId: "t1", stage: "execute", status: "pending", binding: { taskId: "t1", issueId: "i1", attemptId: "a1", candidateId: null, revision: 1 }, task },
  });
});
test("factory errors map to HTTP codes with exact bodies; others propagate", async () => {
  const fail = (code: string) => async () => async () => { throw new FactoryError(code); };
  for (const [code, status] of [["factoryNotFound", 404], ["factoryLifecycleUnavailable", 404], ["factoryInvalid", 422], ["factorySourceMismatch", 409], ["factoryRouteExists", 409], ["factoryReplayMismatch", 409], ["factoryStopped", 409]] as const)
    assert.deepEqual(await handleFactoryRoute(fail(code), base), { status, body: { error: code } }, code);
  await assert.rejects(handleFactoryRoute(async () => async () => { throw new Error("boom"); }, base), /boom/);
});
test("route gate: issue mutations AND routing AND lifecycle (literal 1)", () => {
  const on = { MIKKA_FACTORY_ROUTING_ENABLED: "1", MIKKA_FACTORY_LIFECYCLE_ENABLED: "1" };
  assert.equal(factoryRouteEnabled(true, on), true);
  assert.equal(factoryRouteEnabled(false, on), false);
  assert.equal(factoryRouteEnabled(true, { ...on, MIKKA_FACTORY_ROUTING_ENABLED: undefined }), false);
  assert.equal(factoryRouteEnabled(true, { ...on, MIKKA_FACTORY_LIFECYCLE_ENABLED: "0" }), false);
  assert.equal(factoryRouteEnabled(true, { ...on, MIKKA_FACTORY_ROUTING_ENABLED: "true" }), false);
});
test("persisted human text is masked; other fields and non-objects pass through", () => {
  const token = "ghp_fixtureFixture1234";
  const masked = maskRouteText({ issueId: "i", rationale: `use ${token}`, missingInformation: [`token=${token}`, 3], needsSpec: true }) as Record<string, unknown>;
  assert.ok(!JSON.stringify(masked).includes(token));
  assert.equal(masked.issueId, "i"); assert.equal(masked.needsSpec, true); assert.equal((masked.missingInformation as unknown[])[1], 3);
  assert.equal(maskRouteText(null), null);
  assert.deepEqual(maskRouteText([1]), [1]);
});
