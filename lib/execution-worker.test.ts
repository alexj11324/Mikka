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
test("automatic workers never request a CLI model, even with a subscription binding", () => {
  const subscription = {
    id: "10000000-0000-4000-8000-000000000001",
    modelId: "bound-model",
    route: "codex_cli",
  };
  assert.equal(
    Object.hasOwn(freezeWorkerDefinition({ ...base, subscription }), "model"),
    false,
  );
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
