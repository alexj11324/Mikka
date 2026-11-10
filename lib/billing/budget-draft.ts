import type { BillingBudgetInput } from './management-contract'
import type { BudgetScope, BudgetPeriod, ResourceBudgetView } from './contract'

export type BudgetDraft = { scope: BudgetScope; scopeId: string; period: BudgetPeriod; limit: string; warning: string }
export function budgetDraft(workspaceId: string, budget?: ResourceBudgetView): BudgetDraft {
  return budget ? { scope: budget.scope, scopeId: budget.scopeId, period: budget.period, limit: String(budget.limitPoints), warning: String(budget.warningPercent) }
    : { scope: 'workspace', scopeId: workspaceId, period: 'month', limit: '', warning: '80' }
}
export function wholeNumber(value: string, max = 100_000_000): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n <= max ? n : null
}
export function budgetInput(draft: BudgetDraft, workspaceId: string, remove = false): BillingBudgetInput | null {
  const limit = wholeNumber(draft.limit), warning = wholeNumber(draft.warning, 100)
  const scopeId = draft.scope === 'workspace' ? workspaceId : draft.scopeId.trim()
  if (!scopeId || warning === null || warning < 1 || (!remove && limit === null)) return null
  return { scope: draft.scope, scopeId, period: draft.period, limitPoints: remove ? null : limit, warningPercent: warning }
}
