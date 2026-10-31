import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { bindingSchema, revisionBindingSchema, routeSchema, routeStage } from "./contract";
import { factoryScopeAllows } from "./scope";
import { handleFactory } from "./http";
import type { FactoryStore } from "./http";

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
test("Factory teammate grants stay in their original issue generation", () => {
  const task = { userId: "member", scopeVersion: 1 };
  const issue = { userId: "owner", scope: "workspace", scopeVersion: 1 };
  assert.equal(factoryScopeAllows(task, issue), true);
  assert.equal(factoryScopeAllows(task, { ...issue, scope: "personal", scopeVersion: 2 }), false);
  assert.equal(factoryScopeAllows(task, { ...issue, scopeVersion: 3 }), false);
  assert.equal(factoryScopeAllows({ ...task, scopeVersion: null }, issue), false);
  assert.equal(factoryScopeAllows({ userId: "member" }, issue), false);
  assert.equal(factoryScopeAllows(task, undefined), false);
});
test("Factory issue owners keep their own authority without renewing teammate grants", () => {
  for (const scope of ["personal", "workspace"]) {
    const issue = { userId: "owner", scope, scopeVersion: 3 };
    for (const scopeVersion of [1, null, undefined]) {
      assert.equal(factoryScopeAllows({ userId: "owner", scopeVersion }, issue), true);
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
