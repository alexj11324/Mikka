import type { QuotaWindow } from '@mikka/protocol'
import { codexPlanLabel, decodeCodexUsage } from '../packages/daemon/src/quota/codex'
import { decodeClaudeUsage } from '../packages/daemon/src/quota/claude'

export interface UsageWindow { kind: 'five_hour' | 'weekly'; remaining: number; resetsAt: string | null; model?: string }

/** One connected subscription as its owner's Settings row shows it. Numbers,
 * a plan label and the sign-in email only; never a token or account id.
 * - `extra_usage`: the provider would bill past the plan (Codex credits, Claude
 *   extra usage), so the runtime refuses it (`quota_unknown`, fail closed).
 * - `unverified`: the answer did not say whether that is off; refused too.
 * - `reauth`: the provider refused this read (401/403). Reported for this read
 *   only; the connection itself is untouched.
 * - `unavailable`: the read failed for now; try again. */
export interface SubscriptionUsage {
  id: string
  status: 'ok' | 'extra_usage' | 'unverified' | 'reauth' | 'unavailable'
  account: string | null
  plan: string | null
  /** 5-hour, weekly, then a one-model week only when it is lower than the weekly. */
  windows: UsageWindow[]
  observedAt: string
}

/** What the worker's `usage` call returns: the fixed quota projection and email.
 * Status 0: the provider could not be reached. */
export interface WorkerUsage { status: number; body: unknown; account?: unknown; plan?: unknown }

const CLAUDE_PLANS = new Set(['Pro', 'Max', 'Team', 'Enterprise'])

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/
export const accountLabel = (value: unknown) => typeof value === 'string' && value.length <= 256 && EMAIL.test(value) ? value : null

export function failedUsage(id: string, status: 'reauth' | 'unavailable', account: unknown = null, now = new Date()): SubscriptionUsage {
  return { id, status, account: accountLabel(account), plan: null, windows: [], observedAt: now.toISOString() }
}

/** Mirrors readSubscriptionQuota's spend guard (packages/daemon/src/subscription-quota.ts):
 * only an explicit "off" lets the runtime use the subscription. */
export function extraUsage(provider: 'codex' | 'claude', body: Record<string, unknown>): 'off' | 'on' | 'unknown' {
  const controls = body[provider === 'codex' ? 'credits' : 'extra_usage']
  if (!controls || typeof controls !== 'object') return 'unknown'
  const c = controls as Record<string, unknown>
  if (provider === 'codex') {
    if (c.has_credits === false && c.unlimited === false) return 'off'
    return c.has_credits === true || c.unlimited === true ? 'on' : 'unknown'
  }
  return c.is_enabled === false ? 'off' : c.is_enabled === true ? 'on' : 'unknown'
}

const remaining = (window: QuotaWindow) => Math.max(0, Math.min(100, Math.round(100 - window.used * 100)))

/** Reads the provider's answer with the daemon decoders. Percent is what is
 * left (100 − used), as Comma's rows show it. */
export function parseSubscriptionUsage(id: string, provider: 'codex' | 'claude', result: WorkerUsage, now = new Date()): SubscriptionUsage {
  const account = accountLabel(result.account)
  if (result.status === 401 || result.status === 403) return failedUsage(id, 'reauth', account, now)
  if (result.status !== 200 || !result.body || typeof result.body !== 'object') return failedUsage(id, 'unavailable', account, now)
  const decoded = provider === 'codex' ? decodeCodexUsage(result.body) : decodeClaudeUsage(result.body, {})
  const raw: QuotaWindow[] = decoded?.windows ?? []
  const windows: UsageWindow[] = []
  for (const kind of ['five_hour', 'weekly'] as const) {
    const window = raw.find(item => item.kind === kind && !item.model && !item.meter)
    if (window) windows.push({ kind, remaining: remaining(window), resetsAt: window.resetsAt })
  }
  // Claude's Opus/Sonnet weeks: shown only when one binds before the overall week.
  if (provider === 'claude') {
    const weekly = windows.find(item => item.kind === 'weekly')
    const tightest = raw.filter(item => item.kind === 'weekly' && (item.model === 'Opus' || item.model === 'Sonnet'))
      .map(item => ({ kind: 'weekly' as const, remaining: remaining(item), resetsAt: item.resetsAt, model: item.model! }))
      .sort((a, b) => a.remaining - b.remaining)[0]
    if (tightest && (!weekly || tightest.remaining < weekly.remaining)) windows.push(tightest)
  }
  // Claude's usage answer has no plan (the decoder's fallback label is not one); the worker reads it from the profile.
  const body = result.body as Record<string, unknown>
  const plan = provider === 'codex' ? decoded?.plan ?? codexPlanLabel(body.plan_type) : typeof result.plan === 'string' && CLAUDE_PLANS.has(result.plan) ? result.plan : null
  const guard = extraUsage(provider, body)
  return { id, status: guard === 'off' ? 'ok' : guard === 'on' ? 'extra_usage' : 'unverified', account, plan, windows, observedAt: now.toISOString() }
}

/** How long a read is kept: a refused sign-in 10 minutes (so Settings does not
 * keep asking a provider that said no), a temporary failure not at all. */
export const USAGE_TTL_MS: Record<SubscriptionUsage['status'], number> = { ok: 60_000, extra_usage: 60_000, unverified: 60_000, reauth: 600_000, unavailable: 0 }
/** 重试 may skip a kept read, at most once a minute per connection. */
export const USAGE_FORCE_MS = 60_000

/** A short per-instance cache of reads per connection revision; in-flight
 * reads are shared. */
export function usageCache(now = () => Date.now()) {
  const entries = new Map<string, { at: number; ttl: number; value: Promise<SubscriptionUsage> }>()
  return (key: string, read: () => Promise<SubscriptionUsage>, force = false) => {
    const hit = entries.get(key)
    if (hit && now() - hit.at < hit.ttl && !(force && now() - hit.at >= USAGE_FORCE_MS)) return hit.value
    for (const [name, entry] of entries) if (now() - entry.at >= entry.ttl) entries.delete(name)
    if (entries.size >= 500) entries.delete(entries.keys().next().value!)
    // Kept while in flight; then for its status' time.
    const entry = { at: now(), ttl: Number.POSITIVE_INFINITY, value: read() }
    entries.set(key, entry)
    void entry.value.then(result => { entry.ttl = USAGE_TTL_MS[result.status] ?? 0; if (!entry.ttl && entries.get(key) === entry) entries.delete(key) }, () => { if (entries.get(key) === entry) entries.delete(key) })
    return entry.value
  }
}
