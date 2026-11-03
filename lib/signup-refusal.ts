// Sign-up and verification-mail refusals from #527 (codes as in PR #531,
// docs/backend/hosted-abuse-controls.md). The Turnstile token goes in this
// header on email/password sign-up and on 重新发送验证邮件.
export const TURNSTILE_HEADER = 'x-turnstile-token'

export type SignupRefusal = 'disposableEmail' | 'signupRateLimited' | 'turnstileFailed' | 'turnstileUnavailable' | 'emailRegistered'

/** The refusal behind a failed sign-up or verification-mail request, or null for any other failure. */
export function signupRefusal(status: number | undefined, code: string | undefined): SignupRefusal | null {
  if (code === 'DISPOSABLE_EMAIL') return 'disposableEmail'
  if (code === 'SIGNUP_RATE_LIMITED' || status === 429) return 'signupRateLimited'
  if (code === 'TURNSTILE_INVALID' || code === 'TURNSTILE_REQUIRED') return 'turnstileFailed'
  if (code === 'SIGNUP_VERIFICATION_UNAVAILABLE') return 'turnstileUnavailable'
  if (code === 'EMAIL_ALREADY_REGISTERED' || code === 'USER_ALREADY_EXISTS') return 'emailRegistered'
  return null
}

/** Headers carrying a Turnstile token; empty when the widget is off (no site key). */
export function turnstileHeaders(token: string | null): Record<string, string> {
  return token ? { [TURNSTILE_HEADER]: token } : {}
}

export type SignInRefusal = 'invalidCredentials' | 'emailNotVerified' | 'signInRateLimited'

/**
 * Why an email sign-in failed (usability review N4). A wrong password and an unknown email read the same,
 * so the line never says whether an account exists (OWASP authentication guidance). Better Auth answers
 * EMAIL_NOT_VERIFIED only after the password matched, so that refusal leaks nothing either.
 */
export function signInRefusal(status: number | undefined, code: string | undefined): SignInRefusal | null {
  if (code === 'EMAIL_NOT_VERIFIED') return 'emailNotVerified'
  if (code === 'INVALID_EMAIL_OR_PASSWORD' || code === 'USER_EMAIL_NOT_FOUND' || code === 'INVALID_PASSWORD' || code === 'CREDENTIAL_ACCOUNT_NOT_FOUND' || status === 401) return 'invalidCredentials'
  if (status === 429) return 'signInRateLimited'
  return null
}
