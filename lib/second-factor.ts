// The sign-in page's second step (设置 › 安全 › 两步验证). Email sign-in for a
// person with two-step verification on answers { twoFactorRedirect: true }
// instead of a session; the session starts only after one of these calls.
// Pure over the auth client so tests can drive a real better-auth instance.

export type SecondFactorCodeKind = 'totp' | 'backup'

export interface SecondFactorChallenge {
  twoFactorRedirect: true
  twoFactorMethods?: string[]
}

type ClientResult = { data: unknown; error: { message?: string; code?: string; status?: number } | null }

export interface SecondFactorAuthClient {
  twoFactor: {
    verifyTotp: (input: { code: string; trustDevice?: boolean }) => Promise<ClientResult>
    verifyBackupCode: (input: { code: string; trustDevice?: boolean }) => Promise<ClientResult>
  }
}

/** True when a sign-in result is waiting for the second step. */
export function needsSecondFactor(data: unknown): data is SecondFactorChallenge {
  return Boolean(data && typeof data === 'object' && (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true)
}

/** Six digits are an authenticator code; better-auth backup codes are 5+5 letters/digits. */
export function secondFactorCodeKind(input: string): SecondFactorCodeKind | null {
  const code = input.replace(/\s+/g, '')
  if (/^\d{6}$/.test(code)) return 'totp'
  if (/^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/.test(code)) return 'backup'
  return null
}

function normalizeBackupCode(code: string): string {
  const compact = code.replace(/[\s-]+/g, '')
  return `${compact.slice(0, 5)}-${compact.slice(5)}`
}

/**
 * Finishes sign-in with either kind of code. `trustDevice` skips the second
 * step on this browser for 30 days. Returns the client result unchanged, or a
 * local INVALID_CODE error when the text is neither kind of code.
 */
export async function verifySecondFactor(client: SecondFactorAuthClient, code: string, options: { trustDevice?: boolean } = {}): Promise<ClientResult> {
  const kind = secondFactorCodeKind(code)
  if (!kind) return { data: null, error: { code: 'INVALID_CODE', status: 400 } }
  const trustDevice = options.trustDevice === true
  return kind === 'totp'
    ? client.twoFactor.verifyTotp({ code: code.replace(/\s+/g, ''), trustDevice })
    : client.twoFactor.verifyBackupCode({ code: normalizeBackupCode(code), trustDevice })
}
