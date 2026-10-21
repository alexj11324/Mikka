// Codex subscription windows from the ChatGPT usage endpoint.
// Payload fields are adapted from codeburn (MIT), Copyright (c) 2026 AgentSeal.
// See packages/daemon/THIRD_PARTY_NOTICES.md.
// Unlike codeburn, this reader does not refresh tokens and does not write
// auth.json. A 401 only re-reads the file in case the user's own CLI rotated it.
import type {
  QuotaSnapshot,
  QuotaWindow,
  QuotaWindowKind,
} from "@mikka/protocol"

import { sanitizeError } from "./files"
import {
  cleanText,
  isoUnixSeconds,
  parseJson,
  percentPoints,
  quotaGet,
} from "./parse"

const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token"

export interface CodexAuth {
  accessToken: string
  accountId: string | null
}

export interface CodexReaderOptions {
  authPath: string
  fetch: typeof fetch
  now: () => number
  readFile: (path: string) => Promise<string | null>
  signal?: AbortSignal
  log?: (detail: string) => void
}

export function parseCodexAuth(raw: string): CodexAuth | null {
  const parsed = parseJson(raw)
  if (!parsed || typeof parsed !== "object") return null
  const doc = parsed as Record<string, unknown>
  if (doc.auth_mode !== "chatgpt") return null
  const tokens = doc.tokens
  if (!tokens || typeof tokens !== "object") return null
  const record = tokens as Record<string, unknown>
  if (
    typeof record.access_token !== "string" ||
    record.access_token.length === 0
  ) {
    return null
  }
  return {
    accessToken: record.access_token,
    accountId: typeof record.account_id === "string" ? record.account_id : null,
  }
}

export function codexWindowKind(seconds: number): QuotaWindowKind {
  if (seconds >= 18_000 && seconds < 19_000) return "five_hour"
  if (seconds >= 604_800 && seconds < 605_000) return "weekly"
  if (seconds >= 86_400 && seconds < 87_000) return "daily"
  if (seconds > 0 && seconds < 7_200) return "hourly"
  if (seconds >= 2_400_000 && seconds < 2_800_000) return "monthly"
  return "other"
}

const CODEX_PLANS: Record<string, string> = {
  plus: "Plus",
  pro: "Pro",
  pro_lite: "Pro Lite",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  free: "Free",
  go: "Go",
}

export function codexPlanLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[_-]usage[_-]based$/, "")
  return cleanText(CODEX_PLANS[key] ?? value.trim())
}

function windowFrom(value: unknown, model?: string): QuotaWindow | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const used = percentPoints(row.used_percent)
  if (used === null) return null
  const seconds =
    typeof row.limit_window_seconds === "number" ? row.limit_window_seconds : 0
  const name = model ? cleanText(model) : null
  return {
    kind: codexWindowKind(seconds),
    used,
    resetsAt: isoUnixSeconds(row.reset_at),
    ...(name ? { model: name } : {}),
  }
}

export function decodeCodexUsage(
  body: unknown
): { plan: string | null; windows: QuotaWindow[] } | null {
  const data =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const rateLimit =
    data.rate_limit && typeof data.rate_limit === "object"
      ? (data.rate_limit as Record<string, unknown>)
      : {}
  const windows: QuotaWindow[] = []
  for (const key of ["primary_window", "secondary_window"]) {
    const window = windowFrom(rateLimit[key])
    if (window) windows.push(window)
  }
  if (Array.isArray(data.additional_rate_limits)) {
    for (const additional of data.additional_rate_limits) {
      if (!additional || typeof additional !== "object") continue
      const row = additional as Record<string, unknown>
      const name = typeof row.limit_name === "string" ? row.limit_name : ""
      const limits =
        row.rate_limit && typeof row.rate_limit === "object"
          ? (row.rate_limit as Record<string, unknown>)
          : {}
      for (const key of ["primary_window", "secondary_window"]) {
        const window = windowFrom(limits[key], name)
        if (window) windows.push(window)
      }
    }
  }
  if (windows.length === 0) return null
  return { plan: codexPlanLabel(data.plan_type), windows }
}

function safeAccountId(accountId: string | null): string | null {
  if (!accountId || !/^[A-Za-z0-9_-]{1,128}$/.test(accountId)) return null
  return accountId
}

function headersFor(auth: CodexAuth): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    "User-Agent": "mikka-daemon",
  }
  const accountId = safeAccountId(auth.accountId)
  if (accountId) headers["ChatGPT-Account-Id"] = accountId
  return headers
}

async function loadAuth(
  options: CodexReaderOptions
): Promise<CodexAuth | null | "denied"> {
  let raw: string | null
  try {
    raw = await options.readFile(options.authPath)
  } catch (error) {
    options.log?.(sanitizeError(error))
    return "denied"
  }
  if (!raw) return null
  try {
    return parseCodexAuth(raw)
  } catch (error) {
    options.log?.(sanitizeError(error))
    return "denied"
  }
}

export async function readCodexQuota(
  options: CodexReaderOptions
): Promise<QuotaSnapshot> {
  const observedAt = new Date(options.now()).toISOString()
  const fail = (): QuotaSnapshot => ({
    vendor: "codex",
    source: "local_credentials",
    status: "unknown",
    plan: null,
    windows: [],
    observedAt,
  })
  try {
    const loaded = await loadAuth(options)
    if (loaded === "denied" || !loaded) return fail()
    let response = await quotaGet(
      ENDPOINT,
      headersFor(loaded),
      options.fetch,
      options.signal
    )
    if (response.status === 401) {
      const again = await loadAuth(options)
      if (
        again === "denied" ||
        !again ||
        again.accessToken === loaded.accessToken
      ) {
        return fail()
      }
      response = await quotaGet(
        ENDPOINT,
        headersFor(again),
        options.fetch,
        options.signal
      )
    }
    if (!response.body) return fail()
    const decoded = decodeCodexUsage(response.body)
    if (!decoded) return fail()
    return {
      vendor: "codex",
      source: "local_credentials",
      status: "ok",
      plan: decoded.plan,
      windows: decoded.windows,
      observedAt,
    }
  } catch (error) {
    if (!options.signal?.aborted) options.log?.(sanitizeError(error))
    return fail()
  }
}

/** Guard for tests: the refresh endpoint must never be requested. */
export function isCodexTokenEndpoint(url: string): boolean {
  return url === TOKEN_ENDPOINT || url.startsWith(`${TOKEN_ENDPOINT}?`)
}
