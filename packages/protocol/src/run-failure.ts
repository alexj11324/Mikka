import { z } from "zod"
import { CodedError, type CauseField } from "./coded-error"
import { USER_ERROR_CODES, type UserErrorCode } from "./user-error-codes"

const providers = ["openai", "anthropic", "google", "google-vertex", "azure", "bedrock", "openrouter", "deepseek", "groq", "mistral", "xai", "cohere", "perplexity", "together", "fireworks", "cerebras", "ollama", "lmstudio", "codex", "claude", "claude-code", "gemini", "gemini-cli", "github-copilot", "copilot", "custom"] as const
const categories = ["subscription", "api_key", "quota", "rate_limit", "invalid_request", "access_denied", "model_unavailable", "context_length", "timeout", "network", "provider", "internal"] as const
const recoveries = ["reconnect_subscription", "configure_api_key", "view_usage", "change_model", "retry"] as const
const userCodes = Object.keys(USER_ERROR_CODES) as [UserErrorCode, ...UserErrorCode[]]
const providerCodes = ["unknown", "invalid_request_error", "invalid_request", "bad_request", "authentication_error", "authentication_failed", "invalid_api_key", "invalid_authentication", "unauthorized", "permission_error", "permission_denied", "access_denied", "forbidden", "insufficient_quota", "quota_exceeded", "usage_limit_reached", "usage_limit_exceeded", "credit_balance_too_low", "insufficient_balance", "billing_hard_limit", "billing_hard_limit_reached", "billing_not_active", "billing_error", "payment_required", "resource_exhausted", "rate_limit", "rate_limit_error", "rate_limit_exceeded", "too_many_requests", "overloaded", "overloaded_error", "server_error", "internal_server_error", "api_error", "provider_error", "model_not_found", "model_not_available", "model_unavailable", "model_deprecated", "model_retired", "not_found_error", "context_length_exceeded", "context_window_exceeded", "max_tokens_exceeded", "prompt_too_long", "request_too_large", "timeout", "timeout_error", "request_timeout", "connection_error", "network_error"] as const
const systemCodes = ["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "ABORT_ERR"] as const
const refusalCodes = ["binding_required", "account_unavailable", "binding_mismatch", "stale_binding", "pending_auth", "reconnect_required", "disconnected", "quota_unknown", "quota_exhausted", "provider_approval_required", "backend_unavailable", "isolation_required", "billing_unverified", "subscription_rate_limited", "provider_access_denied", "provider_request_rejected", "provider_temporarily_unavailable", "provider_route_unavailable", "invalid_credential_bundle", "subscription_timeout", "provider_operation_failed", "subscription_generation_failed", "subscription_model_not_reported", "subscription_worker_unavailable", "subscription_cancelled", "stale_operation", "credential_busy", "metadata_unavailable", "secret_store_unavailable", "secret_create_outcome_unknown", "secret_not_found", "credential_integrity_failed"] as const
const causeNames = ["Error", "TypeError", "CodedError", "RunFailureError", "WorkflowRunFailureError", "ProviderError", "WorkerRefusal", "SubscriptionRefusal", "AI_APICallError", "APICallError", "AI_RetryError", "RetryError", "AI_NoSuchModelError", "NoSuchModelError", "AI_NoOutputGeneratedError", "AI_NoObjectGeneratedError", "AI_InvalidResponseDataError", "AI_LoadAPIKeyError", "AI_LoadSettingError", "APIError", "APIConnectionError", "APIConnectionTimeoutError", "AuthenticationError", "PermissionDeniedError", "RateLimitError", "BadRequestError", "NotFoundError", "InternalServerError", "TimeoutError", "AbortError", "FetchError", "NetworkError", "AggregateError"] as const
const safeCodes = [...userCodes, ...providerCodes, ...systemCodes, ...refusalCodes] as [string, ...string[]]
const registeredDetails = [...new Set(Object.values(USER_ERROR_CODES).flat())] as string[]
const detailValues = registeredDetails.length ? registeredDetails as [string, ...string[]] : ["unknown"] as [string]
const dateSchema = z.iso.datetime({ offset: true }).max(40)
const runIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).nullable()
const versionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.+-]+$/)

