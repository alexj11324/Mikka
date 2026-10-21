// Subscription quota the daemon reads on the device and reports onward.
// Numbers only: a snapshot must never carry a vendor token, cookie, or
// account id (ADR 0027).
import { z } from "zod"

export const QUOTA_VENDORS = ["claude_code", "codex", "cursor"] as const
export const quotaVendorSchema = z.enum(QUOTA_VENDORS)
export type QuotaVendor = z.infer<typeof quotaVendorSchema>

/** `official` is reserved for Claude `/usage` and Codex app-server events. */
export const QUOTA_SOURCES = ["local_credentials", "official"] as const
export const quotaSourceSchema = z.enum(QUOTA_SOURCES)
export type QuotaSourceId = z.infer<typeof quotaSourceSchema>

export const QUOTA_WINDOW_KINDS = [
  "five_hour",
  "weekly",
  "monthly",
  "daily",
  "hourly",
  "other",
] as const
export const quotaWindowKindSchema = z.enum(QUOTA_WINDOW_KINDS)
export type QuotaWindowKind = z.infer<typeof quotaWindowKindSchema>

export const QUOTA_METERS = [
  "auto",
  "api",
  "on_demand",
  "team_pool",
  "team_on_demand",
] as const
export const quotaMeterSchema = z.enum(QUOTA_METERS)
export type QuotaMeter = z.infer<typeof quotaMeterSchema>

/** Used fraction at or above this is "almost at the limit". */
export const QUOTA_NEAR_LIMIT = 0.8

export const quotaWindowSchema = z.object({
  kind: quotaWindowKindSchema,
  /** 0..1 share of the window already used. */
  used: z.number().min(0).max(1),
  resetsAt: z.string().nullable(),
  /** Model display name for a per-model window, e.g. "Opus". */
  model: z.string().min(1).max(40).optional(),
  meter: quotaMeterSchema.optional(),
})
export type QuotaWindow = z.infer<typeof quotaWindowSchema>

export const quotaSnapshotSchema = z.object({
  vendor: quotaVendorSchema,
  source: quotaSourceSchema,
  status: z.enum(["ok", "unknown"]),
  plan: z.string().max(40).nullable(),
  windows: z.array(quotaWindowSchema).max(12),
  /** When this vendor was last read (ISO-8601). */
  observedAt: z.string(),
})
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>

export const quotaSnapshotReportSchema = z.object({
  /** When the whole read finished. Null before the first read. */
  observedAt: z.string().nullable(),
  quotas: z.array(quotaSnapshotSchema).max(6),
})
export type QuotaSnapshotReport = z.infer<typeof quotaSnapshotReportSchema>

export function unknownSnapshot(
  vendor: QuotaVendor,
  observedAt: string
): QuotaSnapshot {
  return {
    vendor,
    source: "local_credentials",
    status: "unknown",
    plan: null,
    windows: [],
    observedAt,
  }
}

/** Three unknown rows, in vendor order. `observedAt` is null until a read finishes. */
export function unknownQuotaReport(
  now = new Date().toISOString()
): QuotaSnapshotReport {
  return {
    observedAt: null,
    quotas: QUOTA_VENDORS.map((vendor) => unknownSnapshot(vendor, now)),
  }
}

/** Fills any vendor the payload omitted so the UI always has three rows. */
export function normalizeQuotaReport(
  report: QuotaSnapshotReport,
  now = new Date().toISOString()
): QuotaSnapshotReport {
  const byVendor = new Map(report.quotas.map((quota) => [quota.vendor, quota]))
  return {
    observedAt: report.observedAt,
    quotas: QUOTA_VENDORS.map(
      (vendor) =>
        byVendor.get(vendor) ??
        unknownSnapshot(vendor, report.observedAt ?? now)
    ),
  }
}

export type UsageLevel = "ok" | "near_limit" | "exhausted"

export function usageLevel(used: number): UsageLevel {
  if (used >= 1) return "exhausted"
  if (used >= QUOTA_NEAR_LIMIT) return "near_limit"
  return "ok"
}
