export function decisionTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const configured = Number(env.MIKKA_DECISION_TIMEOUT_MS)
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 2_147_483_647 ? configured : 30_000
}