/** This is a bounded diagnostic record, never a serialized provider Error. */
export const runFailureSchema = z.object({
  schemaVersion: z.literal(1),
  code: z.enum(userCodes),
  detail: z.enum(detailValues).optional(),
  category: z.enum(categories),
  provider: z.enum(providers).optional(),
  status: z.number().int().min(400).max(599).optional(),
  providerMessage: z.string().min(1).max(512).optional(),
  causes: z.array(z.object({
    name: z.enum(causeNames),
    code: z.union([z.enum(safeCodes), z.number().int().min(-2147483648).max(2147483647)]).optional(),
    detail: z.enum(detailValues).optional(),
  }).strict()).max(8),
  recovery: z.enum(recoveries).optional(),
  runId: runIdSchema,
  occurredAt: dateSchema,
  appVersion: versionSchema,
}).strict().superRefine((failure, ctx) => {
  if (failure.detail && !(USER_ERROR_CODES[failure.code] as readonly string[]).includes(failure.detail)) {
    ctx.addIssue({ code: "custom", path: ["detail"], message: "Unregistered error detail" })
  }
})

export type RunFailure = z.infer<typeof runFailureSchema>
export type RunFailureContext = {
  runId?: string | null
  appVersion?: string
  occurredAt?: string
  provider?: string
  credential?: "subscription" | "api_key"
  sensitiveText?: readonly string[]
  /** Complete request context, inspected only for redaction and never stored. */
  requestBodyValues?: unknown
}

const providerSet = new Set<string>(providers)
const codeSet = new Set<string>(safeCodes)
const nameSet = new Set<string>(causeNames)
const detailSet = new Set<string>(registeredDetails)
const userCodeSet = new Set<string>(userCodes)
const providerCodeSet = new Set<string>(providerCodes)
const refusalCodeSet = new Set<string>(refusalCodes)
const MAX_NODES = 24
const MAX_DEPTH = 8
const MAX_BODY = 65_536
const MAX_MESSAGE = 4_096
const MAX_INPUT = 2_097_152
const REDACTED = "[redacted]"

// Never evaluate a getter, toJSON, iterator, or arbitrary coercion while capturing an error.
function own(value: unknown, key: PropertyKey): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}
function string(value: unknown, max = MAX_MESSAGE): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined
}
function array(value: unknown, limit: number): unknown[] {
  try {
    if (!Array.isArray(value)) return []
    const length = own(value, "length")
    if (typeof length !== "number" || !Number.isSafeInteger(length)) return []
    const result: unknown[] = []
    for (let i = 0; i < Math.min(length, limit); i++) result.push(own(value, String(i)))
    return result
  } catch { return [] }
}
function provider(value: unknown): RunFailure["provider"] {
  const raw = string(value, 64)?.toLowerCase().replaceAll("_", "-")
  const normalized = raw === "claude-code-sdk" ? "claude-code" : raw === "vertex" ? "google-vertex" : raw
  return normalized && providerSet.has(normalized) ? normalized as RunFailure["provider"] : undefined
}
function status(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined
}
function knownCode(value: unknown): string | undefined {
  const raw = string(value, 80)
  if (!raw) return undefined
  if (codeSet.has(raw)) return raw
  const normalized = raw.toLowerCase().replaceAll("-", "_")
  return providerCodeSet.has(normalized) ? normalized : undefined
}
function fixedRefusal(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : string(own(value, "message"), 80)
  return text && refusalCodeSet.has(text) ? text : undefined
}
function coded(value: unknown): { code: UserErrorCode; detail?: string } | null {
  let code = string(own(value, "code"), 80)
  let detail = string(own(value, "detail"), 80)
  // Workflow's legacy Error codec stores only the fixed CodedError message.
  if (!code || !userCodeSet.has(code)) {
    const text = typeof value === "string" ? string(value, 160) : string(own(value, "message"), 160)
    const match = text?.match(/^([a-z][a-z0-9_]*)(?: \(([a-z][a-z0-9_]*)\))?$/)
    code = match?.[1]
    detail = match?.[2]
  }
  if (!code || !userCodeSet.has(code)) return null
  const validDetail = detail && (USER_ERROR_CODES[code as UserErrorCode] as readonly string[]).includes(detail) ? detail : undefined
  return { code: code as UserErrorCode, ...(validDetail ? { detail: validDetail } : {}) }
}
function nodes(error: unknown): unknown[] {
  const queue: { value: unknown; depth: number }[] = [{ value: error, depth: 0 }]
  const seen = new Set<unknown>()
  const result: unknown[] = []
  for (let index = 0; index < queue.length && result.length < MAX_NODES; index++) {
    const { value, depth } = queue[index]
    if (!value || typeof value !== "object" || seen.has(value)) continue
    seen.add(value)
    result.push(value)
    if (depth >= MAX_DEPTH) continue
    for (const key of ["cause", "error", "providerFailure"]) {
      const child = own(value, key)
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 })
    }
    for (const child of array(own(value, "errors"), 3)) queue.push({ value: child, depth: depth + 1 })
  }
  return result
}

