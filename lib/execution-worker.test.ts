import test from "node:test";
import assert from "node:assert/strict";
import {
  freezeWorkerDefinition,
  retryWorkerDefinition,
} from "./agent-kit/worker";
const base = {
  harness: "codex" as const,
  instructions: "",
  prompt: "task",
  parent: null,
  executionId: null,
};
test("subscription workers pin the provider model; workers without a credential keep CLI auto", () => {
  const subscription = {
    id: "10000000-0000-4000-8000-000000000001",
    modelId: "bound-model",
    route: "codex_cli",
  };
  const frozen = freezeWorkerDefinition({ ...base, subscription });
  assert.equal(frozen.model, subscription.modelId);
  assert.equal(frozen.cliModelSelection, "explicit");
  assert.equal(Object.hasOwn(freezeWorkerDefinition(base), "model"), false);
  assert.throws(() => freezeWorkerDefinition({ ...base, subscription, model: "slot-alias" }), /agentWorkerSubscriptionMismatch/);
});
test("explicit model and device stay frozen through retries", () => {
  const pinnedDeviceId = "10000000-0000-4000-8000-000000000002";
  const snapshot = freezeWorkerDefinition({
    ...base,
    model: "chosen-model",
    pinnedDeviceId,
  });
  const retry = retryWorkerDefinition(snapshot, "retry task")!;
  assert.equal(retry.model, "chosen-model");
  assert.equal(retry.pinnedDeviceId, pinnedDeviceId);
  assert.notEqual(retry.promptDigest, snapshot.promptDigest);
  assert.notEqual(
    snapshot.definitionDigest,
    freezeWorkerDefinition(base).definitionDigest,
  );
});
