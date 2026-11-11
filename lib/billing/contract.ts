/** JSON-only financial DTOs shared by Web, Desktop and native clients. */
export interface AutoRechargePolicyView {
  state: 'provider_unsupported'
  enabled: false
  provider: 'stripe_managed_payments'
  thresholdPoints: number | null
  amountPoints: number | null
  monthlyCapPoints: number | null
  revision: number
}

export interface BillingView {
  configured: boolean
  /** A resource price must be configured separately from the historical seat price. */
  resourceCheckoutAvailable: boolean
  billingModel: 'legacy_seat' | 'resource_v1' | null
  entitlementPlan: 'free' | 'pro' | 'enterprise'
  entitlementExpiresAt: string | null
  plan: string | null
  status: string | null
  /** True while the subscription still bills (active, trialing, past_due…). */
  live: boolean
  seats: number
  members: number
  currentPeriodEnd: string | null
  hasCustomer: boolean
  planPoints: number | null
  purchasedPoints: number
  autoRecharge?: AutoRechargePolicyView
}

export interface CreditTransaction {
  id: string
  date: string
  type: 'topup' | 'verification' | 'refund' | 'subscription'
  points: number
  amountCents: number | null
  currency: string | null
  stripeFeeCents: number | null
  status: 'succeeded'
  receiptUrl: string | null
}

export interface CreditBillingView {
  balancePoints: number
  transactions: CreditTransaction[]
}

export type BudgetScope = 'workspace' | 'member' | 'project' | 'thread' | 'run'
export type BudgetPeriod = 'month' | 'day' | 'lifetime'
export type ResourceBudgetView = { id: string; workspaceId: string; scope: BudgetScope; scopeId: string; period: BudgetPeriod;
  limitPoints: number; warningPercent: number; spentPoints: number; reservedPoints: number; committedPoints: number;
  remainingPoints: number; thresholdReached: boolean; exhausted: boolean }
