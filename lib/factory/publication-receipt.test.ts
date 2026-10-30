import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PoolClient } from "pg";
import { FactoryError } from "./contract";
import { publicationBindingHash } from "./publication-operation";
import {
  assertPublicationTarget,
  readFactoryPublicationReceiptV2,
  type PublicationAdapterReceipt,
} from "./publication-receipt";

function fixture(environment = "preview") {
  const candidate = {
    repository: "fixture/Mikka",
    sha: "a".repeat(40),
    environment: "device:fixture",
    scope: "run-report Skill",
  };
  const publicationId = randomUUID();
  const authorization = {
    approvalId: randomUUID(),
    ownerId: "fixture-owner",
    humanSessionId: "fixture-session",
    expiresAt: "2026-10-27T00:00:00.000Z",
    binding: {
      taskId: randomUUID(),
      issueId: randomUUID(),
      candidateId: randomUUID(),
      attemptId: randomUUID(),
      revision: 8,
    },
    eventId: randomUUID(),
    action: "activate_skill" as const,
    target: "mikka-builtin:run-report",
    targetEnvironment: environment,
  };
  const bindingHash = publicationBindingHash({
    idempotencyKey: publicationId,
    candidate,
    authorization,
  });
  const receipt: PublicationAdapterReceipt = {
    reference: `skill:${randomUUID()}`,
    verifiedTarget: {
      kind: "skill-activation",
      operationId: publicationId,
      target: authorization.target,
      environment,
      repository: candidate.repository,
      sha: candidate.sha,
      reference: "",
      observedAt: "2026-10-26T20:30:00.000Z",
      skill: {
        version: 1,
        publicationId,
        bindingHash,
        versionId: randomUUID(),
        sha256: "b".repeat(64),
        proposalId: randomUUID(),
        evaluationId: randomUUID(),
      },
    },
  };
  receipt.verifiedTarget.reference = receipt.reference;
  const row = {
    ...candidate,
    id: publicationId,
    approvalId: authorization.approvalId,
    candidate,
    action: authorization.action as string,
    target: authorization.target,
    eventId: authorization.eventId,
    approvalAction: authorization.action,
    approvalTarget: authorization.target,
    publishAttemptId: authorization.binding.attemptId,
    publishRevision: authorization.binding.revision,
    createdAt: new Date("2026-10-26T20:29:00.000Z"),
    request: { binding:authorization.binding,approvalId:authorization.approvalId,eventId:authorization.eventId,action:authorization.action,target:authorization.target,targetEnvironment:authorization.targetEnvironment },
    approvalRequest: { binding:authorization.binding,eventId:randomUUID(),candidate,action:authorization.action,target:authorization.target,targetEnvironment:authorization.targetEnvironment,expiresAt:authorization.expiresAt,evidenceDigest:"d".repeat(64),evidenceReadId:randomUUID() },
    humanSessionId: authorization.humanSessionId,
    issueId: authorization.binding.issueId,
    publishStatus: "passed",
    publishOutput: { publicationId, approvalId: authorization.approvalId },
    publishFinishedAt: new Date("2026-10-26T20:31:00.000Z"),
    finishedAt: new Date("2026-10-26T20:31:00.000Z"),
    receipt,
  };
  const read = () =>
    readFactoryPublicationReceiptV2(
      { query: async () => ({ rows: [row] }) } as unknown as PoolClient,
      authorization.ownerId,
      authorization.binding.taskId,
      authorization.binding.candidateId,
    );
  const check = () =>
    assertPublicationTarget(
      receipt,
      candidate,
      row.action,
      row.target,
      row.request.targetEnvironment,
      publicationId,
      bindingHash,
    );
  return {
    candidate,
    publicationId,
    authorization,
    bindingHash,
    receipt,
    row,
    read,
    check,
  };
}

for (const environment of ["preview", "production"])
  test(`accepts exact candidate-bound Skill publication for ${environment}`, async () => {
    const f = fixture(environment);
    f.check();
    const receipt = await f.read();
    assert.equal(receipt.action, "activate_skill");
    assert.deepEqual(
      receipt.verifiedTarget.skill,
      f.receipt.verifiedTarget.skill,
    );
  });

