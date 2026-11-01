import test from "node:test";
import assert from "node:assert/strict";
import {
  agentFor,
  resolveExecution,
  type ExecutionRule,
  type ExecutionDevice,
} from "./execution-rules";
const rule: ExecutionRule = {
  id: "a",
  label: "backend",
  place: "laptop",
  harness: "codex",
  model: "default",
  position: 0,
};
const device: ExecutionDevice = {
  id: "laptop",
  online: true,
  enabled: true,
  harnesses: [
    {
      harness: "codex",
      installed: true,
      version: null,
      models: ["reported-model"],
      modelSlots: [
        { slot: "default", model: "reported-model", name: "Reported model" },
      ],
    },
  ],
};
test("ordered label rules and the persisted editable default", () => {
  assert.deepEqual(
    resolveExecution(
      ["backend"],
      [{ ...rule, place: "cloud", position: 2 }, rule],
      [device],
    ),
    { place: "laptop", harness: "codex", model: "reported-model" },
  );
  assert.deepEqual(
    resolveExecution(
      [],
      [{ ...rule, label: null, place: "cloud", model: "gpt-chosen" }],
      [device],
    ),
    { place: "cloud", harness: "codex", model: "gpt-chosen" },
  );
  assert.throws(
    () => resolveExecution([], [], [device]),
    /executionModelUnknown/,
  );
});
test("offline waits unless cloud fallback is explicit", () => {
  for (const devices of [
    [],
    [{ ...device, online: false }],
    [{ ...device, enabled: false }],
  ]) {
    assert.deepEqual(resolveExecution(["backend"], [rule], devices), {
      waitFor: "laptop",
    });
    assert.deepEqual(
      resolveExecution(
        ["backend"],
        [{ ...rule, model: "gpt-reported-model" }],
        devices,
        { whenDeviceOffline: "cloud" },
      ),
      { place: "cloud", harness: "codex", model: "gpt-reported-model" },
    );
  }
});
test("auto is refused in every field and harness never changes", () => {
  for (const field of ["place", "harness", "model"])
    assert.throws(
      () =>
        resolveExecution(["backend"], [{ ...rule, [field]: "auto" }], [device]),
      /executionAutoNotAllowed/,
    );
  assert.throws(
    () =>
      resolveExecution(
        ["backend"],
        [{ ...rule, harness: "claude_code" }],
        [device],
      ),
    /agentHarnessMissing/,
  );
});
test("a saved slot follows a changed device mapping", () => {
  const devices = [
    {
      ...device,
      harnesses: [
        {
          ...device.harnesses[0],
          modelSlots: [
            { slot: "default", model: "new-model", name: "New model" },
          ],
        },
      ],
    },
  ];
  assert.equal(
    (resolveExecution(["backend"], [rule], devices) as { model: string }).model,
    "new-model",
  );
});

test("the Agent follows the model (orchestration.md §3), unless the model is the rule Agent's own slot or report", () => {
  // A non-GPT model picked under Codex runs on Claude Code; a GPT model under Claude Code runs on Codex.
  assert.deepEqual(resolveExecution([], [{ ...rule, label: null, place: "cloud", model: "deepseek-v4" }], [device]),
    { place: "cloud", harness: "claude_code", model: "deepseek-v4" });
  assert.deepEqual(resolveExecution([], [{ ...rule, label: null, place: "cloud", harness: "claude_code", model: "gpt-5.5" }], [device]),
    { place: "cloud", harness: "codex", model: "gpt-5.5" });
  // On a device, the derived Agent must be installed there.
  assert.throws(() => resolveExecution(["backend"], [{ ...rule, model: "claude-sonnet" }], [device]), /agentHarnessMissing/);
  // Codex's own "default" slot and its reported model stay on Codex.
  assert.equal((resolveExecution(["backend"], [rule], [device]) as { harness: string }).harness, "codex");
  assert.equal((resolveExecution(["backend"], [{ ...rule, model: "reported-model" }], [device]) as { harness: string }).harness, "codex");
  // Other Agents run their own models.
  assert.equal(agentFor("deepseek-v4", "cursor", () => false), "cursor");
  // The suggested default rule names the install's default slot, even when it lists no slots.
  const bare = { ...device, harnesses: [{ ...device.harnesses[0]!, modelSlots: undefined, models: ["gpt-5"], defaultModelSlot: "auto-slot" }] };
  assert.equal((resolveExecution([], [{ ...rule, label: null, model: "auto-slot" }], [bare]) as { harness: string }).harness, "codex");
});
