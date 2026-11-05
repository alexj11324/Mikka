import { causeFields } from "./coded-error"

// Span attributes shared by the web server (lib/tracing) and the daemon
// (packages/daemon/src/tracing.ts). docs/operations/tracing.md, "Errors".

/** Only identifiers become codes: a message, path or token never matches. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/i

export type ErrorAttributes = { "error.type": string; "mikka.error.code"?: string; "mikka.error.detail"?: string }

/**
 * A failed operation's error by name and code only, read from the error and
 * its cause chain (CodedError, a refusal with `code`). Never the message: it
 * can echo user input, stderr or a credential.
 */
export function safeErrorAttributes(error: unknown): ErrorAttributes {
  const chain = causeFields(error)
  const coded = chain.find(field => typeof field.code === "string" && CODE.test(field.code))
  return {
    "error.type": chain[0]?.name ?? "unknown",
    ...(coded ? { "mikka.error.code": String(coded.code) } : {}),
    ...(coded?.detail ? { "mikka.error.detail": coded.detail } : {}),
  }
}
