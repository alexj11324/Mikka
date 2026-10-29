import type { QuotaSnapshot } from "@mikka/protocol"
import { decodeCodexUsage } from "./quota/codex"
import { decodeClaudeUsage } from "./quota/claude"

// Reuse quota decoding, without local auth files or CLI identity headers.
export function readSubscriptionQuota(provider: "codex" | "claude", response: {status: number; body: unknown}): QuotaSnapshot {
  const result: QuotaSnapshot = { vendor: provider === "codex" ? "codex" : "claude_code", source: "official", status: "unknown", windows: [], plan: null, observedAt: new Date().toISOString() }
  try {
    // A native OAuth mode alone does not prove provider-side credit/extra-usage
    // fallback is disabled. Unknown evidence must not authorize spending.
    const body = response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : {}
    const billing = body[provider === 'codex' ? 'credits' : 'extra_usage']
    if (!billing || typeof billing !== 'object') return result
    const controls = billing as Record<string, unknown>
    if (provider === 'codex' ? controls.has_credits !== false || controls.unlimited !== false : controls.is_enabled !== false) return result
    const decoded = provider === "codex" ? decodeCodexUsage(response.body) : decodeClaudeUsage(response.body, {})
    if (response.status === 200 && decoded) return { ...result, ...decoded, status: "ok" }
  } catch { /* Unknown is fail-closed; no refresh, retry or alternative account. */ }
  return result
}
