import { describe, expect, it } from "vitest"
import { deviceHeartbeatSchema } from "./device"
import { harnessInfoSchema, SUBSCRIPTION_PREFLIGHT_FAILURES } from "./harness"
import { USER_ERROR_CODES } from "./user-error-codes"

describe("subscription preflight capability report", () => {
  const info = { harness: "codex", installed: true, version: "0.163.0" }

  it("preserves only registered safe failure details across device heartbeats", () => {
    for (const subscriptionPreflight of SUBSCRIPTION_PREFLIGHT_FAILURES) {
      expect(USER_ERROR_CODES.subscription_local_runtime_unavailable).toContain(subscriptionPreflight)
      const report = { ...info, subscriptionPreflight }
      expect(harnessInfoSchema.parse(report)).toEqual(report)
      expect(deviceHeartbeatSchema.parse({ harnesses: [report], runs: [], worktreeDiskBytes: 0 }).harnesses[0]).toEqual(report)
    }
  })

  it("rejects raw CLI text and arbitrary details; an older successful report stays compatible", () => {
    for (const subscriptionPreflight of ["unknown_failure", "secret provider output", { detail: "cli_missing" }, true]) {
      expect(harnessInfoSchema.safeParse({ ...info, subscriptionPreflight }).success).toBe(false)
    }
    expect(harnessInfoSchema.parse({ ...info, subscriptionBroker: true }).subscriptionBroker).toBe(true)
    expect(harnessInfoSchema.parse(info).subscriptionPreflight).toBeUndefined()
  })
})
