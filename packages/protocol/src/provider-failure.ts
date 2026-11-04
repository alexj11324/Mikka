// A daemon-observed model-provider failure, separate from an agent's code or
// tool failure. Only fixed classes and an HTTP status cross the run boundary;
// upstream messages, response bodies, headers and credentials never do.
import { z } from "zod"

const BALANCE_CODES = [
  "payment_required", "insufficient_balance", "insufficient_quota", "billing_hard_limit", "billing_error",
] as const
const AUTH_CODES = ["authentication_failed", "invalid_api_key"] as const
const UNAVAILABLE_CODES = ["rate_limit", "overloaded", "server_error", "timeout", "connection_error"] as const
export const PROVIDER_FAILURE_CODES = [...BALANCE_CODES, ...AUTH_CODES, ...UNAVAILABLE_CODES] as const
export type ProviderFailureCode = typeof PROVIDER_FAILURE_CODES[number]

const status = z.number().int().min(100).max(599).optional()
export const providerFailureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("balance"), retryable: z.literal(false), status, code: z.enum(BALANCE_CODES).optional() }).strict(),
  z.object({ kind: z.literal("auth"), retryable: z.literal(false), status, code: z.enum(AUTH_CODES).optional() }).strict(),
  z.object({ kind: z.literal("unavailable"), retryable: z.literal(true), status, code: z.enum(UNAVAILABLE_CODES).optional() }).strict(),
])
export type ProviderFailure = z.infer<typeof providerFailureSchema>

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value : undefined
}

/** SDKs may carry the structured API response as a JSON string. */
function responseBody(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return record(value)
  if (value.length > 64_000) return undefined
  try { return record(JSON.parse(value)) } catch { return undefined }
}

const BALANCE_ALIASES: Readonly<Record<string, typeof BALANCE_CODES[number]>> = {
  payment_required: "payment_required",
  insufficient_balance: "insufficient_balance",
  insufficient_quota: "insufficient_quota",
  billing_hard_limit: "billing_hard_limit",
  billing_hard_limit_reached: "billing_hard_limit",
  billing_error: "billing_error",
}
const AUTH_ALIASES: Readonly<Record<string, typeof AUTH_CODES[number]>> = {
  authentication_failed: "authentication_failed",
  authentication_error: "authentication_failed",
  authenticationerror: "authentication_failed",
  unauthorized: "authentication_failed",
  invalid_api_key: "invalid_api_key",
  invalid_authentication: "authentication_failed",
}
const UNAVAILABLE_ALIASES: Readonly<Record<string, typeof UNAVAILABLE_CODES[number]>> = {
  rate_limit: "rate_limit", rate_limit_error: "rate_limit", rate_limit_exceeded: "rate_limit", ratelimiterror: "rate_limit",
  overloaded: "overloaded", overloaded_error: "overloaded",
  server_error: "server_error", internal_server_error: "server_error", internalservererror: "server_error",
  timeout: "timeout", request_timeout: "timeout", etimedout: "timeout",
  apiconnectiontimeouterror: "timeout", apitimeouterror: "timeout",
  connection_error: "connection_error", apiconnectionerror: "connection_error",
  econnreset: "connection_error", econnrefused: "connection_error", enotfound: "connection_error", eai_again: "connection_error",
}

/**
 * Call only at a known model-provider error boundary, after SDK retries have
 * ended. This deliberately never searches free-form messages, tool output or
 * a run's generic error/cause chain. A bare 403 can be a model/policy refusal;
 * it needs an explicit authentication code before disabling a credential.
 */
export function classifyProviderFailure(error: unknown): ProviderFailure | undefined {
  const value = record(error)
  if (!value) return undefined
  const body = responseBody(value.responseBody)
  const details = [record(value.error), record(body?.error), body, value].filter((item): item is Record<string, unknown> => Boolean(item))
  const codes = details.flatMap(item => [item.code, item.type, item.name, item.error])
    .filter((code): code is string => typeof code === "string").map(code => code.toLowerCase())
  const foundStatus = [value.status, value.statusCode, value.api_error_status, ...details.flatMap(item => [item.status, item.statusCode])]
    .map(httpStatus).find(code => code !== undefined)
  const statusField = foundStatus === undefined ? {} : { status: foundStatus }
  for (const code of codes) if (Object.hasOwn(BALANCE_ALIASES, code))
    return { kind: "balance", retryable: false, ...statusField, code: BALANCE_ALIASES[code] }
  if (foundStatus === 402) return { kind: "balance", retryable: false, ...statusField, code: "payment_required" }
  for (const code of codes) if (Object.hasOwn(AUTH_ALIASES, code))
    return { kind: "auth", retryable: false, ...statusField, code: AUTH_ALIASES[code] }
  if (foundStatus === 401) return { kind: "auth", retryable: false, ...statusField, code: "authentication_failed" }
  if (foundStatus === 429) return { kind: "unavailable", retryable: true, ...statusField, code: "rate_limit" }
  if (foundStatus === 529) return { kind: "unavailable", retryable: true, ...statusField, code: "overloaded" }
  if (foundStatus !== undefined && foundStatus >= 500 && foundStatus <= 599)
    return { kind: "unavailable", retryable: true, ...statusField, code: "server_error" }
  if (foundStatus === 408) return { kind: "unavailable", retryable: true, ...statusField, code: "timeout" }
  // A concrete unrelated HTTP refusal wins over a generic connection label.
  if (foundStatus !== undefined) return undefined
  for (const code of codes) if (Object.hasOwn(UNAVAILABLE_ALIASES, code))
    return { kind: "unavailable", retryable: true, code: UNAVAILABLE_ALIASES[code] }
  return undefined
}

/** A startup failure already classified by the adapter, never by the model. */
export class ProviderFailureError extends Error {
  readonly providerFailure: ProviderFailure
  constructor(failure: ProviderFailure) {
    const safe = providerFailureSchema.parse(failure)
    super(providerFailureMessage(safe))
    this.name = "ProviderFailureError"
    this.providerFailure = safe
  }
}

/** Fixed owner-facing diagnostic for a provider error; no upstream text. */
export function providerFailureMessage(failure: ProviderFailure): string {
  return `Model provider failed (${failure.kind}${failure.code ? `: ${failure.code}` : ""}${failure.status === undefined ? "" : `; HTTP ${failure.status}`})`
}
