import { test, expect } from "vitest";
import { harnessInfoSchema } from "./harness";
import { deviceHeartbeatSchema, deviceManagementCommand } from "./device";
test("old harness and heartbeat payloads remain valid", () => {
  const harness = { harness: "codex", installed: true, version: null };
  expect(harnessInfoSchema.parse(harness)).toEqual(harness);
  expect(
    deviceHeartbeatSchema.parse({
      harnesses: [harness],
      runs: [],
      worktreeDiskBytes: 0,
    }).harnesses,
  ).toEqual([harness]);
  expect(
    harnessInfoSchema.parse({ ...harness, models: ["account-model"] }).models,
  ).toEqual(["account-model"]);
});
test("redetect is a device command, independent of run ids", () => {
  const command = {
    kind: "redetect",
    id: "10000000-0000-4000-8000-000000000001",
  };
  expect(deviceManagementCommand.parse(command)).toEqual(command);
  expect(deviceManagementCommand.safeParse({ kind: "redetect" }).success).toBe(
    false,
  );
});
