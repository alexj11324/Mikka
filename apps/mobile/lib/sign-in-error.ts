import messages from '../../../messages/zh-CN.json'

/**
 * The sign-in screen's line for a failed sign-in, by better-auth's error code
 * (copy.md C-08: say what went wrong). Rate limits come as HTTP 429.
 */
export function signInErrorLine(error: { code?: string; status?: number } | null | undefined, copy = messages.Auth): string {
  if (error?.status === 429) return copy.signInRefusal.signInRateLimited
  switch (error?.code) {
    case 'INVALID_EMAIL_OR_PASSWORD':
    case 'USER_EMAIL_NOT_FOUND': return copy.signInRefusal.invalidCredentials
    case 'INVALID_EMAIL': return copy.emailInvalid
    case 'EMAIL_NOT_VERIFIED': return copy.mobileEmailNotVerified
    case 'PROVIDER_NOT_FOUND': return copy.mobileProviderUnavailable
    default: return copy.mobileSignInFailed
  }
}
