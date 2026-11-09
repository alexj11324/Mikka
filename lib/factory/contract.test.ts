import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bindingSchema, revisionBindingSchema, routeSchema, routeStage, nextStage, factoryFlowVersion, FactoryError, changeSchema } from "./contract";
import { factoryScopeAllows } from "./scope";
import { handleFactory } from "./http";
import type { FactoryStore } from "./http";
import { createFactoryHumanStore } from "./human-store";

test("mutation requests need only the owned task id and revision", () => {
  const binding = { taskId: randomUUID(), revision: 1 };
  assert.deepEqual(revisionBindingSchema.parse(binding), binding);
  assert.deepEqual(revisionBindingSchema.parse({ ...binding, issueId: randomUUID(), attemptId: randomUUID(), candidateId: randomUUID() }), binding);
  for (const input of [{ ...binding, revision: 0 }, { ...binding, revision: 1.5 }, { ...binding, taskId: 'invalid' }])
    assert.equal(revisionBindingSchema.safeParse(input).success, false);
});

test("clear authorization routes directly; only missing items clarify, spec is optional", () => {
  const base = routeSchema.parse({
    issueId: randomUUID(),
    eventId: randomUUID(),
    sourceEventId: randomUUID(),
    rationale: "Requested task",
  });
  assert.equal(routeStage(base), "execute");
  assert.equal(routeStage({ ...base, needsSpec: true }), "spec");
  assert.equal(
    routeStage({
      ...base,
      missingInformation: ["Target repository?"],
      needsSpec: true,
    }),
    "clarify",
  );
  assert.equal(
    routeStage({ ...base, missingPermissions: ["Target write grant"] }),
    "clarify",
  );
});
test("Factory authority follows its immutable task workspace across provider policy changes", () => {
  const task = { userId: "member", workspaceId: "shared", scopeVersion: 1 };
  const issue = { userId: "owner", workspaceId: "shared", ownershipState: "bound", scope: "workspace", scopeVersion: 1 };
  assert.equal(factoryScopeAllows(task, issue), true);
  assert.equal(factoryScopeAllows(task, { ...issue, scope: "personal", scopeVersion: 2 }), true);
  assert.equal(factoryScopeAllows(task, { ...issue, scopeVersion: 3 }), true);
  assert.equal(factoryScopeAllows({ ...task, scopeVersion: null }, issue), true);
  assert.equal(factoryScopeAllows(task, { ...issue, workspaceId: "other" }), false);
  assert.equal(factoryScopeAllows(task, { ...issue, ownershipState: "pending" }), false);
  assert.equal(factoryScopeAllows({ userId: "member" }, issue), false);
  assert.equal(factoryScopeAllows(task, undefined), false);
});
test("Factory owners cannot bypass missing or mismatched tenant bindings", () => {
  for (const scope of ["personal", "workspace"]) {
    const issue = { userId: "owner", workspaceId: "shared", ownershipState: "bound", scope, scopeVersion: 3 };
    for (const scopeVersion of [1, null, undefined]) {
      assert.equal(factoryScopeAllows({ userId: "owner", scopeVersion }, issue), false);
      assert.equal(factoryScopeAllows({ userId: "owner", workspaceId: "other", scopeVersion }, issue), false);
      assert.equal(factoryScopeAllows({ userId: "owner", workspaceId: "shared", scopeVersion }, issue), true);
      assert.equal(factoryScopeAllows({ userId: "member", scopeVersion }, issue), false);
    }
  }
});
test("Factory scope generation is captured by the host, never accepted from route or binding input", () => {
  assert.equal(routeSchema.safeParse({ issueId: randomUUID(), eventId: randomUUID(), sourceEventId: randomUUID(), rationale: "Requested task", scopeVersion: 3 }).success, false);
  assert.equal(bindingSchema.safeParse({ taskId: randomUUID(), issueId: randomUUID(), attemptId: randomUUID(), revision: 1, candidateId: null, scopeVersion: 3 }).success, false);
});
const noDatabase = new Proxy(
  {},
  {
    get() {
      throw new Error("must reject before store");
    },
  },
) as FactoryStore;
const req = {
  userId: "owner",
  method: "POST",
  taskId: randomUUID(),
  origin: "https://preview.invalid",
  url: "https://preview.invalid/api/factory/tasks/id",
  body: {},
};
test('same-candidate recheck is an explicit Owner operation and never a runtime stage-change instruction', async () => {
  let rechecks = 0, retries = 0, started = 0;
  const result = { task: { id: req.taskId, stage: 'review', status: 'running' } };
  const store = { recheckCandidate: async () => { rechecks++; return { result, start: async () => { started++; } }; },
    apply: async () => { retries++; } } as unknown as FactoryStore;
  const human = createFactoryHumanStore({ query: async () => ({ rows: [{ botId: null }] }) } as never, () => store);
  const response = await handleFactory(human, { ...req, body: { binding: { taskId: req.taskId, revision: 12 }, eventId: randomUUID(), action: 'recheck', reason: 'Inspect all criteria again' } });
  assert.equal(response.status, 200); assert.deepEqual(response.body, result);
  assert.deepEqual({ rechecks, retries, started }, { rechecks: 1, retries: 0, started: 1 });
  assert.equal(changeSchema.safeParse({ action: 'recheck', reason: 'Inspect all criteria again' }).success, false);
});
test("Owner Retry consumes an admitted completed run before ordinary execution retry", async () => {
  let retried = 0, recovered = 0, started = 0;
  const result = { task: { id: req.taskId, stage: "review", status: "running" } };
  const store = { retryCheckStart: async () => null, apply: async () => { retried++; return {}; }, retryCompletion: async () => {
    recovered++; return { result, start: async () => { started++; } };
  } } as unknown as FactoryStore;
  const pool = { query: async () => ({ rows: [{ botId: null }] }) };
  const human = createFactoryHumanStore(pool as never, () => store);
  const response = await handleFactory(human, { ...req, body: {
    binding: { taskId: req.taskId, revision: 16 }, eventId: randomUUID(), action: "retry", reason: "Retry",
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, result);
  assert.deepEqual({ recovered, retried, started }, { recovered: 1, retried: 0, started: 1 });
});
test("an unavailable completion recovery cannot fall through to ordinary Retry", async () => {
  let retries = 0;
  const store = { retryCheckStart: async () => null, apply: async () => { retries++; }, retryCompletion: async () => { throw new FactoryError('factoryCompletionRecoveryUnavailable'); } } as unknown as FactoryStore;
  const human = createFactoryHumanStore({ query: async () => ({ rows: [{ botId: null }] }) } as never, () => store);
  const response = await handleFactory(human, { ...req, body: {
    binding: { taskId: req.taskId, revision: 16 }, eventId: randomUUID(), action: 'retry', reason: 'Retry',
  } });
  assert.equal(response.status, 409);
  assert.equal(retries, 0);
});
test("ordinary failed-run Retry keeps its existing store path", async () => {
  let retries = 0;
  const store = { retryCheckStart: async () => null, apply: async () => { retries++; return { normalRetry: true }; }, retryCompletion: async () => null } as unknown as FactoryStore;
  const human = createFactoryHumanStore({ query: async () => ({ rows: [{ botId: null }] }) } as never, () => store);
  const response = await handleFactory(human, { ...req, body: {
    binding: { taskId: req.taskId, revision: 16 }, eventId: randomUUID(), action: 'retry', reason: 'Retry',
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { normalRetry: true });
  assert.equal(retries, 1);
});
test("API rejects missing session, invalid ids, cross origin, missing origin and unsupported methods before DB", async () => {
  assert.equal(
    (await handleFactory(noDatabase, { ...req, userId: null })).status,
    401,
  );
  assert.equal(
    (await handleFactory(noDatabase, { ...req, taskId: "invalid" })).status,
    404,
  );
  for (const origin of [
    null,
    "null",
    "malformed",
    "https://evil.invalid",
    "http://preview.invalid",
    "https://preview.invalid:444",
  ]) {
    assert.equal(
      (await handleFactory(noDatabase, { ...req, origin })).status,
      403,
    );
  }
  assert.equal(
    (await handleFactory(noDatabase, { ...req, method: "DELETE" })).status,
    405,
  );
  assert.equal((await handleFactory(noDatabase, req)).status, 422);
  assert.equal(
    (
      await handleFactory(noDatabase, {
        ...req,
        body: { action: "finish", status: "passed" },
      })
    ).status,
    422,
  );
});


test("the host flow version keeps old Verify history while new tasks hand off after one review", () => {
  assert.equal(factoryFlowVersion({}), 1);
  assert.equal(factoryFlowVersion({ route: { flowVersion: 2 } }), 2);
  assert.equal(nextStage('review'), 'verify');
  assert.equal(nextStage('verify'), 'approval');
  assert.equal(nextStage('review', 2), 'approval');
  assert.equal(nextStage('execute', 2, false), 'review');
  assert.equal(nextStage('execute', 2, true), 'approval');
  const input = { issueId: randomUUID(), eventId: randomUUID(), sourceEventId: randomUUID(), rationale: 'Task requested' };
  for (const flowVersion of [1, 2, 3]) assert.equal(routeSchema.safeParse({ ...input, flowVersion }).success, false);
});
