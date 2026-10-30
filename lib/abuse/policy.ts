/** USD accounting uses integer microdollars; the one-off allowance is fixed. */
export const FREE_ALLOWANCE_MICRO_USD = 1_000_000
export const MICRO_USD_PER_POINT = 10_000 // Billing conversion: 100 points = USD 1.
export const HOSTED_CALL_RESERVATION = 100_000
export const HOSTED_CALL_TIMEOUT_MS = 60_000
export type PaidResourceCode =
  | 'verification_required'
  | 'free_allowance_used'
  | 'points_exhausted'
  | 'platform_paused'
  | 'usage_in_progress'
  | 'usage_cost_unavailable'
export class PaidResourceError extends Error {
  constructor(readonly code: PaidResourceCode) {
    super(code)
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
/** Gateway returns billed cost as USD in providerMetadata.gateway.cost. */
export function gatewayCost(metadata: unknown): number | null {
  const value = (metadata as { gateway?: { cost?: unknown } } | undefined)
    ?.gateway?.cost
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '')
    return null
  const cost = Number(value)
  return Number.isFinite(cost) &&
    cost >= 0 &&
    Number.isSafeInteger(Math.ceil(cost * 1e6))
    ? Math.ceil(cost * 1e6)
    : null
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

export function gatewayGenerationId(metadata: unknown): string | undefined {
  const id = (metadata as { gateway?: { generationId?: unknown } } | undefined)
    ?.gateway?.generationId
  return typeof id === 'string' && id.length <= 200 ? id : undefined
}
