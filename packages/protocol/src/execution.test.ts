import { test, expect } from "vitest";
import { harnessInfoSchema } from "./harness";
import { deviceHeartbeatSchema, runCommandSchema } from "./device";
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
  const command = { kind: "redetect", requestedAt: "2026-10-30T19:00:00.000Z" };
  expect(runCommandSchema.parse(command)).toEqual(command);
  expect(runCommandSchema.safeParse({ kind: "redetect" }).success).toBe(false);
});
