import { describe, expect, it } from "vitest"

import { claudeQuotaSignal, codexQuotaSignal, mergeQuota, quotaStopApplies } from "./quota-exhausted"

// Shapes as the Claude Agent SDK streams them (sdk.d.ts: SDKRateLimitEvent,
// SDKAssistantMessage.error, SDKResultMessage) and as `codex app-server` sends
// `error` notifications and failed turns (TurnError with codexErrorInfo).
const RESET = 1_762_016_400
const RESET_ISO = new Date(RESET * 1000).toISOString()

describe("Claude Code quota failures", () => {
  it("reads a rejected rate_limit_event with its window's reset", () => {
    expect(claudeQuotaSignal({ type: "rate_limit_event", session_id: "s", uuid: "u",
      rate_limit_info: { status: "rejected", resetsAt: RESET, rateLimitType: "five_hour" } })).toEqual({ resetsAt: RESET_ISO })
  })

  it("ignores a rate_limit_event that still allows requests", () => {
    for (const status of ["allowed", "allowed_warning"])
      expect(claudeQuotaSignal({ type: "rate_limit_event", rate_limit_info: { status, resetsAt: RESET, utilization: 0.9 } })).toBeNull()
  })

  it("reads the usage-limit assistant message with the reset after the bar", () => {
    expect(claudeQuotaSignal({ type: "assistant", error: "rate_limit", parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: `Claude AI usage limit reached|${RESET}` }] } })).toEqual({ resetsAt: RESET_ISO })
  })

  it("reads an error result without a reset time as null", () => {
    expect(claudeQuotaSignal({ type: "result", subtype: "success", is_error: true,
      result: "You've hit your limit · resets 5pm (Europe/Berlin)" })).toEqual({ resetsAt: null })
    expect(claudeQuotaSignal({ type: "result", subtype: "success", is_error: true,
      result: `Claude AI usage limit reached|${RESET}` })).toEqual({ resetsAt: RESET_ISO })
  })

  it("leaves other errors and successful results alone", () => {
    expect(claudeQuotaSignal({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["The build tool crashed"] })).toBeNull()
    expect(claudeQuotaSignal({ type: "result", subtype: "success", is_error: false, result: "usage limit reached" })).toBeNull()
    expect(claudeQuotaSignal({ type: "assistant", error: "authentication_failed", message: { content: [] } })).toBeNull()
    expect(claudeQuotaSignal({ type: "system", subtype: "api_retry", error: "rate_limit", attempt: 1 })).toBeNull()
  })
})

describe("Codex quota failures", () => {
  const now = Date.parse("2026-11-01T12:00:00.000Z")

  it("reads usageLimitExceeded with a relative retry time", () => {
    expect(codexQuotaSignal({ message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 hours 5 minutes.", codexErrorInfo: "usageLimitExceeded" }, undefined, now))
      .toEqual({ resetsAt: "2026-11-01T14:05:00.000Z" })
  })

  it("reads an absolute retry date", () => {
    const signal = codexQuotaSignal({ message: "You've hit your usage limit. Try again at Nov 3rd, 2026 4:05 PM.", codexErrorInfo: "usageLimitExceeded" }, undefined, now)
    expect(signal?.resetsAt).toBe(new Date(2026, 10, 3, 16, 5).toISOString())
  })

  it("takes the reset from the plan's used-up window when the message has none", () => {
    expect(codexQuotaSignal({ message: "exceeded retry limit, last status: 429 Too Many Requests", codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } },
      { primary: { usedPercent: 100, resetsAt: RESET }, secondary: { usedPercent: 40, resetsAt: RESET + 10 } }, now)).toEqual({ resetsAt: RESET_ISO })
  })

  it("has no reset when Codex gave none", () => {
    expect(codexQuotaSignal({ message: "Quota exceeded. Check your plan and billing details." }, undefined, now)).toEqual({ resetsAt: null })
  })

  it("leaves other turn errors alone", () => {
    expect(codexQuotaSignal({ message: "Your input exceeds the context window of this model.", codexErrorInfo: "contextWindowExceeded" }, undefined, now)).toBeNull()
    expect(codexQuotaSignal({ message: "stream disconnected before completion", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } }, undefined, now)).toBeNull()
    expect(codexQuotaSignal(null)).toBeNull()
  })
})

describe("quota signals", () => {
  it("keep the one that knows the reset", () => {
    expect(mergeQuota({ resetsAt: RESET_ISO }, { resetsAt: null })).toEqual({ resetsAt: RESET_ISO })
    expect(mergeQuota(undefined, { resetsAt: null })).toEqual({ resetsAt: null })
    expect(mergeQuota({ resetsAt: null }, null)).toEqual({ resetsAt: null })
  })

  it("apply to subscription and local-login runs only, never to an API-key run", () => {
    expect(quotaStopApplies({})).toBe(true)
    expect(quotaStopApplies({ modelCredential: { kind: "provider", protocol: "anthropic", baseUrl: "https://api.anthropic.com", key: "fixture-key-0123456789" } })).toBe(false)
  })
})
