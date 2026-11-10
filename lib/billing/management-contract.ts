import type { BillingView, CreditBillingView, ResourceBudgetView, BudgetPeriod, BudgetScope } from './contract'

export type BillingScope = { kind: 'workspace' | 'organization'; id: string }
export type BillingBudgetInput = { scope: BudgetScope; scopeId: string; period: BudgetPeriod; limitPoints: number | null; warningPercent: number }
export type BillingManagementView = {
  scope: BillingScope & { name: string }
  account: { workspaceId: string; name: string } | null
  billing: BillingView | null
  credits: CreditBillingView | null
  canManagePayments: boolean
  canPurchasePlatform: boolean
  platformAccountWorkspaceId: string | null
  canManageRecharge: boolean
  canManageBudget: boolean
  organizations: { id: string; name: string }[]
  organization: { id: string; name: string; role: 'owner' | 'admin'; accountWorkspaceId: string | null;
    canDesignate: boolean; accounts: { id: string; name: string; selectable: boolean }[] } | null
  budgetWorkspaceId: string | null
  workspaces: { id: string; name: string; canEdit: boolean }[]
  members: { id: string; name: string }[]
  resourceTargets: { id: string; kind: 'project' | 'thread'; visibility: string; ownerId: string }[]
  resourceTargetsAvailable: boolean
  budgets: ResourceBudgetView[]
  usage: { month: string; costMicroUsd: number; reservedMicroUsd: number; unknownCalls: number; externalUnknownRuns: number;
    members: { id: string | null; name: string | null; costMicroUsd: number; unknownCalls: number }[] }
}
export type BillingManagementOperation = (
  | { action: 'budget'; workspaceId: string; budget: BillingBudgetInput }
  | { action: 'account'; workspaceId: string | null }
  | { action: 'recharge'; policy: { enabled: false; expectedRevision: number; thresholdPoints: number; amountPoints: 1000 | 2500 | 5000; monthlyCapPoints: number } }
  | { action: 'checkout' | 'portal' }
  | { action: 'topup'; amount: number; locale: string }
) & { accountWorkspaceId?: string }
