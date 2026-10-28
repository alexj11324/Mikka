import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PoolClient } from "pg";
import { FactoryError } from "./approval-contract";
import { digest } from "./evidence";
import {
  authorizeFactoryDecision,
  type FactoryDecisionScope,
  type FactoryVerifiedPolicyDecision,
} from "./policy-authorization";

const now = new Date("2026-10-28T20:00:00Z");
const tx = {
  query: async () => ({ rows: [{ now }] }),
} as unknown as PoolClient;
const expected: FactoryDecisionScope = {
  ownerId: "synthetic-owner",
  binding: {
    taskId: randomUUID(),
    issueId: randomUUID(),
    attemptId: randomUUID(),
    candidateId: randomUUID(),
    revision: 8,
  },
  candidate: {
    sha: "a".repeat(40),
    repository: "https://github.com/alexj11324/Mikka.git",
    environment: "synthetic-device",
    scope: "synthetic-task",
  },
  action: "deploy_preview",
  target: "synthetic-target",
  targetEnvironment: "preview",
  evidenceDigest: "b".repeat(64),
  visualEvidenceDigests: ["c".repeat(64)],
  expiresAt: "2026-10-28T20:10:00Z",
};
function decision(): FactoryVerifiedPolicyDecision {
  return {
    version: 1,
    credentialId: "synthetic-credential",
    issuer: "synthetic-policy-authority",
    policyId: "synthetic-policy",
    policyRevision: "1",
    permissionAction: expected.action,
    ownerId: expected.ownerId,
    scopeDigest: digest(expected),
    decision: "allow",
    issuedAt: "2026-10-28T19:59:00Z",
    expiresAt: "2026-10-28T20:15:00Z",
    verification: {
      receiptId: "synthetic-signature-verification",
      signatureDigest: "d".repeat(64),
    },
    judgment: {
      receiptId: "synthetic-model-invocation",
      model: "synthetic-vision-model",
      capability: "vision",
      visualInputRequired: true,
      scopeDigest: digest(expected),
      evidenceDigest: expected.evidenceDigest,
      imageDigests: expected.visualEvidenceDigests,
    },
  };
}
const rejects = (fn: () => Promise<unknown>, code: string) =>
  assert.rejects(fn, (e) => e instanceof FactoryError && e.code === code);

test("policy allow has no human/session prerequisite; fixture authority is not a real signer/model", async () => {
  const d = decision();
  assert.equal(
    (
      await authorizeFactoryDecision(
        tx,
        { verify: async () => d },
        d.credentialId,
        expected,
      )
    ).decision,
    "allow",
  );
});
test("only policy ask requires its verified decision-bound confirmation", async () => {
  const d = decision();
  d.decision = "ask";
  const authority = { verify: async () => d };
  await rejects(
    () => authorizeFactoryDecision(tx, authority, d.credentialId, expected),
    "factoryPolicyConfirmationRequired",
  );
  d.confirmation = {
    decisionId: d.credentialId,
    ownerId: expected.ownerId,
    sessionId: "synthetic-session",
    scopeDigest: d.scopeDigest,
    confirmedAt: now.toISOString(),
    expiresAt: expected.expiresAt,
  };
  assert.equal(
    (await authorizeFactoryDecision(tx, authority, d.credentialId, expected))
      .decision,
    "ask",
  );
  d.confirmation.decisionId = "different";
  await rejects(
    () => authorizeFactoryDecision(tx, authority, d.credentialId, expected),
    "factoryPolicyConfirmationInvalid",
  );
});
test("deny cannot be upgraded by confirmation; current decisions are reread, never cached", async () => {
  const d = decision();
  let calls = 0;
  const authority = {
    verify: async () => {
      calls++;
      return d;
    },
  };
  await authorizeFactoryDecision(tx, authority, d.credentialId, expected);
  d.decision = "deny";
  await rejects(
    () => authorizeFactoryDecision(tx, authority, d.credentialId, expected),
    "factoryPolicyDenied",
  );
  assert.equal(calls, 2);
});
test("missing/broken authority is unavailable, not a new blanket human-confirmation fallback", async () => {
  await rejects(
    () => authorizeFactoryDecision(tx, undefined, "id", expected),
    "factoryPolicyDecisionUnavailable",
  );
  await rejects(
    () =>
      authorizeFactoryDecision(
        tx,
        {
          verify: async () => {
            throw Error("private upstream detail");
          },
        },
        "id",
        expected,
      ),
    "factoryPolicyDecisionUnavailable",
  );
  await rejects(
    () =>
      authorizeFactoryDecision(
        tx,
        { verify: async () => ({ decision: "allow" }) },
        "id",
        expected,
      ),
    "factoryPolicyDecisionInvalid",
  );
});
test("ordinary network permission and unknown-action ask cannot become a Factory deployment credential", async () => {
  const raw = { ...decision(), decision: "ask", permissionAction: "network" };
  await rejects(
    () =>
      authorizeFactoryDecision(
        tx,
        { verify: async () => raw },
        raw.credentialId,
        expected,
      ),
    "factoryPolicyDecisionInvalid",
  );
});
test("owner/candidate/action/target/environment/evidence/expiry cannot be substituted", async () => {
  const d = decision(),
    authority = { verify: async () => d };
  for (const patch of [
    { ownerId: "other" },
    { candidate: { ...expected.candidate, sha: "e".repeat(40) } },
    { action: "deploy_production" as const },
    { target: "other" },
    { targetEnvironment: "production" },
    { evidenceDigest: "e".repeat(64) },
    { expiresAt: "2026-10-28T20:11:00Z" },
  ])
    await rejects(
      () =>
        authorizeFactoryDecision(tx, authority, d.credentialId, {
          ...expected,
          ...patch,
        }),
      "factoryPolicyDecisionMismatch",
    );
  d.expiresAt = now.toISOString();
  await rejects(
    () => authorizeFactoryDecision(tx, authority, d.credentialId, expected),
    "factoryPolicyDecisionExpired",
  );
});
test("visual task needs actual recorded image-input digests from the trusted model invocation", async () => {
  const d = decision();
  d.judgment.imageDigests = [];
  await rejects(
    () =>
      authorizeFactoryDecision(
        tx,
        { verify: async () => d },
        d.credentialId,
        expected,
      ),
    "factoryPolicyDecisionMismatch",
  );
  const raw = {
    ...decision(),
    judgment: { ...decision().judgment, capability: "text-only" },
  };
  await rejects(
    () =>
      authorizeFactoryDecision(
        tx,
        { verify: async () => raw },
        raw.credentialId,
        expected,
      ),
    "factoryPolicyDecisionInvalid",
  );
});
