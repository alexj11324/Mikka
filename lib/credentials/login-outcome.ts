// The one place that reads the site's login outcome (BE-17) and picks its copy.
// When BE-17 ships or changes, only this module changes.
//
// Site outcomes: HTTP 200 { attemptId?, status, origin, reason?, channel?, retryAfterSeconds? }
// Mikka's own errors: non-2xx { error }.
// Only an explicit `signed_in` is a sign-in, only `rejected` + a reason is a rejection,
// only `needs_code` asks for a code. Any other status (e.g. `submitted`, `guarded`,
// `needs_login`, or none) means the result is not in yet: show waiting, never guess.

export type CodeChannel = 'totp' | 'sms' | 'email'
export type LoginView =
  | { kind: 'signed_in' }
  | { kind: 'rejected'; field: 'password' | 'code' | null; message: LoginCopy; retryAfterSeconds?: number }
  | { kind: 'needs_code'; label: LoginCopy; message?: LoginCopy }
  | { kind: 'needs_user'; message: LoginCopy }
  | { kind: 'unknown'; message: LoginCopy; attemptId: string | null }
  | { kind: 'waiting'; attemptId: string | null }
  | { kind: 'error'; message: LoginCopy; attemptId: string | null }

/** A key under `CredentialLogin.outcome` plus its ICU values. */
export type OutcomeKey =
  | 'invalidCredentials' | 'twoFactorInvalid' | 'rateLimited' | 'rateLimitedFor' | 'accountLocked' | 'rejected'
  | 'code' | 'codeTotp' | 'codeSms' | 'codeEmail' | 'captchaRequired' | 'needsUser' | 'outcomeUnknown'
  | 'submissionInvalid' | 'denied' | 'loginPending' | 'unavailable' | 'failed'
/** A key under CredentialLogin.outcome in messages/*.json. */
export type LoginCopy = { key: OutcomeKey; values?: Record<string, number> }

const REJECTED: Record<string, { field: 'password' | 'code' | null; key: OutcomeKey }> = {
  invalidCredentials: { field: 'password', key: 'invalidCredentials' },
  twoFactorInvalid: { field: 'code', key: 'twoFactorInvalid' },
  rateLimited: { field: null, key: 'rateLimited' },
  accountLocked: { field: null, key: 'accountLocked' },
}
const NEEDS_USER: Record<string, OutcomeKey> = { captchaRequired: 'captchaRequired' }
const CHANNEL: Record<string, OutcomeKey> = { totp: 'codeTotp', sms: 'codeSms', email: 'codeEmail' }
const ERRORS: Record<string, OutcomeKey> = {
  credential_submission_invalid: 'submissionInvalid',
  credential_denied: 'denied',
  credential_login_pending: 'loginPending',
  credential_outcome_unknown: 'outcomeUnknown',
  credential_unavailable: 'unavailable',
}

const str = (value: unknown) => typeof value === 'string' && value ? value : null

/** Maps one credential API response to what the card shows. */
/** Own keys only: an open-enum value like `toString` must hit the generic fallback. */
function pick<T>(map: Record<string, T>, key: string | null | undefined): T | undefined {
  return key && Object.hasOwn(map, key) ? map[key] : undefined
}

export function loginView(httpStatus: number, body: unknown): LoginView {
  const data = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
  const attemptId = str(data.attemptId)
  if (httpStatus < 200 || httpStatus >= 300) {
    const code = str(data.error)
    if (code === 'credential_outcome_unknown') return { kind: 'unknown', message: { key: 'outcomeUnknown' }, attemptId }
    if (code === 'credential_login_pending') return { kind: 'waiting', attemptId }
    return { kind: 'error', message: { key: pick(ERRORS, code) ?? 'failed' }, attemptId }
  }
  const status = str(data.status)
  const reason = str(data.reason)
  if (status === 'signed_in') return { kind: 'signed_in' }
  if (status === 'rejected') {
    const known = pick(REJECTED, reason)
    if (!known) return { kind: 'rejected', field: null, message: { key: 'rejected' } }
    const seconds = typeof data.retryAfterSeconds === 'number' && data.retryAfterSeconds > 0 ? Math.ceil(data.retryAfterSeconds) : undefined
    if (known.key === 'rateLimited') return { kind: 'rejected', field: null, retryAfterSeconds: seconds, message: seconds ? { key: 'rateLimitedFor', values: { seconds } } : { key: 'rateLimited' } }
    return { kind: 'rejected', field: known.field, message: { key: known.key } }
  }
  if (status === 'needs_code') {
    const channel = str(data.channel)
    return { kind: 'needs_code', label: { key: pick(CHANNEL, channel) ?? 'code' } }
  }
  if (status === 'needs_user') return { kind: 'needs_user', message: { key: pick(NEEDS_USER, reason) ?? 'needsUser' } }
  if (status === 'unknown') return { kind: 'unknown', message: { key: 'outcomeUnknown' }, attemptId }
  return { kind: 'waiting', attemptId }
}
