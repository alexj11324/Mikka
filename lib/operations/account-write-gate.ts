import type { AppToolDecision } from '@/lib/app-tools'
import type { WriteJudgment } from './write-judgment'

/**
 * What happens to one first-class mail or calendar write, before anything is
 * sent: `deny` withholds it, `ask` makes the card, `run` dispatches at once.
 */
export type AccountWriteOutcome = 'deny' | 'ask' | 'run'

/**
 * The workspace's one setting decides first, then the Decisions judge:
 *
 * - deny  → withholds the call; the model is told the workspace blocked it.
 * - ask   → an approval card; nothing runs until the person approves.
 * - allow → runs at once. The workspace's Allow is a real grant, not an absence,
 *           so the judge is never consulted (ADR 2026-11-10-1730).
 * - null  → the workspace names no key for this app, so the judge decides, and
 *           its own unavailable answer goes ahead (lib/operations/write-judgment.ts,
 *           decision 2026-11-01-1330). `judge` is called only in this case.
 *
 * Pure so the three-way decision is testable without a database: the caller
 * supplies the stored setting and how to run the judge.
 */
export async function accountWriteOutcome(
  setting: AppToolDecision | null,
  judge: () => Promise<WriteJudgment>,
): Promise<AccountWriteOutcome> {
  if (setting === 'deny') return 'deny'
  if (setting === 'ask') return 'ask'
  if (setting === 'allow') return 'run'
  return await judge() === 'ask' ? 'ask' : 'run'
}

/** The tool result each outcome returns before any dispatch. `null` runs the call. */
export function accountWriteError(outcome: AccountWriteOutcome): { error: string } | null {
  if (outcome === 'deny') return { error: 'integrationActionDenied' }
  if (outcome === 'ask') return { error: 'integrationApprovalRequired' }
  return null
}
