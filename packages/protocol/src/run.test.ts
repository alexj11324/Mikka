import { describe, expect, it } from "vitest"

import { STOP_REASONS, handoffReportSchema } from "./daemon"
import {
  RUN_STOP_REASONS,
  emptyRunReport,
  reachesReview,
  runCompleteRequest,
  runCompletion,
  runReport,
} from "./run"

const report = {
  ...emptyRunReport("Did it."),
  filesChanged: ["src/a.ts"],
  verify: { status: "passed" as const, command: "bun test", output: "ok" },
}

describe("run completion contract", () => {
  it("has one set of stop reasons and one report shape for both sides", () => {
    expect(STOP_REASONS).toBe(RUN_STOP_REASONS)
    expect(handoffReportSchema).toBe(runReport)
  })

  it("accepts the report the daemon builds, including an empty summary", () => {
    expect(
      runCompletion.parse({ stopReason: "error", report: emptyRunReport() })
    ).toBeTruthy()
    expect(
      runCompleteRequest.parse({ stopReason: "submitted", report })
    ).toEqual({ stopReason: "submitted", report })
  })

  it("refuses the old done/partial-only shape and a submit without a report", () => {
    expect(
      runCompleteRequest.safeParse({
        stopReason: "submitted",
        report: { status: "done", summary: "x" },
      }).success
    ).toBe(false)
    expect(
      runCompleteRequest.safeParse({ stopReason: "submitted" }).success
    ).toBe(false)
    expect(runCompleteRequest.safeParse({ stopReason: "error" }).success).toBe(
      true
    )
  })

  it("a submission reaches review unless its verify failed", () => {
    expect(reachesReview("submitted", report)).toBe(true)
    expect(reachesReview("submitted", { verify: { status: "failed" } })).toBe(
      false
    )
    expect(reachesReview("submitted", { verify: { status: "not_run" } })).toBe(
      true
    )
    expect(reachesReview("turn_ended", report)).toBe(false)
    expect(reachesReview("submitted", undefined)).toBe(false)
  })
})
