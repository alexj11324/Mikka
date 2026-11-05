// An error with a stable code for the UI, a detail from a closed set saying
// which precondition failed, and the original error kept as `cause`
// (decision docs/design/decisions/2026-11-05-0330-error-causes.md).
//
// The message is the code, or `code (detail)` when there is a detail, the same
// shape the run's stored error already uses ("… (child_exit: cli_exited_early)").
// The UI reads it back with parseCodedErrorText and shows the copy for it from
// messages/*.json; the raw code goes only into the details area.

export interface CodedErrorOptions<D extends string = string> {
  /** Which precondition failed, from the code's closed set. */
  detail?: D
  /** The error that caused this one. Kept, never shown; logged by name and code only. */
  cause?: unknown
}

const IDENT = /^[a-z][a-z0-9_]*$/

export class CodedError<C extends string = string, D extends string = string> extends Error {
  readonly code: C
  readonly detail?: D
  constructor(code: C, options: CodedErrorOptions<D> = {}) {
    super(options.detail ? `${code} (${options.detail})` : code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "CodedError"
    this.code = code
    if (options.detail) this.detail = options.detail
  }
}

/** The first coded error with this code in the error and its cause chain. */
export function findCodedError(error: unknown, code: string, depth = 6): CodedError | undefined {
  for (let value = error, i = 0; value instanceof Error && i < depth; i++, value = value.cause)
    if (value instanceof CodedError && value.code === code) return value
  return undefined
}

/** The stored text of a coded error read back: `code` or `code (detail)`; null for any other text. */
export function parseCodedErrorText(text: string | null | undefined): { code: string; detail: string | null } | null {
  const line = text?.trim()
  if (!line) return null
  const match = /^([a-z][a-z0-9_]*)(?: \(([a-z][a-z0-9_]*)\))?$/.exec(line)
  return match ? { code: match[1], detail: match[2] ?? null } : null
}

export interface CauseField {
  name: string
  code?: string | number
  detail?: string
}

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * The cause chain by name and code only, outermost first. Never the message:
 * it can carry stderr, a response body or a credential.
 */
export function causeFields(cause: unknown, depth = 4): CauseField[] {
  const out: CauseField[] = []
  for (let value = cause, i = 0; value !== undefined && value !== null && i < depth; i++) {
    if (typeof value !== "object") { out.push({ name: typeof value }); break }
    const record = value as { name?: unknown; code?: unknown; detail?: unknown; cause?: unknown; constructor?: { name?: unknown } }
    const name = typeof record.name === "string" && SAFE_CODE.test(record.name) ? record.name
      : typeof record.constructor?.name === "string" && SAFE_CODE.test(record.constructor.name) ? record.constructor.name : "unknown"
    const field: CauseField = { name }
    if ((typeof record.code === "string" && SAFE_CODE.test(record.code)) || (typeof record.code === "number" && Number.isFinite(record.code))) field.code = record.code as string | number
    if (typeof record.detail === "string" && IDENT.test(record.detail)) field.detail = record.detail
    out.push(field)
    if (value instanceof AggregateError) {
      for (const inner of value.errors.slice(0, 3)) out.push(...causeFields(inner, 1).map(item => ({ ...item, name: `aggregate:${item.name}` })))
    }
    value = record.cause
  }
  return out
}

export interface CodedErrorLog {
  warn(fields: Record<string, unknown>, message?: string): void
}

/** A JSON line on stderr, the shape the web's request log uses; for code without a logger. */
export const consoleCodedErrorLog: CodedErrorLog = {
  warn(fields, message) {
    console.warn(JSON.stringify({ level: "warn", msg: message ?? "coded_error", ...fields }))
  },
}

/**
 * One structured line for a coded error: its code, detail and the cause chain
 * by name and code. `fields` must be identifiers (run id, harness), never
 * free text.
 */
export function logCodedError(error: CodedError, fields: Record<string, string | number | boolean | undefined> = {}, log: CodedErrorLog = consoleCodedErrorLog) {
  try {
    log.warn({ event: "coded_error", code: error.code, ...(error.detail ? { detail: error.detail } : {}), causes: causeFields(error.cause), ...fields }, error.code)
  } catch { /* Logging never replaces the error itself. */ }
}
