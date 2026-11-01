// Hosted-model (Mikka 默认) usage, card verification and the points balance,
// as the backend reports them (#531, #558, #559), and the UI's helpers for them.

/** Every state `getHostedUsage` reports; a refused model call carries the same code. */
export const HOSTED_STATES = ['ready', 'verification_required', 'free_allowance_used', 'points_exhausted', 'platform_paused', 'usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable'] as const
export type HostedState = (typeof HOSTED_STATES)[number]
export type HostedRefusal = Exclude<HostedState, 'ready'>

export interface HostedBalance {
  /** A verified card, a paid plan or a purchase. */
  verified: boolean
  /** Remaining one-off allowance, integer microdollars (USD 1 = 1,000,000). */
  free: number
  /** Remaining purchased points, converted to microdollars. */
  purchased: number
}

export interface HostedUsage {
  state: HostedState
  balance: HostedBalance
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
  type: 'topup' | 'verification' | 'refund'
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
export const POINTS_PURCHASE_AMOUNTS = [10, 25, 50] as const
export const POINTS_PER_USD = 100
const MICRO_USD_PER_POINT = 10_000

/**
 * The refusal code in a model failure, or null. Failure records carry the code
 * as the whole message or inside a longer one (`Error: verification_required`).
 */
export function hostedRefusal(message: string | null | undefined): HostedRefusal | null {
  if (!message) return null
  const match = /\b(verification_required|free_allowance_used|points_exhausted|platform_paused|usage_in_progress|usage_concurrency_limit|usage_cost_unavailable)\b/.exec(message)
  return match ? match[1] as HostedRefusal : null
}

/** Allowance and purchased points as one balance, rounded down so the screen never shows more than is left. */
export function balancePoints(balance: HostedBalance): number {
  return Math.floor(Math.max(0, balance.free + balance.purchased) / MICRO_USD_PER_POINT)
}

/** Polls until `done` holds or `attempts` run out; the last read either way. */
export async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, { attempts = 10, interval = 2000, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) } = {}): Promise<T> {
  let value = await read()
  for (let i = 1; i < attempts && !done(value); i++) {
    await sleep(interval)
    value = await read()
  }
  return value
}
