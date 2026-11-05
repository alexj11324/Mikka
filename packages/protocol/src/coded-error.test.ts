import { describe, expect, it } from "vitest"

import { causeFields, CodedError, findCodedError, logCodedError, parseCodedErrorText } from "./coded-error"
import { SubscriptionRefusal } from "./subscription"
import { USER_ERROR_CODES } from "./user-error-codes"

describe("coded errors", () => {
  it("keep one code, name the failed check in a detail and keep the cause", () => {
    const cause = new Error("server said no")
    const error = new CodedError("subscription_local_runtime_unavailable", { detail: "lease_refused", cause })
    expect(error.code).toBe("subscription_local_runtime_unavailable")
    expect(error.detail).toBe("lease_refused")
    expect(error.cause).toBe(cause)
    expect(error.message).toBe("subscription_local_runtime_unavailable (lease_refused)")
    expect(new CodedError("x").message).toBe("x")
    expect("cause" in new CodedError("x")).toBe(false)
  })

  it("give distinct causes distinct details that read back from the stored text", () => {
    const texts = ["lease_refused", "model_mismatch"].map(detail => new CodedError("subscription_local_runtime_unavailable", { detail }).message)
    expect(texts.map(parseCodedErrorText)).toEqual([
      { code: "subscription_local_runtime_unavailable", detail: "lease_refused" },
      { code: "subscription_local_runtime_unavailable", detail: "model_mismatch" },
    ])
    expect(parseCodedErrorText(" subscription_hosted_runtime_unavailable ")).toEqual({ code: "subscription_hosted_runtime_unavailable", detail: null })
    for (const text of ["Model provider failed (balance: payment_required; HTTP 402)", "Claude Code: API Error: 402", "", null, "code (Detail With Spaces)"])
      expect(parseCodedErrorText(text)).toBeNull()
  })

  it("let existing refusal types carry a detail and cause", () => {
    const refusal = new SubscriptionRefusal("backend_unavailable", { detail: "capability_missing", cause: new TypeError("x") })
    expect(refusal).toBeInstanceOf(CodedError)
    expect(refusal.name).toBe("SubscriptionRefusal")
    expect(refusal.code).toBe("backend_unavailable")
    expect(new SubscriptionRefusal("backend_unavailable").message).toBe("backend_unavailable")
  })

  it("find a coded refusal wrapped by an adapter", () => {
    const inner = new CodedError("subscription_hosted_runtime_unavailable", { detail: "context_changed" })
    const wrapped = new Error("Claude subscription authentication unavailable", { cause: inner })
    expect(findCodedError(wrapped, "subscription_hosted_runtime_unavailable")).toBe(inner)
    expect(findCodedError(wrapped, "other")).toBeUndefined()
  })

  it("log the cause chain by name and code, never its message", () => {
    const secret = "sk-ant-oat01-very-secret-token"
    const root = Object.assign(new Error(`upstream body: ${secret}`), { code: "ECONNRESET" })
    const error = new CodedError("subscription_local_runtime_unavailable", { detail: "lease_refused", cause: new TypeError(`fetch failed ${secret}`, { cause: root }) })
    expect(causeFields(error.cause)).toEqual([{ name: "TypeError" }, { name: "Error", code: "ECONNRESET" }])
    const lines: Array<[Record<string, unknown>, string | undefined]> = []
    logCodedError(error, { runId: "run-1" }, { warn: (fields, message) => lines.push([fields, message]) })
    expect(lines).toEqual([[{ event: "coded_error", code: "subscription_local_runtime_unavailable", detail: "lease_refused",
      causes: [{ name: "TypeError" }, { name: "Error", code: "ECONNRESET" }], runId: "run-1" }, "subscription_local_runtime_unavailable"]])
    expect(JSON.stringify(lines)).not.toContain(secret)
    expect(causeFields(new AggregateError([new RangeError("a")]))).toEqual([{ name: "AggregateError" }, { name: "aggregate:RangeError" }])
    // A logger that throws never replaces the error.
    expect(() => logCodedError(error, {}, { warn: () => { throw new Error("log down") } })).not.toThrow()
  })

  it("register only identifier codes and details", () => {
    for (const [code, details] of Object.entries(USER_ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/)
      for (const detail of details) expect(detail).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(new Set(details).size).toBe(details.length)
    }
  })
})
