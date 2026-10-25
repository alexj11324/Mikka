import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { routeSchema, routeStage } from "./contract";
import { handleFactory } from "./http";
import type { FactoryStore } from "./http";

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
