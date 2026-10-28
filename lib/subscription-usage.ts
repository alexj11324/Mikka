import type { QuotaWindow } from '@mikka/protocol'
import { codexPlanLabel, decodeCodexUsage } from '../packages/daemon/src/quota/codex'
import { decodeClaudeUsage } from '../packages/daemon/src/quota/claude'

/** One connected subscription as its owner's Settings row shows it. Numbers,
 * a plan label and the sign-in email only; never a token or account id. */
export interface SubscriptionUsage {
  id: string
  status: 'ok' | 'unavailable'
  account: string | null
  plan: string | null
  /** Account-wide windows the provider returned, in 5-hour, weekly order. */
  windows: { kind: 'five_hour' | 'weekly'; remaining: number; resetsAt: string | null }[]
}

/** What the worker's `usage` call returns: the fixed quota projection and email. */
export interface WorkerUsage { status: number; body: unknown; account?: unknown }

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}$/

export function unavailableUsage(id: string): SubscriptionUsage {
  return { id, status: 'unavailable', account: null, plan: null, windows: [] }
}

/** Reads the provider's answer with the daemon decoders. Percent is what is
 * left (100 − used), as Comma's rows show it. A window for one model only
 * (Claude's Opus week, Codex's additional limits) is not the account's. */
export function parseSubscriptionUsage(id: string, provider: 'codex' | 'claude', result: WorkerUsage): SubscriptionUsage {
  const account = typeof result.account === 'string' && EMAIL.test(result.account) ? result.account : null
  if (result.status !== 200 || !result.body || typeof result.body !== 'object') return { ...unavailableUsage(id), account }
  const decoded = provider === 'codex' ? decodeCodexUsage(result.body) : decodeClaudeUsage(result.body, {})
  const raw: QuotaWindow[] = decoded?.windows ?? []
  const windows: SubscriptionUsage['windows'] = []
  for (const kind of ['five_hour', 'weekly'] as const) {
    const window = raw.find(item => item.kind === kind && !item.model && !item.meter)
    if (window) windows.push({ kind, remaining: Math.max(0, Math.min(100, Math.round(100 - window.used * 100))), resetsAt: window.resetsAt })
  }
  // Claude's usage answer has no plan; the decoder's fallback label is not one.
  const plan = provider === 'codex' ? decoded?.plan ?? codexPlanLabel((result.body as Record<string, unknown>).plan_type) : null
  return { id, status: 'ok', account, plan, windows }
}

/** A short per-instance cache: one provider read per connection revision a minute. */
export function usageCache(ttlMs = 60_000, now = () => Date.now()) {
  const entries = new Map<string, { at: number; value: Promise<SubscriptionUsage> }>()
  return (key: string, read: () => Promise<SubscriptionUsage>) => {
    const hit = entries.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.value
    for (const [name, entry] of entries) if (now() - entry.at >= ttlMs) entries.delete(name)
    if (entries.size >= 500) entries.delete(entries.keys().next().value!)
    const value = read()
    entries.set(key, { at: now(), value })
    return value
  }
}
