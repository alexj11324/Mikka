import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { intakeRequest, intakeSchema } from "./intake";
import { routeStage } from "./contract";
const request = () => ({
  sourceEventId: randomUUID(),
  title: "Change parser",
  body: "Keep the API",
  rationale: "Actual user request",
  missingInformation: [],
  missingPermissions: [],
  needsSpec: false,
});
test("clear requests execute; actual missing information/permission wins over optional spec", () => {
  const r = request();
  assert.equal(routeStage(r), "execute");
  assert.equal(routeStage({ ...r, needsSpec: true }), "spec");
  for (const key of ["missingInformation", "missingPermissions"])
    assert.equal(
      routeStage({ ...r, needsSpec: true, [key]: ["Which target?"] }),
      "clarify",
    );
  for (const field of ["ownerId", "botId", "approved", "questionId", "stage"])
    assert.equal(
      intakeSchema.safeParse({ ...r, [field]: "forged" }).success,
      false,
    );
});
test("failure after issue creation reuses the same durable issue key and never reports routing success", async () => {
  const r = request(),
    issueId = randomUUID(),
    seen = new Map<string, string>();
  let attempts = 0;
  const deps = {
    source: async (id: string) => assert.equal(id, r.sourceEventId),
    create: async (_body: unknown, key: string) => {
      seen.set(key, issueId);
      return { id: seen.get(key) };
    },
    route: async (input: unknown) => {
      attempts++;
      if (attempts === 1) throw Error("interrupted");
      return input;
    },
  };
  await assert.rejects(intakeRequest(r, deps), /interrupted/);
  const result = (await intakeRequest(r, deps)) as {
    issueId: string;
    eventId: string;
  };
  assert.equal(seen.size, 1);
  assert.equal(result.issueId, issueId);
  assert.equal(result.eventId, r.sourceEventId);
});
test("source denial and durable creation conflict cannot proceed to routing", async () => {
  let created = 0,
    routed = 0;
  const deps = {
    source: async () => {
      throw Error("sourceMismatch");
    },
    create: async () => {
      created++;
      return { error: "issueToolCallConflict" };
    },
    route: async () => {
      routed++;
    },
  };
  await assert.rejects(intakeRequest(request(), deps), /sourceMismatch/);
  assert.equal(created, 0);
  const result = await intakeRequest(request(), {
    ...deps,
    source: async () => {},
  });
  assert.deepEqual(result, { error: "issueToolCallConflict" });
  assert.equal(routed, 0);
});
