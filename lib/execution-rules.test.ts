import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveExecution,
  DEFAULT_EXECUTION_RULE,
  type ExecutionRule,
  type ExecutionDevice,
} from "./execution-rules";
const device: ExecutionDevice = {
  id: "laptop",
  online: true,
  enabled: true,
  harnesses: [
    {
      harness: "codex",
      installed: true,
      version: null,
      models: ["account-model"],
    },
  ],
};
const rule: ExecutionRule = {
  id: "a",
  label: "backend",
  place: "laptop",
  harness: "codex",
  model: "auto",
  position: 0,
};
test("first matching label in position order wins", () => {
  assert.deepEqual(
    resolveExecution(
      ["backend", "frontend"],
      [
        { ...rule, place: "cloud", position: 2 },
        { ...rule, id: "b", position: 1, model: "chosen" },
      ],
      [device],
    ),
    { place: "laptop", harness: "codex", model: "chosen" },
  );
});
test("fixed default ignores editable rows labelled null, prefers own online device", () => {
  assert.deepEqual(
    resolveExecution(
      [],
      [{ ...DEFAULT_EXECUTION_RULE, place: "cloud" }],
      [device],
    ),
    { place: "laptop", harness: "codex" },
  );
});
test("explicit offline or disabled device waits without cloud fallback", () => {
  for (const d of [
    { ...device, online: false },
    { ...device, enabled: false },
  ])
    assert.deepEqual(resolveExecution(["backend"], [rule], [d]), {
      waitFor: "laptop",
    });
  assert.deepEqual(resolveExecution(["backend"], [rule], []), {
    waitFor: "laptop",
  });
});
test("auto skips offline, disabled and incompatible devices then uses cloud", () => {
  assert.deepEqual(resolveExecution([], [], [{ ...device, online: false }]), {
    place: "cloud",
    harness: "auto",
  });
  assert.deepEqual(
    resolveExecution(
      ["backend"],
      [{ ...rule, place: "auto", harness: "claude_code" }],
      [device],
    ),
    { place: "cloud", harness: "claude_code" },
  );
});
test("explicit cloud does not use the online laptop", () =>
  assert.deepEqual(
    resolveExecution(["backend"], [{ ...rule, place: "cloud" }], [device]),
    { place: "cloud", harness: "codex" },
  ));
test("auto model is absent; explicit model passes through", () => {
  assert.equal(
    Object.hasOwn(resolveExecution(["backend"], [rule], [device]), "model"),
    false,
  );
  assert.deepEqual(
    resolveExecution(
      ["backend"],
      [{ ...rule, model: "account-model" }],
      [device],
    ),
    { place: "laptop", harness: "codex", model: "account-model" },
  );
});
test("an explicit device never substitutes a different harness", () =>
  assert.throws(
    () =>
      resolveExecution(
        ["backend"],
        [{ ...rule, harness: "claude_code" }],
        [device],
      ),
    /agentHarnessMissing/,
  ));
