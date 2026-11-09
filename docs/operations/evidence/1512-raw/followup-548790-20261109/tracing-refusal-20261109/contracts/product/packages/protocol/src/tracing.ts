import { causeFields } from "./coded-error.ts"

// Span privacy rules shared by the web server (lib/tracing/sanitize.ts) and
// the daemon (packages/daemon/src/tracing.ts). docs/operations/tracing.md, "Privacy".

const STRING_LIMIT = 256
const EMAIL = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[A-Za-z]{2,}/g
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const IPV6 = /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?\b/gi

/** Removes `?query` and `#hash` from any URL or path inside the string, then masks emails and IPs. */
export function scrubString(value: string): string {
  const scrubbed = value
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*|(?:^|(?<=\s))\/[^\s?#]*)[?#]\S*/gi, '$1')
    .replace(EMAIL, '[email]')
    .replace(IPV4, '[ip]')
    .replace(IPV6, '[ip]')
  return scrubbed.length > STRING_LIMIT ? scrubbed.slice(0, STRING_LIMIT) : scrubbed
}

const HOME_PATH = /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root|[A-Za-z]:\\Users\\[^\\\s]+)(?=[/\\\s]|$)[^\s]*/g

/** A string from the user's computer: `scrubString`, and any path under a home directory becomes `[home]`. */
export function scrubLocalString(value: string): string {
  return scrubString(value.replace(HOME_PATH, '[home]'))
}

/** Only identifiers become codes: a message, path or token never matches. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/i

export type ErrorAttributes = { "error.type": string; "mikka.error.code"?: string; "mikka.error.detail"?: string; "mikka.error.causes"?: string }

/**
 * A failed operation's error by name and code only, read from the error and
 * its cause chain (CodedError, a refusal with `code`). Never the message: it
 * can echo user input, stderr or a credential.
 */
export function safeErrorAttributes(error: unknown): ErrorAttributes {
  let chain: ReturnType<typeof causeFields>
  try {
    chain = causeFields(error)
  } catch {
    // Provider errors can expose throwing getters. Diagnostics must preserve
    // the original failure, never export or throw a new inspection error.
    return { "error.type": "unknown" }
  }
  const coded = chain.find(field => typeof field.code === "string" && CODE.test(field.code))
  return {
    "error.type": chain[0]?.name ?? "unknown",
    ...(coded ? { "mikka.error.code": String(coded.code) } : {}),
    ...(coded?.detail ? { "mikka.error.detail": coded.detail } : {}),
    ...(chain.length > 1 ? { "mikka.error.causes": chain.map(field => [field.name, field.code, field.detail].filter(value => value !== undefined).join(':')).join(' > ').slice(0, STRING_LIMIT) } : {}),
  }
}
