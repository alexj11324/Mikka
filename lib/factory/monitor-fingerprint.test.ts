import assert from "node:assert/strict";
import test from "node:test";
import { monitorFingerprint, monitorWorkspacePartition } from "./monitor-fingerprint";
const base = { userId: "owner-a", workspaceKey: "workspace:a", repository: "repo", environment: "production", target: "application", component: "api", check: "health", failure: "HTTP 503 token=secret-a request 123" };
test("replays with volatile values share a logical failure", () => {
  assert.deepEqual(monitorFingerprint(base), monitorFingerprint({ ...base, failure: "HTTP 503 token=secret-b request 456" }));
});
test("owner/workspace/repository/environment/target/check boundaries never coalesce", () => {
  for (const key of ["userId", "workspaceKey", "repository", "environment", "target", "component", "check"] as const) {
    assert.notEqual(monitorFingerprint(base).fingerprint, monitorFingerprint({ ...base, [key]: "other" }).fingerprint, key);
  }
});
test("different HTTP failure classes remain distinct", () => {
  assert.notEqual(monitorFingerprint(base).fingerprint, monitorFingerprint({ ...base, failure: "HTTP 401 token=secret-a request 123" }).fingerprint);
});
test("missing workspace association narrows to issue rather than personal namespace", () => {
  const input = { userId: "owner", issueId: "a", workspaceId: null, issueScope: "workspace", linearTeamSyncId: null };
  assert.notEqual(monitorWorkspacePartition(input), monitorWorkspacePartition({ ...input, issueId: "b" }));
  assert.equal(monitorWorkspacePartition({ ...input, workspaceId: "w" }), "workspace:w");
});

test("adapter HTTP codes remain distinct", () => {
 assert.notEqual(monitorFingerprint({ ...base, failure: "health-http-503" }).fingerprint, monitorFingerprint({ ...base, failure: "health-http-401" }).fingerprint);
});