/** Input text is used solely to remove echoes. It is never retained in the record. */
function sensitiveTexts(errorNodes: unknown[], context: RunFailureContext): { texts: string[]; incomplete: boolean } {
  const texts: string[] = []
  let incomplete = false
  let total = 0
  let inspected = 0
  const seen = new Set<unknown>()
  const seenTexts = new Set<string>()
  const add = (value: string) => {
    if (seenTexts.has(value)) return
    seenTexts.add(value)
    if (value.length > MAX_INPUT || total + value.length > MAX_INPUT || texts.length >= 2_048) { incomplete = true; return }
    if (value.trim().length >= 3) { texts.push(value); total += value.length }
  }
  const contextText = own(context, "sensitiveText")
  if (contextText !== undefined) {
    const length = own(contextText, "length")
    if (typeof length !== "number" || length > 2_048) incomplete = true
    for (const value of array(contextText, 2_048)) {
      if (typeof value === "string") add(value)
      else incomplete = true
    }
  }
  const walk = (value: unknown, depth: number) => {
    if (++inspected > 8_192 || depth > 8) { incomplete = true; return }
    if (typeof value === "string") {
      // Some SDKs retain the request body as JSON rather than requestBodyValues.
      if (value.length <= MAX_INPUT && (value.trimStart().startsWith("[") || value.trimStart().startsWith("{"))) {
        try { walk(JSON.parse(value) as unknown, depth + 1); return } catch { /* Inspect the text below. */ }
      }
      add(value)
      return
    }
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    try {
      const keys = Reflect.ownKeys(value)
      if (keys.length > 128) incomplete = true
      for (const key of keys.slice(0, 128)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !("value" in descriptor)) { incomplete = true; continue }
        walk(descriptor.value, depth + 1)
      }
    } catch { incomplete = true }
  }
  const inspectField = (node: unknown, key: string) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(node, key)
      if (descriptor && !("value" in descriptor)) incomplete = true
      else if (descriptor) walk(descriptor.value, 0)
    } catch { incomplete = true }
  }
  inspectField(context, "requestBodyValues")
  for (const node of errorNodes) {
    for (const key of ["requestBodyValues", "requestBody", "request", "prompt", "messages", "input", "apiKey", "token", "accessToken", "refreshToken", "authorization"]) inspectField(node, key)
  }
  return { texts, incomplete }
}
function decodeEscapes(value: string): string {
  return value.replace(/\\u([0-9a-f]{4})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\(["'\\/])/g, "$1").replace(/\\[nrt]/g, " ")
}
function echoesInput(message: string, inputs: string[]): boolean {
  const lower = message.toLowerCase().replace(/\s+/gu, " ")
  const words = lower.match(/[\p{L}\p{N}_]+/gu) ?? []
  const phrases = new Set<string>()
  for (let i = 0; i + 2 < words.length; i++) phrases.add(words.slice(i, i + 3).join("\0"))
  const unicodeFragments = new Set<string>()
  for (let i = 0; i + 6 <= lower.length; i++) {
    const fragment = lower.slice(i, i + 6)
    if (/\P{ASCII}/u.test(fragment)) unicodeFragments.add(fragment)
  }
  const messageWords = words.join(" ")
  for (const input of inputs) {
    const normalized = decodeEscapes(input).trim().toLowerCase().replace(/\s+/gu, " ")
    if (normalized.length <= lower.length && lower.includes(normalized)) return true
    const inputWords = normalized.match(/[\p{L}\p{N}_]+/gu) ?? []
    if (inputWords.length > 0 && inputWords.length < 3 && messageWords.includes(inputWords.join(" "))) return true
    for (let i = 0; i + 2 < inputWords.length; i++) {
      if (phrases.has(inputWords.slice(i, i + 3).join("\0"))) return true
    }
    if (unicodeFragments.size) {
      for (let i = 0; i + 6 <= normalized.length; i++) {
        if (unicodeFragments.has(normalized.slice(i, i + 6))) return true
      }
    }
  }
  return false
}
function redact(text: string | undefined, sensitive: { texts: string[]; incomplete: boolean }): string | undefined {
  if (!text || sensitive.incomplete || text.length > MAX_MESSAGE) return undefined
  // Decode escapes before matching request echoes, including JSON/unicode-escaped echoes.
  let result = decodeEscapes(text)
  // Candidate fragments are bounded by MAX_MESSAGE; every known input is scanned, including
  // the tail of long prompts. An echo discards the entire message to avoid leaking its rest.
  if (echoesInput(result, sensitive.texts)) return undefined
  // Quoted strings and JSON fragments can contain arbitrary request echoes. Omit the whole
  // fragment, even when it also contains useful model names or provider parameter values.
  result = result.replace(/\{[\s\S]*\}|\[[\s\S]*\]/g, REDACTED)
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, REDACTED)
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"']+/gi, REDACTED)
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, REDACTED)
    .replace(/\b(?:sk|pk|rk|sess|session|token|key|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_.-]+/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, REDACTED)
    .replace(/\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password|authorization|credential)(?:\s+(?:provided|supplied|received|value|is|was))*\s*(?:[:=]|\s)\s*[^\s,;]+/gi, REDACTED)
    .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, REDACTED)
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|cloud|tech)\b(?:\/[^\s]*)?/gi, REDACTED)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, REDACTED)
    .replace(/(?:^|\s)(?:\/[A-Za-z0-9_.-]+){2,}(?:\/[A-Za-z0-9_.-]*)?/g, ` ${REDACTED}`)
    .replace(/\b(?:prompt|request body|user (?:message|input)|input (?:text|content)|messages|requestBodyValues)\s*[:=][\s\S]*/gi, REDACTED)
    .replace(/\p{Cc}|[\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ").trim()
  // An unmatched quotation/JSON opener, a stack, or markup makes safe extraction uncertain.
  if (/["{}<>`]|(?:^|[\s:=])'|'(?:\s|$)|(?:^|\s)at\s+\S+\s*\(|\b(?:stack|headers|stderr)\s*:/i.test(result)) return undefined
  return result ? result.slice(0, 512) : undefined
}

const recordKeys = new Set(["schemaVersion", "code", "detail", "category", "provider", "status", "providerMessage", "causes", "recovery", "runId", "occurredAt", "appVersion"])
function snapshot(value: unknown, keys: Set<string>): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null
  try {
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length > keys.size) return null
    const result: Record<string, unknown> = {}
    for (const key of ownKeys) {
      if (typeof key !== "string" || !keys.has(key)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

/** Read untrusted IPC/persistence values without running property accessors. */
export function readRunFailure(value: unknown): RunFailure | null {
  const record = snapshot(value, recordKeys)
  if (!record) return null
  const length = own(record.causes, "length")
  try { if (!Array.isArray(record.causes)) return null } catch { return null }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 8) return null
  const causes = array(record.causes, 8).map((cause) => snapshot(cause, new Set(["name", "code", "detail"])))
  try {
    const parsed = runFailureSchema.safeParse({ ...record, causes })
    if (!parsed.success) return null
    const safe = parsed.data
    const providerMessage = redact(safe.providerMessage, { texts: [], incomplete: false })
    const { providerMessage: _raw, ...rest } = safe
    return { ...rest, ...(providerMessage ? { providerMessage } : {}) }
  } catch { return null }
}

export function failureFrom(error: unknown): RunFailure | null {
  for (const node of nodes(error)) {
    const failure = readRunFailure(own(node, "failureDetails"))
    if (failure) return failure
  }
  return null
}

type Evidence = { status?: number; message?: string; code?: string; provider?: RunFailure["provider"] }
function structured(value: unknown): Evidence | null {
  if (!value || typeof value !== "object") return null
  const message = string(own(value, "message"))
  const code = knownCode(own(value, "code")) ?? knownCode(own(value, "type"))
  return message || code ? { message, code } : null
}
function responseEvidence(value: unknown): Evidence | null {
  if (typeof value !== "string" || value.length > MAX_BODY) return null
  try { return structured(own(JSON.parse(value) as unknown, "error")) } catch { return null }
}
function evidenceFor(node: unknown, contextProvider: RunFailure["provider"]): Evidence {
  const http = status(own(node, "statusCode")) ?? status(own(node, "status"))
  const sourceProvider = provider(own(node, "provider")) ?? contextProvider
  const nested = structured(own(node, "error"))
  const body = responseEvidence(own(node, "responseBody"))
  const directCode = knownCode(own(node, "code")) ?? knownCode(own(node, "type")) ?? fixedRefusal(node)
  const selected = body ?? nested
  const apiError = ["AI_APICallError", "APICallError", "APIError"].includes(string(own(node, "name"), 80) ?? "")
  // A field called `error` alone is not proof that arbitrary tool output came from a provider.
  if (selected && (http !== undefined || provider(own(node, "provider")) || apiError || (selected.code && providerCodeSet.has(selected.code)))) {
    return { ...selected, status: http, provider: sourceProvider }
  }
  // Only CLI API error envelopes are eligible for message extraction. Generic Error.message,
  // including AI_APICallError.message, is intentionally not a source of display text.
  if (sourceProvider && ["codex", "claude", "claude-code", "gemini-cli"].includes(sourceProvider)) {
    const raw = string(own(node, "message"))
    const match = raw?.match(/^API [Ee]rror:\s*([45]\d\d)\s*(?:[-:]\s*)?([\s\S]*)$/)
    if (match) {
      const parsed = responseEvidence(match[2])
      return { status: Number(match[1]), provider: sourceProvider, ...(parsed ?? { message: match[2], code: directCode }) }
    }
  }
  return { status: http, provider: sourceProvider, code: directCode }
}
const categoryCode: Record<RunFailure["category"], UserErrorCode> = {
  subscription: "run_subscription_expired", api_key: "run_api_key_invalid", quota: "run_quota_exceeded", rate_limit: "run_rate_limited", invalid_request: "run_invalid_request", access_denied: "run_access_denied", model_unavailable: "run_model_unavailable", context_length: "run_context_length_exceeded", timeout: "run_timeout", network: "run_network_error", provider: "run_provider_error", internal: "run_failed",
}
const categoryRecovery: Partial<Record<RunFailure["category"], RunFailure["recovery"]>> = {
  subscription: "reconnect_subscription", api_key: "configure_api_key", quota: "view_usage", rate_limit: "retry", model_unavailable: "change_model", context_length: "change_model", timeout: "retry", network: "retry", provider: "retry",
}
function classify(evidence: Evidence[], chain: unknown[], credential: unknown): RunFailure["category"] {
  const codes = new Set(evidence.map((item) => item.code).filter(Boolean))
  const has = (...values: string[]) => values.some((value) => codes.has(value))
  const text = evidence.map((item) => item.message ?? "").join(" ").toLowerCase()
  const http = evidence.findLast((item) => item.status !== undefined)?.status
  const names = chain.map((node) => string(own(node, "name"), 80))
  if (has("context_length_exceeded", "context_window_exceeded", "max_tokens_exceeded", "prompt_too_long", "request_too_large") || /context (?:length|window).*(?:exceed|limit|long)|maximum context|prompt is too long|too many (?:input )?tokens|input.*exceeds.*token/.test(text)) return "context_length"
  if (has("model_not_found", "model_not_available", "model_unavailable", "model_deprecated", "model_retired") || names.some((name) => name === "AI_NoSuchModelError" || name === "NoSuchModelError") || /model.{0,120}(?:not found|does not exist|not available|unavailable|deprecated|retired|decommissioned|no longer supported)|(?:unknown|unsupported|deprecated|retired) model/.test(text)) return "model_unavailable"
  if (has("insufficient_quota", "quota_exceeded", "quota_exhausted", "usage_limit_reached", "usage_limit_exceeded", "credit_balance_too_low", "insufficient_balance", "billing_hard_limit", "billing_hard_limit_reached", "billing_not_active", "billing_error", "payment_required") || http === 402 || /insufficient (?:quota|credit|balance)|(?:quota|credit balance|billing|spending|usage limit).{0,80}(?:exceed|exhaust|limit|low|reach)|exceeded.{0,40}(?:quota|usage)|out of credits|not enough credits/.test(text)) return "quota"
  if (http === 401 || has("authentication_error", "authentication_failed", "invalid_api_key", "invalid_authentication", "unauthorized") || names.includes("AI_LoadAPIKeyError")) return credential === "subscription" ? "subscription" : "api_key"
  if (http === 403 || has("permission_error", "permission_denied", "access_denied", "forbidden", "provider_access_denied")) return "access_denied"
  if (http === 429 || has("rate_limit", "rate_limit_error", "rate_limit_exceeded", "too_many_requests", "resource_exhausted", "subscription_rate_limited") || /rate[ -]?limit|too many requests|requests per minute|tokens per minute/.test(text)) return "rate_limit"
  if (http === 408 || http === 504 || has("timeout", "timeout_error", "request_timeout", "subscription_timeout", "ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT") || names.some((name) => name === "TimeoutError" || name === "APIConnectionTimeoutError")) return "timeout"
  if (has("connection_error", "network_error", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_SOCKET") || names.some((name) => name === "APIConnectionError" || name === "NetworkError" || name === "FetchError")) return "network"
  if (http === 400 || http === 422 || has("invalid_request_error", "invalid_request", "bad_request", "provider_request_rejected")) return "invalid_request"
  if (http !== undefined || has("overloaded", "overloaded_error", "server_error", "internal_server_error", "api_error", "provider_error", "provider_temporarily_unavailable", "provider_operation_failed", "provider_route_unavailable", "subscription_generation_failed", "subscription_worker_unavailable", "backend_unavailable", "quota_unknown") || evidence.some((item) => item.message)) return "provider"
  if (has("reconnect_required", "pending_auth", "disconnected", "invalid_credential_bundle", "account_unavailable", "binding_required", "binding_mismatch", "stale_binding")) return "subscription"
  return "internal"
}
function causesFor(chain: unknown[]): CauseField[] {
  return chain.slice(0, 8).map((node) => {
    const name = string(own(node, "name"), 80)
    const legacy = coded(node)
    const rawCode = own(node, "code") ?? own(node, "type")
    const code = legacy?.code ?? knownCode(rawCode) ?? fixedRefusal(node) ?? (typeof rawCode === "number" && Number.isInteger(rawCode) && Math.abs(rawCode) <= 2147483647 ? rawCode : undefined)
    const detail = legacy?.detail
    return { name: name && nameSet.has(name) ? name : "Error", ...(code !== undefined ? { code } : {}), ...(detail && detailSet.has(detail) ? { detail } : {}) }
  })
}

/** Capture once at the provider boundary, then carry this same safe record through IPC/UI. */
export function captureRunFailure(error: unknown, context: RunFailureContext = {}): RunFailure {
  const chain = nodes(error)
  const existing = failureFrom(error) ?? readRunFailure(error)
  const sensitive = sensitiveTexts(chain, context)
  const contextProvider = provider(own(context, "provider"))
  const runId = runIdSchema.safeParse(own(context, "runId"))
  const appVersion = versionSchema.safeParse(own(context, "appVersion"))
  const occurredAt = dateSchema.safeParse(own(context, "occurredAt"))
  const identity = {
    runId: runId.success ? runId.data : existing?.runId ?? null,
    appVersion: appVersion.success ? appVersion.data : existing?.appVersion ?? "unknown",
    occurredAt: occurredAt.success ? occurredAt.data : existing?.occurredAt ?? new Date().toISOString(),
  }
  if (existing) {
    const { providerMessage: original, ...rest } = existing
    const providerMessage = redact(original, sensitive)
    return { ...rest, ...identity, ...(contextProvider ? { provider: contextProvider } : {}), ...(providerMessage ? { providerMessage } : {}) }
  }
  const evidence = chain.map((node) => evidenceFor(node, contextProvider))
  if (typeof error === "string" && fixedRefusal(error)) evidence.push({ code: fixedRefusal(error) })
  const category = classify(evidence, chain, own(context, "credential"))
  const legacy = chain.map(coded).find((value) => value !== null) ?? coded(error)
  const preservedCategory = legacy ? (Object.entries(categoryCode).find(([, code]) => code === legacy.code)?.[0] as RunFailure["category"] | undefined) : undefined
  const finalCategory = category === "internal"
    ? preservedCategory ?? (legacy?.code.startsWith("subscription_") ? "subscription" : category)
    : category
  // Preserve registered legacy codes/details when no more specific provider evidence exists.
  const code = category === "internal" && legacy ? legacy.code : categoryCode[finalCategory]
  const detail = code === legacy?.code ? legacy.detail : undefined
  const selected = evidence.findLast((item) => item.status !== undefined)
  const candidateMessage = selected?.message ?? evidence.findLast((item) => item.message)?.message
  const providerMessage = redact(candidateMessage, sensitive)
  const sourceProvider = contextProvider ?? evidence.findLast((item) => item.provider)?.provider
  const recovery = categoryRecovery[finalCategory]
  return {
    schemaVersion: 1, code, category: finalCategory,
    ...(detail ? { detail } : {}), ...(sourceProvider ? { provider: sourceProvider } : {}),
    ...(selected?.status !== undefined ? { status: selected.status } : {}),
    ...(providerMessage ? { providerMessage } : {}), causes: causesFor(chain) as RunFailure["causes"],
    ...(recovery ? { recovery } : {}), ...identity,
  }
}

/** Error.message contains only a registered code; provider prose stays in failureDetails. */
export class RunFailureError extends CodedError<UserErrorCode> {
  readonly failureDetails: RunFailure
  constructor(failure: RunFailure, options: { cause?: unknown } = {}) {
    const safe = readRunFailure(failure) ?? captureRunFailure(undefined)
    super(safe.code, { detail: safe.detail, cause: options.cause })
    this.name = "RunFailureError"
    this.failureDetails = safe
  }
}

/** Safe for logs: omit provider prose and causes, even when the input is malformed. */
export function compactRunFailure(failure: RunFailure | null): Omit<RunFailure, "providerMessage" | "causes"> | null {
  const safe = readRunFailure(failure)
  if (!safe) return null
  const { providerMessage: _message, causes: _causes, ...compact } = safe
  return compact
}
