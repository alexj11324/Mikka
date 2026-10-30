import assert from "node:assert/strict";
import test from "node:test";
import { FactoryError } from "./contract";
import { factoryListStatus, handleFactoryList, type FactoryStore } from "./http";

test("list error codes distinguish 401/403/404/422/503", async () => {
  assert.equal(factoryListStatus("factoryNotFound"), 404);
  assert.equal(factoryListStatus("factoryInvalid"), 422);
  assert.equal(factoryListStatus("factoryForbidden"), 403);
  assert.equal(factoryListStatus("factoryRoutingUnavailable"), 503);
  assert.equal(factoryListStatus("factoryLifecycleUnavailable"), 503);
  assert.equal(factoryListStatus("factoryStale"), 409);
  const issueId = "00000000-0000-4000-8000-000000000000";
  const throwing = (code: string) =>
    ({ listForIssue: async () => { throw new FactoryError(code as never); } }) as unknown as FactoryStore;
  assert.equal((await handleFactoryList(throwing("factoryNotFound"), { userId: "u", issueId })).status, 404);
  assert.equal((await handleFactoryList(throwing("factoryRoutingUnavailable"), { userId: "u", issueId })).status, 503);
  assert.equal((await handleFactoryList(throwing("factoryNotFound"), { userId: null, issueId })).status, 401);
  assert.equal((await handleFactoryList(throwing("factoryNotFound"), { userId: "u", issueId: "x" })).status, 422);
});
