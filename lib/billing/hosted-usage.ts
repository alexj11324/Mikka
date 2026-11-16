// Mikka 额度 usage and the points balance (card verification is history only, decision 2026-11-15-1900),
// as the backend reports them (#531, #558, #559), and the UI's helpers for them.

/** Every state `getHostedUsage` reports; a refused model call carries the same code. */
export const HOSTED_STATES = ['ready', 'verification_required', 'free_allowance_used', 'points_exhausted', 'platform_paused', 'usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable', 'usage_budget_exhausted', 'billing_authorization_revoked'] as const
export type HostedState = (typeof HOSTED_STATES)[number]
export type HostedRefusal = Exclude<HostedState, 'ready'>

export interface HostedBalance {
  /** A verified card, a paid plan or a purchase. */
  verified: boolean
  /** Remaining one-off allowance, integer microdollars (USD 1 = 1,000,000). */
  free: number
  /** Remaining purchased points, converted to microdollars. */
  purchased: number
  /** Remaining paid-period credits. Optional while older clients are in use. */
  plan?: number
}

export interface HostedUsage {
  state: HostedState
  balance: HostedBalance
  /** A personal workspace: card verification (the person's, C19) lands here. */
  personal?: boolean
  /** The person may choose a plan or add credits here: a personal workspace, or a team admin. */
  admin?: boolean
  /** The person has a Claude / ChatGPT subscription connected; it serves them in any workspace (#838). */
  subscribed?: boolean
  /** The workspace this was read for, so a dialog opened from the chat acts there. */
  workspaceId?: string
}

/** #558 `cardVerificationStatus`. */
export interface CardVerificationStatus {
  status: 'unverified' | 'pending' | 'verified' | 'unavailable'
  last4?: string | null
  /** Whether this card granted the allowance, or it was already claimed by another workspace. */
  allowance?: 'granted' | 'claimed_elsewhere' | null
}

/** #559 `getCreditBilling`: one balance (allowance included at 100 points per dollar) and 账单记录. */
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

/** #559 `startPointsPurchase` accepts only these USD amounts. */
export { POINTS_PURCHASE_AMOUNTS } from './points'
export const POINTS_PER_USD = 100
const MICRO_USD_PER_POINT = 10_000

/**
 * The refusal code in a model failure, or null. Failure records carry the code
 * as the whole message or inside a longer one (`Error: verification_required`).
 */
export function hostedRefusal(message: string | null | undefined): HostedRefusal | null {
  if (!message) return null
  const match = /\b(verification_required|free_allowance_used|points_exhausted|platform_paused|usage_in_progress|usage_concurrency_limit|usage_cost_unavailable|usage_budget_exhausted|billing_authorization_revoked)\b/.exec(message)
  return match ? match[1] as HostedRefusal : null
}

/**
 * What the refusal card offers, from the person's real state (`usage`, null
 * until read). Out of Mikka 额度 (decision 2026-11-15-1900): 充值 and 选择套餐
 * in a personal workspace; 打开计费 in a team, where admins pay and members
 * ask them. 改用我的订阅 when one is connected. No card verification: there is
 * no trial any more.
 */
export function refusalOffer(code: HostedRefusal, usage: HostedUsage | null) {
  const busy = code === 'usage_in_progress' || code === 'usage_concurrency_limit' || code === 'usage_cost_unavailable'
  // A team with no points of its own: retrying never helps, even with a subscription connected. Its 计费 page buys points or turns on a member's shared credits.
  const restricted = code === 'usage_budget_exhausted' || code === 'billing_authorization_revoked'
  const billing = restricted || (!busy && usage?.personal === false && (code === 'verification_required' || code === 'free_allowance_used' || code === 'points_exhausted'))
  // Out of Mikka 额度 is never a moment's outage, even with a subscription connected: 改用我的订阅 is offered beside 充值.
  const transient = busy
  return {
    transient,
    billing,
    card: false,
    connect: !transient && !restricted && usage?.subscribed === false,
    // A personal workspace with a verified card that ran out: 充值 right there (decision 2026-11-02-1450).
    topUp: !transient && Boolean(usage?.personal) && (code === 'verification_required' || code === 'free_allowance_used' || code === 'points_exhausted'),
  }
}

/** Allowance and purchased points as one balance, rounded down so the screen never shows more than is left. */
export function balancePoints(balance: HostedBalance): number {
  return Math.floor(Math.max(0, balance.free + (balance.plan ?? 0) + balance.purchased) / MICRO_USD_PER_POINT)
}
