import test from "node:test";
import assert from "node:assert/strict";
import {
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
      [{ ...rule, label: null, place: "cloud", model: "chosen" }],
      [device],
    ),
    { place: "cloud", harness: "codex", model: "chosen" },
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
        [{ ...rule, model: "reported-model" }],
        devices,
        { whenDeviceOffline: "cloud", whenQuotaExhausted: "stop" },
      ),
      { place: "cloud", harness: "codex", model: "reported-model" },
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
