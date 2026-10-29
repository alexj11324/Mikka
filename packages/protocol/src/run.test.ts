import { describe, expect, it } from "vitest"

import { STOP_REASONS, handoffReportSchema } from "./daemon"
import {
  RUN_STOP_REASONS,
  emptyRunReport,
  reachesReview,
  runCompleteRequest,
  runCompletion,
  runReport,
  runExecution,
  runBenchmarkContext,
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

  it("preserves the daemon check receipt and exact process failure without accepting malformed SHA", () => {
    const checked = {
      ...emptyRunReport(),
      check: { sha: "a".repeat(40), readOnly: true },
      verify: {
        status: "failed",
        command: "node acceptance.mjs",
        output: "real failure",
        exitCode: 17,
        signal: null,
        timedOut: false,
      },
    }
    expect(runReport.parse(checked)).toEqual(checked)
    expect(
      runReport.safeParse({
        ...checked,
        check: { sha: "main", readOnly: true },
      }).success
    ).toBe(false)
  })

  it("validates strict host mount evidence and the source commit", () => {
    const mount = { receiptId: "aa39c8af-e44c-4f38-bbc6-55e075f78701", versionId: "aa39c8af-e44c-4f38-bbc6-55e075f78702",
      sha256: "a".repeat(64), sessionId: "actual-session", mountedAt: new Date().toISOString() }
    expect(runReport.parse({ ...report, sourceCommit: "b".repeat(40), skillMount: mount }).skillMount).toEqual(mount)
    for (const invalid of [{ ...mount, path: "/model/path" }, { ...mount, sha256: "bad" }, { ...mount, receiptId: "bad" },
      { ...mount, mountedAt: "yesterday" }, { ...mount, sessionId: "" }])
      expect(runReport.safeParse({ ...report, skillMount: invalid }).success).toBe(false)
    expect(runReport.safeParse({ ...report, sourceCommit: "main" }).success).toBe(false)
  })

  it("keeps requested and observed model identity separate in strict benchmark execution evidence", () => {
    const context = { sourceCommit: "a".repeat(40), benchmarkDigest: "b".repeat(64), policyDigest: "c".repeat(64),
      fixtureDigest: "d".repeat(64), caseId: "case-1" }
    expect(runBenchmarkContext.safeParse({ ...context, seed: "private-seed" }).success).toBe(false)
    const execution = { ...context, harness: "codex", requestedModel: "requested", observedModel: null, verifyCommand: "node verify.mjs" }
    expect(runExecution.parse(execution).observedModel).toBeNull()
    expect(runExecution.parse({ ...execution, observedModel: "other" }).observedModel).toBe("other")
    expect(runExecution.safeParse({ ...execution, model: "invented" }).success).toBe(false)
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
