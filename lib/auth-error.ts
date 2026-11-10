/**
 * A refused company SSO returns `sso=failed` together with the server-issued
 * `ENTERPRISE_*` code that the auth-sso slot renders itself. Only that exact
 * shape suppresses the generic OAuth notice: `sso=failed` alone is a URL
 * parameter any link can carry, so it must not silence the notice for an
 * unrelated OAuth error. Repeated `error` values must all look server-issued.
 */
export function ssoRefusalHasOwnNotice(
  sso: string | string[] | undefined,
  error: string | string[] | undefined,
): boolean {
  const refusals = Array.isArray(sso) ? sso : [sso]
  if (!refusals.includes('failed')) return false
  const errors = (Array.isArray(error) ? error : [error]).filter((value): value is string => typeof value === 'string')
  return errors.length > 0 && errors.every((value) => /^ENTERPRISE_[A-Z_]+$/.test(value))
}

export function oauthAccountNotLinkedProvider(
  error: string | string[] | undefined,
  provider: string | string[] | undefined,
): 'google' | 'github' | null {
  const errors = Array.isArray(error) ? error : [error]
  if (!errors.includes('account_not_linked')) return null
  const providers = Array.isArray(provider) ? provider : [provider]
  return providers.find((value): value is 'google' | 'github' => value === 'google' || value === 'github') ?? null
}
