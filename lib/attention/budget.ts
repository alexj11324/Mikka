import type { AttentionLevel } from './judgment'

// Two budgets per person, after Comma (github.com/AFK-surf/Comma,
// systems/apps/salix_im/lib/salix_im/mail_interaction.ex, AGPL-3.0). Handoffs wake the Coordinator with
// evidence; their daily cap bounds its cost. Telling the person is the
// Coordinator's decision to interrupt them about a matter it was handed; that
// cap bounds a Coordinator that is wrong about what must be known now. A
// critical matter skips the spacing but not the cap. Staying quiet spends
// nothing, and so do replies and reminders the person asked for.

export const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000

export const BUDGETS = {
  handoff: { limit: 12, spacingMs: 0 },
  notify: { limit: 5, spacingMs: 30 * 60_000 },
} as const
export type BudgetKind = keyof typeof BUDGETS

export type BudgetState = { open: true; remaining: number } | { open: false; nextAt: Date }

/** Whether the budget is open at `now`, given when it was spent. `level` critical skips the spacing. */
export function budgetState(kind: BudgetKind, spends: readonly Date[], now: Date, level?: AttentionLevel): BudgetState {
  const { limit } = BUDGETS[kind]
  const spacingMs = level === 'critical' ? 0 : BUDGETS[kind].spacingMs
  const inWindow = spends.map(at => at.getTime()).filter(at => now.getTime() - at < BUDGET_WINDOW_MS).sort((a, b) => b - a)
  if (inWindow.length >= limit) {
    // The cap reopens when the oldest spend in the window leaves it, and not sooner than the spacing allows.
    return { open: false, nextAt: new Date(Math.max(inWindow[limit - 1] + BUDGET_WINDOW_MS, inWindow[0] + spacingMs)) }
  }
  if (inWindow.length && now.getTime() - inWindow[0] < spacingMs) return { open: false, nextAt: new Date(inWindow[0] + spacingMs) }
  return { open: true, remaining: limit - inWindow.length }
}
