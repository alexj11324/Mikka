import type { QuotaWindow } from '@mikka/protocol'
import { codexPlanLabel, decodeCodexUsage } from '../packages/daemon/src/quota/codex'
import { decodeClaudeUsage } from '../packages/daemon/src/quota/claude'

export interface UsageWindow { kind: 'five_hour' | 'weekly'; remaining: number; resetsAt: string | null; model?: string }

/** One connected subscription as its owner's Settings row shows it. Numbers,
 * a plan label and the sign-in email only; never a token or account id.
 * `reauth`: the provider refused the sign-in (401/403, still refused after one
 * refresh). `unavailable`: the read failed for now; try again. */
export interface SubscriptionUsage {
  id: string
  status: 'ok' | 'reauth' | 'unavailable'
  account: string | null
  plan: string | null
  /** 5-hour, weekly, then a one-model week only when it is lower than the weekly. */
  windows: UsageWindow[]
  observedAt: string
}

/** What the worker's `usage` call returns: the fixed quota projection and email.
 * Status 0: the provider could not be reached. */
export interface WorkerUsage { status: number; body: unknown; account?: unknown }

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/
export const accountLabel = (value: unknown) => typeof value === 'string' && value.length <= 256 && EMAIL.test(value) ? value : null

export function failedUsage(id: string, status: 'reauth' | 'unavailable', account: unknown = null, now = new Date()): SubscriptionUsage {
  return { id, status, account: accountLabel(account), plan: null, windows: [], observedAt: now.toISOString() }
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
  // Claude's usage answer has no plan; the decoder's fallback label is not one.
  const plan = provider === 'codex' ? decoded?.plan ?? codexPlanLabel((result.body as Record<string, unknown>).plan_type) : null
  return { id, status: 'ok', account, plan, windows, observedAt: now.toISOString() }
}

/** A short per-instance cache: one provider read per connection revision a
 * minute. Only successful reads are kept, so 重试 really reads again. */
export function usageCache(ttlMs = 60_000, now = () => Date.now()) {
  const entries = new Map<string, { at: number; value: Promise<SubscriptionUsage> }>()
  return (key: string, read: () => Promise<SubscriptionUsage>) => {
    const hit = entries.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.value
    for (const [name, entry] of entries) if (now() - entry.at >= ttlMs) entries.delete(name)
    if (entries.size >= 500) entries.delete(entries.keys().next().value!)
    const entry = { at: now(), value: read() }
    entries.set(key, entry)
    void entry.value.then(result => { if (result.status !== 'ok' && entries.get(key) === entry) entries.delete(key) }, () => { if (entries.get(key) === entry) entries.delete(key) })
    return entry.value
  }
}
