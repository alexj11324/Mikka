import type { AttentionLevel } from './judgment'

// Runaway caps only. Whether to hand a matter to the Coordinator and whether to
// interrupt the person are the Decisions API's answers (./interrupt.ts), which
// read how often the person was told today. These caps stop a loop or a
// broken model from burning the person's attention or the paid calls; at the
// usual pace they are never reached (Alex, 2026-11-01: hard limits against
// runaways stay, the daily 5 / 30-minute / 12 budgets go to the Decisions API).

export const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000

export const BUDGETS = {
  handoff: { limit: 48, spacingMs: 0 },
  notify: { limit: 24, spacingMs: 0 },
} as const
export type BudgetKind = keyof typeof BUDGETS

export type BudgetState = { open: true; remaining: number } | { open: false; nextAt: Date }

/** Whether the cap is open at `now`, given when it was spent. `level` critical skips any spacing. */
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
