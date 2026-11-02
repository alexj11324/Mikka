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
test("subscription workers retain CLI auto unless a provider model is explicitly selected", () => {
  const subscription = {
    id: "10000000-0000-4000-8000-000000000001",
    modelId: "bound-model",
    route: "codex_cli",
  };
  const frozen = freezeWorkerDefinition({ ...base, subscription });
  assert.equal(Object.hasOwn(frozen, "model"), false);
  assert.equal(frozen.cliModelSelection, "auto");
  const selected = freezeWorkerDefinition({ ...base, subscription, model: subscription.modelId });
  assert.equal(selected.model, subscription.modelId);
  assert.equal(selected.cliModelSelection, "explicit");
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
