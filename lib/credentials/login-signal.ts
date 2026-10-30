/**
 * BE-17: login outcome from definite page signals only. Anything uncertain stays
 * `waiting` (and becomes `expired` at the attempt TTL); nothing is ever guessed.
 * A mechanical fill result such as `submitted` is NOT an input here and never
 * means signed_in: only what the page shows after the submit counts.
 */
export const LOGIN_ATTEMPT_STATUSES = ['waiting', 'needs_code', 'signed_in', 'rejected', 'expired'] as const
export type LoginAttemptStatus = typeof LOGIN_ATTEMPT_STATUSES[number]
export const LOGIN_ATTEMPT_REASONS = ['twoFactorRequired', 'invalidCredentials', 'twoFactorInvalid', 'sessionLost', 'saveFailed'] as const
export type LoginAttemptReason = typeof LOGIN_ATTEMPT_REASONS[number]

/** Which step was just submitted in the browser. */
export type LoginStep = 'password' | 'code'

/** Facts read from the live page. Each one is a boolean the page either shows or not. */
export interface LoginPageSnapshot {
  /** Top-level URL now. */
  url: string
  /** The URL of the page the step was submitted on (login page or code page). */
  stepUrl: string
  /** The site's signed-in marker: a configured session cookie, or an element that only
   * exists after login. Never inferred from navigation alone. */
  signedInMarker: boolean
  /** An input with autocomplete="one-time-code", or a recognised code input. */
  codeInput: boolean
  /** A visible error message on the page (role=alert / aria-invalid / the site's error element). */
  errorMessage: boolean
}

export type LoginSignal =
  | { status: 'signed_in' }
  | { status: 'needs_code'; reason: 'twoFactorRequired' }
  | { status: 'rejected'; reason: 'invalidCredentials' | 'twoFactorInvalid' }
  | { status: 'waiting' }

/** Same page = same origin + path; query/hash churn on a login page is not leaving it. */
function samePage(a: string, b: string) {
  try {
    const x = new URL(a), y = new URL(b)
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '')
  } catch { return true }
}

export function classifyLoginSignal(step: LoginStep, page: LoginPageSnapshot): LoginSignal {
  const onStepPage = samePage(page.url, page.stepUrl)
  // signed_in needs BOTH: the page left the login/code URL and the site's marker is present.
  if (!onStepPage && page.signedInMarker && !page.codeInput) return { status: 'signed_in' }
  if (step === 'password') {
    if (page.codeInput && !page.errorMessage) return { status: 'needs_code', reason: 'twoFactorRequired' }
    if (onStepPage && page.errorMessage && !page.codeInput) return { status: 'rejected', reason: 'invalidCredentials' }
    return { status: 'waiting' }
  }
  // Code step: an error on the code page means the code was rejected.
  if (onStepPage && page.errorMessage) return { status: 'rejected', reason: 'twoFactorInvalid' }
  return { status: 'waiting' }
}
