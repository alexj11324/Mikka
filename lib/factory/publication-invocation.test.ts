import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { digest } from "./evidence";
import type { FactoryDecisionScope } from "./policy-authorization";
import {
  invokeFactoryPublicationDecision,
  readFactoryPublicationInvocation,
  type FactoryPublicationDecisionTransport,
  type FactoryPublicationExecutorContext,
  type FactoryPublicationInvocation,
} from "./publication-invocation";

// Synthetic in-memory transport only. No model, I/O, listener, signing key or
// resource fixture. These assertions verify provenance, not real model quality.
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function fixture() {
  const scope: FactoryDecisionScope = {
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
      repository: "fixture/Factory194",
      environment: "synthetic-device",
      scope: "synthetic-task",
    },
    action: "deploy_preview",
    target: "synthetic-target",
    targetEnvironment: "preview",
    evidenceDigest: "b".repeat(64),
    visualEvidenceDigests: [],
    expiresAt: "2026-10-29T00:00:00.000Z",
  };
  const executor: FactoryPublicationExecutorContext = {
    runId: randomUUID(),
    sessionId: "synthetic-session",
    assignmentDigest: "c".repeat(64),
    instructionsDigest: "d".repeat(64),
    policyId: "synthetic-policy",
    policyRevision: "1",
  };
  const transport: FactoryPublicationDecisionTransport = {
    modelId: "synthetic-vision-model",
    serializeInput: (input) => input,
    invokeDecision: async (_purpose, input, questions) => {
      const now = new Date().toISOString();
      return {
        answers: new Map([
          [
            "evidence_requirement",
            {
              type: "choice",
              name: "evidence_requirement",
              choice: "text_sufficient",
            },
          ],
          [
            "publication",
            { type: "choice", name: "publication", choice: "publish_current" },
          ],
        ]),
        execution: {
          executionId: randomUUID(),
          modelId: transport.modelId,
          providerGenerationId: "synthetic-generation",
          startedAt: now,
          completedAt: now,
          requestDigest: sha(
            JSON.stringify({ model: transport.modelId, input, questions }),
          ),
          imageDigests: (input.images ?? []).map((image) =>
            sha(Buffer.from(image.dataUrl.split(",")[1], "base64")),
          ),
          vision: input.images?.length
            ? "image-input-submitted"
            : "no-image-input",
        },
      };
    },
  };
  return { scope, executor, transport };
}
test("original request freezes candidate/action/environment, executor/policy and fixed business question before invocation", async () => {
  const { scope, executor, transport } = fixture();
  const original = transport.invokeDecision;
  transport.invokeDecision = async (purpose, input, questions) => {
    assert.equal(purpose, "factory-publication");
    assert.deepEqual(JSON.parse(input.text), {
      contract: "factory-publication-decision.v1",
      scope,
      executor,
      observations: "synthetic observations",
    });
    assert.ok(Object.isFrozen(input));
    assert.ok(Object.isFrozen(questions));
    assert.ok(Object.isFrozen(questions[0].choices));
    assert.deepEqual(
      questions[1].choices.map((choice) => choice.value),
      ["publish_current", "defer"],
    );
    return original(purpose, input, questions);
  };
  const handle = await invokeFactoryPublicationDecision(
    scope,
    executor,
    { text: "synthetic observations", requiresVisual: false },
    transport,
  );
  assert.ok(handle);
  const row = readFactoryPublicationInvocation(
    handle,
    scope,
    transport.modelId,
    executor,
  );
  assert.equal(row.scopeDigest, digest(scope));
  assert.equal(row.executorDigest, digest(executor));
  assert.equal(row.judgment.choice, "publish_current");
  assert.equal("decision" in row.judgment, false);
});
test("opaque invocation cannot be cloned, forged or rebound to another candidate/action/target/evidence/expiry", async () => {
  const { scope, executor, transport } = fixture();
  const handle = await invokeFactoryPublicationDecision(
    scope,
    executor,
    { text: "synthetic", requiresVisual: false },
    transport,
  );
  assert.ok(handle);
  for (const changed of [
    { ...scope, candidate: { ...scope.candidate, sha: "d".repeat(40) } },
    {
      ...scope,
      action: "deploy_production" as const,
      targetEnvironment: "production" as const,
    },
    { ...scope, target: "other-target" },
    { ...scope, evidenceDigest: "e".repeat(64) },
    { ...scope, expiresAt: "2026-10-29T01:00:00.000Z" },
  ])
    assert.throws(
      () =>
        readFactoryPublicationInvocation(
          handle,
          changed,
          transport.modelId,
          executor,
        ),
      /factoryPolicyModelEvidenceUnavailable/,
    );
  for (const forged of [{}, structuredClone(handle)])
    assert.throws(
      () =>
        readFactoryPublicationInvocation(
          forged as FactoryPublicationInvocation,
          scope,
          transport.modelId,
          executor,
        ),
      /factoryPolicyModelEvidenceUnavailable/,
    );
});
test("run/session/assignment/current policy/model identities cannot be attached after invocation", async () => {
  const { scope, executor, transport } = fixture();
  const handle = await invokeFactoryPublicationDecision(
    scope,
    executor,
    { text: "synthetic", requiresVisual: false },
    transport,
  );
  assert.ok(handle);
  for (const changed of [
    { ...executor, runId: randomUUID() },
    { ...executor, sessionId: "other-session" },
    { ...executor, assignmentDigest: "d".repeat(64) },
    { ...executor, policyRevision: "2" },
    { ...executor, instructionsDigest: "e".repeat(64) },
  ])
    assert.throws(
      () =>
        readFactoryPublicationInvocation(
          handle,
          scope,
          transport.modelId,
          changed,
        ),
      /factoryPolicyModelEvidenceUnavailable/,
    );
  assert.throws(
    () =>
      readFactoryPublicationInvocation(handle, scope, "other-model", executor),
    /factoryPolicyModelEvidenceUnavailable/,
  );
});
test("a previous model response cannot be relabelled with the new request scope", async () => {
  const { scope, executor, transport } = fixture();
  let earlier: Awaited<ReturnType<typeof transport.invokeDecision>>;
  const original = transport.invokeDecision;
  transport.invokeDecision = async (...args) =>
    (earlier = await original(...args));
  assert.ok(
    await invokeFactoryPublicationDecision(
      scope,
      executor,
      { text: "original observations", requiresVisual: false },
      transport,
    ),
  );
  transport.invokeDecision = async () => earlier!;
  await assert.rejects(
    () =>
      invokeFactoryPublicationDecision(
        { ...scope, target: "other-target" },
        executor,
        { text: "other observations", requiresVisual: false },
        transport,
      ),
    /factoryPolicyModelEvidenceUnavailable/,
  );
});
test("visual evidence hashes bind actual submitted bytes; missing pixels stop before the transport", async () => {
  const { scope, executor, transport } = fixture();
  const pixels = Buffer.from(
    "explicit synthetic pixels, not a real screenshot",
  );
  scope.visualEvidenceDigests = [sha(pixels)];
  let calls = 0;
  const original = transport.invokeDecision;
  transport.invokeDecision = async (...args) => {
    calls++;
    return original(...args);
  };
  await assert.rejects(
    () =>
      invokeFactoryPublicationDecision(
        scope,
        executor,
        { text: "synthetic", requiresVisual: true },
        transport,
      ),
    /factoryPolicyModelEvidenceUnavailable/,
  );
  assert.equal(calls, 0);
  const handle = await invokeFactoryPublicationDecision(
    scope,
    executor,
    {
      text: "synthetic",
      requiresVisual: true,
      images: [
        { dataUrl: `data:image/png;base64,${pixels.toString("base64")}` },
      ],
    },
    transport,
  );
  assert.ok(handle);
  assert.equal(calls, 1);
  assert.deepEqual(
    readFactoryPublicationInvocation(handle, scope, transport.modelId, executor)
      .judgment.imageDigests,
    [sha(pixels)],
  );
});
test("mutable caller observations and transport ID cannot alter the pre-call snapshot while awaiting a result", async () => {
  const { scope, executor, transport } = fixture();
  const observations = { text: "original", requiresVisual: false };
  const modelId = transport.modelId,
    original = transport.invokeDecision;
  transport.invokeDecision = async (...args) => {
    const result = await original(...args);
    observations.text = "changed";
    observations.requiresVisual = true;
    transport.modelId = "changed-model";
    return result;
  };
  const handle = await invokeFactoryPublicationDecision(
    scope,
    executor,
    observations,
    transport,
  );
  assert.ok(handle);
  assert.equal(
    readFactoryPublicationInvocation(handle, scope, modelId, executor).judgment
      .visualInputRequired,
    false,
  );
});

test("the model determines visual necessity; absent/visual-required answers cannot be inferred as text sufficiency", async () => {
  const { scope, executor, transport } = fixture();
  const original = transport.invokeDecision;
  for (const choice of [undefined, "visual_required"]) {
    transport.invokeDecision = async (...args) => {
      const result = await original(...args);
      const answers = new Map(result!.answers);
      answers.delete("evidence_requirement");
      if (choice)
        answers.set("evidence_requirement", {
          type: "choice",
          name: "evidence_requirement",
          choice,
        });
      return { ...result!, answers };
    };
    assert.equal(
      await invokeFactoryPublicationDecision(
        scope,
        executor,
        {
          text: "synthetic visual scope without images",
          requiresVisual: false,
        },
        transport,
      ),
      null,
    );
  }
});
