// Email verification and password recovery requests, per
// docs/handoff/auth-email-frontend.md (Better Auth 1.7.12).
//
// The email requests answer 202 whether or not an account exists or a message
// was delivered, so a success here only means "request processed". Callback
// and redirect targets are left to the backend, which fixes them to
// /mikka/sign-in and /mikka/reset-password.

import { withBasePath } from '@/lib/base-path'
import { turnstileHeaders } from '@/lib/signup-refusal'

export type AuthRecoveryError = 'invalid_token' | 'password_length' | 'rate_limited' | 'unavailable' | 'turnstile_failed' | 'turnstile_unavailable' | 'invalid_request' | 'failed'
export type AuthRecoveryResult = { ok: true } | { ok: false; error: AuthRecoveryError; retryAfter?: number }

// The page's own cooldown after a processed email request. The backend limits
// sending on its own; this only stops repeated clicks.
export const EMAIL_RESEND_COOLDOWN_SECONDS = 60

export function classifyFailure(status: number, code: string | undefined, retryAfter: string | null): Extract<AuthRecoveryResult, { ok: false }> {
  if (status === 429) {
    const seconds = Number.parseInt(retryAfter ?? '', 10)
    return { ok: false, error: 'rate_limited', retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds : EMAIL_RESEND_COOLDOWN_SECONDS }
  }
  if (code === 'INVALID_TOKEN') return { ok: false, error: 'invalid_token' }
  // Turnstile on 重新发送验证邮件 (#527).
  if (code === 'TURNSTILE_INVALID' || code === 'TURNSTILE_REQUIRED') return { ok: false, error: 'turnstile_failed' }
  if (code === 'SIGNUP_VERIFICATION_UNAVAILABLE') return { ok: false, error: 'turnstile_unavailable' }
  if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') return { ok: false, error: 'password_length' }
  if (status === 503 || code === 'AUTH_EMAIL_DELIVERY_UNAVAILABLE') return { ok: false, error: 'unavailable' }
  if (status === 400 || status === 403) return { ok: false, error: 'invalid_request' }
  return { ok: false, error: 'failed' }
}

async function post(path: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<AuthRecoveryResult> {
  const response = await fetch(withBasePath(`/api/auth/${path}`), {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  if (response.ok) return { ok: true }
  const payload: unknown = await response.json().catch(() => null)
  const code = payload && typeof payload === 'object' && 'code' in payload && typeof payload.code === 'string' ? payload.code : undefined
  return classifyFailure(response.status, code, response.headers.get('X-Retry-After'))
}

export function sendVerificationEmail(email: string, turnstileToken: string | null = null) {
  return post('send-verification-email', { email }, turnstileHeaders(turnstileToken))
}

export function requestPasswordReset(email: string) {
  return post('request-password-reset', { email })
}

export function resetPassword(token: string, newPassword: string) {
  return post('reset-password', { token, newPassword })
}

export type RecoveryMessageKey = 'resetLinkInvalid' | 'passwordLength' | 'recoveryUnavailable' | 'signupRefusal.turnstileFailed' | 'signupRefusal.turnstileUnavailable' | 'submitFailed' | 'connectionFailed'

// Rate limits are shown as a countdown instead (see useCooldown).
export function recoveryMessageKey(error: Exclude<AuthRecoveryError, 'rate_limited'>): RecoveryMessageKey {
  if (error === 'invalid_token') return 'resetLinkInvalid'
  if (error === 'password_length') return 'passwordLength'
  if (error === 'unavailable') return 'recoveryUnavailable'
  if (error === 'turnstile_failed') return 'signupRefusal.turnstileFailed'
  if (error === 'turnstile_unavailable') return 'signupRefusal.turnstileUnavailable'
  if (error === 'invalid_request') return 'submitFailed'
  return 'connectionFailed'
}

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

export type PasswordProblem = 'length' | 'mismatch'

// Length counts JavaScript string units, as the server does.
export function newPasswordProblem(password: string, confirmation: string): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return 'length'
  if (password !== confirmation) return 'mismatch'
  return null
}

// A failed verification link lands on /verify-email?error=… (fixed backend
// target). Returns whether it failed and the address without the parameter.
export function readLinkError(href: string): { failed: boolean; cleaned: string } {
  const url = new URL(href)
  const failed = url.searchParams.has('error')
  url.searchParams.delete('error')
  return { failed, cleaned: `${url.pathname}${url.search}${url.hash}` }
}

// Reads the reset link the backend redirects to (/reset-password?token=… or
// ?error=INVALID_TOKEN) and returns the address without either parameter, so
// the caller can drop the token from the URL before anything else runs.
export function readResetLink(href: string): { token: string | null; cleaned: string } {
  const url = new URL(href)
  const token = url.searchParams.get('token')?.trim() || null
  const invalid = url.searchParams.has('error')
  url.searchParams.delete('token')
  url.searchParams.delete('error')
  return { token: invalid ? null : token, cleaned: `${url.pathname}${url.search}${url.hash}` }
}
