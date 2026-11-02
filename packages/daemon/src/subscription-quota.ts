import type { QuotaSnapshot } from "@mikka/protocol"
import { decodeCodexUsage } from "./quota/codex"
import { decodeClaudeUsage } from "./quota/claude"

// Reuse quota decoding, without local auth files or CLI identity headers.
export function readSubscriptionQuota(provider: "codex" | "claude", response: {status: number; body: unknown}): QuotaSnapshot {
  const result: QuotaSnapshot = { vendor: provider === "codex" ? "codex" : "claude_code", source: "official", status: "unknown", windows: [], plan: null, observedAt: new Date().toISOString() }
  try {
    // Credits and extra usage are account billing preferences, not evidence
    // that the subscription allowance is unavailable. Read the plan's meter.
    const decoded = provider === "codex" ? decodeCodexUsage(response.body) : decodeClaudeUsage(response.body, {})
    if (response.status === 200 && decoded) return { ...result, ...decoded, status: "ok" }
  } catch { /* Unknown is fail-closed; no refresh, retry or alternative account. */ }
  return result
}
