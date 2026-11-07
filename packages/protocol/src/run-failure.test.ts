import { describe, expect, it } from "vitest"
import { CodedError, causeFields } from "./coded-error"
import { USER_ERROR_CODES } from "./user-error-codes"
import { captureRunFailure, compactRunFailure, failureFrom, readRunFailure, RunFailureError, runFailureSchema, type RunFailure, type RunFailureContext } from "./run-failure"

const context: RunFailureContext = { runId: "wrun_fixture", appVersion: "1.2.3-test", occurredAt: "2026-11-07T00:00:00.000Z", provider: "openai" }
function api(status: number, type: string, message = "The requested operation is not supported.") {
  return Object.assign(new Error("private SDK wrapper message"), {
    name: "AI_APICallError", statusCode: status,
    responseBody: JSON.stringify({ error: { type, message } }),
  })
}

describe("captureRunFailure provider matrix", () => {
  it.each([
    [400, "invalid_request_error", "The requested operation is not supported.", "invalid_request", undefined],
    [401, "authentication_error", "Authentication failed.", "api_key", "configure_api_key"],
    [403, "permission_error", "Access denied.", "access_denied", undefined],
    [402, "unknown", "Payment required.", "quota", "view_usage"],
    [429, "insufficient_quota", "Usage exhausted.", "quota", "view_usage"],
    [429, "rate_limit_error", "Too many requests.", "rate_limit", "retry"],
    [429, "unknown", "You exceeded your current quota.", "quota", "view_usage"],
    [400, "credit_balance_too_low", "Your credit balance is too low.", "quota", "view_usage"],
    [404, "model_not_found", "The selected model does not exist.", "model_unavailable", "change_model"],
    [400, "model_deprecated", "This model has been deprecated.", "model_unavailable", "change_model"],
    [410, "model_retired", "This model has been retired.", "model_unavailable", "change_model"],
    [400, "model_not_available", "The model is not available.", "model_unavailable", "change_model"],
    [400, "context_length_exceeded", "The maximum context length was exceeded.", "context_length", "change_model"],
    [408, "unknown", "Request timed out.", "timeout", "retry"],
    [504, "timeout_error", "The provider timed out.", "timeout", "retry"],
    [500, "network_error", "The provider connection failed.", "network", "retry"],
    [529, "overloaded_error", "The provider is overloaded.", "provider", "retry"],
    [503, "server_error", "The provider is unavailable.", "provider", "retry"],
  ])("maps %s/%s to %s", (status, type, message, category, recovery) => {
    const failure = captureRunFailure(api(status as number, type as string, message as string), context)
    expect(failure).toMatchObject({ category, status, runId: context.runId, appVersion: context.appVersion, occurredAt: context.occurredAt })
    expect(failure.recovery).toBe(recovery)
    expect(failure.providerMessage).toBe(message)
    expect(runFailureSchema.safeParse(failure).success).toBe(true)
    expect(USER_ERROR_CODES).toHaveProperty(failure.code)
  })

  it("distinguishes subscriptions from API keys without treating bare 403 as invalid credentials", () => {
    const subscription = captureRunFailure(api(401, "authentication_error"), { ...context, provider: "claude_code", credential: "subscription" })
    expect(subscription).toMatchObject({ code: "run_subscription_expired", category: "subscription", provider: "claude-code", recovery: "reconnect_subscription" })
    expect(captureRunFailure({ status: 403 }, { ...context, credential: "subscription" })).toMatchObject({ category: "access_denied", code: "run_access_denied" })
    expect(captureRunFailure({ status: 403 }, context).recovery).toBeUndefined()
  })

  it("prefers nested failed HTTP status over a successful bridge status", () => {
    const error = Object.assign(new Error("bridge"), { statusCode: 200, cause: api(503, "server_error", "Please retry later.") })
    expect(captureRunFailure(error, context)).toMatchObject({ status: 503, category: "provider", providerMessage: "Please retry later." })
  })

  it.each(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET"])("classifies %s without displaying the generic message", (code) => {
    const failure = captureRunFailure(Object.assign(new Error("request prompt or credentials"), { code }), context)
    expect(failure.category).toBe("network")
    expect(failure.providerMessage).toBeUndefined()
  })

  it.each(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"])("classifies timeout %s", (code) => {
    expect(captureRunFailure({ cause: { code } }, context).category).toBe("timeout")
  })

  it("accepts the trusted Go worker provider envelope", () => {
    const failure = captureRunFailure({ code: "subscription_generation_failed", providerFailure: { provider: "codex", status: 429, error: { type: "insufficient_quota", message: "You have reached your usage limit." } } }, { ...context, provider: undefined, credential: "subscription" })
    expect(failure).toMatchObject({ provider: "codex", category: "quota", status: 429, providerMessage: "You have reached your usage limit." })
  })

  it.each([
    ["reconnect_required", "subscription"], ["pending_auth", "subscription"], ["invalid_credential_bundle", "subscription"],
    ["quota_exhausted", "quota"], ["subscription_rate_limited", "rate_limit"], ["provider_access_denied", "access_denied"],
    ["provider_request_rejected", "invalid_request"], ["subscription_timeout", "timeout"], ["provider_operation_failed", "provider"],
  ])("preserves fixed worker refusal %s as a typed cause", (code, category) => {
    const failure = captureRunFailure(Object.assign(new Error(code), { name: "WorkerRefusal", code }), { ...context, credential: "subscription" })
    expect(failure.category).toBe(category)
    expect(failure.causes[0]).toEqual({ name: "WorkerRefusal", code })
    expect(captureRunFailure(new Error(code), context).category).toBe(category)
    expect(failure.providerMessage).toBeUndefined()
    expect(runFailureSchema.safeParse(failure).success).toBe(true)
  })

  it("extracts only the controlled CLI API error prefix", () => {
    const envelope = new Error('API Error: 400 {"error":{"type":"invalid_request_error","message":"Unsupported request format."}}')
    expect(captureRunFailure(envelope, { ...context, provider: "claude_code" })).toMatchObject({ category: "invalid_request", providerMessage: "Unsupported request format." })
    expect(captureRunFailure(envelope, context).providerMessage).toBeUndefined()
    expect(captureRunFailure(new Error("CLI stderr: API Error: 400 private command"), { ...context, provider: "claude" }).providerMessage).toBeUndefined()
  })
})

