// What 设置 › 计费's page receives (docs/ui-overlay.md). Reading, the Stripe
// redirects and the returns from Checkout stay in BillingSettings; the states and
// actions are the hooks in hooks/settings/use-billing.ts.
import type { BillingPlanState, CreditBalanceState, FreeAllowanceState } from '@/hooks/settings/use-billing'

export type SettingsBillingProps = {
  /** The plan, seats and points (V15), with 订阅 / 更改方案 / payment and invoices through Stripe. */
  plan: BillingPlanState
  /** 余额, 充值 and 账单记录 (#559). */
  balance: CreditBalanceState
  /** 免费额度 (#558): personal workspaces only, null elsewhere. */
  allowance: FreeAllowanceState | null
  /** The points rows are shown only where computer billing is on. */
  computerBilling: boolean
}
