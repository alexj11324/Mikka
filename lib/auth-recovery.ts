// Front-end seam for email verification and password recovery.
//
// The backend owns the endpoints, error codes and the parameters its emails
// link back with. Until that contract is handed over, every request here fails
// with 'contract_pending', so no screen can report a success that did not
// happen. Wiring the contract means filling in the request functions and the
// CONTRACT constants below; the screens only depend on this module's types.

export type AuthRecoveryError = 'contract_pending' | 'invalid_token' | 'rate_limited' | 'failed'
export type AuthRecoveryResult = { ok: true } | { ok: false; error: AuthRecoveryError }

const CONTRACT = {
  // Query parameters the reset and verification links land with.
  resetToken: 'token',
  linkError: 'error',
  verifiedFlag: 'verified',
  // Error codes the sign-in endpoint returns for an unverified email.
  emailNotVerifiedCodes: [] as readonly string[],
} as const

const pending: AuthRecoveryResult = { ok: false, error: 'contract_pending' }

export async function sendVerificationEmail(_input: { email: string; callbackURL: string }): Promise<AuthRecoveryResult> {
  return pending
}

export async function requestPasswordReset(_input: { email: string; redirectTo: string }): Promise<AuthRecoveryResult> {
  return pending
}

export async function resetPassword(_input: { token: string; newPassword: string }): Promise<AuthRecoveryResult> {
  return pending
}

export function isEmailNotVerified(error: { code?: string } | null | undefined) {
  return Boolean(error?.code && CONTRACT.emailNotVerifiedCodes.includes(error.code))
}

export type RecoveryMessageKey = 'recoveryUnavailable' | 'resetLinkInvalid' | 'tooManyRequests' | 'submitFailed'

export function recoveryMessageKey(error: AuthRecoveryError): RecoveryMessageKey {
  if (error === 'contract_pending') return 'recoveryUnavailable'
  if (error === 'invalid_token') return 'resetLinkInvalid'
  if (error === 'rate_limited') return 'tooManyRequests'
  return 'submitFailed'
}

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 128

export type PasswordProblem = 'length' | 'mismatch'

export function newPasswordProblem(password: string, confirmation: string): PasswordProblem | null {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) return 'length'
  if (password !== confirmation) return 'mismatch'
  return null
}

type Query = Record<string, string | string[] | undefined>

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export type ResetPageState = { kind: 'form'; token: string } | { kind: 'invalid' }

export function resetPageState(query: Query): ResetPageState {
  const token = single(query[CONTRACT.resetToken])?.trim()
  if (single(query[CONTRACT.linkError]) || !token) return { kind: 'invalid' }
  return { kind: 'form', token }
}

export type VerifyPageState = 'pending' | 'verified' | 'invalid'

export function verifyPageState(query: Query): VerifyPageState {
  if (single(query[CONTRACT.linkError])) return 'invalid'
  if (single(query[CONTRACT.verifiedFlag]) === '1') return 'verified'
  return 'pending'
}
