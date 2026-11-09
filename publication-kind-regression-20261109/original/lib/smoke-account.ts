/**
 * Production smoke accounts (docs/production-smoke.md) are ordinary accounts
 * whose email carries a `+mikka-smoke` tag. The tag grants nothing; it only
 * marks the account's analytics as test traffic so dashboards can leave it out.
 */
export function isSmokeAccountEmail(email: string | null | undefined) {
  return typeof email === 'string' && /^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(email)
}
