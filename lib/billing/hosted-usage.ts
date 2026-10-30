// Hosted-model (Mikka 默认) usage as #531 reports it, and the UI's helpers for it.

/** Every state `getHostedUsage` reports; a refused model call carries the same code. */
export const HOSTED_STATES = ['ready', 'verification_required', 'free_allowance_used', 'points_exhausted', 'platform_paused', 'usage_in_progress', 'usage_cost_unavailable'] as const
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

export interface CardSetup {
  clientSecret: string
  /** Prefills the person's email so Link can offer saved cards. */
  paymentElementOptions?: { defaultValues?: { billingDetails?: { email?: string } } }
}

/** Stripe.js needs the publishable key; #531 does not return it, so it comes from the build (backend gap). */
export const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY

/**
 * The refusal code in a model failure, or null. Failure records carry the code
 * as the whole message or inside a longer one (`Error: verification_required`).
 */
export function hostedRefusal(message: string | null | undefined): HostedRefusal | null {
  if (!message) return null
  const match = /\b(verification_required|free_allowance_used|points_exhausted|platform_paused|usage_in_progress|usage_cost_unavailable)\b/.exec(message)
  return match ? match[1] as HostedRefusal : null
}

/** Microdollars → dollars, rounded down to the cent so the screen never shows more than is left. */
export function usdFromMicro(micro: number): number {
  return Math.floor(Math.max(0, micro) / 10_000) / 100
}

/** What is left to spend on Mikka 默认. */
export function hostedRemaining(balance: HostedBalance): number {
  return usdFromMicro(balance.free + balance.purchased)
}

/** Waits for the webhook to record a confirmed card; false when it has not after `attempts`. */
export async function waitForVerification(read: () => Promise<HostedUsage | null>, { attempts = 15, interval = 2000, sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) } = {}): Promise<HostedUsage | null> {
  for (let i = 0; i < attempts; i++) {
    const usage = await read()
    if (usage?.balance.verified) return usage
    if (i < attempts - 1) await sleep(interval)
  }
  return null
}