describe("safe diagnostic boundaries", () => {
  it("never displays arbitrary messages, stack, stderr, tool output, headers, or request bodies", () => {
    const privateText = "private canary alpha bravo charlie delta"
    const failure = captureRunFailure(Object.assign(new Error(privateText), { stderr: privateText, stack: privateText, headers: { authorization: privateText }, requestBody: privateText, toolOutput: privateText, error: { message: privateText } }), context)
    expect(failure.category).toBe("internal")
    expect(failure.providerMessage).toBeUndefined()
    expect(JSON.stringify(failure)).not.toContain(privateText)
    expect(captureRunFailure(privateText, context).code).toBe("run_failed")
  })

  it.each([
    "The provider rejected the instruction Project Calico has a confidential acquisition plan.",
    'Bad payload: {"prompt":"Project Calico has a confidential acquisition plan."}',
    "Not accepted: confidential acquisition plan",
    "Not accepted: Project\\u0020Calico\\u0020has",
  ])("omits full, JSON, partial and escaped prompt echoes: %s", (message) => {
    const prompt = "Project Calico has a confidential acquisition plan."
    const failure = captureRunFailure(Object.assign(api(400, "invalid_request_error", message), { requestBodyValues: { messages: [{ role: "user", content: prompt }] } }), context)
    expect(failure.providerMessage).toBeUndefined()
    expect(JSON.stringify(failure)).not.toMatch(/Calico|acquisition|confidential/)
    expect(failure.category).toBe("invalid_request")
  })

  it("also removes prompts supplied through context, including Chinese fragments", () => {
    const failure = captureRunFailure(api(400, "invalid_request_error", "输入错误：秘密收购计划将于下月执行"), { ...context, sensitiveText: ["秘密收购计划将于下月执行，请勿向外部透露"] })
    expect(failure.providerMessage).toBeUndefined()
  })

  it("inspects context request input beyond the old 256-string cutoff", () => {
    const messages = Array.from({ length: 257 }, (_, index) => ({ role: "user", content: index === 256 ? "late private canary" : `Synthetic input ${index}` }))
    const failure = captureRunFailure(api(400, "invalid_request_error", "Request rejected: late private canary"), { ...context, requestBodyValues: { messages } })
    expect(failure).toMatchObject({ code: "run_invalid_request", category: "invalid_request", status: 400 })
    expect(failure.providerMessage).toBeUndefined()
    expect(JSON.stringify(failure)).not.toContain("late private canary")
  })

  it.each([
    { prompt: [{ role: "user", content: "calico7" }] },
    { tools: [{ name: "lookup", description: "calico7", inputSchema: { type: "object" } }] },
    { providerOptions: { provider: { privateOption: "calico7" } } },
    { headers: { "x-private-input": "calico7" } },
  ])("removes seven-character private values from complete context request fields: %j", (requestBodyValues) => {
    const failure = captureRunFailure(api(400, "invalid_request_error", "The provider rejected calico7."), { ...context, requestBodyValues })
    expect(failure.providerMessage).toBeUndefined()
    expect(failure.code).toBe("run_invalid_request")
    expect(failure).not.toHaveProperty("requestBodyValues")
    expect(JSON.stringify(failure)).not.toContain("calico7")
  })

  it("rechecks existing diagnostics against complete context input", () => {
    const initial = captureRunFailure(api(400, "invalid_request_error", "The provider rejected calico7."), context)
    expect(initial.providerMessage).toContain("calico7")
    const failure = captureRunFailure({ failureDetails: initial }, { ...context, runId: "wrun_rebound", requestBodyValues: { tools: [{ description: "calico7" }] } })
    expect(failure).toMatchObject({ code: initial.code, category: initial.category, runId: "wrun_rebound" })
    expect(failure.providerMessage).toBeUndefined()
  })

  it("omits provider text when context inspection encounters accessors or exceeds its bounds", () => {
    let getterCalls = 0
    const nestedGetter = { get input() { getterCalls++; return "private getter value" } }
    let deep: unknown = "private deep value"
    for (let i = 0; i < 10; i++) deep = { nested: deep }
    const contexts: RunFailureContext[] = [
      { ...context, get requestBodyValues() { getterCalls++; return "private context getter" } },
      { ...context, requestBodyValues: nestedGetter },
      { ...context, requestBodyValues: { prompt: "p".repeat(2_097_153) } },
      { ...context, requestBodyValues: deep },
      { ...context, requestBodyValues: { prompt: Array.from({ length: 257 }, (_, index) => `input ${index}`) } },
    ]
    for (const input of contexts) {
      const failure = captureRunFailure(api(400, "invalid_request_error", "The requested operation is not supported."), input)
      expect(failure).toMatchObject({ code: "run_invalid_request", category: "invalid_request", status: 400 })
      expect(failure.providerMessage).toBeUndefined()
      expect(failure).not.toHaveProperty("requestBodyValues")
    }
    expect(getterCalls).toBe(0)
  })

  it("inspects JSON request strings for short echoes and omits incomplete quotations", () => {
    const error = Object.assign(api(400, "invalid_request_error", "Not accepted: Calico dossier"), { requestBody: JSON.stringify({ input: "Calico dossier" }) })
    expect(captureRunFailure(error, context).providerMessage).toBeUndefined()
    expect(captureRunFailure(api(400, "invalid_request_error", 'Rejected "private incomplete echo'), context).providerMessage).toBeUndefined()
    expect(captureRunFailure(api(400, "invalid_request_error", "Rejected 'private incomplete echo"), context).providerMessage).toBeUndefined()
  })

  it("redacts credentials, tokens, URL, email and arbitrary quoted or JSON values", () => {
    const message = 'Rejected sk-test-secret123 token=shortsecret Bearer privatebearer alice@example.com https://provider.test/key?token=privatevalue "private quoted echo" {"input":"private JSON echo"}'
    const failure = captureRunFailure(api(400, "invalid_request_error", message), context)
    expect(failure.providerMessage).toContain("Rejected")
    expect(JSON.stringify(failure)).not.toMatch(/secret123|shortsecret|privatebearer|alice|provider\.test|privatevalue|quoted echo|JSON echo/)
    expect(JSON.stringify(captureRunFailure(api(401, "authentication_error", "Incorrect API key provided: shortprivate. Learn more at custom://account.example/private"), context))).not.toMatch(/shortprivate|account\.example/)
  })

  it("omits text if complete sensitive input inspection is impossible", () => {
    const request = { get prompt() { throw new Error("getter executed") } }
    expect(captureRunFailure(Object.assign(api(400, "invalid_request_error"), { requestBodyValues: request }), context).providerMessage).toBeUndefined()
    expect(captureRunFailure(api(400, "invalid_request_error"), { ...context, sensitiveText: ["p".repeat(2_097_153)] }).providerMessage).toBeUndefined()
  })

  it("keeps independent provider text for long request input within the hosted payload budget", () => {
    const prompt = "Long synthetic private background material. ".repeat(25_000)
    const message = "The requested operation is not supported."
    const error = Object.assign(api(400, "invalid_request_error", message), { requestBodyValues: { messages: [{ role: "user", content: prompt }] } })
    expect(captureRunFailure(error, { ...context, sensitiveText: [prompt] }).providerMessage).toBe(message)
    const json = Object.assign(api(400, "invalid_request_error", message), { requestBody: JSON.stringify({ prompt }) })
    expect(captureRunFailure(json, context).providerMessage).toBe(message)
  })

  it("detects partial prompt echoes after the first 256 words and at the end of long input", () => {
    for (const repetitions of [600, 20_000]) {
      const prompt = "Routine background filler words. ".repeat(repetitions) + "Private Calico acquisition dossier remains confidential."
      const failure = captureRunFailure(api(400, "invalid_request_error", "Request rejected: Calico acquisition dossier"), { ...context, sensitiveText: [prompt] })
      expect(failure.providerMessage).toBeUndefined()
    }
    const prompt = "普通背景材料".repeat(5_000) + "此处存在秘密收购计划请勿外传"
    expect(captureRunFailure(api(400, "invalid_request_error", "输入错误：秘密收购计划"), { ...context, sensitiveText: [prompt] }).providerMessage).toBeUndefined()
  })

  it("does not execute hostile field getters, toJSON or coercion", () => {
    let calls = 0
    const error: Record<string, unknown> = { toJSON() { calls++; throw new Error("called") }, toString() { calls++; throw new Error("called") } }
    for (const key of ["cause", "error", "message", "status", "code", "provider", "failureDetails", "requestBodyValues"]) {
      Object.defineProperty(error, key, { get() { calls++; throw new Error("called") } })
    }
    expect(() => captureRunFailure(error, context)).not.toThrow()
    expect(failureFrom(error)).toBeNull()
    expect(readRunFailure(error)).toBeNull()
    expect(calls).toBe(0)
    const revoked = Proxy.revocable({}, {}); revoked.revoke()
    expect(() => captureRunFailure(revoked.proxy, context)).not.toThrow()
  })

  it("bounds cyclic and oversized cause chains and whitelists identifiers", () => {
    const root: Record<string, unknown> = { name: "private_name", code: "secret_token_canary", detail: "secret_detail_canary" }
    let cursor = root
    for (let i = 0; i < 50; i++) { const cause: Record<string, unknown> = { name: "Error", code: "ECONNRESET" }; cursor.cause = cause; cursor = cause }
    cursor.cause = root
    const failure = captureRunFailure(root, context)
    expect(failure.causes).toHaveLength(8)
    expect(JSON.stringify(failure)).not.toMatch(/private_name|secret_token|secret_detail/)
    expect(runFailureSchema.safeParse(failure).success).toBe(true)
    const cycle: Record<string, unknown> = {}; cycle.cause = cycle
    expect(captureRunFailure(cycle, context).causes).toHaveLength(1)
  })

  it("drops freeform provider names and unsafe identity fields", () => {
    const failure = captureRunFailure(api(500, "server_error"), { provider: "https://private.example/api", runId: "private@example.com", appVersion: "secret/value" })
    expect(failure.provider).toBeUndefined()
    expect(failure.runId).toBeNull()
    expect(failure.appVersion).toBe("unknown")
  })
})

