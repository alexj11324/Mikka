import assert from "node:assert/strict";
import test from "node:test";
import { FactoryError } from "./contract";
import { factoryListStatus, handleFactoryList, type FactoryStore } from "./http";
import { redactFactoryCheckText } from "./checks";

const issueId = "00000000-0000-4000-8000-000000000000";
const throwing = (error: unknown) =>
  ({ listForIssue: async () => { throw error; } }) as unknown as FactoryStore;

test("list contract is exactly 401/422/404/503", async () => {
  assert.equal(factoryListStatus("factoryNotFound"), 404);
  assert.equal(factoryListStatus("factoryInvalid"), 422);
  assert.equal(factoryListStatus("factoryStale"), 503);
  assert.deepEqual(await handleFactoryList(throwing(new FactoryError("factoryNotFound")), { userId: null, issueId }), { status: 401, body: { error: "authRequired" } });
  assert.deepEqual(await handleFactoryList(throwing(new FactoryError("factoryNotFound")), { userId: "u", issueId: "x" }), { status: 422, body: { error: "factoryInvalid" } });
  assert.deepEqual(await handleFactoryList(throwing(new FactoryError("factoryNotFound")), { userId: "u", issueId }), { status: 404, body: { error: "factoryNotFound" } });
});

test("a database error is 503 without detail, never a 500", async () => {
  const dbError = Object.assign(new Error('relation "factory_tasks" does not exist at 10.0.0.5 password=hunter2'), { code: "42P01" });
  const result = await handleFactoryList(throwing(dbError), { userId: "u", issueId });
  assert.deepEqual(result, { status: 503, body: { error: "factoryUnavailable" } });
  assert.doesNotMatch(JSON.stringify(result), /hunter2|42P01|factory_tasks/);
});

test("list reason uses the factory text masker", () => {
  assert.equal(redactFactoryCheckText("token ghp_abcdefghijklmnop leaked"), "token [REDACTED] leaked");
});

// TODO(#438): once #438's shared secret masker merges, the list reason must go through it
// (covers key=value secrets, URLs with credentials, etc. beyond the bearer/token patterns).
test("list reason masks key=value secrets via #438 masker", { skip: "pending #438 masker" }, () => {
  assert.doesNotMatch(redactFactoryCheckText("E2B_API_KEY=e2b_live_xxx"), /e2b_live_xxx/);
});
