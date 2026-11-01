import { describe, expect, it } from "vitest"

import {
  DEVICE_ONLINE_WINDOW_MS,
  deviceHeartbeatSchema,
  devicePaths,
  devicesOnline,
  heartbeatResultSchema,
  isDeviceOnline,
  runAssignmentSchema,
  runPatchSchema,
} from "./device"

describe("device online state", () => {
  const now = Date.parse("2026-10-16T12:00:00Z")

  it("counts a device online within the heartbeat window", () => {
    expect(isDeviceOnline(new Date(now - 1_000), now)).toBe(true)
    expect(isDeviceOnline(now - DEVICE_ONLINE_WINDOW_MS, now)).toBe(true)
    expect(isDeviceOnline(now - DEVICE_ONLINE_WINDOW_MS - 1, now)).toBe(false)
    expect(isDeviceOnline(null, now)).toBe(false)
    expect(isDeviceOnline("not a date", now)).toBe(false)
  })

  it("summarizes 设备 n/m 在线", () => {
    expect(
      devicesOnline(
        [
          { lastSeenAt: new Date(now - 5_000).toISOString() },
          { lastSeenAt: new Date(now - 10 * 60_000) },
          { lastSeenAt: null },
        ],
        now
      )
    ).toEqual({ online: 1, total: 3 })
  })
})

describe("device link schemas", () => {
  it("escapes ids into one path segment each", () => {
    expect(devicePaths.claim("d/1", "r 2")).toBe(
      "/v1/devices/d%2F1/runs/r%202/claim"
    )
    expect(devicePaths.pendingRuns("d")).toBe("/v1/devices/d/runs?state=queued")
  })

  it("parses a heartbeat and its result", () => {
    const hb = deviceHeartbeatSchema.parse({
      harnesses: [{ harness: "mock", installed: true, version: "0.0.1" }],
      runs: [{ runId: "r1", lastProgressAt: "2026-10-16T12:00:00.000Z" }],
      worktreeDiskBytes: 0,
    })
    expect(hb.runs).toHaveLength(1)
    expect(
      heartbeatResultSchema.parse({ leases: { r1: "2026-10-16T12:01:30Z" } })
    ).toEqual({ leases: { r1: "2026-10-16T12:01:30Z" } })
  })

  it("refuses an assignment without a base branch or with an unknown harness", () => {
    const base = {
      runId: "r1",
      issueId: "i1",
      deviceId: "d1",
      repoId: "repo",
      baseBranch: "main",
      harness: "mock",
      prompt: "p",
    }
    expect(runAssignmentSchema.safeParse(base).success).toBe(true)
    expect(
      runAssignmentSchema.safeParse({ ...base, baseBranch: "" }).success
    ).toBe(false)
    expect(
      runAssignmentSchema.safeParse({ ...base, harness: "gpt" }).success
    ).toBe(false)
  })

  it("takes one strict model credential, never with a subscription binding", () => {
    const base = { runId: "r1", issueId: "i1", deviceId: "d1", repoId: "repo", harness: "claude_code", prompt: "p" }
    const provider = { kind: "provider", protocol: "anthropic", baseUrl: "https://api.deepseek.com/anthropic", key: "sk-test-0000" }
    expect(runAssignmentSchema.parse({ ...base, modelCredential: provider }).modelCredential).toEqual(provider)
    expect(runAssignmentSchema.safeParse({ ...base, modelCredential: { kind: "api_key", key: "sk-test-0000" } }).success).toBe(true)
    for (const modelCredential of [
      { ...provider, baseUrl: "http://api.deepseek.com/anthropic" },
      { ...provider, baseUrl: "https://user:pass@api.deepseek.com" },
      { ...provider, baseUrl: "https://api.deepseek.com/?x=1" },
      { ...provider, key: "sk-test\nX-Injected: 1" },
      { ...provider, key: "sk-test\0" },
      { ...provider, key: "" },
      { ...provider, key: "k".repeat(4_097) },
      { ...provider, protocol: "gemini" },
      { ...provider, extra: true },
    ]) expect(runAssignmentSchema.safeParse({ ...base, modelCredential }).success).toBe(false)
    const subscriptionBinding = { bindingId: "00000000-0000-4000-8000-000000000001", ownerId: "o", workspaceId: "00000000-0000-4000-8000-000000000002", consumerId: "00000000-0000-4000-8000-000000000003", route: "claude_code_cli" }
    expect(runAssignmentSchema.safeParse({ ...base, subscriptionBinding }).success).toBe(true)
    expect(runAssignmentSchema.safeParse({ ...base, subscriptionBinding, modelCredential: provider }).success).toBe(false)
  })

  it("accepts every daemon-local state in a patch, including stopped", () => {
    expect(
      runPatchSchema.parse({ state: "stopped", stopReason: "turn_ended" })
    ).toEqual({ state: "stopped", stopReason: "turn_ended" })
  })
})
