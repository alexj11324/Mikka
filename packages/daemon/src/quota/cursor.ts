// Cursor subscription meters from the app's usage-summary endpoint.
// Credential location and payload fields are adapted from codeburn (MIT),
// Copyright (c) 2026 AgentSeal. See packages/daemon/THIRD_PARTY_NOTICES.md.
// The state database is opened read-only. The session is never refreshed.
import { lstat } from "node:fs/promises"
import { join } from "node:path"

import type { QuotaMeter, QuotaSnapshot, QuotaWindow } from "@mikka/protocol"

import { sanitizeError } from "./files"
import { cleanText, isoString, percentPoints, quotaGet, ratio } from "./parse"

const ENDPOINT = "https://cursor.com/api/usage-summary"
const ACCESS_TOKEN_KEY = "cursorAuth/accessToken"

export function cursorDatabasePath(
  platform: NodeJS.Platform,
  home: string
): string {
  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb"
    )
  }
  if (platform === "win32") {
    return join(
      home,
      "AppData",
      "Roaming",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb"
    )
  }
  return join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb")
}

const CURSOR_PLANS: Record<string, string> = {
  pro: "Pro",
  pro_plus: "Pro Plus",
  "pro plus": "Pro Plus",
  business: "Business",
  enterprise: "Enterprise",
  hobby: "Hobby",
  free: "Hobby",
  ultra: "Ultra",
}

export function cursorPlanLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const raw = value.trim()
  return cleanText(CURSOR_PLANS[raw.toLowerCase()] ?? raw)
}

function blobToText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (value instanceof Uint8Array) {
    const trimmed = Buffer.from(value).toString("utf8").trim()
    return trimmed.length > 0 ? trimmed : null
  }
  return null
}

export async function readCursorAccessToken(
  databasePath: string
): Promise<string | null> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(databasePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("Refusing Cursor state database")
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 1_500 })
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1")
      .get(ACCESS_TOKEN_KEY) as { value?: unknown } | undefined
    return blobToText(row?.value)
  } finally {
    db.close()
  }
}

function decodeBase64Url(value: string): string | null {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
  try {
    return Buffer.from(padded, "base64").toString("utf8")
  } catch {
    return null
  }
}

export function cursorSessionCookie(token: string, now: number): string | null {
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return null
  const payload = decodeBase64Url(parts[1])
  if (payload === null) return null
  let claims: { sub?: unknown; exp?: unknown }
  try {
    claims = JSON.parse(payload) as { sub?: unknown; exp?: unknown }
  } catch {
    return null
  }
  if (typeof claims.sub !== "string") return null
  const userId = claims.sub
    .split("|")
    .filter((part) => part.length > 0)
    .pop()
  if (!userId || !/^[A-Za-z0-9._-]+$/.test(userId)) return null
  const exp =
    typeof claims.exp === "number" && Number.isFinite(claims.exp)
      ? claims.exp
      : null
  if (exp === null || exp * 1000 - now <= 60_000) return null
  return `WorkosCursorSessionToken=${userId}%3A%3A${token}`
}

function meterWindow(
  meter: QuotaMeter,
  used: number | null,
  resetsAt: string | null
): QuotaWindow | null {
  if (used === null) return null
  return { kind: "other", used, resetsAt, meter }
}

export function decodeCursorUsage(
  body: unknown
): { plan: string | null; windows: QuotaWindow[] } | null {
  const data =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const individual =
    data.individualUsage && typeof data.individualUsage === "object"
      ? (data.individualUsage as Record<string, unknown>)
      : {}
  const plan =
    individual.plan && typeof individual.plan === "object"
      ? (individual.plan as Record<string, unknown>)
      : {}
  const overall =
    individual.overall && typeof individual.overall === "object"
      ? (individual.overall as Record<string, unknown>)
      : {}
  const onDemand =
    individual.onDemand && typeof individual.onDemand === "object"
      ? (individual.onDemand as Record<string, unknown>)
      : null
  const team =
    data.teamUsage && typeof data.teamUsage === "object"
      ? (data.teamUsage as Record<string, unknown>)
      : {}
  const pooled =
    team.pooled && typeof team.pooled === "object"
      ? (team.pooled as Record<string, unknown>)
      : null
  const teamOnDemand =
    team.onDemand && typeof team.onDemand === "object"
      ? (team.onDemand as Record<string, unknown>)
      : null

  const auto = percentPoints(plan.autoPercentUsed)
  const api = percentPoints(plan.apiPercentUsed)
  const monthly =
    percentPoints(plan.totalPercentUsed) ??
    (auto !== null && api !== null ? Math.max(auto, api) : (api ?? auto)) ??
    ratio(plan.used, plan.limit) ??
    ratio(overall.used, overall.limit) ??
    ratio(pooled?.used, pooled?.limit) ??
    (data.isUnlimited === true ? 0 : null)
  const teamOnDemandUsed =
    teamOnDemand?.enabled === false
      ? null
      : ratio(teamOnDemand?.used, teamOnDemand?.limit)
  const primary = monthly ?? teamOnDemandUsed
  if (primary === null) return null

  const resetsAt = isoString(data.billingCycleEnd)
  const windows: QuotaWindow[] = []
  if (monthly !== null)
    windows.push({ kind: "monthly", used: monthly, resetsAt })
  else if (teamOnDemandUsed !== null) {
    windows.push({
      kind: "other",
      used: teamOnDemandUsed,
      resetsAt,
      meter: "team_on_demand",
    })
  }
  const autoWindow = meterWindow("auto", auto, resetsAt)
  const apiWindow = meterWindow("api", api, resetsAt)
  if (autoWindow) windows.push(autoWindow)
  if (apiWindow) windows.push(apiWindow)
  const onDemandUsed =
    onDemand?.enabled === false ? null : ratio(onDemand?.used, onDemand?.limit)
  const onDemandWindow = meterWindow("on_demand", onDemandUsed, resetsAt)
  if (onDemandWindow) windows.push(onDemandWindow)
  const teamUsed = ratio(pooled?.used, pooled?.limit)
  const teamWindow = meterWindow("team_pool", teamUsed, resetsAt)
  if (teamWindow) windows.push(teamWindow)
  if (monthly !== null && teamOnDemandUsed !== null) {
    windows.push({
      kind: "other",
      used: teamOnDemandUsed,
      resetsAt,
      meter: "team_on_demand",
    })
  }
  return { plan: cursorPlanLabel(data.membershipType), windows }
}

export interface CursorReaderOptions {
  databasePath: string
  fetch: typeof fetch
  now: () => number
  loadAccessToken?: (databasePath: string) => Promise<string | null>
  signal?: AbortSignal
  log?: (detail: string) => void
}

export async function readCursorQuota(
  options: CursorReaderOptions
): Promise<QuotaSnapshot> {
  const observedAt = new Date(options.now()).toISOString()
  const fail = (): QuotaSnapshot => ({
    vendor: "cursor",
    source: "local_credentials",
    status: "unknown",
    plan: null,
    windows: [],
    observedAt,
  })
  try {
    const load = options.loadAccessToken ?? readCursorAccessToken
    const token = (await load(options.databasePath))?.trim() || null
    if (!token) return fail()
    const cookie = cursorSessionCookie(token, options.now())
    if (!cookie) return fail()
    const response = await quotaGet(
      ENDPOINT,
      {
        Accept: "application/json",
        Cookie: cookie,
        "User-Agent": "mikka-daemon",
      },
      options.fetch,
      options.signal
    )
    if (!response.body) return fail()
    const decoded = decodeCursorUsage(response.body)
    if (!decoded) return fail()
    return {
      vendor: "cursor",
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
