export function safeAuthReturn(value?: string) {
  if (!value) return '/'
  if (/^\/invite\/[a-f0-9]{64}$/.test(value)) return value
  if (value === '/settings/members' || value === '/devices') return value
  // A deep link to one issue is the only query form accepted, so `next`
  // cannot be used as an open redirect.
  if (/^\/\?issue=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value
  return '/'
}

/**
 * When an agent's OAuth sign-in (lib/auth.ts) sends the person to the sign-in
 * page, its query holds the signed authorization request. After signing in,
 * the person goes back to the authorize endpoint with the same request, which
 * now finds a session and moves on to consent. Null for an ordinary sign-in.
 * The path has no base path; the authorize endpoint checks every parameter.
 */
export function oauthResumePath(query: Record<string, string | string[] | undefined>): string | null {
  if (typeof query.sig !== 'string' || typeof query.client_id !== 'string') return null
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || key === 'sig' || key === 'exp' || key === 'prompt' || key.startsWith('ba_')) continue
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item)
  }
  return `/api/auth/oauth2/authorize?${params}`
}
