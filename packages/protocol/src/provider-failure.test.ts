import { describe, expect, it } from "vitest"

import {
  classifyProviderFailure,
  ProviderFailureError,
  providerFailureSchema,
} from "./provider-failure"
import { emptyRunReport, runCompletion } from "./run"

describe("provider failures", () => {
  it.each([
    [{ status: 402 }, { kind: "balance", retryable: false, status: 402, code: "payment_required" }],
    [{ status: 429, error: { code: "insufficient_quota" } }, { kind: "balance", retryable: false, status: 429, code: "insufficient_quota" }],
    [{ error: { type: "insufficient_balance" } }, { kind: "balance", retryable: false, code: "insufficient_balance" }],
    [{ code: "billing_hard_limit_reached" }, { kind: "balance", retryable: false, code: "billing_hard_limit" }],
    [{ code: "billing_error" }, { kind: "balance", retryable: false, code: "billing_error" }],
    [{ status: 401 }, { kind: "auth", retryable: false, status: 401, code: "authentication_failed" }],
    [{ status: 403, error: { code: "invalid_api_key" } }, { kind: "auth", retryable: false, status: 403, code: "invalid_api_key" }],
    [{ type: "authentication_error" }, { kind: "auth", retryable: false, code: "authentication_failed" }],
  ])("normalizes permanent provider failures without retrying: %j", (error, expected) => {
    expect(classifyProviderFailure(error)).toEqual(expected)
  })

  it.each([429, 500, 501, 502, 503, 504, 507, 599])("marks provider HTTP %s unavailable after native retries", status => {
    expect(classifyProviderFailure({ status })).toEqual({
      kind: "unavailable", retryable: true, status,
      code: status === 429 ? "rate_limit" : "server_error",
    })
  })

  it("keeps the native overload code for HTTP 529", () => {
    expect(classifyProviderFailure({ status: 529 })).toEqual({ kind: "unavailable", retryable: true, status: 529, code: "overloaded" })
  })

  it.each([
    [{ name: "APIConnectionTimeoutError" }, "timeout"],
    [{ name: "APIConnectionError" }, "connection_error"],
    [{ code: "ECONNRESET" }, "connection_error"],
    [{ code: "ETIMEDOUT" }, "timeout"],
    [{ error: "overloaded" }, "overloaded"],
  ])("normalizes a provider transport exception: %j", (error, code) => {
    expect(classifyProviderFailure(error)).toEqual({ kind: "unavailable", retryable: true, code })
  })

  it("uses a structured error body ahead of the HTTP rate-limit default and drops all diagnostics", () => {
    const failure = classifyProviderFailure({
      statusCode: 429,
      responseBody: JSON.stringify({ error: { code: "insufficient_quota", message: "private provider diagnostic sk-private" } }),
      message: "Authorization: Bearer private-token",
      headers: { Authorization: "private-token" },
    })
    expect(failure).toEqual({ kind: "balance", retryable: false, status: 429, code: "insufficient_quota" })
    expect(JSON.stringify(failure)).not.toMatch(/private|Authorization|message|headers/)
  })

  it.each([
    new Error("Build failed: HTTP 503; insufficient_balance; invalid_api_key"),
    { message: "API Error: 402" },
    { status: 403, error: { code: "permission_denied" } },
    { status: 400, error: { type: "invalid_request_error" } },
    { status: 404, code: "model_not_found" },
    { status: 700, code: "private-provider-code" },
    { code: "ENOENT" },
    null,
  ])("does not infer a provider fault from ordinary errors or unrelated refusals: %j", error => {
    expect(classifyProviderFailure(error)).toBeUndefined()
  })

  it("accepts only a consistent, fixed-shape failure receipt", () => {
    const failure = { kind: "balance", retryable: false, code: "insufficient_balance", status: 402 }
    expect(providerFailureSchema.safeParse(failure).success).toBe(true)
    for (const value of [
      { ...failure, retryable: true },
      { ...failure, message: "raw diagnostic" },
      { ...failure, code: "raw diagnostic" },
      { ...failure, code: "rate_limit" },
      { ...failure, status: 700 },
    ]) expect(providerFailureSchema.safeParse(value).success).toBe(false)
    expect(runCompletion.parse({ stopReason: "provider_failure", report: { ...emptyRunReport(), providerFailure: failure } }).report.providerFailure).toEqual(failure)
  })

  it("carries only the classified receipt when a provider fails before the session opens", () => {
    const failure = { kind: "unavailable" as const, retryable: true as const, code: "server_error" as const, status: 503 }
    const error = new ProviderFailureError(failure)
    expect(error.providerFailure).toEqual(failure)
    expect(error.message).toContain("server_error")
    expect(() => new ProviderFailureError({ ...failure, message: "secret" } as typeof failure)).toThrow()
  })

  it("accepts only the two fixed final checkpoint outcomes", () => {
    const report = { ...emptyRunReport(), providerFailure: { kind: "balance", retryable: false, status: 402 } }
    for (const providerCheckpoint of ["ready", "unavailable"]) {
      expect(runCompletion.parse({ stopReason: "provider_failure", report: { ...report, providerCheckpoint } }).report.providerCheckpoint).toBe(providerCheckpoint)
    }
    expect(runCompletion.safeParse({ stopReason: "provider_failure", report: { ...report, providerCheckpoint: "raw upload diagnostic" } }).success).toBe(false)
  })
})
