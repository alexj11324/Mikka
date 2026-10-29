import assert from "node:assert/strict";
import test from "node:test";
import { validateMonitorV2Observation as validate, type MonitorV2Observation } from "./monitor-v2-binding";
import type { FactoryPublicationReceiptV2 } from "./publication-receipt";
const at = "2026-10-28T12:00:00.000Z";
const provider = { version: 2 as const, name: "vercel" as const, teamId: "team_a", projectId: "prj_a", deploymentId: "dpl_a", environment: "production" as const, publicationId: "publication", bindingHash: "a".repeat(64) };
const target = { kind: "production-deployment" as const, operationId: "dpl_a", target: "vercel:team_a:prj_a:production", environment: "production", repository: "repo", sha: "a".repeat(40), reference: "https://immutable.vercel.app", observedAt: at, provider };
const receipt: FactoryPublicationReceiptV2 = { version: 2, publicationId: "publication", approvalId: "approval", taskId: "task", issueId: "issue", candidateId: "candidate", candidate: { sha: target.sha, repository: "repo", environment: "device", scope: "scope" }, action: "deploy_production", target: target.target, targetEnvironment: "production", publishedAt: at, reference: target.reference, verifiedTarget: target };
const observation: MonitorV2Observation = { startedAt: at, finishedAt: at, target, health: { immutableStatus: 200, immutableBodyValid: true, aliasStatus: 200, aliasBodyValid: true }, alias: { origin: "https://app.example.com", before: "dpl_a", after: "dpl_a" } };
const check = (r = receipt, o = observation) => validate(r, o, "https://app.example.com");
test("bound health is required independently of publication readiness", () => {
 assert.equal(check(), "healthy");
 assert.equal(check(receipt, { ...observation, health: { ...observation.health, immutableStatus: 503 } }), "unhealthy");
 assert.equal(check(receipt, { ...observation, health: { ...observation.health, immutableStatus: 403 } }), "blocked");
});
test("every provider identity field is bound", () => {
 for (const key of ["teamId", "projectId", "deploymentId", "publicationId", "bindingHash"] as const)
  assert.equal(check(receipt, { ...observation, target: { ...target, provider: { ...provider, [key]: "different" } } }), "blocked", key);
});
test("alias movement, prepublication and target mismatch block even healthy output", () => {
 assert.equal(check(receipt, { ...observation, alias: { ...observation.alias!, after: "dpl_old" } }), "blocked");
 assert.equal(check(receipt, { ...observation, startedAt: "2026-10-27T12:00:00Z" }), "blocked");
 for (const key of ["sha", "reference", "environment", "operationId", "repository", "target"] as const)
  assert.equal(check(receipt, { ...observation, target: { ...target, [key]: "wrong" } }), "blocked", key);
 assert.equal(check({ ...receipt, action: "merge" }), "blocked");
});

test("missing alias body evidence blocks even with immutable failure", () => {
 assert.equal(check(receipt, { ...observation, health: { ...observation.health, immutableStatus: 503, aliasBodyValid: null } }), "blocked");
});
