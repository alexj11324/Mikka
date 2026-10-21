// Claude Code subscription windows from the oauth usage endpoint.
// Credential location and payload fields are adapted from codeburn (MIT),
// Copyright (c) 2026 AgentSeal. See packages/daemon/THIRD_PARTY_NOTICES.md.
// This reader never refreshes or writes the credential.
import type { QuotaSnapshot, QuotaVendor, QuotaWindow } from "@mikka/protocol"

import type { KeychainOutcome } from "./files"
import { sanitizeError } from "./files"
import {
  cleanText,
  isoString,
  parseJson,
  percentPoints,
  quotaGet,
} from "./parse"

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage"

export interface ClaudeCredentialMeta {
  subscriptionType?: string
  rateLimitTier?: string
}

interface ClaudeCredential extends ClaudeCredentialMeta {
  accessToken: string
  expiresAt?: number
}

export interface ClaudeReaderOptions {
  credentialPath: string
  platform: NodeJS.Platform
  fetch: typeof fetch
  now: () => number
  readFile: (path: string) => Promise<string | null>
  readKeychain: () => Promise<KeychainOutcome>
  signal?: AbortSignal
  log?: (detail: string) => void
}

export function parseClaudeCredential(raw: string): ClaudeCredential | null {
  const parsed = parseJson(raw.replace(/\r/g, ""))
  if (!parsed || typeof parsed !== "object") return null
  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
  if (!oauth || typeof oauth !== "object") return null
  const record = oauth as Record<string, unknown>
  if (
    typeof record.accessToken !== "string" ||
    record.accessToken.length === 0
  ) {
    return null
  }
  return {
    accessToken: record.accessToken,
    expiresAt:
      typeof record.expiresAt === "number" ? record.expiresAt : undefined,
    rateLimitTier:
      typeof record.rateLimitTier === "string"
        ? record.rateLimitTier
        : undefined,
    subscriptionType:
      typeof record.subscriptionType === "string"
        ? record.subscriptionType
        : undefined,
  }
}

export function claudePlanLabel(
  credential: ClaudeCredentialMeta
): string | null {
  const subscriptionType = credential.subscriptionType?.toLowerCase() ?? ""
  const tier = credential.rateLimitTier?.toLowerCase() ?? ""
  const hasMax20 =
    tier.includes("max_20x") ||
    tier.includes("max20x") ||
    tier.includes("max-20x")
  const hasMax = tier.includes("max")
  let label = "Subscription"
  if (
    subscriptionType === "team" ||
    (subscriptionType === "" && tier.includes("team"))
  ) {
    label = hasMax ? "Team Premium" : "Team"
  } else if (
    subscriptionType === "enterprise" ||
    (subscriptionType === "" && tier.includes("enterprise"))
  ) {
    label = hasMax ? "Enterprise Premium" : "Enterprise"
  } else if (subscriptionType === "max" || hasMax) {
    label = hasMax20 ? "Max 20x" : "Max 5x"
  } else if (subscriptionType === "pro" || tier.includes("pro")) {
    label = "Pro"
  }
  return cleanText(label)
}

function windowFrom(
  kind: QuotaWindow["kind"],
  value: unknown,
  model?: string
): QuotaWindow | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  const used = percentPoints(row.utilization ?? row.percent)
  if (used === null) return null
  const name = model ? cleanText(model) : null
  return {
    kind,
    used,
    resetsAt: isoString(row.resets_at),
    ...(name ? { model: name } : {}),
  }
}

export function decodeClaudeUsage(
  body: unknown,
  credential: ClaudeCredentialMeta
): { plan: string | null; windows: QuotaWindow[] } | null {
  const data =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const windows: QuotaWindow[] = []
  const five = windowFrom("five_hour", data.five_hour)
  const weekly = windowFrom("weekly", data.seven_day)
  const opus = windowFrom("weekly", data.seven_day_opus, "Opus")
  const sonnet = windowFrom("weekly", data.seven_day_sonnet, "Sonnet")
  for (const row of [five, weekly, opus, sonnet]) {
    if (row) windows.push(row)
  }
  const seen = new Set(
    windows
      .map((row) => row.model?.toLowerCase())
      .filter((model) => model !== undefined)
  )
  if (Array.isArray(data.limits)) {
    for (const item of data.limits) {
      if (!item || typeof item !== "object") continue
      const row = item as Record<string, unknown>
      const scope = row.scope as
        | { model?: { display_name?: unknown } }
        | undefined
      const display = scope?.model?.display_name
      if (row.kind !== "weekly_scoped" || typeof display !== "string") continue
      const name = cleanText(display)
      if (!name || seen.has(name.toLowerCase())) continue
      const window = windowFrom("weekly", row, name)
      if (!window) continue
      seen.add(name.toLowerCase())
      windows.push(window)
    }
  }
  if (windows.length === 0) return null
  return { plan: claudePlanLabel(credential), windows }
}

function unknown(vendor: QuotaVendor, observedAt: string): QuotaSnapshot {
  return {
    vendor,
    source: "local_credentials",
    status: "unknown",
    plan: null,
    windows: [],
    observedAt,
  }
}

async function loadCredential(
  options: ClaudeReaderOptions
): Promise<ClaudeCredential | null | "denied"> {
  let fromFile: string | null
  try {
    fromFile = await options.readFile(options.credentialPath)
  } catch (error) {
    options.log?.(sanitizeError(error))
    return "denied"
  }
  if (fromFile) {
    try {
      return parseClaudeCredential(fromFile)
    } catch (error) {
      options.log?.(sanitizeError(error))
      return "denied"
    }
  }
  if (options.platform !== "darwin") return null
  const outcome = await options.readKeychain()
  if (outcome.status === "accessDenied") return "denied"
  if (outcome.status !== "found") return null
  try {
    return parseClaudeCredential(outcome.value)
  } catch (error) {
    options.log?.(sanitizeError(error))
    return "denied"
  }
}

export async function readClaudeQuota(
  options: ClaudeReaderOptions
): Promise<QuotaSnapshot> {
  const observedAt = new Date(options.now()).toISOString()
  const fail = () => unknown("claude_code", observedAt)
  try {
    const loaded = await loadCredential(options)
    if (loaded === "denied" || !loaded) return fail()
    if (loaded.expiresAt !== undefined && loaded.expiresAt <= options.now())
      return fail()

    const headers = {
      Authorization: `Bearer ${loaded.accessToken}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.0",
    }
    let response = await quotaGet(
      ENDPOINT,
      headers,
      options.fetch,
      options.signal
    )
    if (response.status === 401) {
      const again = await loadCredential(options)
      if (
        again === "denied" ||
        !again ||
        again.accessToken === loaded.accessToken
      ) {
        return fail()
      }
      response = await quotaGet(
        ENDPOINT,
        { ...headers, Authorization: `Bearer ${again.accessToken}` },
        options.fetch,
        options.signal
      )
      if (!response.body) return fail()
      const decoded = decodeClaudeUsage(response.body, again)
      if (!decoded) return fail()
      return {
        vendor: "claude_code",
        source: "local_credentials",
        status: "ok",
        plan: decoded.plan,
        windows: decoded.windows,
        observedAt,
      }
    }
    if (!response.body) return fail()
    const decoded = decodeClaudeUsage(response.body, loaded)
    if (!decoded) return fail()
    return {
      vendor: "claude_code",
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
