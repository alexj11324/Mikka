import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "vitest"

import { claudeProviderFailure } from "../src/adapters/claude"
import { codexProviderFailure } from "../src/adapters/codex"

const result = (fields: Record<string, unknown>) => ({
  type: "result", subtype: "success", is_error: true, result: "", ...fields,
}) as unknown as SDKResultMessage

it.each(['badRequest', 'other'] as const)('Codex %s accepts only a structured model refusal at its native API boundary', codexErrorInfo => {
  expect(codexProviderFailure({ codexErrorInfo, message: 'unexpected status 400 Bad Request: {"error":{"code":"model_not_found","message":"PRIVATE_BODY"}}' }))
    .toEqual({ kind: 'model', retryable: false, status: 400, code: 'model_not_found' })
  expect(codexProviderFailure({ codexErrorInfo, message: 'unsupported model in ordinary tool output' })).toBeUndefined()
})

describe("Claude terminal provider failures", () => {
  it("keeps a native model refusal distinct from account health", () => {
    expect(claudeProviderFailure(result({ api_error_status: 404 }), "model_not_found"))
      .toEqual({ kind: "model", retryable: false, status: 404, code: "model_not_found" })
  })
  it.each([402, 429, 500, 502, 503, 504])("uses the CLI's provider HTTP %s, never model text", status => {
    expect(claudeProviderFailure(result({ api_error_status: status, result: "private diagnostic" }), undefined)).toMatchObject({
      kind: status === 402 ? "balance" : "unavailable", retryable: status !== 402, status,
    })
  })

  it("preserves permanent billing codes inside a terminal API error body", () => {
    expect(claudeProviderFailure(result({ api_error_status: 429, result: 'API Error: 429 {"error":{"code":"insufficient_quota","message":"private diagnostic"}}' }), "rate_limit"))
      .toEqual({ kind: "balance", retryable: false, status: 429, code: "insufficient_quota" })
  })

  it.each(["success", "error_during_execution"])("reads an older %s terminal API status without structured metadata", subtype => {
    expect(claudeProviderFailure(result({ subtype, result: "API Error: 402 Payment Required", errors: ["API Error: 402 Payment Required"] }), undefined))
      .toEqual({ kind: "balance", retryable: false, status: 402, code: "payment_required" })
  })

  it("uses a terminal assistant authentication category even without an HTTP status", () => {
    expect(claudeProviderFailure(result({ subtype: "error_during_execution", errors: ["private diagnostic"] }), "authentication_failed"))
      .toEqual({ kind: "auth", retryable: false, code: "authentication_failed" })
  })

  it("recognizes the CLI's terminal timeout without retaining its text", () => {
    expect(claudeProviderFailure(result({ terminal_reason: "api_error", result: "API Error: Request timed out." }), "unknown"))
      .toEqual({ kind: "unavailable", retryable: true, code: "timeout" })
  })

  it.each([
    ["Request timed out", "timeout"],
    ["Request timed out. Check your internet connection and proxy settings", "timeout"],
    ["API Error: No response from API (waited 3m, then 10m on the retry).", "timeout"],
    ["API Error: Stream idle timeout - no chunks received", "timeout"],
    ["Unable to connect to API (ETIMEDOUT)", "timeout"],
    ["Unable to connect to API (ECONNREFUSED)", "connection_error"],
    ["Unable to connect to API. Check your internet connection", "connection_error"],
    ["Can't reach the API server — check your internet or DNS (ENOTFOUND)", "connection_error"],
    ["Connection dropped (ECONNRESET)", "connection_error"],
  ])("reads the CLI's terminal transport failure: %s", (diagnostic, code) => {
    expect(claudeProviderFailure(result({ terminal_reason: "api_error", result: diagnostic }), "unknown"))
      .toEqual({ kind: "unavailable", retryable: true, code })
  })

  it.each([
    result({ is_error: false, result: "API Error: 402 insufficient_balance" }),
    result({ subtype: "error_during_execution", errors: ["Tool failed: HTTP 503"] }),
    result({ terminal_reason: "image_error", api_error_status: 400, result: "API Error: 529" }),
    result({ subtype: "error_max_turns", terminal_reason: "max_turns", errors: ["HTTP 402"] }),
    result({ subtype: "error_max_budget_usd", errors: ["budget exhausted"] }),
    result({ result: "Request timed out" }),
    result({ result: "Unable to connect to API (ECONNREFUSED)" }),
    result({ api_error_status: 403, result: "API Error: Connection error." }),
  ])("leaves successful model output and execution errors unclassified", message => {
    expect(claudeProviderFailure(message, undefined)).toBeUndefined()
  })
})

describe("Codex terminal provider failures", () => {
  it.each([402, 429, 500, 502, 503, 504])("uses the app-server's provider HTTP %s", status => {
    expect(codexProviderFailure({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } }, message: "private diagnostic" })).toMatchObject({
      kind: status === 402 ? "balance" : "unavailable", retryable: status !== 402, status,
    })
  })

  it("retains billing precedence over a rate limit", () => {
    expect(codexProviderFailure({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, message: 'unexpected status 429 Too Many Requests: {"error":{"code":"billing_hard_limit_reached","message":"private diagnostic"}}' }))
      .toEqual({ kind: "balance", retryable: false, status: 429, code: "billing_hard_limit" })
  })

  it("retains the terminal JSON-RPC diagnostic alongside its structured error data", () => {
    expect(codexProviderFailure({
      code: -32000,
      message: 'unexpected status 429: {"error":{"code":"insufficient_quota","message":"private diagnostic"}}',
      data: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } },
    })).toEqual({ kind: "balance", retryable: false, status: 429, code: "insufficient_quota" })
  })

  it.each([undefined, "other"])("reads the native terminal HTTP status when codexErrorInfo is %s", codexErrorInfo => {
    expect(codexProviderFailure({ codexErrorInfo, message: 'unexpected status 402 Payment Required: {"error":{"code":"insufficient_balance","message":"private diagnostic"}}' }))
      .toEqual({ kind: "balance", retryable: false, status: 402, code: "insufficient_balance" })
  })

  it.each([
    ["unauthorized", { kind: "auth", retryable: false, code: "authentication_failed" }],
    ["serverOverloaded", { kind: "unavailable", retryable: true, code: "overloaded" }],
    ["rateLimitExceeded", { kind: "unavailable", retryable: true, code: "rate_limit" }],
    [{ responseStreamDisconnected: {} }, { kind: "unavailable", retryable: true, code: "connection_error" }],
  ])("normalizes the CLI's fixed provider category: %j", (codexErrorInfo, failure) => {
    expect(codexProviderFailure({ codexErrorInfo, message: "private diagnostic" })).toEqual(failure)
  })

  it.each([
    { codexErrorInfo: "sandboxError", message: "HTTP 503; insufficient_balance" },
    { codexErrorInfo: "contextWindowExceeded", message: "limit reached" },
    { codexErrorInfo: "usageLimitExceeded", message: "usage limit" },
    { codexErrorInfo: "badRequest", message: "API Error: 402" },
    { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } }, message: "policy denied" },
    { codexErrorInfo: { privateCategory: { httpStatusCode: 503 } }, message: "private diagnostic" },
    { message: "Tool failed: HTTP 503; insufficient_balance" },
  ])("does not convert code failures or legacy quota into provider failures: %j", error => {
    expect(codexProviderFailure(error)).toBeUndefined()
  })
})
