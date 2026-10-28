import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  factoryDecisionExecutionMatches,
  factoryPublicationJudgment,
  type FactoryDecisionExpectation,
} from "./decision-execution";

// Structural host receipts are synthetic. No transport/model is invoked.
const expected: FactoryDecisionExpectation = {
  modelId: "synthetic-vision-model",
  requestDigest: "a".repeat(64),
  imageDigests: ["b".repeat(64)],
  requiresVisual: true,
  scopeDigest: "c".repeat(64),
  evidenceDigest: "d".repeat(64),
  startedAfter: "2026-10-28T20:00:00.000Z",
  observedAt: "2026-10-28T20:01:00.000Z",
};
const execution = {
  executionId: randomUUID(),
  modelId: expected.modelId,
  providerGenerationId: "synthetic-generation",
  startedAt: expected.startedAfter,
  completedAt: expected.observedAt,
  requestDigest: expected.requestDigest,
  imageDigests: [...expected.imageDigests],
  vision: "image-input-submitted" as const,
};
const result = (choice = "publish_current") => ({
  answers: new Map<string, unknown>([
    [
      "publication",
      { type: "choice", name: "publication", choice, confidence: 0 },
    ],
  ]),
  execution,
});
test("shared Map choice is the business decision; confidence does not impose another threshold or confirmation", () => {
  const judgment = factoryPublicationJudgment(result(), expected)!;
  assert.equal(judgment.choice, "publish_current");
  assert.equal(judgment.receiptId, execution.executionId);
  assert.deepEqual(judgment.execution, execution);
  assert.equal("decision" in judgment, false);
  assert.equal("confirmation" in judgment, false);
});
test("unavailable, refusal, missing and defer choices provide no permission or human fallback", () => {
  for (const input of [
    null,
    result("defer"),
    { ...result(), answers: new Map() },
    {
      ...result(),
      answers: new Map([
        ["publication", { type: "refusal", name: "publication" }],
      ]),
    },
  ]) {
    assert.equal(factoryPublicationJudgment(input, expected), null);
  }
});
test("host execution must bind model/request/ordered pixels and time; visual input cannot be a text marker", () => {
  for (const change of [
    { modelId: "other-model" },
    { requestDigest: "e".repeat(64) },
    { providerGenerationId: "" },
    { imageDigests: [] },
    { vision: "no-image-input" },
    { executionId: "model-prose" },
    { startedAt: "2026-10-28T19:59:59.000Z" },
    { completedAt: "2026-10-28T20:01:01.000Z" },
    { startedAt: expected.observedAt, completedAt: expected.startedAfter },
  ]) {
    const changed = { ...execution, ...change };
    assert.equal(factoryDecisionExecutionMatches(changed, expected), false);
    assert.throws(
      () =>
        factoryPublicationJudgment(
          { ...result(), execution: changed },
          expected,
        ),
      /factoryPolicyModelEvidenceUnavailable/,
    );
  }
  assert.equal(
    factoryDecisionExecutionMatches(
      {
        ...execution,
        imageDigests: ["e".repeat(64), ...execution.imageDigests],
      },
      {
        ...expected,
        imageDigests: [...execution.imageDigests, "e".repeat(64)],
      },
    ),
    false,
  );
});
test("an answer cannot substitute a claimed execution or self-reported authorization for host provenance", () => {
  const input = result();
  input.answers.set("publication", {
    type: "choice",
    name: "publication",
    choice: "publish_current",
    execution: { ...execution, executionId: randomUUID() },
    decision: "allow",
  });
  assert.equal(
    factoryPublicationJudgment(input, expected)!.receiptId,
    execution.executionId,
  );
  assert.throws(
    () =>
      factoryPublicationJudgment({ ...input, execution: undefined }, expected),
    /factoryPolicyModelEvidenceUnavailable/,
  );
});
