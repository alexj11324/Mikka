import assert from "node:assert/strict";
import test from "node:test";
import { planMonitorIssueAssociation as plan } from "./monitor-issue-plan";
const identity = { userId: "u", workspaceKey: "w", checkKey: "c", fingerprint: "f" };
const link = { ...identity, issueId: "i", incidentId: "incident" };
test("ten repeated links propose one existing incident without mutation", () => {
  const links = Object.freeze(Array(10).fill(Object.freeze(link)));
  assert.deepEqual(plan(identity, links, null), { action: "append", issueId: "i", incidentId: "incident" });
});
test("existing original issue is reused; new issue is only a proposal", () => {
  assert.deepEqual(plan(identity, [], { ...identity, issueId: "original" }), { action: "associate", issueId: "original" });
  assert.deepEqual(plan(identity, [], null), { action: "propose-new" });
});
test("foreign scope cannot associate or leak another incident", () => {
  assert.deepEqual(plan(identity, [{ ...link, userId: "other" }], null), { action: "propose-new" });
  assert.equal(plan(identity, [], { ...identity, workspaceKey: "other", issueId: "foreign" }).action, "blocked");
});
test("conflicting or incomplete identity fails closed", () => {
  assert.equal(plan(identity, [link, { ...link, incidentId: "second" }], null).action, "blocked");
  assert.equal(plan({ ...identity, checkKey: "" }, [], null).action, "blocked");
});