describe("transport and legacy compatibility", () => {
  it("rebinds stored failure identities without losing safe provider diagnostics", () => {
    const initial = captureRunFailure(api(400, "invalid_request_error", "Unsupported request format."), context)
    const rebound = captureRunFailure({ cause: { failureDetails: initial } }, { runId: "wrun_next", appVersion: "next-build" })
    expect(rebound).toEqual({ ...initial, runId: "wrun_next", appVersion: "next-build" })
    expect(failureFrom({ failureDetails: initial })).toEqual(initial)
    expect(readRunFailure(JSON.parse(JSON.stringify(initial)))).toEqual(initial)
    expect(captureRunFailure({ failureDetails: initial }, { sensitiveText: ["Unsupported request format."] }).providerMessage).toBeUndefined()
  })

  it("keeps CodedError causes, fixed messages and registered legacy details", () => {
    const cause = new Error("private original")
    const old = new CodedError("subscription_local_runtime_unavailable", { detail: "cli_missing", cause })
    const failure = captureRunFailure(old, context)
    expect(failure).toMatchObject({ code: old.code, detail: "cli_missing", category: "subscription" })
    expect(captureRunFailure(new Error(old.message), context).code).toBe(old.code)
    const error = new RunFailureError(failure, { cause: old })
    expect(error).toBeInstanceOf(CodedError)
    expect(error.message).toBe(old.message)
    expect(error.cause).toBe(old)
    expect(failureFrom(error)).toEqual(failure)
    expect(JSON.stringify(causeFields(error))).not.toContain("private original")
  })

  it.each([[401, "authentication_error", "subscription"], [400, "invalid_request_error", "invalid_request"]])("prefers provider evidence beneath a generic CodedError wrapper: %s", (status, type, category) => {
    const cause = { status, error: { type, message: "Authentication failed." } }
    const failure = captureRunFailure(new CodedError("run_failed", { cause }), { ...context, credential: "subscription" })
    expect(failure.category).toBe(category)
    expect(failure.code).not.toBe("run_failed")
    expect(failure.providerMessage).toBe("Authentication failed.")
  })

  it("rejects malformed, oversized, unknown, accessor and extra-field records", () => {
    const failure = captureRunFailure(api(400, "invalid_request_error"), context)
    const invalid = [
      { ...failure, schemaVersion: 2 }, { ...failure, provider: "private-provider" }, { ...failure, providerMessage: "x".repeat(513) },
      { ...failure, causes: Array(9).fill({ name: "Error" }) }, { ...failure, causes: { length: 0 } },
      { ...failure, causes: [{ name: "private-cause" }] }, { ...failure, causes: [{ name: "Error", code: "private-code" }] },
      { ...failure, raw: "private" }, { ...failure, status: 200 }, { ...failure, detail: "cli_missing" },
      { ...failure, occurredAt: "today" }, { ...failure, code: "unregistered" },
    ]
    for (const value of invalid) expect(readRunFailure(value)).toBeNull()
    let calls = 0
    const getter = { ...failure, get providerMessage() { calls++; return "private" } }
    expect(readRunFailure(getter)).toBeNull()
    expect(calls).toBe(0)
  })

  it("removes provider prose and cause chains from compact log/list diagnostics", () => {
    const failure = captureRunFailure(api(400, "invalid_request_error"), context)
    const compact = compactRunFailure(failure)
    expect(compact).toMatchObject({ schemaVersion: 1, code: "run_invalid_request", status: 400, runId: context.runId })
    expect(compact).not.toHaveProperty("providerMessage")
    expect(compact).not.toHaveProperty("causes")
    expect(compactRunFailure(null)).toBeNull()
    expect(compactRunFailure({ code: "private" } as unknown as RunFailure)).toBeNull()
  })
})
