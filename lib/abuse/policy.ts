import { CodedError, type CodedErrorOptions } from '@mikka/protocol/coded-error'
/** USD accounting uses integer microdollars. The one-off card allowance is no longer
 * granted (decision 2026-11-15-1900); its size stays for reading old grants and history. */
export const FREE_ALLOWANCE_MICRO_USD = 1_000_000
export const MICRO_USD_PER_POINT = 10_000 // Billing conversion: 100 points = USD 1.
export const HOSTED_CALL_TIMEOUT_MS = 120_000
/**
 * Estimated maximum cost one hosted call holds while in flight. Output is capped
 * at 4,096 tokens (model.ts); USD 0.10 covers that at USD 15 per million output
 * tokens plus about 100k input tokens at USD 0.30 per million, far above the
 * default hosted model. A call that still costs more settles at its actual cost
 * (any shortfall is debt, as before). Eight holds fit the USD 1 allowance.
 */
export const HOSTED_CALL_HOLD_MICRO_USD = 100_000
/** Anti-abuse cap on concurrent hosted calls per workspace. */
export const HOSTED_MAX_IN_FLIGHT_PER_WORKSPACE = 8
export type PaidResourceCode =
  | 'verification_required'
  | 'free_allowance_used'
  | 'points_exhausted'
  | 'platform_paused'
  | 'usage_in_progress'
  | 'usage_concurrency_limit'
  | 'usage_cost_unavailable'
  | 'usage_budget_exhausted'
  | 'billing_authorization_revoked'
export class PaidResourceError extends CodedError<PaidResourceCode> {
  constructor(code: PaidResourceCode, options?: CodedErrorOptions) {
    super(code, options)
    this.name = 'PaidResourceError'
  }
}
const positive = (value: string | undefined, fallback: number) => {
  const n = Number(value)
  return Number.isInteger(n) && Number.isSafeInteger(n * 10_000) && n > 0
    ? n
    : fallback
}
export function abuseLimits(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    dailyMicroUsd: positive(env.MIKKA_FREE_MODEL_DAILY_CENTS, 2500) * 10_000,
    firstUseHourly: positive(env.MIKKA_FREE_MODEL_FIRST_USE_HOURLY, 50),
  }
}
export function abuseAlertKinds(
  spent: number,
  firstUses: number,
  limits: ReturnType<typeof abuseLimits>,
): string[] {
  return [
    ...(spent >= limits.dailyMicroUsd / 2 ? ['half'] : []),
    ...(spent >= limits.dailyMicroUsd ? ['full'] : []),
    ...(firstUses > limits.firstUseHourly ? ['signup_spike'] : []),
  ]
}