test("Skill publication rejects wrong action, kind, source, operation, target and environment", async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.row.action = "deploy_preview";
    },
    (f) => {
      f.receipt.verifiedTarget.kind = "preview-deployment";
    },
    (f) => {
      f.receipt.verifiedTarget.skill = undefined;
    },
    (f) => {
      f.receipt.verifiedTarget.sha = "c".repeat(40);
    },
    (f) => {
      f.receipt.verifiedTarget.repository = "other/Mikka";
    },
    (f) => {
      f.receipt.verifiedTarget.operationId = randomUUID();
    },
    (f) => {
      f.receipt.verifiedTarget.skill!.publicationId = randomUUID();
    },
    (f) => {
      f.receipt.verifiedTarget.skill!.bindingHash = "c".repeat(64);
    },
    (f) => {
      f.receipt.verifiedTarget.skill!.bindingHash = "malformed";
    },
    (f) => {
      f.row.target = f.receipt.verifiedTarget.target = "mikka-builtin:other";
    },
    (f) => {
      f.row.request.targetEnvironment = f.receipt.verifiedTarget.environment =
        "local-acceptance";
    },
    (f) => {
      f.receipt.verifiedTarget.reference = "other-reference";
    },
    (f) => {
      f.row.candidate = { ...f.candidate, scope: "other scope" };
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.read, FactoryError);
  }
});

test("shared assertion validates proof version and strict fields and requires trusted binding", () => {
  for (const mutation of [
    { version: 2 },
    { versionId: "invalid" },
    { sha256: "bad" },
    { proposalId: "invalid" },
    { evaluationId: "invalid" },
    { extra: "untrusted" },
  ]) {
    const f = fixture();
    Object.assign(f.receipt.verifiedTarget.skill!, mutation);
    assert.throws(f.check, FactoryError);
  }
  const f = fixture();
  assert.throws(
    () =>
      assertPublicationTarget(
        f.receipt,
        f.candidate,
        "activate_skill",
        f.row.target,
        "preview",
        f.publicationId,
      ),
    FactoryError,
  );
  assert.throws(
    () =>
      assertPublicationTarget(
        f.receipt,
        f.candidate,
        "activate_skill",
        f.row.target,
        "preview",
        undefined,
        f.bindingHash,
      ),
    FactoryError,
  );
});

test("a deployment receipt cannot activate a Skill or carry a Skill proof", () => {
  const f = fixture();
  const receipt = f.receipt;
  receipt.reference = receipt.verifiedTarget.reference =
    "https://fixed.example.com";
  receipt.verifiedTarget.kind = "preview-deployment";
  receipt.verifiedTarget.target = "preview-target";
  receipt.verifiedTarget.skill = undefined;
  const check = (action: string) =>
    assertPublicationTarget(
      receipt,
      f.candidate,
      action,
      "preview-target",
      "preview",
      f.publicationId,
      f.bindingHash,
    );
  check("deploy_preview");
  assert.throws(() => check("activate_skill"), FactoryError);
  assert.throws(() => check("deploy_production"), FactoryError);
  assert.throws(() => check("merge"), FactoryError);
  receipt.verifiedTarget.skill = fixture().receipt.verifiedTarget.skill;
  assert.throws(() => check("deploy_preview"), FactoryError);
});

test("authorization hash binds candidate, action, target, environment and publication", () => {
  const f = fixture();
  for (const change of [
    { idempotencyKey: randomUUID() },
    { candidate: { ...f.candidate, sha: "c".repeat(40) } },
    { candidate: { ...f.candidate, scope: "changed" } },
    {
      authorization: { ...f.authorization, action: "deploy_preview" as const },
    },
    { authorization: { ...f.authorization, target: "other" } },
    { authorization: { ...f.authorization, targetEnvironment: "production" } },
    {
      authorization: {
        ...f.authorization,
        binding: { ...f.authorization.binding, candidateId: randomUUID() },
      },
    },
  ]) {
    const changedHash = publicationBindingHash({
      idempotencyKey: f.publicationId,
      candidate: f.candidate,
      authorization: f.authorization,
      ...change,
    });
    assert.notEqual(changedHash, f.bindingHash);
    f.receipt.verifiedTarget.skill!.bindingHash = changedHash;
    assert.throws(f.check, FactoryError);
  }
});

test("an approval revoked after publication no longer yields a receipt", async () => {
  const live = fixture();
  await live.read();
  const revoked = fixture();
  Object.assign(revoked.row, { revokedAt: new Date("2026-10-26T20:32:00.000Z") });
  await assert.rejects(
    revoked.read(),
    (e: unknown) =>
      e instanceof FactoryError && e.code === "factoryPublicationReceiptRequired",
  );
});
