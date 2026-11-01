// A subscription's quota or rate limit running out mid-run (stop reason
// `quota_exhausted`). The adapters read the CLI's own failure into a
// `QuotaSignal`; the supervisor turns it into the stop reason only for a run
// on a subscription (a hosted binding or the device's own CLI login). A run
// already on an API key that hits a rate limit fails as an ordinary error.
// Pure: no I/O, so each CLI shape is unit-tested on fixture output.
import type { RunAssignment } from "@mikka/protocol"

/** The CLI said the quota ran out; `resetsAt` is when, if it said. */
export interface QuotaSignal {
  resetsAt: string | null
}

const QUOTA_TEXT = /usage limit|hit your (?:usage )?limit|limit reached|rate limit|quota|too many requests|\b429\b/i

const fromEpochSeconds = (value: unknown): string | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : null

/** Keeps the signal that knows when the quota resets. */
export function mergeQuota(previous: QuotaSignal | undefined, next: QuotaSignal | null): QuotaSignal | undefined {
  if (!next) return previous
  return previous?.resetsAt && !next.resetsAt ? previous : next
}

/** "Claude AI usage limit reached|1762016400": the reset as Unix seconds after the bar. */
function claudeResetFromText(text: string): string | null {
  const match = /\|\s*(\d{10})\b/.exec(text)
  return match ? fromEpochSeconds(Number(match[1])) : null
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")
    .join("\n")
}

/**
 * One Claude Agent SDK message: a rejected `rate_limit_event` (with the
 * window's reset), an assistant message the CLI marked `rate_limit`, or an
 * error result whose text says the usage limit was reached.
 */
export function claudeQuotaSignal(message: unknown): QuotaSignal | null {
  if (!message || typeof message !== "object") return null
  const value = message as Record<string, unknown>
  if (value.type === "rate_limit_event") {
    const info = value.rate_limit_info as Record<string, unknown> | undefined
    if (info?.status !== "rejected") return null
    return { resetsAt: fromEpochSeconds(info.resetsAt) ?? fromEpochSeconds(info.overageResetsAt) }
  }
  if (value.type === "assistant" && value.error === "rate_limit") {
    const text = textOf((value.message as { content?: unknown } | undefined)?.content)
    return { resetsAt: claudeResetFromText(text) }
  }
  if (value.type === "result" && value.is_error === true) {
    const text = [typeof value.result === "string" ? value.result : "", ...(Array.isArray(value.errors) ? value.errors.map(String) : [])].join("\n")
    if (!/usage limit|hit your (?:usage )?limit|limit reached/i.test(text)) return null
    return { resetsAt: claudeResetFromText(text) }
  }
  return null
}

const UNIT_MS: Record<string, number> = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1_000 }

/** "try again in 2 days 3 hours 5 minutes" / "try again at 4:05 PM" / "try again at Nov 2nd, 2026 4:05 PM". */
function codexResetFromText(text: string, now: number): string | null {
  const within = /try again in ([^.]+)/i.exec(text)
  if (within) {
    let total = 0
    for (const part of within[1].matchAll(/(\d+)\s*(day|hour|minute|second)s?/gi)) total += Number(part[1]) * UNIT_MS[part[2].toLowerCase()]
    return total > 0 ? new Date(now + total).toISOString() : null
  }
  const at = /try again at ([^.]+)/i.exec(text)?.[1]?.trim()
  if (!at) return null
  const clock = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(at)
  if (clock) {
    let hours = Number(clock[1]) % (clock[3] ? 12 : 24)
    if (clock[3]?.toUpperCase() === "PM") hours += 12
    const day = new Date(now)
    day.setHours(hours, Number(clock[2]), 0, 0)
    if (day.getTime() <= now) day.setDate(day.getDate() + 1)
    return day.toISOString()
  }
  const parsed = Date.parse(at.replace(/(\d)(st|nd|rd|th)\b/gi, "$1"))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** Codex's `codexErrorInfo`: the usage limit, or a request that kept getting 429. */
function codexInfoIsQuota(info: unknown): boolean {
  if (info === "usageLimitExceeded") return true
  if (!info || typeof info !== "object") return false
  return Object.values(info as Record<string, unknown>).some(detail =>
    Boolean(detail && typeof detail === "object" && (detail as { httpStatusCode?: unknown }).httpStatusCode === 429))
}

/** The latest `account/rateLimits/updated`: a window used up gives its reset. */
export interface CodexRateLimits {
  primary?: { usedPercent?: number; resetsAt?: number | null } | null
  secondary?: { usedPercent?: number; resetsAt?: number | null } | null
}

function codexResetFromLimits(limits: CodexRateLimits | undefined): string | null {
  const full = [limits?.primary, limits?.secondary].filter(window => window && (window.usedPercent ?? 0) >= 100)
  const resets = full.map(window => fromEpochSeconds(window?.resetsAt)).filter((value): value is string => Boolean(value))
  return resets.sort().at(-1) ?? null
}

/**
 * A Codex app-server turn error (an `error` notification that will not be
 * retried, or a failed turn's `error`): its `codexErrorInfo` or its message
 * says the usage limit or rate limit was hit.
 */
export function codexQuotaSignal(error: { message?: unknown; codexErrorInfo?: unknown } | null | undefined, limits?: CodexRateLimits, now = Date.now()): QuotaSignal | null {
  if (!error) return null
  const message = typeof error.message === "string" ? error.message : ""
  if (!codexInfoIsQuota(error.codexErrorInfo) && !QUOTA_TEXT.test(message)) return null
  return { resetsAt: codexResetFromText(message, now) ?? codexResetFromLimits(limits) }
}

/**
 * Whether a run's quota failure is `quota_exhausted`: only on a subscription,
 * which is a hosted `subscriptionBinding` or, with no credential at all, the
 * device's own CLI login. A run handed an API key is never switched.
 */
export function quotaStopApplies(assignment: Pick<RunAssignment, "modelCredential">): boolean {
  return !assignment.modelCredential
}
