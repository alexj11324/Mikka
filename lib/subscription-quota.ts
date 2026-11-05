import { quotaSnapshotSchema, quotaWindowSchema } from "@mikka/protocol";
import { subscriptionQuotaScope, subscriptionQuotaState } from '@mikka/protocol/subscription'
import { z } from "zod";

/** The same selected-model allowance check used at execution. A valid
 * connection alone does not establish that its allowance is available. */
export function subscriptionAvailability(quota: unknown, modelId: string, provider: 'claude' | 'codex', now = Date.now()): { status: 'available' | 'checking' | 'exhausted'; resetsAt: string | null } {
  const parsed = quotaSnapshotSchema.safeParse(quota)
  if (!parsed.success) return { status: 'checking', resetsAt: null }
  const state = subscriptionQuotaState(parsed.data, provider === 'codex' ? 'codex_cpa' : 'claude_cpa', now, modelId)
  const exhausted = parsed.data.windows.filter(window => window.used >= 1 && subscriptionQuotaScope(window, modelId) === 'applicable')
  const times = state === 'exhausted' && exhausted.every(window => window.resetsAt && Date.parse(window.resetsAt) > now) ? exhausted
    .map(window => window.resetsAt!)
    .sort((a, b) => Date.parse(b) - Date.parse(a)) : []
  // Every applicable exhausted window must reset before the model can resume.
  return { status: state === 'unknown' ? 'checking' : state, resetsAt: times[0] ?? null }
}

/** How long Settings shows the last read allowance before it says 待检查 again. */
export const QUOTA_DISPLAY_MS = 15 * 60_000

/**
 * The last read allowance as Settings shows it. Dispatch reads it fresh (60 s, `subscriptionAvailability`); the
 * page shows what the account last answered, for QUOTA_DISPLAY_MS, so a read a minute ago is not 待检查 again.
 * A used-up window whose reset has passed needs another read: that one is 待检查.
 */
export function shownSubscriptionAvailability(quota: unknown, modelId: string, provider: 'claude' | 'codex', now = Date.now()): ReturnType<typeof subscriptionAvailability> {
  const parsed = quotaSnapshotSchema.safeParse(quota)
  const observed = parsed.success ? Date.parse(parsed.data.observedAt) : NaN
  if (!Number.isFinite(observed) || observed > now || now - observed > QUOTA_DISPLAY_MS) return { status: 'checking', resetsAt: null }
  const shown = subscriptionAvailability(quota, modelId, provider, observed)
  if (shown.status === 'exhausted' && shown.resetsAt && Date.parse(shown.resetsAt) <= now) return { status: 'checking', resetsAt: null }
  return shown
}

/** A subscription is out of quota while an account-wide window is fully used and has not reset. */
export function quotaExhausted(quota: unknown, now = Date.now()) {
  const parsed = z.object({ windows: z.array(quotaWindowSchema) }).safeParse(quota);
  if (!parsed.success) return false;
  return parsed.data.windows.some(
    (window) =>
      !window.model &&
      window.used >= 1 &&
      (!window.resetsAt || !(Date.parse(window.resetsAt) <= now)),
  );
}

/** When the soonest used-up account-wide window resets, or null when none says. */
export function quotaResetsAt(quota: unknown, now = Date.now()): string | null {
  const parsed = z.object({ windows: z.array(quotaWindowSchema) }).safeParse(quota);
  if (!parsed.success) return null;
  const times = parsed.data.windows
    .filter((window) => !window.model && window.used >= 1 && window.resetsAt && Date.parse(window.resetsAt) > now)
    .map((window) => window.resetsAt!)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return times[0] ?? null;
}
