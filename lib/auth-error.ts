export function oauthAccountNotLinkedProvider(
  error: string | string[] | undefined,
  provider: string | string[] | undefined,
): 'google' | 'github' | null {
  const errors = Array.isArray(error) ? error : [error]
  if (!errors.includes('account_not_linked')) return null
  const providers = Array.isArray(provider) ? provider : [provider]
  return providers.find((value): value is 'google' | 'github' => value === 'google' || value === 'github') ?? null
}
